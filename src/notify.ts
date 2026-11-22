/**
 * Human-gated Bike Index notifications for reviewed object recovery leads.
 * Drafting is local. Sending rechecks authoritative case evidence, records an
 * attempt before the network call, and never automatically retries an uncertain
 * outcome. There is no seller-contact path.
 */
import type { Store } from './store.ts';
import { BikeIndex } from './adapters/bikeindex.ts';
import { requestJson } from './http.ts';
import { fingerprint } from './store.ts';

/**
 * Builds a local message only after a current human match verdict.
 * @param store Case, snapshot, and verdict history used to enforce eligibility.
 * @param id Observation ID whose object evidence was reviewed.
 * @returns A canonical Bike Index report link and proposed message.
 * @throws For stale evidence, non-match verdicts, or staged/sandbox data.
 * This function does not send or persist a notification.
 */
export function notificationDraft(store: Store, id: number) {
  const { observation, bike } = store.current(id);
  if (observation.verdict !== 'match') {
    throw new Error('Notification requires a current human match verdict');
  }
  if (bike.staged || !bike.bikeIndexId) {
    throw new Error('Staged cases cannot notify Bike Index');
  }
  if (
    observation.listing.source === 'staged' ||
    observation.listing.testData ||
    observation.listing.environment === 'sandbox'
  ) {
    throw new Error('Staged or sandbox listing cannot notify Bike Index');
  }
  return {
    bikeIndexId: bike.bikeIndexId,
    observationId: id,
    reportUrl: `https://bikeindex.org/bikes/${bike.bikeIndexId}`,
    message: `Possible bicycle recovery lead, reviewed by a human. This is not a finding about any seller.\nListing: ${observation.listing.url}\nCaptured: ${observation.capturedAt}\nEvidence: ${observation.notes}\nPlease verify independently through Bike Index.`,
  };
}

/**
 * Sends a verified lead through Bike Index after an authoritative recheck.
 * @param store Persistence used for verdict checks and delivery-attempt history.
 * @param id The reviewed observation to notify about.
 * @param token An appropriately scoped, authorized Bike Index access token.
 * @param fetcher Injectable transport for isolated provider-contract tests.
 * @returns A sent receipt after a successful provider response.
 * @throws For ineligible evidence, duplicate attempts, or provider errors.
 * A failed response can follow actual delivery; such outcomes remain uncertain
 * and must be reconciled manually instead of retried automatically.
 * The CLI separately requires explicit send and application-approval settings.
 */
export async function sendNotification(
  store: Store,
  id: number,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  if (!token) {
    throw new Error(
      'BIKEINDEX_TOKEN with read_user scope and application approval required',
    );
  }
  const draft = notificationDraft(store, id);
  // Check authoritative current status immediately before sending.
  const current = await new BikeIndex(token, fetcher).get(draft.bikeIndexId);
  if (current.status !== 'open') {
    store.putCase(current);
    throw new Error('Bike Index case is no longer stolen; notification blocked');
  }
  if (
    fingerprint(current) !== fingerprint(store.getCase(`bikeindex:${draft.bikeIndexId}`))
  ) {
    store.putCase(current);
    throw new Error('Authoritative case attributes changed; search and review again');
  }
  notificationDraft(store, id); // Recheck after asynchronous request.
  // Reserve the attempt before sending. If the server delivers the message but
  // our connection fails, a later command must not blindly send it again.
  store.transaction(() => {
    const existing = store.db
      .prepare(
        `SELECT n.id FROM notifications n JOIN observations o ON n.observation_id=o.id
      WHERE o.candidate_key=?`,
      )
      .get(store.observation(id).candidateKey);
    if (existing) {
      throw new Error(
        'Notification already attempted; reconcile outcome manually instead of retrying',
      );
    }
    store.db
      .prepare('INSERT INTO notifications(observation_id,state,created_at) VALUES(?,?,?)')
      .run(id, 'pending', new Date().toISOString());
    store.audit('notification_attempt', String(id));
  });
  try {
    await requestJson(
      `https://bikeindex.org/api/v3/bikes/${draft.bikeIndexId}/send_stolen_notification`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ message: draft.message }),
      },
      fetcher,
    );
    store.db
      .prepare('UPDATE notifications SET state=? WHERE observation_id=?')
      .run('sent', id);
    store.audit('notification_sent', String(id));
    return { sent: true, via: 'Bike Index', observationId: id };
  } catch (error) {
    // A timeout can happen after delivery: never automatically retry.
    store.db
      .prepare('UPDATE notifications SET state=? WHERE observation_id=?')
      .run('unknown_or_failed', id);
    store.audit('notification_outcome_uncertain', String(id));
    throw error;
  }
}
