/**
 * Transactional SQLite persistence for cases, search snapshots, and human review.
 * Each observation keeps the case snapshot it was scored against. Current actions
 * use fresh evidence, while earlier observations and verdicts remain auditable
 * until retention removes them. This store is for one trusted local operator.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { BikeCase, Listing, Score, Verdict } from './domain.ts';
import { scoreListing } from './score.ts';
import { DATABASE_SCHEMA } from './schema.ts';

/**
 * Hashes case attributes to invalidate reviews after material case changes.
 * The fetch timestamp is excluded so an unchanged refresh does not invalidate evidence.
 */
export const fingerprint = (bike: BikeCase) => {
  const { fetchedAt, ...attributes } = bike;
  return createHash('sha256').update(JSON.stringify(attributes)).digest('hex');
};

/**
 * Supplies UTC timestamps consistently for persistence and retention comparisons.
 */
const now = () => new Date().toISOString();
const encode = JSON.stringify;
/**
 * A listing snapshot with its original case evidence and latest human verdict.
 * Historical review events remain in the reviews table even when this view shows
 * only the latest verdict.
 */
export type Observation = {
  id: number;
  runId: number;
  caseId: string;
  caseFingerprint: string;
  caseSnapshot: BikeCase;
  candidateKey: string;
  listing: Listing;
  score: Score;
  capturedAt: string;
  verdict: Verdict | null;
  reviewer: string | null;
  notes: string | null;
  reviewedAt: string | null;
};

/**
 * Owns the local database and enforces transactional evidence/review rules.
 * Opening a store initializes the schema; retention is invoked by the CLI.
 * The audit is application history, not cryptographically tamper-proof evidence.
 */
