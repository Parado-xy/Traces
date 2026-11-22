/**
 * Application operations used by the local review interface.
 *
 * HTTP and browser code do not reimplement scoring or verification policy. This
 * service normalizes manual input and delegates writes to the same Store methods
 * as the CLI. Its read models add provenance and clear blocked-review reasons.
 */
import type { BikeCase, Verdict } from '../domain.ts';
import { parseListing, text } from '../domain.ts';
import { Store, fingerprint } from '../store.ts';
import type { Observation } from '../store.ts';
import { BikeIndex } from '../adapters/bikeindex.ts';

/** A provider dependency that tests can replace without contacting Bike Index. */
export type CaseProvider = Pick<BikeIndex, 'get' | 'search'>;

/** Describes why a snapshot is eligible or blocked without hiding older evidence. */
export type ReviewEligibility = { reviewable: boolean; blockReason: string | null };

/**
 * Supplies case-specific read models and mutations for one trusted operator.
 * @param store The shared persistent store; its owner closes it on shutdown.
 * @param provider Official case reads, injected for provider-isolated tests.
 * @param practice Whether this workspace contains synthetic demonstration data.
 */
export class ReviewService {
  readonly store: Store;
  readonly provider: CaseProvider;
  readonly practice: boolean;

  /** Stores dependencies explicitly so Node's native TypeScript stripping can run this class. */
  constructor(
    store: Store,
    provider: CaseProvider = new BikeIndex(process.env.BIKEINDEX_TOKEN),
    practice = false,
  ) {
    this.store = store;
    this.provider = provider;
    this.practice = practice;
  }

  /** Lists cases with their latest candidate counts and review progress. */
  cases() {
    return this.store.cases().map((bike) => {
      const candidates = this.store.observations(bike.id);
      return {
        ...bike,
        candidateCount: candidates.length,
        needsReview: candidates.filter(
          (item) => !item.verdict || item.verdict === 'unsure',
        ).length,
      };
    });
  }

  /**
   * Returns the current case, ranked queue, honest metrics, and active-time records.
   * Historical case snapshots remain on each observation, separate from this case.
   */
  caseDetail(caseId: string) {
    const bike = this.store.getCase(caseId);
    return {
      bike,
      fingerprint: fingerprint(bike),
      candidates: this.store.observations(caseId).map((item) => ({
        ...item,
        ...this.eligibility(item),
      })),
      metrics: this.store.metrics(caseId),
      sessions: this.store.workSessions(caseId),
    };
  }

  /**
   * Returns a particular snapshot and its append-only verdict history.
   * The search run supplies the actual source/query, not a reconstructed query.
   */
  observationDetail(id: number) {
    const observation = this.store.observation(id);
    return {
      ...observation,
      ...this.eligibility(observation),
      run: this.store.searchRun(observation.runId),
      reviews: this.store.reviewHistory(id),
      snapshots: this.store
        .observations(observation.caseId, false)
        .filter((item) => item.candidateKey === observation.candidateKey)
        .map((item) => ({
          id: item.id,
          capturedAt: item.capturedAt,
          verdict: item.verdict,
          ...this.eligibility(item),
        })),
    };
  }

  /**
   * Imports one manually inspected listing for an open case and scores it.
   * @throws If the case changed since the browser loaded it or input is invalid.
   * Normalization completes before starting a run; the pasted URL is never fetched.
   */
  addCandidate(caseId: string, input: any) {
    const bike = this.store.openCase(caseId);
    if (input.caseFingerprint !== fingerprint(bike)) {
      throw new Error('Case changed. Reload the case before adding a candidate.');
    }

    const query = text(input.query, 500);
    if (!query) {
      throw new Error('Record the search terms used to find this candidate.');
    }

    // The source is chosen from the case, not trusted from submitted JSON.
    // A user cannot turn a staged listing into real evidence through this form.
    const listing = parseListing(input.listing, bike.staged ? 'staged' : 'manual');
    const runId = this.store.startRun(bike.id, 'manual', query);
    try {
      const [observationId] = this.store.finishRun(runId, bike, [listing]);
      return { observationId, runId };
    } catch (error) {
      this.store.failRun(runId);
      throw error;
    }
  }

  /** Saves a verdict through the authoritative current-evidence gate in Store. */
  review(id: number, input: any) {
    this.store.review(
      id,
      text(input.verdict) as Verdict,
      text(input.reviewer, 100),
      text(input.notes),
    );
    return this.observationDetail(id);
  }

  /** Records operator-reported active minutes; never infers them from idle time. */
  recordTime(caseId: string, input: any) {
    const minutes = Number(input.minutes);
    this.store.time(caseId, text(input.method), minutes);
    return this.caseDetail(caseId);
  }

  /**
   * Pulls a bounded regional batch from Bike Index after an explicit user action.
   * Practice workspaces reject real ingestion to keep the two populations apart.
   */
  async ingest(input: any) {
    this.assertRealWorkspace();
    const bikes = await this.provider.search(
      text(input.region, 300),
      Number(input.distance),
      Number(input.limit),
    );
    for (const bike of bikes) {
      this.store.putCase(bike);
    }
    return { ingested: bikes.length, cases: this.cases() };
  }

  /** Refreshes a real report; existing verdicts become stale if attributes change. */
  async refresh(caseId: string) {
    this.assertRealWorkspace();
    const bike = this.store.getCase(caseId);
    if (bike.staged || !bike.bikeIndexId) {
      throw new Error('Practice cases cannot refresh from Bike Index.');
    }
    this.store.putCase(await this.provider.get(bike.bikeIndexId));
    return this.caseDetail(caseId);
  }

  /** Converts the store's action guard into a visible reason in the review UI. */
  private eligibility(observation: Observation): ReviewEligibility {
    try {
      this.store.current(observation.id);
      return { reviewable: true, blockReason: null };
    } catch (error) {
      return {
        reviewable: false,
        blockReason:
          error instanceof Error ? error.message : 'Evidence cannot be reviewed.',
      };
    }
  }

  /** Prevents accidental mixing of demonstration cases and real provider calls. */
  private assertRealWorkspace() {
    if (this.practice) {
      throw new Error(
        'Practice workspace: restart with npm run review to use real cases.',
      );
    }
  }
}
