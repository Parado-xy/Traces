# Live integration test plan

Updated November 22, 2026. This guide separates successful configuration, actual
provider requests, candidate retrieval, human verification and message delivery.
A mocked test or an HTTP 200 is not evidence that a stolen bicycle was found.

## Observed results in the development workspace

| Check | Outcome | Evidence / remaining input |
| --- | --- | --- |
| Bike Index regional search | Passed live | Grambling, LA; 100-mile radius; one-case limit |
| Bike Index detail / normalization / persistence | Passed live | `bikeindex:3502695`, open at check time; three photo references; saved fingerprint agreed |
| eBay configuration | Blocked before HTTP | `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` are not configured here |
| eBay live sandbox query | Not run | Needs the matching sandbox keyset and known test inventory |
| eBay production query | Not run | Needs production access and confirmation of this recovery use case |
| Bike Index notification preflight | Not run on a real lead | No current genuine human-match verdict and no token/test recipient setup supplied |
| Bike Index notification delivery | Not run | Requires controlled authorization, scoped token and explicit send |
| Automated checks | 39 passed | Includes provider-isolated data-flow, secret-redaction, empty-result and no-send preflight checks |

The live Bike Index read completed at `2026-11-22T22:17:50.348Z` (16:17 CT). No
marketplace candidate was verified and no notification was sent. Source status
can change; this timestamp is a test observation, not a permanent theft assertion.

## Test stages

| Stage | Sends requests to | Mutates external data? | Pass condition |
| --- | --- | --- | --- |
| `status` | Nobody | No | Shows setup flags and missing configuration without secrets |
| `bikeindex-read` | Official Bike Index search/detail endpoints | No | Current open report normalizes, saves and reads back correctly |
| `ebay-search`, sandbox | eBay sandbox token and Browse endpoints | Token issuance only; no listing creation or seller contact | Query works and known test inventory reaches a staged review queue |
| `ebay-search`, production | Official eBay production token and Browse endpoints | Token issuance only; no seller contact | Permitted real query produces inspectable candidates and provenance |
| `notification-check` | Bike Index detail endpoint after local verification | No | Existing human match still agrees with current authoritative case; draft inspected |
| Existing CLI `notify --send` | Bike Index stolen-notification endpoint | Yes: message to the case owner | Intended authorized recipient receives the expected message once |

## Local configuration

Run commands from the repository root with Node 24+. If you do not already have
`.env`, copy `.env.example` and edit it locally. Never overwrite an existing
secret file merely to reset test settings. Do not paste keys into chat, command
arguments, screenshots, commits or test reports.

```sh
npm ci
npm run integration -- status
```

For sandbox search, configure the **sandbox** eBay application keyset:

```dotenv
EBAY_ENV=sandbox
EBAY_CLIENT_ID=your-sandbox-app-id
EBAY_CLIENT_SECRET=your-sandbox-cert-id-or-client-secret
EBAY_PRODUCTION_APPROVED=false
BIKEINDEX_NOTIFY_APPROVED=false
```

The client ID is the eBay application ID and the client secret is the associated
secret, not the developer account password or a user access token. Keep sandbox
and production keysets matched to their API environment. Traces obtains the
application token through the client-credentials exchange.

The test runner defaults to `data/integration.sqlite`, separate from the ordinary
review database. `--db PATH` overrides it. The environment file is shared with
the CLI, but the test database selection is explicit and does not silently reuse
`TRACE_DB`. Local test records/logs under `data/` are ignored by Git.

`readyToAttemptSearch` in `status` means required settings are present. It does
not validate a token or prove that eBay approved the application purpose.

## A. Repeat the live Bike Index intake check

```sh
npm run integration -- bikeindex-read --region "Grambling, LA" --distance 100 --limit 1
npm run review -- --db data/integration.sqlite
```

Inspect the imported case at `http://127.0.0.1:4317/`. Confirm the record, source
link and photographs are inspectable. Stop another review server first or choose
a different `--port`. No Bike Index token is needed for the public reads used in
this check. A successful empty regional search reports connectivity success but
not a case round-trip success; use a documented alternate region if appropriate.

## B. Exercise eBay sandbox end to end

Use a known sandbox listing whose object details match the synthetic case
(make Trek, model FX 3, title such as “Blue Trek FX 3 bicycle”). Create test
inventory through eBay's supported sandbox tools in your own authorized sandbox
account; this repository does not create listings or users. No real seller or
real stolen-bike report is needed for this stage.

```sh
npm run integration -- ebay-search
```

Without `--case`, sandbox mode uses the clearly staged case from the supplied
text fixture. The adapter allows staged input in sandbox only. The query is
still case-led; there is no arbitrary marketplace crawl.

If you have the exact Browse `itemId` for your controlled listing:

```sh
npm run integration -- ebay-search --expect-item 'v1|YOUR_SANDBOX_ITEM_ID|0'
```

Use the exact ID returned by Browse, not a guessed numeric page ID. The command
reports `knownItemFound`; an explicit expectation that is not met exits nonzero.
A query with zero results can prove authentication/search transport but cannot
prove candidate normalization, scoring or retrieval of known inventory.

Open the integration database in the review interface and inspect the query,
source, image references, ranking explanation and snapshot. Save an unsure or
other deliberate practice verdict. Sandbox/staged data remains excluded from
real-case evaluation and cannot notify an owner, regardless of its score.

## C. Production eBay test requires provider confirmation

Official developer support describes buying/selling applications as the API's
intended use and says other uses are typically not permitted. Buy API documents
also describe production-access eligibility. An API key that returns a token
is therefore not enough to establish permission for Traces' recovery use case.

