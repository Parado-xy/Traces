/**
 * Exercises matching and verification rules using synthetic object records.
 * Each database is isolated in memory, and provider calls use local HTTP stubs.
 * A test may simulate a real-case flag, but no test contacts an owner or seller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store, fingerprint } from '../src/store.ts';
import { scoreListing } from '../src/score.ts';
import { parseListing } from '../src/domain.ts';
import type { BikeCase } from '../src/domain.ts';
import { normalizeBike, BikeIndex } from '../src/adapters/bikeindex.ts';
import { Ebay } from '../src/adapters/ebay.ts';
import { benchmark } from '../src/benchmark.ts';
import { notificationDraft, sendNotification } from '../src/notify.ts';
import { requestJson } from '../src/http.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/benchmark.json', import.meta.url), 'utf8'),
);
/** Returns a fresh case so one test's mutations cannot affect another test. */
const bike = () => structuredClone(fixture.bike) as BikeCase;

/** Normalizes one labeled synthetic candidate using the ordinary import path. */
const listing = (index = 0) => parseListing(fixture.items[index].listing, 'staged');

/**
 * Seeds an isolated case, search run, and observation for review/store tests.
 * Setting real simulates the real-case branch of the guards without network I/O.
 * Callers close the returned store in finally, even when an assertion fails.
 */
function setup(real = false) {
  const store = new Store(':memory:');
  const bikeCase = real
    ? normalizeBike({
        id: 123,
        stolen: true,
        manufacturer_name: 'Trek',
        frame_model: 'FX 3',
        frame_colors: ['Blue'],
        serial: 'DEMO-123456',
        components: [],
      })
    : bike();
  store.putCase(bikeCase);
  const run = store.startRun(bikeCase.id, 'test', 'Trek FX 3');
  const candidate = listing();
  if (real) {
    candidate.source = 'manual';
    candidate.testData = false;
  }
  const ids = store.finishRun(run, bikeCase, [candidate]);
  return { store, bikeCase, id: ids[0] };
}

/** Builds a provider-shaped JSON response for an injected fetch implementation. */
const response = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status });

test('score points are fixed, evidence sums to 100, and exact serial is explicit', () => {
  const score = scoreListing(bike(), listing());
  assert.equal(score.total, 100);
  assert.equal(
    score.evidence.reduce((n, e) => n + e.possible, 0),
    100,
  );
  assert.equal(scoreListing(bike(), listing(1)).total, 10);
  const candidate = listing();
  candidate.attributes.serial = '';
  candidate.description += ' DEMO123456';
  assert.equal(
    scoreListing(bike(), candidate).evidence.find((e) => e.attribute === 'serial')
      ?.points,
    0,
  );
});

test('serial conflict overrides a highly similar listing', () => {
  const score = scoreListing(bike(), listing(3));
  assert.equal(score.total, 10);
  assert.match(score.conflicts[0], /serial/);
});

test('no substring make/model matches, no renormalization with missing fields', () => {
  const candidate = listing();
  candidate.title = 'Trekked FX 30';
  candidate.description = '';
  candidate.attributes = {};
  assert.equal(scoreListing(bike(), candidate).total, 0);
  const bikeCase = bike();
  bikeCase.serial = 'unknown';
  bikeCase.markings = [];
  bikeCase.components = [];
  assert.equal(scoreListing(bikeCase, candidate).total, 0);
});

test('explicit make/color conflicts remain visible despite matching title', () => {
  const candidate = listing();
  candidate.attributes.make = 'Giant';
  candidate.attributes.colors = ['Red'];
  const score = scoreListing(bike(), candidate);
  assert.ok(score.total <= 35);
  assert.equal(score.conflicts.length, 2);
});

test('listing whitelist removes identity fields and rejects non-web URLs', () => {
  const candidate = parseListing({
    ...fixture.items[0].listing,
    seller: { name: 'SECRET' },
    email: 'PRIVATE',
  });
  assert.ok(!JSON.stringify(candidate).includes('SECRET'));
  assert.ok(!JSON.stringify(candidate).includes('PRIVATE'));
  assert.throws(() => parseListing({ title: 'x', url: 'javascript:alert(1)' }));
});

test('case normalization drops owner fields and does not invent markings', () => {
  const bikeCase = normalizeBike({
    id: 5,
    stolen: true,
    manufacturer_name: 'Trek',
    description: 'dent',
    owner_email: 'SECRET',
    serial: 'A123',
  });
  assert.equal(bikeCase.status, 'open');
  assert.deepEqual(bikeCase.markings, []);
  assert.ok(!JSON.stringify(bikeCase).includes('SECRET'));
  assert.throws(() => normalizeBike({ id: '5' }));
});

