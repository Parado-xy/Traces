# Local review workspace

The W1 interface is a browser UI over the same SQLite store and matching rules as
the CLI. It is designed for one operator on one computer. It does not deploy a
public service, send notifications, or automatically fetch pasted listing URLs.

## Start with real case data

Use Node 24 or newer and run these commands from the repository root:

```sh
npm ci
npm run review
```

Open `http://127.0.0.1:4317/` in the browser on that computer. The default database
is `data/trace-shadow.sqlite`, shared with the CLI. Existing `.env` settings and
`TRACE_DB` are respected. You can choose a separate database or port explicitly:

```sh
npm run review -- --db data/pilot.sqlite --port 4318
```

The server binds only loopback. A phone on the same Wi-Fi cannot connect to this
address; multi-device hosting and account access are separate future decisions.
Do not expose this server as a public application.

## Try the practice workspace

```sh
npm run review:demo
```

Practice mode uses an isolated in-memory database, even if `.env` points to a real
database. It includes an ordinary open case, a changed case with stale evidence,
a closed case, and repeated listing snapshots. Practice illustrations are not
photographs or proof of image-matching performance. Reviews can be exercised, but
practice records never enter real-case metrics or owner notifications. Real
Bike Index import and refresh are disabled in practice mode. Stopping the server
discards practice changes.

`npm run dev` also starts practice mode for local preview tooling. It accepts
`--host 127.0.0.1 --port 4173 --strictPort`; non-loopback host requests are rejected.

## Review workflow

1. **Import cases.** Choose a region, radius and small case limit. This triggers
   bounded, read-only Bike Index API calls. If no reports are found, change the
   region explicitly rather than assuming an empty list means import failed.
2. **Choose a case.** Its current identity and status appear above the workspace.
   Case search filters make, model, location and source ID.
3. **Add a candidate.** Enter the actual query used, listing URL, title and object
   details. Structured make/model/color/serial fields are optional, as are image
   URLs. Keep seller names, contact details and unrelated personal data out of
   descriptions and notes. Image upload and automatic webpage extraction are not
   part of this milestone.
4. **Compare evidence.** The left card shows the original case snapshot used by
   the scorer; the right shows the captured listing. Previous/next controls let
   you inspect multiple images. Missing or failed images have visible fallback
   messages. Source links open separately with no referrer.
5. **Inspect the explanation.** Each attribute has earned/possible points,
   evidence state and explanation. Conflicts are explicit. The score is a ranking
   aid, not a probability that the item is stolen.
6. **Inspect provenance.** Source/query, capture time, scoring version and listing
   URL remain visible. Select an earlier listing snapshot to inspect its own
   case evidence and reviews. A disclosure shows original and current case data.
7. **Save a verdict.** Choose match, not a match, or unsure; enter reviewer and
   evidence notes. The new assessment is appended to history. Draft notes survive
   candidate navigation in that browser tab's memory, but only saved verdicts
   persist across reloads. Saving a verdict never sends a notification.
8. **Record active time.** Case metrics accepts assisted and manual-baseline
   minutes and shows the stored sessions. Compare like-for-like trials; browser
   wall-clock time and idle periods are not automatically counted as work.

## Current evidence and review blocks

Both the UI and server enforce the review boundary. Disabled controls are not
the security or verification mechanism; the server calls `Store.review` and its
current-evidence checks for every submitted verdict.

- Closed cases remain inspectable but cannot receive new candidates or verdicts.
- When a report's attributes change, earlier observations remain visible but
  require a fresh candidate snapshot before review.
- When a listing has a newer observation, earlier snapshots are historical only.
- Refreshing a real report can reveal that it is closed or changed.
- Sandbox and staged records are clearly marked and excluded from real-case
  evaluation, even though their review workflow can be exercised.

The UI has no notification-sending endpoint. The existing CLI's human-gated
notification workflow and its provider authorization requirements remain separate.

## Measurements

The interface distinguishes raw queue counts from real-case evaluation. A real
case can show sandbox candidates for inspection while excluding them from real
precision calculations. An empty precision denominator is shown as a dash, not
zero. Practice work is labeled and its real precision remains unavailable.

The report presents current-snapshot human-reviewed precision and active-time
records. Population false-positive and miss rates still require the labeled W4
experiment; this UI does not manufacture those rates from rejected candidates.

## Code map

| File | Responsibility |
| --- | --- |
| `src/review/start.ts` | Configuration, loopback binding, real/practice store lifetime |
| `src/review/service.ts` | Case read models, manual import, review and time operations |
| `src/review/server.ts` | Explicit routes, bounded JSON bodies, local session/origin checks, asset allowlist |
| `src/review/demo.ts` | Isolated synthetic records and stale/closed examples |
| `src/store.ts` | Shared transactions, scoring history, current-evidence enforcement, metrics |
| `web/index.html` | Accessible page shell, dialogs, forms and tabs |
| `web/app.js` | Safe DOM rendering, comparison, gallery, forms and navigation |
| `web/style.css` | Responsive layout and evidence/status presentation |
| `tests/review.test.ts` | Application and HTTP integration checks, including persistence |

Browser code assigns untrusted text through `textContent`, not HTML injection.
Remote images load directly in the operator's browser without a referrer; the
server is not an image proxy. Credentials and the database are outside the asset
allowlist. Successful UI operations return JSON read models; errors are visible
instead of silently ignored.

Retention runs at startup and is checked again on active API use at most hourly.
There is no idle background retention process. Existing CLI retention remains in
place. Backups, exports and manually entered external references need separate
handling; the database audit is not tamper-proof.

## Validation record

- Formatting and TypeScript checks, JavaScript syntax validation, and 31 automated
  tests passed during W1 implementation.
- Service/API tests cover normalized candidate import, stored query provenance,
  append-only verdicts, snapshot history, changed and closed case rejection,
  stale-browser form rejection, persistence after reopening SQLite, real/practice
  metric separation, and missing-token/cross-origin request rejection.
- Desktop browser checks exercised case selection, photo navigation, manual
  candidate entry, verdict saving/history, historical-snapshot review blocking,
  changed/closed evidence, and active-time recording.
- Responsive breakpoints are implemented. A narrow device viewport was not
  visually validated because the available browser interface did not expose a
  viewport-resize operation. Desktop behavior was checked in the live browser.
- Actual eBay access, authorized Bike Index notification testing, field precision
  and active-time improvements are still separate outstanding milestones.

For a trusted preview proxy, an exact `TRACES_REVIEW_PREVIEW_ORIGIN` can be set
explicitly. It is not needed for normal loopback use and is not permission to
turn this single-operator server into a hosted product.
