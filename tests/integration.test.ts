/**
 * Tests the integration runner's claims and side effects using injected HTTP.
 * Provider setup checks must not leak secrets, sandbox tests must stay staged,
 * and a notification preflight must never issue a POST to an owner endpoint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { normalizeBike } from '../src/adapters/bikeindex.ts';
import { parseListing } from '../src/domain.ts';
import { Ebay } from '../src/adapters/ebay.ts';
import { requestJson, ProviderHttpError } from '../src/http.ts';
import { integrationConfig, integrationStatus } from '../src/integration/config.ts';
import {
  checkBikeIndexRead,
  checkEbaySearch,
  checkNotification,
} from '../src/integration/checks.ts';

/** Produces a provider-shaped response without real network access. */
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Creates the minimal synthetic bike record used to exercise real-case branches. */
function providerBike() {
  return {
    id: 123,
    stolen: true,
    manufacturer_name: 'Trek',
    frame_model: 'FX 3',
    frame_colors: ['Blue'],
    serial: 'SYNTHETIC123',
  };
}

/** Configures fake credentials that must never appear in diagnostic output. */
function configured(environment = 'sandbox') {
  return integrationConfig({
    EBAY_ENV: environment,
    EBAY_CLIENT_ID: 'SECRET-CLIENT',
    EBAY_CLIENT_SECRET: 'SECRET-KEY',
  });
}

test('setup diagnostics disclose presence only and never mistake settings for live approval', () => {
  const config = configured();
  config.bikeIndexToken = 'PRIVATE-TOKEN';
  const status = integrationStatus(config);
  assert.equal(status.ebay.readyToAttemptSearch, true);
  assert.equal(status.bikeIndex.notificationDelivery, 'not_checked');
  const output = JSON.stringify(status);
  for (const secret of ['SECRET-CLIENT', 'SECRET-KEY', 'PRIVATE-TOKEN']) {
    assert.ok(!output.includes(secret));
  }
  assert.equal(integrationStatus(integrationConfig({})).ebay.readyToAttemptSearch, false);
  assert.equal(
    integrationStatus(configured('production')).ebay.readyToAttemptSearch,
    false,
  );
  assert.throws(
    () => integrationConfig({ EBAY_ENV: 'misspelled-production' }),
    /EBAY_ENV/,
  );
});

test('Bike Index exercise proves normalization and persistence without outward notification', async () => {
  const store = new Store(':memory:');
  const methods: string[] = [];
  const mock = (async (url: any, init: any) => {
    methods.push(init.method || 'GET');
    return String(url).includes('/search?')
      ? response({ bikes: [{ id: 123 }] })
      : response({ bike: providerBike() });
  }) as typeof fetch;
  try {
    const result = await checkBikeIndexRead(
      store,
      integrationConfig({}),
      'Test region',
      10,
      1,
      mock,
    );
    assert.equal(result.caseRoundTripPassed, true);
    assert.equal(result.cases[0].fingerprintAgrees, true);
    assert.equal(store.getCase('bikeindex:123').make, 'Trek');
    assert.equal(result.notificationsSent, 0);
    assert.deepEqual(methods, ['GET', 'GET']);
  } finally {
    store.close();
  }
});

test('sandbox integration accepts a synthetic case and checks known inventory through the full queue path', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const mock = (async (url: any) => {
    calls.push(String(url));
    return String(url).includes('/token')
      ? response({ access_token: 'FAKE-ACCESS-TOKEN' })
      : response({
          total: 1,
          itemSummaries: [
            {
              itemId: 'v1|known|0',
              itemWebUrl: 'https://sandbox.ebay.com/itm/known',
              title: 'Blue Trek FX 3 bicycle',
              seller: { username: 'DO-NOT-STORE' },
            },
          ],
        });
  }) as typeof fetch;
  try {
    const result = await checkEbaySearch(
      store,
      configured(),
      undefined,
      'v1|known|0',
      mock,
    );
    assert.equal(result.knownItemFound, true);
    assert.equal(result.candidateRoundTripPassed, true);
    assert.equal(result.candidates, 1);
    assert.ok(calls.every((url) => url.startsWith('https://api.sandbox.ebay.com/')));
    const observation = store.observation(result.observationIds[0]);
    assert.equal(observation.listing.testData, true);
    assert.equal(observation.caseSnapshot.staged, true);
    assert.ok(!JSON.stringify(observation).includes('DO-NOT-STORE'));
    assert.equal(store.metrics().cases, 0);
  } finally {
    store.close();
  }
});