test('duplicate within one run dedupes; new runs preserve observations and require fresh verdict', () => {
  const { store, bikeCase, id } = setup();
  try {
    store.review(id, 'match', 'Jalla', 'staged test');
    const run = store.startRun(bikeCase.id, 'staged', 'q');
    const ids = store.finishRun(run, bikeCase, [listing(), listing()]);
    assert.equal(ids.length, 1);
    assert.equal(store.observations().length, 1);
    assert.equal(store.observations(undefined, false).length, 2);
    assert.equal(store.observations()[0].verdict, null);
    assert.throws(() => store.current(id), /newer/);
  } finally {
    store.close();
  }
});

test('review history is append-only and latest verdict controls draft', () => {
  const { store, id } = setup(true);
  try {
    assert.throws(() => notificationDraft(store, id), /human/);
    assert.throws(() => store.review(id, 'match', 'Jalla', ''), /notes/);
    store.review(id, 'match', 'Jalla', 'serial checked in staged test');
    assert.equal(notificationDraft(store, id).bikeIndexId, 123);
    store.review(id, 'not_match', 'Jalla', 'correction');
    assert.throws(() => notificationDraft(store, id), /human/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviews').get()?.n, 2);
  } finally {
    store.close();
  }
});

test('case changes and recovered status block review and notification', () => {
  const { store, bikeCase, id } = setup(true);
  try {
    store.review(id, 'match', 'Jalla', 'test');
    const updated = { ...bikeCase, model: 'FX 4' };
    store.putCase(updated);
    assert.throws(() => notificationDraft(store, id), /changed/);
    assert.throws(() => store.review(id, 'match', 'Jalla', 'test'), /changed/);
    store.putCase({ ...updated, status: 'closed' });
    assert.throws(() => store.startRun(bikeCase.id, 'manual', 'q'), /closed/);
  } finally {
    store.close();
  }
});

test('case timestamp refresh does not invalidate identical evidence', () => {
  const bikeCase = bike();
  assert.equal(
    fingerprint(bikeCase),
    fingerprint({ ...bikeCase, fetchedAt: new Date().toISOString() }),
  );
});

test('staged demo cannot notify and cannot inflate real-case metrics', () => {
  const { store, id } = setup();
  try {
    store.review(id, 'match', 'DEMO', 'synthetic');
    assert.throws(() => notificationDraft(store, id), /Staged/);
    assert.equal(store.metrics().cases, 0);
    assert.equal(store.metrics().reviewedPrecision, null);
  } finally {
    store.close();
  }
});

test('real metrics exclude unsure, preserve null FPR, and pair manual and assisted time', () => {
  const { store, bikeCase, id } = setup(true);
  try {
    store.review(id, 'unsure', 'Jalla', 'not enough evidence');
    assert.equal(store.metrics().reviewedPrecision, null);
    store.review(id, 'not_match', 'Jalla', 'different serial');
    store.time(bikeCase.id, 'manual', 12);
    store.time(bikeCase.id, 'assisted', 5);
    const m = store.metrics();
    assert.equal(m.reviewedPrecision, 0);
    assert.equal(m.reviewedRejectionFraction, 1);
    assert.equal(m.falsePositiveRate, null);
    assert.equal(m.perCase[0].minutesSaved, 7);
    assert.throws(() => store.time(bikeCase.id, 'manual', -1));
  } finally {
    store.close();
  }
});

test('labeled benchmark includes deliberate false positives and misses', () => {
  // The fixture is intentionally imperfect: a look-alike clears the threshold,
  // while a true match with little descriptive text falls below it.
  const bikeCase = benchmark(fixture);
  assert.deepEqual([bikeCase.tp, bikeCase.fp, bikeCase.tn, bikeCase.fn], [1, 1, 2, 1]);
  assert.equal(bikeCase.falsePositiveRate, 1 / 3);
  assert.equal(bikeCase.missRate, 1 / 2);
});

test('retention deletes case, evidence, reviews, runs and old audit records', () => {
  const { store, id } = setup();
  try {
    store.review(id, 'match', 'Jalla', 'test');
    store.purge(30, new Date('2028-01-01'));
    for (const table of ['cases', 'runs', 'observations', 'reviews'])
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM audit').get()?.n, 1);
  } finally {
    store.close();
  }
});

test('failed source requests are logged as failed runs', () => {
  const { store, bikeCase } = setup();
  try {
    const id = store.startRun(bikeCase.id, 'ebay', 'q');
    store.failRun(id);
    assert.equal(
      store.db.prepare('SELECT status FROM runs WHERE id=?').get(id)?.status,
      'failed',
    );
  } finally {
    store.close();
  }
});

test('eBay uses OAuth, case keywords, category and discards seller data', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const mock = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? response({ access_token: 'TOKEN' })
      : response({
          total: 1,
          itemSummaries: [
            {
              itemId: 'v1|1|0',
              itemWebUrl: 'https://www.ebay.com/itm/1',
              title: 'Trek FX 3 Blue',
              seller: { username: 'SECRET' },
            },
          ],
        });
  }) as typeof fetch;
  const bikeCase = bike();
  bikeCase.staged = false;
  const result = await new Ebay(
    {
      clientId: 'id',
      clientSecret: 'secret',
      environment: 'sandbox',
      productionApproved: false,
    },
    mock,
  ).search(bikeCase);
  assert.match(calls[0].url, /sandbox.*token/);
  assert.equal(calls[0].init.method, 'POST');
  const u = new URL(calls[1].url);
  assert.equal(u.searchParams.get('q'), 'Trek FX 3 bicycle');
  assert.equal(u.searchParams.get('limit'), '25');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(result.listings[0].testData, true);
  assert.equal(result.listings[0].environment, 'sandbox');
});