export class Store {
  db: DatabaseSync;
  /**
   * Opens SQLite and initializes the schema and indexes.
   * @param path A database filename, or :memory: for isolated tests/demos.
   * Enables foreign-key cascades so retention removes dependent evidence and reviews.
   * On disk, creates the parent directory and restricts database file permissions.
   */
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      chmodSync(path, 0o600);
    }
    // Foreign keys and cascading ownership are defined with the schema so
    // expiration cannot leave orphaned observations or review history behind.
    this.db.exec(DATABASE_SCHEMA);
  }

  /**
   * Closes the SQLite connection after the command or test finishes.
   */
  close() {
    this.db.close();
  }

  /**
   * Runs related writes atomically and rolls them back together on failure.
   * @param fn Synchronous database work; do not pass an async callback.
   * @returns The callback result after a successful commit.
   * @throws The original error after rollback.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Appends a short event and internal entity reference to application history.
   * Do not pass credentials, descriptions, or contact information into this log.
   */
  audit(event: string, entity: string) {
    this.db
      .prepare('INSERT INTO audit(event,entity,created_at) VALUES(?,?,?)')
      .run(event, entity, now());
  }

  /**
   * Inserts or refreshes a normalized case and records the change atomically.
   * Updating the case does not rewrite observations; their fingerprints expose
   * whether the evidence used for an earlier review has become stale.
   */
  putCase(bike: BikeCase) {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
        )
        .run(bike.id, encode(bike), now());
      this.audit('case_upsert', bike.id);
    });
  }

  /**
   * Loads one normalized case by its internal source-qualified ID.
   * @throws If the case does not exist in this store.
   */
  getCase(id: string): BikeCase {
    const row = this.db.prepare('SELECT data FROM cases WHERE id=?').get(id) as any;
    if (!row) {
      throw new Error(`Case not found: ${id}`);
    }
    return JSON.parse(row.data);
  }

  /**
   * Returns all retained cases in stable ID order for inspection and reporting.
   */
  cases(): BikeCase[] {
    return this.db
      .prepare('SELECT data FROM cases ORDER BY id')
      .all()
      .map((row: any) => JSON.parse(row.data));
  }

  /**
   * Loads a case and rejects closed cases before search, review, or notification.
   */
  openCase(id: string) {
    const bike = this.getCase(id);
    if (bike.status !== 'open') {
      throw new Error('Case is closed');
    }
    return bike;
  }

  /**
   * Records a bounded search attempt before asking the external source for data.
   * @param caseId An existing open case.
   * @param source Adapter and environment label used for provenance.
   * @param query The actual query associated with this attempt.
   * @returns The run ID used to complete or fail the attempt.
   */
  startRun(caseId: string, source: string, query: string): number {
    this.openCase(caseId);
    return this.transaction(() => {
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO runs(case_id,source,query,started_at,status) VALUES(?,?,?,?,?)',
          )
          .run(caseId, source, query, now(), 'running').lastInsertRowid,
      );
      this.audit('search_started', String(id));
      return id;
    });
  }

  /**
   * Commits listing snapshots and their score explanations for one running search.
   * Checks that the case did not change while the source request was in flight.
   * Duplicates within a run are collapsed; later runs keep fresh observations.
   * @returns IDs of the observations created by this run.
   * @throws If the run is invalid, closed, or based on stale case attributes.
   */
  finishRun(runId: number, bike: BikeCase, listings: Listing[]): number[] {
    return this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
      if (!run || run.status !== 'running' || run.case_id !== bike.id) {
        throw new Error('Invalid active run');
      }
      const current = this.openCase(bike.id);
      if (fingerprint(current) !== fingerprint(bike)) {
        throw new Error('Case changed during search; rerun');
      }
      // Identity is scoped to the case and source. A repeated result within this
      // response is redundant; the same listing in a later run is fresh evidence.
      const seen = new Set<string>();
      const ids: number[] = [];
      for (const listing of listings) {
        const key = createHash('sha256')
          .update(`${bike.id}\n${listing.source}\n${listing.sourceId}`)
          .digest('hex');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        // Keep both snapshots and the scoring explanation in the same write.
        // Later case refreshes must not rewrite what a reviewer originally saw.
        const id = Number(
          this.db
            .prepare(
              `INSERT INTO observations(run_id,case_id,case_fingerprint,candidate_key,case_snapshot,listing,score,captured_at)
          VALUES(?,?,?,?,?,?,?,?)`,
            )
            .run(
              runId,
              bike.id,
              fingerprint(bike),
              key,
              encode(bike),
              encode(listing),
              encode(scoreListing(bike, listing)),
              listing.capturedAt,
            ).lastInsertRowid,
        );
        ids.push(id);
      }
      this.db
        .prepare('UPDATE runs SET status=?,finished_at=? WHERE id=?')
        .run('completed', now(), runId);
      this.audit('search_completed', String(runId));
      return ids;
    });
  }

  /**
   * Marks a source attempt as failed without storing provider bodies or secrets.
   */
  failRun(id: number) {
    this.db
      .prepare('UPDATE runs SET status=?,finished_at=?,error=? WHERE id=?')
      .run(
        'failed',
        now(),
        'Source request failed; see terminal for sanitized reason',
        id,
      );
    this.audit('search_failed', String(id));
  }

  /**
   * Reads snapshots with the most recent review attached to each one.
   * @param caseId Optional case filter.
   * @param latest When true, returns only the newest snapshot per case/listing identity.
   * Earlier observations are retained and can be requested for history inspection.
   */
  observations(caseId?: string, latest = true): Observation[] {
    // The first subquery attaches the latest verdict, not every historical
    // review. The optional second filter prevents repeated searches from
    // multiplying the current queue while preserving the underlying history.
    const rows = this.db
      .prepare(
        `
          SELECT
            o.*,
            r.verdict,
            r.reviewer,
            r.notes,
            r.created_at AS reviewed_at
          FROM observations o
          LEFT JOIN reviews r ON r.id = (
            SELECT MAX(id)
            FROM reviews
            WHERE observation_id = o.id
          )
          WHERE (? IS NULL OR o.case_id = ?)
          ${
            latest
              ? `AND o.id = (
                  SELECT MAX(newest.id)
                  FROM observations newest
                  WHERE newest.candidate_key = o.candidate_key
                )`
              : ''
          }
          ORDER BY json_extract(o.score, '$.total') DESC, o.id DESC
        `,
      )
      .all(caseId ?? null, caseId ?? null) as any[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      caseId: row.case_id,
      caseFingerprint: row.case_fingerprint,
      candidateKey: row.candidate_key,
      listing: JSON.parse(row.listing),
      score: JSON.parse(row.score),
      capturedAt: row.captured_at,
      caseSnapshot: JSON.parse(row.case_snapshot),
      verdict: row.verdict,
      reviewer: row.reviewer,
      notes: row.notes,
      reviewedAt: row.reviewed_at,
    }));
  }

  /**
   * Finds a retained observation by its numeric ID, including historical snapshots.
   * @throws If that observation no longer exists.
   */
  observation(id: number): Observation {
    const result = this.observations(undefined, false).find(
      (observation) => observation.id === id,
    );
    if (!result) {
      throw new Error(`Observation not found: ${id}`);
    }
    return result;
  }

  /**
   * Checks that an observation still represents actionable current evidence.
   * Rejects closed cases, changed case attributes, and superseded listing snapshots.
   * @returns The eligible observation and its current case.
   * @throws When fresh search/review is required.
   */
  current(id: number): { observation: Observation; bike: BikeCase } {
    const observation = this.observation(id);
    const bike = this.openCase(observation.caseId);
    if (observation.caseFingerprint !== fingerprint(bike)) {
      throw new Error(
        'Case attributes changed; search again before review or notification',
      );
    }
    if (!this.observations(bike.id).some((observation) => observation.id === id)) {
      throw new Error('A newer listing snapshot exists; review that snapshot');
    }
    return { observation, bike };
  }

  /**
   * Appends a human verdict without overwriting earlier assessments.
   * Requires current evidence, a supported verdict, a reviewer, and evidence notes.
   * An unsure verdict remains unresolved; only match can pass the notification gate.
   */
  review(id: number, verdict: Verdict, reviewer: string, notes: string) {
    if (!['match', 'not_match', 'unsure'].includes(verdict)) {
      throw new Error('Verdict must be match, not_match, or unsure');
    }
    if (!reviewer.trim() || !notes.trim()) {
      throw new Error('Reviewer and evidence notes are required');
    }
    this.transaction(() => {
      this.current(id);
      this.db
        .prepare(
          'INSERT INTO reviews(observation_id,verdict,reviewer,notes,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          id,
          verdict,
          reviewer.trim().slice(0, 100),
          notes.trim().slice(0, 5000),
          now(),
        );
      this.audit(`verdict_${verdict}`, String(id));
    });
  }

  /**
   * Records operator-reported active minutes for a manual or assisted case trial.
   * Validates the method and duration; it does not infer time from CLI wall-clock gaps.
   */
  time(caseId: string, method: string, minutes: number) {
    this.getCase(caseId);
    if (
      !['manual', 'assisted'].includes(method) ||
      !Number.isFinite(minutes) ||
      minutes <= 0 ||
      minutes > 1440
    ) {
      throw new Error('Use manual/assisted and minutes >0 and <=1440');
    }
    this.db
      .prepare(
        'INSERT INTO work_sessions(case_id,method,minutes,created_at) VALUES(?,?,?,?)',
      )
      .run(caseId, method, minutes, now());
    this.audit('time_recorded', caseId);
  }

  /**
   * Reports current real-case candidate counts, judgments, and recorded work time.
   * Uses only latest observations/verdicts and excludes staged/sandbox inventory.
   * Reviewed rejection fraction is not population FPR. FPR and miss rate stay null
   * because real cases do not supply a labeled universe of positives and negatives.
   */
  metrics(caseId?: string) {
    // First select the real population; demo cases and sandbox candidates must
    // never make the tool appear more effective on real recovery work.
    const selected = this.cases().filter(
      (bike) => (!caseId || bike.id === caseId) && !bike.staged,
    );
    const ids = new Set(selected.map((bike) => bike.id));
    const candidates = this.observations(caseId).filter(
      (observation) => ids.has(observation.caseId) && !observation.listing.testData,
    );
    // A verdict based on older case attributes is not a current assessment.
    // Keep stale counts visible rather than quietly treating them as reviewed.
    const current = candidates.filter(
      (observation) =>
        observation.caseFingerprint === fingerprint(this.getCase(observation.caseId)),
    );
    const matches = current.filter(
      (observation) => observation.verdict === 'match',
    ).length;
    const rejected = current.filter(
      (observation) => observation.verdict === 'not_match',
    ).length;
    const sessions = this.db.prepare('SELECT * FROM work_sessions').all() as any[];
    const perCase = selected.map((bike) => {
      /**
       * Totals recorded sessions for one case and method.
       * Returns null, rather than zero, when no time measurement was recorded.
       */
      const sum = (method: string) => {
        const rows = sessions.filter(
          (session) => session.case_id === bike.id && session.method === method,
        );
        return rows.length
          ? rows.reduce((total, session) => total + session.minutes, 0)
          : null;
      };
      const assisted = sum('assisted');
      const manual = sum('manual');
      return {
        caseId: bike.id,
        candidates: candidates.filter((observation) => observation.caseId === bike.id)
          .length,
        assistedMinutes: assisted,
        manualMinutes: manual,
        minutesSaved: assisted !== null && manual !== null ? manual - assisted : null,
      };
    });
    return {
      population:
        'real cases only; latest listing snapshot and latest verdict; staged data excluded',
      cases: selected.length,
      candidates: candidates.length,
      candidatesPerCase: selected.length ? candidates.length / selected.length : null,
      matches,
      rejected,
      unsure: current.filter((observation) => observation.verdict === 'unsure').length,
      unreviewed: current.filter((observation) => !observation.verdict).length,
      stale: candidates.length - current.length,
      reviewedPrecision: matches + rejected ? matches / (matches + rejected) : null,
      reviewedRejectionFraction:
        matches + rejected ? rejected / (matches + rejected) : null,
      falsePositiveRate: null,
      missRate: null,
      limitation:
        'Verdicts are human judgments, not confirmed recovery. Rejection fraction is NOT population FPR. FPR and miss rate require labeled benchmark negatives/positives.',
      perCase,
    };
  }

  /**
   * Deletes expired data and its dependent snapshots/reviews, then compacts SQLite.
   * @param days Retention window from 1 through 365 days.
   * @param asOf Reference time; tests inject a future date to exercise expiration.
   * @returns Counts of cases and remaining standalone runs removed.
   * Retention runs only when invoked; backups and exports are outside this purge.
   */
  purge(days: number, asOf = new Date()): { cases: number; runs: number } {
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error('Retention must be 1..365 days');
    }
    const cutoff = new Date(asOf.getTime() - days * 86400000).toISOString();
    // Case deletion cascades first; the run count below covers additional
    // expired searches belonging to cases that are still retained.
    const result = this.transaction(() => {
      const cases = Number(
        this.db.prepare('DELETE FROM cases WHERE updated_at<?').run(cutoff).changes,
      );
      const runs = Number(
        this.db.prepare('DELETE FROM runs WHERE started_at<?').run(cutoff).changes,
      );
      this.db.prepare('DELETE FROM work_sessions WHERE created_at<?').run(cutoff);
      this.db.prepare('DELETE FROM audit WHERE created_at<?').run(cutoff);
      this.audit('retention_purge', `${cases} cases; ${runs} runs`);
      return { cases, runs };
    });
    this.db.exec('VACUUM');
    return result;
  }
}
