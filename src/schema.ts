/**
 * SQLite schema for the single-operator case review workflow.
 *
 * Ownership follows case -> search run -> observation -> review/notification.
 * Cascading foreign keys ensure retention removes dependent evidence together.
 * JSON columns preserve normalized domain snapshots; indexed relational columns
 * support queue selection and current-evidence checks.
 */

/**
 * Initializes tables and indexes without changing existing records.
 * This is the initial schema, not a migration runner. Future structural changes
 * must provide an explicit migration rather than rely on CREATE IF NOT EXISTS.
 */
export const DATABASE_SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;

  -- A case is the root of all retained search and review evidence.
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Store failed attempts too, so an empty queue is not confused with a search
  -- that never completed successfully.
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    query TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    error TEXT
  );

  -- Each result keeps the exact case/listing snapshots used by the scorer.
  -- candidate_key groups repeated sightings of the same case/listing identity.
  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    case_fingerprint TEXT NOT NULL,
    candidate_key TEXT NOT NULL,
    case_snapshot TEXT NOT NULL,
    listing TEXT NOT NULL,
    score TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS observation_case
    ON observations(case_id, candidate_key, id);

  -- Verdicts are appended. The queue joins the latest review for each snapshot.
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK(verdict IN ('match', 'not_match', 'unsure')),
    reviewer TEXT NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS work_sessions (
    id INTEGER PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    method TEXT NOT NULL CHECK(method IN ('assisted', 'manual')),
    minutes REAL NOT NULL CHECK(minutes > 0),
    created_at TEXT NOT NULL
  );

  -- An attempt is recorded before sending; uncertain delivery is not retried.
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Audit entries contain short internal references rather than copied payloads.
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    event TEXT NOT NULL,
    entity TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  PRAGMA user_version = 1;
`;
