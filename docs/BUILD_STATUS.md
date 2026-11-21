# Build status: November 21, 2026

This is an implemented, runnable first slice. It is not a fully validated recovery service.

| Milestone | Implemented | Validation / outstanding work |
| --- | --- | --- |
| M0: skeleton | TypeScript project, local SQLite schema, configuration, README, API notes, tests | Project named Traces; initial source prepared for Parado-xy/Traces |
| M1: ingestion | Regional Bike Index search, detail reads, normalized cases, record inspection, refresh | Live ingestion succeeded for two cases within 100 miles of Grambling, LA |
| M2: first search source | eBay OAuth and Browse adapter; case-specific query, object whitelist, scoring and provenance | HTTP contract tested with mocks; no supplied credentials, so live sandbox/production integration is unverified |
| M3: review and metrics | Append-only verdicts, current-evidence checks, real-case metrics, manual timing, retention and audit | Tested locally; no genuine candidate verdicts or measured field precision/time savings yet |
| M3: notification | Bike Index sender, local draft default, explicit send, authoritative recheck, duplicate-attempt guard | Mocked tests only; provider-approved/authorized own-bike integration test remains outstanding; no real messages sent |
| M4: second source and ground truth | Manual listing entry from permitted sources; synthetic labeled text benchmark runner | No second automated source; no photographed owned-object blind test; no image similarity |

## Observed validation

- Static TypeScript checking passed.
- 22 automated tests passed, covering scoring, conflicts, provenance whitelisting, review history, stale snapshots, changed cases, retention, real/synthetic metric separation, OAuth request construction, rate-limit handling, notification gating, duplicate prevention, recovered cases, sandbox data exclusion, and uncertain send outcomes.
- `npm run demo` completed without network access in an in-memory database.
- Live command: `ingest --region "Grambling, LA" --distance 100 --limit 2` succeeded.
- Returned source IDs: `bikeindex:3502695` (Ride1Up Portola; Ruston, LA) and `bikeindex:3486678` (Mongoose standoff; Natchez, MS). These are source records, not recovery leads or verified matches.
- Case inspection and empty real-case metrics were checked after ingestion. No listings were collected from real marketplaces and no sellers were contacted.
- Synthetic threshold-50 confusion counts: TP=1, FP=1, TN=2, FN=1. These show mechanics and intentional failure cases, not production quality.

## Release boundaries

Source archive excludes credentials, node_modules, local SQLite data, and git internals. Running ingestion obtains fresh real data rather than shipping a stale theft status. `npm ci` restores development tools from the lockfile; runtime code itself has no external packages.

Sandbox eBay inventory is explicitly marked as test data, excluded from real-case candidate metrics, and blocked from notifying owners. Bike Index records marked `test_bike` are treated as staged. Unknown notification outcomes require manual reconciliation; there is no automatic retry.

This version has no hosted service, dashboard, user accounts, camera stream, image embedding model, geographic score, full marketplace description fetch, automated polling, or tamper-evident audit. Retention executes when the CLI runs, not while it is idle. Read the implementation guide before interpreting the metrics.