test('production eBay use is gated and rate limit errors do not leak body', async () => {
  const bikeCase = bike();
  bikeCase.staged = false;
  let calls = 0;
  const mock = (async () => {
    calls++;
    return response({ secret: 'PRIVATE' }, 429);
  }) as typeof fetch;
  await assert.rejects(
    new Ebay(
      {
        clientId: 'a',
        clientSecret: 'b',
        environment: 'production',
        productionApproved: false,
      },
      mock,
    ).search(bikeCase),
    /Production disabled/,
  );
  assert.equal(calls, 0);
  await assert.rejects(requestJson('https://example.com', {}, mock), /HTTP 429/);
});

test('Bike Index uses canonical read endpoint and does not put token in URL', async () => {
  const mock = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://bikeindex.org/api/v3/bikes/123');
    assert.equal(init.headers.Authorization, 'Bearer TOKEN');
    return response({ bike: { id: 123, stolen: true } });
  }) as typeof fetch;
  assert.equal((await new BikeIndex('TOKEN', mock).get(123)).id, 'bikeindex:123');
});

test('notification send rechecks live status, calls only Bike Index, and prevents duplicates', async () => {
  const { store, id } = setup(true);
  let posts = 0;
  const mock = (async (url: any, init: any) => {
    if (init.method === 'POST') {
      posts++;
      assert.match(
        String(url),
        /bikeindex.org\/api\/v3\/bikes\/123\/send_stolen_notification/,
      );
      assert.match(
        new URLSearchParams(init.body).get('message')!,
        /verify independently/,
      );
      return new Response(null, { status: 204 });
    }
    return response({
      bike: {
        id: 123,
        stolen: true,
        manufacturer_name: 'Trek',
        frame_model: 'FX 3',
        frame_colors: ['Blue'],
        serial: 'DEMO-123456',
        components: [],
      },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(sendNotification(store, id, 'TOKEN', mock), /human/);
    assert.equal(posts, 0);
    store.review(id, 'match', 'Jalla', 'test verification');
    await sendNotification(store, id, 'TOKEN', mock);
    assert.equal(posts, 1);
    await assert.rejects(sendNotification(store, id, 'TOKEN', mock), /already attempted/);
    assert.equal(posts, 1);
  } finally {
    store.close();
  }
});

test('recovered authoritative bike prevents any notification post', async () => {
  const { store, id } = setup(true);
  let posts = 0;
  const mock = (async (_url: any, init: any) => {
    if (init.method === 'POST') posts++;
    return response({ bike: { id: 123, stolen: false, status: 'unencumbered' } });
  }) as typeof fetch;
  try {
    store.review(id, 'match', 'Jalla', 'test');
    await assert.rejects(sendNotification(store, id, 'TOKEN', mock), /no longer stolen/);
    assert.equal(posts, 0);
  } finally {
    store.close();
  }
});

test('sandbox inventory cannot notify a real owner or inflate real-case candidates', () => {
  const { store, bikeCase } = setup(true);
  try {
    const candidate = listing(1);
    candidate.source = 'ebay';
    candidate.testData = true;
    candidate.environment = 'sandbox';
    const run = store.startRun(bikeCase.id, 'ebay:sandbox', 'Trek FX 3');
    const [id] = store.finishRun(run, bikeCase, [candidate]);
    store.review(id, 'match', 'Jalla', 'test');
    assert.throws(() => notificationDraft(store, id), /sandbox/);
    assert.equal(store.metrics().candidates, 1);
  } finally {
    store.close();
  }
});

test('uncertain notification outcome blocks blind retry', async () => {
  const { store, id } = setup(true);
  let posts = 0;
  const mock = (async (_url: any, init: any) => {
    if (init.method === 'POST') {
      posts++;
      throw new Error('Network timeout');
    }
    return response({
      bike: {
        id: 123,
        stolen: true,
        manufacturer_name: 'Trek',
        frame_model: 'FX 3',
        frame_colors: ['Blue'],
        serial: 'DEMO-123456',
        components: [],
      },
    });
  }) as typeof fetch;
  try {
    store.review(id, 'match', 'Jalla', 'test');
    await assert.rejects(sendNotification(store, id, 'TOKEN', mock), /timeout/);
    assert.equal(
      store.db.prepare('SELECT state FROM notifications').get()?.state,
      'unknown_or_failed',
    );
    await assert.rejects(sendNotification(store, id, 'TOKEN', mock), /already attempted/);
    assert.equal(posts, 1);
  } finally {
    store.close();
  }
});
