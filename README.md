# Traces: bike matching MVP

Object matching from stolen-bike reports to case-specific listing candidates. Repository: https://github.com/Parado-xy/Traces.

This is a local, single-operator TypeScript CLI. It imports stolen-bike cases from Bike Index, records case-specific listing searches, ranks object similarities with explanations, and records human verdicts. There is no web server or dashboard yet.

## Run it

Install Node.js 24 or newer. Runtime code uses Node's built-in TypeScript support, SQLite, fetch, and test runner; no runtime npm packages are required. Development dependencies provide static type checking.

```sh
npm ci
npm run check
npm test
npm run demo
cp .env.example .env
npm run cli -- init
npm run cli -- ingest --region "Grambling, LA" --distance 100 --limit 2
npm run cli -- cases
```

The default database is `data/trace-shadow.sqlite`. `.env` is loaded by the CLI. `--db /another/path.sqlite` overrides the database. The demo uses an in-memory database and synthetic data, with no network access or notifications. Run commands from this directory.

Start with [the MVP milestones](docs/MILESTONES.md) for current priorities, blockers, and completion criteria.

Read [the implementation guide](docs/IMPLEMENTATION_GUIDE.md) for the reasoning, scoring, architecture, metrics, and limitations. [API notes](docs/API_NOTES.md) record verified upstream requirements. [Build status](docs/BUILD_STATUS.md) distinguishes implemented features from live validation.

## Review a real case using manually found listings

1. Ingest cases and copy an actual ID from the output. The examples below use `bikeindex:3502695`, which was returned by the November 21 live check; it may later be recovered.
2. Inspect its record and photographs.
3. Search permitted sources manually for that particular case. Copy only relevant object listings into a JSON file using `fixtures/manual-listings.example.json` as the format.
4. Record the actual search terms when importing, then inspect the scored queue.

```sh
npm run cli -- show --case bikeindex:3502695
npm run cli -- import-listings --case bikeindex:3502695 --file my-listings.json --query "Ride1Up Portola bicycle"
npm run cli -- queue --case bikeindex:3502695
npm run cli -- review --id 1 --verdict unsure --reviewer Jalla --notes "Model agrees; serial and distinctive marks are not visible."
npm run cli -- time --case bikeindex:3502695 --method assisted --minutes 8
npm run cli -- time --case bikeindex:3502695 --method manual --minutes 15
npm run cli -- metrics --case bikeindex:3502695
```

Use the observation ID returned by your own import, not necessarily `1`. Values in the timing example are illustrative, not measured results. For a meaningful comparison, conduct separate manual and assisted trials with the same task definition.

If a candidate really merits a match verdict after visual inspection and independent evidence checks, record that verdict with evidence notes. A draft is local and does not send anything:

```sh
npm run cli -- notify --id 1
```

Sending requires `--send`, a Bike Index token with `read_user` scope, and `BIKEINDEX_NOTIFY_APPROVED=true` after the application setup is approved (or an authorized own-bike test is arranged). The command rechecks current Bike Index status and attributes, validates the latest verdict, and refuses duplicate attempts for the same case/listing identity. A failed or timed-out send needs manual reconciliation; it is never retried automatically. No real notification was sent during development.

## eBay adapter

Set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` in `.env`. Sandbox is the default. For production, obtain the appropriate eBay access and confirm that this application purpose is permitted before setting `EBAY_ENV=production` and `EBAY_PRODUCTION_APPROVED=true`. That flag records your confirmation; it does not grant provider approval.

```sh
npm run cli -- search --case bikeindex:3502695 --source ebay
```

The adapter obtains a client-credentials token, sends one make/model/bicycle query to the Browse API, limits the response to 25 bicycle-category listings, normalizes object fields, and discards the raw response. There is no crawler, seller index, browser login, or automatic seller contact. Live eBay access has not been exercised because credentials were not supplied. Sandbox listings are test inventory, not real recovery leads.

## Metrics and synthetic benchmark

```sh
npm run cli -- metrics
npm run cli -- benchmark --file fixtures/benchmark.json --threshold 50
npm run cli -- audit
npm run cli -- purge --days 30
```

Real-case metrics count each case/listing identity once, use its latest observation and verdict, exclude staged cases, and show unresolved and stale records. Precision is the share of definitive reviewed candidates marked match. It is provisional human-reviewed precision, not confirmed recovery precision. Rejection fraction is reported separately. Population false-positive and miss rates remain `null` for real cases because their ground truth is unknown.

The five-item synthetic text benchmark intentionally contains a sparse positive and a similar negative. At threshold 50 it produces TP=1, FP=1, TN=2, FN=1. These are mechanics checks, not product performance claims. A photographed owned-object blind test is still required.

## Storage and boundaries

The SQLite file uses owner-only permissions where supported. Retention defaults to 30 days and is enforced whenever the CLI opens the database; there is no background scheduler. Case records expire from their last ingestion, and searches expire from their creation. Associated observations and reviews cascade on deletion. Image URLs are stored, not downloaded images. Ordinary backups and exported files require separate retention handling.

Names and seller/contact fields are excluded from structured schemas, but free text is not automatically redacted. Keep manual descriptions and review notes limited to object evidence. No person search, faces, biometrics, camera integration, hardware, standing marketplace index, or seller messaging is implemented.

The local history is an application audit trail, not cryptographically tamper-proof evidence. Anyone able to edit the SQLite file can edit its contents. Use this version as a learning/research tool for one trusted operator, not a deployed multi-user service.

## Contributing and code readability

Read [AGENTS.md](AGENTS.md) before changing the implementation. Code must be
written for human review: descriptive names, clear spacing, module overviews,
purposeful JSDoc, and comments explaining nontrivial decisions and workflow steps.
The formatting commands make spacing consistent; documentation and naming still
require human judgment.

```sh
npm run format
npm run format:check
npm run check
npm test
```