test('empty sandbox search passes connectivity but does not claim candidate retrieval validation', async () => {
  const store = new Store(':memory:');
  const mock = (async (url: any) =>
    String(url).includes('/token')
      ? response({ access_token: 'TOKEN' })
      : response({ total: 0 })) as typeof fetch;
  try {
    const result = await checkEbaySearch(
      store,
      configured(),
      undefined,
      'missing-item',
      mock,
    );
    assert.equal(result.transportPassed, true);
    assert.equal(result.candidateRoundTripPassed, false);
    assert.equal(result.knownItemFound, false);
    assert.equal(result.candidates, 0);
  } finally {
    store.close();
  }
});

test('staged production searches fail before credentials are sent', async () => {
  const store = new Store(':memory:');
  const config = configured('production');
  config.ebay.productionApproved = true;
  let calls = 0;
  const mock = (async () => {
    calls++;
    return response({});
  }) as typeof fetch;
  try {
    await assert.rejects(
      checkEbaySearch(store, config, undefined, undefined, mock),
      /requires --case/,
    );
    // Prepare the staged record via a sandbox run, then test the production gate.
    await checkEbaySearch(store, configured(), undefined, undefined, (async (url: any) =>
      String(url).includes('/token')
        ? response({ access_token: 'TOKEN' })
        : response({ total: 0 })) as typeof fetch);
    await assert.rejects(
      new Ebay(config.ebay, mock).search(store.getCase('staged:blue-trek')),
      /Staged cases/,
    );
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('source failures leave a failed search attempt instead of an apparently empty success', async () => {
  const store = new Store(':memory:');
  try {
    const mock = (async () =>
      response(
        { error: 'invalid_client', error_description: 'PRIVATE-TOKEN' },
        401,
      )) as typeof fetch;
    await assert.rejects(
      checkEbaySearch(store, configured(), undefined, undefined, mock),
      /invalid_client/,
    );
    assert.equal(store.db.prepare('SELECT status FROM runs').get()?.status, 'failed');
    assert.equal(store.observations().length, 0);
  } finally {
    store.close();
  }
});

test('provider errors retain only safe identifiers and sanitize malformed success bodies', async () => {
  const mock = (async () =>
    response(
      { error: 'invalid_client', error_description: 'PRIVATE-TOKEN' },
      401,
    )) as typeof fetch;
  await assert.rejects(
    requestJson('https://api.sandbox.ebay.com/test', {}, mock),
    (error: any) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.code, 'invalid_client');
      assert.equal(error.status, 401);
      assert.ok(!String(error).includes('PRIVATE-TOKEN'));
      return true;
    },
  );
  const untrusted = (async () =>
    response({ error: 'SECRET-TOKEN-WITH-ARBITRARY-CONTENT' }, 400)) as typeof fetch;
  await assert.rejects(
    requestJson('https://example.com', {}, untrusted),
    (error: any) => !String(error).includes('SECRET'),
  );
  const malformed = (async () =>
    new Response('PRIVATE-TOKEN is not JSON')) as typeof fetch;
  await assert.rejects(
    requestJson('https://example.com', {}, malformed),
    (error: any) =>
      String(error).includes('Invalid JSON') && !String(error).includes('PRIVATE-TOKEN'),
  );
});

test('notification preflight rechecks real case evidence but makes no notification POST', async () => {
  const store = new Store(':memory:');
  try {
    const bike = normalizeBike(providerBike());
    store.putCase(bike);
    const listing = parseListing({
      url: 'https://example.com/listing/one',
      title: 'Synthetic controlled test listing',
      attributes: { serial: 'SYNTHETIC123' },
    });
    const run = store.startRun(bike.id, 'manual', 'Synthetic fixture');
    const [id] = store.finishRun(run, bike, [listing]);
    let calls = 0;
    const mock = (async (_url: any, init: any) => {
      calls++;
      assert.notEqual(init.method, 'POST');
      return response({ bike: providerBike() });
    }) as typeof fetch;
    await assert.rejects(
      checkNotification(store, integrationConfig({}), id, mock),
      /human/,
    );
    assert.equal(calls, 0);
    store.review(
      id,
      'match',
      'Test reviewer',
      'Synthetic fixture check, not a real recovery verdict.',
    );
    const result = await checkNotification(store, integrationConfig({}), id, mock);
    assert.equal(result.sent, false);
    assert.equal(result.deliveryValidated, false);
    assert.equal(result.tokenConfigured, false);
    assert.equal(calls, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()?.n, 0);
  } finally {
    store.close();
  }
});
