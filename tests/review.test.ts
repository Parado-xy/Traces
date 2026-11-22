/**
 * Integration checks for the local review interface and its HTTP boundary.
 * Fixtures are synthetic even when exercising the real-case code path. Provider
 * reads are injected and no test sends a notification or contacts a marketplace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store, fingerprint } from '../src/store.ts';
import { normalizeBike } from '../src/adapters/bikeindex.ts';
import { parseListing } from '../src/domain.ts';
import type { BikeCase } from '../src/domain.ts';
import { ReviewService } from '../src/review/service.ts';
import { createReviewServer } from '../src/review/server.ts';
import { seedPracticeWorkspace } from '../src/review/demo.ts';

/** Returns a fresh synthetic provider-format record normalized through the real adapter. */
function caseFixture(): BikeCase {
  return normalizeBike({
    id: 123,
    stolen: true,
    manufacturer_name: 'Trek',
    frame_model: 'FX 3',
    frame_colors: ['Blue'],
    serial: 'SYNTHETIC123',
    description: 'Synthetic test record, not a public theft report.',
    components: [],
  });
}

/** Builds a manual form submission with the expected case version and no seller fields. */
function candidateInput(bike: BikeCase) {
  return {
    caseFingerprint: fingerprint(bike),
    query: 'Trek FX 3 blue bicycle',
    listing: {
      url: 'https://example.com/listing/one',
      title: 'Blue Trek FX 3',
      description: 'Bicycle with visible serial.',
      attributes: { serial: 'SYNTHETIC123' },
    },
  };
}

/** Supplies an isolated store and a replaceable authoritative report for service checks. */
function workspace() {
  const store = new Store(':memory:');
  const bike = caseFixture();
  store.putCase(bike);
  let authoritative = bike;
  const provider = {
    get: async () => authoritative,
    search: async () => [authoritative],
  };
  return {
    store,
    bike,
    service: new ReviewService(store, provider),
    setAuthoritative: (next: BikeCase) => {
      authoritative = next;
    },
  };
}

test('manual form reaches scoring, provenance, verdict history and real-case metrics', () => {
  const { store, service, bike } = workspace();
  try {
    const { observationId } = service.addCandidate(bike.id, candidateInput(bike));
    const observation = service.observationDetail(observationId);
    assert.equal(observation.run.query, 'Trek FX 3 blue bicycle');
    assert.equal(observation.score.total, 75);
    assert.equal(observation.reviewable, true);
    assert.equal(observation.caseSnapshot.model, 'FX 3');
    service.review(observationId, {
      verdict: 'unsure',
      reviewer: 'Test reviewer',
      notes: 'Photo too sparse.',
    });
    service.review(observationId, {
      verdict: 'match',
      reviewer: 'Test reviewer',
      notes: 'Explicit serial agrees in this synthetic fixture.',
    });
    const updated = service.observationDetail(observationId);
    assert.deepEqual(
      updated.reviews.map((entry) => entry.verdict),
      ['match', 'unsure'],
    );
    assert.equal(service.caseDetail(bike.id).metrics.reviewedPrecision, 1);
    assert.equal(service.cases()[0].needsReview, 0);
  } finally {
    store.close();
  }
});

test('changed authoritative case blocks a stale browser verdict and candidate form', async () => {
  const { store, service, bike, setAuthoritative } = workspace();
  try {
    const input = candidateInput(bike);
    const { observationId } = service.addCandidate(bike.id, input);
    setAuthoritative({ ...bike, model: 'FX 4' });
    await service.refresh(bike.id);
    assert.equal(service.observationDetail(observationId).reviewable, false);
    assert.match(service.observationDetail(observationId).blockReason!, /changed/);
    assert.throws(
      () =>
        service.review(observationId, {
          verdict: 'match',
          reviewer: 'Test',
          notes: 'Old evidence',
        }),
      /changed/,
    );
    assert.throws(() => service.addCandidate(bike.id, input), /Case changed/);
    assert.equal(service.observationDetail(observationId).caseSnapshot.model, 'FX 3');
  } finally {
    store.close();
  }
});

test('new snapshot supersedes older review while preserving query and case evidence', () => {
  const { store, service, bike } = workspace();
  try {
    const input = candidateInput(bike);
    const older = service.addCandidate(bike.id, input).observationId;
    service.review(older, {
      verdict: 'not_match',
      reviewer: 'Test',
      notes: 'Initial assessment.',
    });
    const latest = service.addCandidate(bike.id, input).observationId;
    assert.equal(service.caseDetail(bike.id).candidates.length, 1);
    assert.equal(service.observationDetail(latest).snapshots.length, 2);
    assert.equal(service.observationDetail(older).reviews.length, 1);
    assert.equal(service.observationDetail(older).reviewable, false);
    assert.throws(
      () =>
        service.review(older, {
          verdict: 'match',
          reviewer: 'Test',
          notes: 'Bypass attempt',
        }),
      /newer/,
    );
  } finally {
    store.close();
  }
});

test('closed case keeps its evidence visible but rejects new candidates and verdicts', async () => {
  const { store, service, bike, setAuthoritative } = workspace();
  try {
    const { observationId } = service.addCandidate(bike.id, candidateInput(bike));
    setAuthoritative({ ...bike, status: 'closed' });
    await service.refresh(bike.id);
    assert.equal(service.caseDetail(bike.id).candidates.length, 1);
    assert.match(service.observationDetail(observationId).blockReason!, /closed/);
    assert.throws(
      () =>
        service.review(observationId, {
          verdict: 'match',
          reviewer: 'Test',
          notes: 'Bypass',
        }),
      /closed/,
    );
    assert.throws(() => service.addCandidate(bike.id, candidateInput(bike)), /closed/);
  } finally {
    store.close();
  }
});