Ask eBay to confirm this exact purpose before enabling production. A draft to
adapt through their support channel (not sent by this project):

> We are testing a case-led stolen-bicycle recovery tool. For a specific open
> owner-reported Bike Index case, it would query bicycle listings through Browse,
> compare object attributes, retain relevant candidate provenance for limited
> human review, and avoid seller profiling or seller contact. Is this use
> permitted under our API access, and what approval and retention requirements
> apply?

After appropriate access and purpose confirmation, configure the production
keyset, `EBAY_ENV=production` and `EBAY_PRODUCTION_APPROVED=true`. That setting
records the operator's confirmation; it does not grant provider permission.
Then choose an actual open report from the integration database:

```sh
npm run integration -- ebay-search --case bikeindex:ACTUAL_OPEN_REPORT_ID
```

Production refuses an omitted or staged case. Review actual candidates and
record genuine judgments. A positive ranking or a scripted assertion is not a
human match. Keep counts and active minutes for the later W3 field pilot.

## D. Bike Index notification preflight: no sending

A notification begins with a genuine, current human match verdict. Do not mark
an arbitrary candidate as a match just to test the sender on someone else's
report. The code intentionally rejects staged and sandbox evidence.

For the observation that actually qualifies:

```sh
npm run integration -- notification-check --db data/integration.sqlite --id YOUR_OBSERVATION_ID
```

This checks the current-verdict gate, fetches the authoritative report, compares
attributes, and returns the exact proposed message and report ID. It has no send
option and creates no notification attempt. Missing credentials remain visible
as missing; public detail-read success does not validate `read_user` scope.

For an owned/provider-controlled notification exercise, agree the case and
recipient with Bike Index first. The documented unapproved-app exception is a
notification to an actually stolen bike owned by the authenticated user. If that
does not describe an available test case, ask for a sanctioned test arrangement.
Do not mark an ordinary owned bike stolen, change test flags to evade guards, or
use another owner's report as a convenient endpoint test. Keep controlled
notification experiments in a separate test database rather than a pilot dataset.

A draft for Bike Index support (not sent):

> We have integrated public case search/detail reads and a human-gated
> send_stolen_notification sender. We would like approval and a controlled
> end-to-end notification test. What sanctioned case/recipient setup should we
> use without creating a false public theft report? Our client never contacts
> sellers and does not send messages on a score alone.

## E. Explicit notification delivery test

The endpoint requires a user OAuth token with `read_user` scope and the approved
application or eligible authorized owned-bike setup. Configure `BIKEINDEX_TOKEN`
locally. Set `BIKEINDEX_NOTIFY_APPROVED=true` only when that setup is actually
established. This is an operator attestation, not an OAuth scope or provider grant.

After the exact case, recipient and message have been inspected and the test is
authorized, the existing CLI performs the deliberate send:

```sh
npm run cli -- notify --db PATH_TO_AUTHORIZED_TEST_DATABASE --id VERIFIED_OBSERVATION_ID --send
```

The runner does not execute this command for you. The sender rechecks current
case status/attributes, reserves one attempt, and calls only Bike Index. Verify
receipt with the intended recipient. A successful API response records provider
acceptance, not proof that the person read the message. If delivery times out or
the response is uncertain, reconcile the outcome manually; do not retry blindly.
No automated token refresh or interactive OAuth enrollment is implemented here;
expired/missing credentials must be resolved through the provider setup.

## Interpreting failures

| Outcome | Interpretation / next step |
| --- | --- |
| Missing key/token configuration | No live request was attempted for that gated operation; finish local setup |
| `invalid_client` | Check matching environment/keyset and credentials; diagnostics never echo the secret |
| `invalid_scope` / `unauthorized_client` | Check the application's permitted API/scopes and access with the provider |
| HTTP 403 | A real provider access/policy issue to investigate; do not bypass it with scraping |
| HTTP 429 | Rate limit; stop and honor provider limits; no automatic retry |
| Empty successful search | Transport works; known-item/candidate data flow is not yet validated |
| Malformed or empty token response | Fail closed; do not continue with missing authorization |
| Changed/closed case or historical snapshot | Refresh case evidence, repeat the case-led search and review |
| `unknown_or_failed` notification | Delivery may have occurred; manually reconcile before any further action |

## Record evidence without leaking credentials

For each stage retain timestamp, provider environment, exact query or source
case ID, run/observation IDs, counts, pass/fail and the remaining limitation. Do
not retain tokens, Basic headers, raw seller responses or private account details
in a shared report. Local JSON output can be captured under ignored `data/`.
Sanitized OAuth identifiers and numeric provider error IDs are sufficient for
most first-pass debugging; raw error descriptions are deliberately omitted.

Update `MILESTONES.md` only for the stage actually validated. W2 is not complete
until permitted production retrieval works. W5 is not complete until authorized
notification delivery has been observed. These checks do not establish field
precision, recall, recovery rate or time savings.

## Official references checked November 22, 2026

- Bike Index endpoint and scope definitions: https://bikeindex.org/api/v3/swagger_doc/bikes
- Bike Index user/bike read scopes: https://bikeindex.org/api/v3/swagger_doc/me
- eBay sandbox: https://developer.ebay.com/api-docs/sandbox-environment.html
- eBay OAuth: https://developer.ebay.com/api-docs/static/oauth-client-credentials-grant.html
- eBay permitted-use guidance: https://developer.ebay.com/support/developer-account-support
- eBay Buy API eligibility: https://developer.ebay.com/api-docs/buy/static/buy-requirements.html
