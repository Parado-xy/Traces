/**
 * Controlled live integration exercises without automatic outward notifications.
 * Each operation returns evidence about what it actually checked. Sandbox search
 * uses synthetic attributes; real ingestion and sandbox matching stay distinct.
 */
import { readFileSync } from 'node:fs';
import { BikeIndex } from '../adapters/bikeindex.ts';
import { Ebay } from '../adapters/ebay.ts';
import type { BikeCase } from '../domain.ts';
import { Store, fingerprint } from '../store.ts';
import { notificationDraft } from '../notify.ts';
import { caseQuery } from '../score.ts';
import type { IntegrationConfig } from './config.ts';

/**
 * Exercises regional discovery, detail reads, normalization and persistence.
 * Reopens the retained case through Store so success is more than HTTP reachability.
 */
export async function checkBikeIndexRead(
  store: Store,
  config: IntegrationConfig,
  region: string,
  distance: number,
  limit: number,
  fetcher: typeof fetch = fetch,
) {
  const bikes = await new BikeIndex(config.bikeIndexToken, fetcher).search(
    region,
    distance,
    limit,
  );
  for (const bike of bikes) {
    store.putCase(bike);
  }
  return {
    checkedAt: new Date().toISOString(),
    provider: 'Bike Index',
    operation: 'regional search → detail → normalized case → store readback',
    region,
    distanceMiles: distance,
    transportPassed: true,
    caseRoundTripPassed: bikes.length > 0,
    cases: bikes.map((bike) => {
      const retained = store.getCase(bike.id);
      return {
        id: retained.id,
        status: retained.status,
        photoReferences: retained.photos.length,
        fingerprintAgrees: fingerprint(retained) === fingerprint(bike),
      };
    }),
    notificationsSent: 0,
    limitation: bikes.length
      ? 'No marketplace candidate or recovery has been verified.'
      : 'Search succeeded but no open reports were returned for this region.',
  };
}

/**
 * Runs one official eBay query and stores its ranked observations.
 * In sandbox, an omitted case selects the clearly staged text fixture. Production
 * always requires an explicit retained real case and the adapter's approval gate.
 * @param expectedItem Optional exact eBay itemId from controlled sandbox inventory.
 */
export async function checkEbaySearch(
  store: Store,
  config: IntegrationConfig,
  caseId?: string,
  expectedItem?: string,
  fetcher: typeof fetch = fetch,
) {
  let bike: BikeCase;
  if (caseId) {
    bike = store.openCase(caseId);
  } else {
    if (config.ebay.environment !== 'sandbox') {
      throw new Error(
        'Production search requires --case with a real open Bike Index case.',
      );
    }
    bike = JSON.parse(
      readFileSync(new URL('../../fixtures/benchmark.json', import.meta.url), 'utf8'),
    ).bike;
    store.putCase(bike);
  }
  if (config.ebay.environment === 'sandbox' && !bike.staged) {
    throw new Error(
      'Use a staged case for the sandbox integration exercise; keep real-case evaluation separate.',
    );
  }

  // Get the exact query from the same deterministic helper as the adapter.
  // The run is retained on source failures as well as successful empty searches.
  const runId = store.startRun(
    bike.id,
    `ebay:${config.ebay.environment}`,
    caseQuery(bike),
  );
  try {
    const result = await new Ebay(config.ebay, fetcher).search(bike);
    const ids = store.finishRun(runId, bike, result.listings);
    const knownItemFound = expectedItem
      ? result.listings.some((listing) => listing.sourceId === expectedItem)
      : null;
    return {
      checkedAt: new Date().toISOString(),
      provider: 'eBay',
      environment: config.ebay.environment,
      transportPassed: true,
      caseId: bike.id,
      query: result.query,
      runId,
      candidates: ids.length,
      observationIds: ids,
      expectedItemChecked: Boolean(expectedItem),
      knownItemFound,
      candidateRoundTripPassed: ids.length > 0,
      notificationsSent: 0,
      limitation:
        config.ebay.environment === 'sandbox'
          ? 'Sandbox connectivity and data flow only; not real inventory or recovery performance.'
          : 'Candidates are unverified leads. A human must inspect them before any outward action.',
    };
  } catch (error) {
    store.failRun(runId);
    throw error;
  }
}

/**
 * Builds a notification preflight without sending anything or obtaining ownership.
 * The human match and test-data gates are checked before any provider read. A
 * successful preflight does not prove that the token has read_user scope, that
 * the app is approved, or that a message reached its intended recipient.
 */
export async function checkNotification(
  store: Store,
  config: IntegrationConfig,
  observationId: number,
  fetcher: typeof fetch = fetch,
) {
  const draft = notificationDraft(store, observationId);
  const current = await new BikeIndex(config.bikeIndexToken, fetcher).get(
    draft.bikeIndexId,
  );
  const retained = store.getCase(`bikeindex:${draft.bikeIndexId}`);
  const attributesAgree = fingerprint(current) === fingerprint(retained);
  if (!attributesAgree || current.status !== 'open') {
    store.putCase(current);
    throw new Error(
      'Authoritative case changed or closed. Search and review again before notification.',
    );
  }
  return {
    checkedAt: new Date().toISOString(),
    operation: 'local draft and authoritative case recheck only',
    observationId,
    bikeIndexId: draft.bikeIndexId,
    humanMatchCurrent: true,
    attributesAgree,
    tokenConfigured: Boolean(config.bikeIndexToken),
    notificationSetupConfirmed: config.bikeIndexNotifyApproved,
    draft,
    sent: false,
    deliveryValidated: false,
    next: 'Review the exact recipient case and draft. Use the existing explicit CLI send only for an authorized test or verified real lead.',
  };
}