test('invalid form input creates neither a partial search nor a candidate', () => {
  const { store, service, bike } = workspace();
  try {
    const input = candidateInput(bike);
    input.listing.url = 'javascript:alert(1)';
    assert.throws(() => service.addCandidate(bike.id, input));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, 0);
    const valid = candidateInput(bike);
    valid.query = '';
    assert.throws(() => service.addCandidate(bike.id, valid), /search terms/);
  } finally {
    store.close();
  }
});

test('verdict and time entries persist after a disk store is closed and reopened', () => {
  const directory = mkdtempSync(join(tmpdir(), 'traces-review-'));
  const filename = join(directory, 'case.sqlite');
  let store = new Store(filename);
  try {
    const bike = caseFixture();
    store.putCase(bike);
    const service = new ReviewService(store);
    const { observationId } = service.addCandidate(bike.id, candidateInput(bike));
    service.review(observationId, {
      verdict: 'unsure',
      reviewer: 'Test',
      notes: 'Needs a clearer marking.',
    });
    service.recordTime(bike.id, { method: 'assisted', minutes: 6 });
    service.recordTime(bike.id, { method: 'manual', minutes: 14 });
    store.close();
    store = new Store(filename);
    const reopened = new ReviewService(store);
    assert.equal(
      reopened.observationDetail(observationId).reviews[0].notes,
      'Needs a clearer marking.',
    );
    const detail = reopened.caseDetail(bike.id);
    assert.equal(detail.sessions.length, 2);
    assert.equal(detail.metrics.perCase[0].minutesSaved, 8);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('practice workspace provides blocked examples without entering real evaluation', async () => {
  const store = new Store(':memory:');
  try {
    seedPracticeWorkspace(store, 'http://127.0.0.1:4317');
    const service = new ReviewService(store, undefined, true);
    const cases = service.cases();
    assert.equal(cases.length, 3);
    assert.ok(cases.every((bike) => bike.staged));
    const changed = service.caseDetail('staged:changed-case');
    assert.equal(changed.candidates[0].reviewable, false);
    service.recordTime(changed.bike.id, { method: 'assisted', minutes: 3 });
    assert.equal(store.metrics().cases, 0);
    assert.equal(changed.metrics.reviewedPrecision, null);
    await assert.rejects(
      service.ingest({ region: 'Grambling, LA', distance: 100, limit: 1 }),
      /Practice workspace/,
    );
  } finally {
    store.close();
  }
});

test('HTTP session protects evidence, blocks cross-site mutations and serves only allowlisted assets', async () => {
  const { store, service, bike } = workspace();
  const server = createReviewServer({ service });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const session = (await (await fetch(`${origin}/api/session`)).json()) as any;
    assert.equal((await fetch(`${origin}/api/cases`)).status, 403);
    const headers = {
      'X-Traces-Token': session.token,
      'Content-Type': 'application/json',
      Origin: origin,
    };
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
    assert.equal((await fetch(`${origin}/data/trace-shadow.sqlite`)).status, 404);
    const hostile = await fetch(
      `${origin}/api/cases/${encodeURIComponent(bike.id)}/candidates`,
      {
        method: 'POST',
        headers: { ...headers, Origin: 'https://unrelated.example' },
        body: JSON.stringify(candidateInput(bike)),
      },
    );
    assert.equal(hostile.status, 403);
    const missingOrigin = { ...headers };
    delete (missingOrigin as any).Origin;
    assert.equal(
      (
        await fetch(`${origin}/api/cases/ingest`, {
          method: 'POST',
          headers: missingOrigin,
          body: '{}',
        })
      ).status,
      403,
    );
    const imported = await fetch(
      `${origin}/api/cases/${encodeURIComponent(bike.id)}/candidates`,
      { method: 'POST', headers, body: JSON.stringify(candidateInput(bike)) },
    );
    assert.equal(imported.status, 201);
    const { observationId } = (await imported.json()) as any;
    const review = await fetch(`${origin}/api/observations/${observationId}/reviews`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        verdict: 'unsure',
        reviewer: 'HTTP test',
        notes: 'Synthetic test evidence.',
      }),
    });
    assert.equal(review.status, 201);
    const page = await fetch(origin);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(await page.text(), /Evidence review/);
    assert.equal(store.reviewHistory(observationId).length, 1);
    // There is deliberately no browser route for sending notifications.
    assert.equal(
      (
        await fetch(`${origin}/api/observations/${observationId}/notify`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('sandbox observations stay visible but excluded from real candidate metrics', () => {
  const { store, service, bike } = workspace();
  try {
    const listing = parseListing(candidateInput(bike).listing, 'ebay');
    listing.testData = true;
    listing.environment = 'sandbox';
    const run = store.startRun(bike.id, 'ebay:sandbox', 'Trek FX 3 bicycle');
    const [id] = store.finishRun(run, bike, [listing]);
    const detail = service.caseDetail(bike.id);
    assert.equal(detail.candidates.length, 1);
    assert.equal(service.observationDetail(id).listing.environment, 'sandbox');
    assert.equal(detail.metrics.candidates, 0);
  } finally {
    store.close();
  }
});
