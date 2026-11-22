# Traces milestones

Last updated: November 21, 2026 (America/Chicago).

This is the active roadmap for MVP 1: stolen-asset tracking, starting with bikes.
Use it to resume work and determine what is actually complete. A feature being
implemented does not mean its provider integration or field performance is validated.

## Objective and scope

Complete this loop for a specific open bicycle case:

1. Ingest the owner's public Bike Index report.
2. Search permitted listing sources for that case.
3. Rank object candidates with explainable evidence and provenance.
4. Let a human inspect the evidence and record a verdict.
5. Measure candidate quality and active time per case.
6. Notify through Bike Index only after human verification.

The broader product connects physical object traces with online shadows. Bikes
are the first proving ground, not a permanent restriction on the platform.
Camera streaming and object detection belong to MVP 2, after this workflow works.

## Current position

The repository has a working local TypeScript CLI and SQLite store. The core
workflow is implemented; live marketplace integration and useful field results
remain unproven. The latest completed work is the readability/documentation pass.

| Capability | Current evidence | Remaining gap |
| --- | --- | --- |
| Bike Index ingestion | Two real cases imported within 100 miles of Grambling; detail inspection and refresh implemented | Small pilot beyond the initial read-only check |
| Candidate search | eBay adapter with mocked HTTP tests; manual object-only imports | Actual eBay sandbox and production integration |
| Text scoring | Attribute explanations, fixed weights, visible conflicts | Realistic evaluation and calibration |
| Review | Verdict history, notes, stale-evidence checks | Convenient side-by-side visual workflow |
| Metrics | Candidate counts, provisional reviewed precision, recorded work time | Actual human review sessions and measured time comparisons |
| Notification | Local drafts and gated sender; mocked delivery tests | Authorized owned-bike integration test |
| Ground truth | Synthetic text benchmark with deliberate false positive and miss | Photographed owned-object blind experiment |
| Engineering | Formatting/type checks and 22 tests passed at the last code revision | Continue the standards in AGENTS.md for every change |

No genuine recovery lead or recovery has been demonstrated. No seller has been
contacted and no real notification has been sent during development. Image URLs
are retained for inspection; image similarity is not implemented.

## Original milestone IDs

Keep the brief's IDs so earlier notes remain interpretable. The work packages
below refine these milestones; they do not silently redefine completion.

| Original milestone | State | Completion condition |
| --- | --- | --- |
| M0: repository and skeleton | Complete | Repository, configuration, README, API notes, documented code and runnable checks exist |
| M1: case ingestion | Initial implementation and live check complete | Regional ingestion produces inspectable real case records; broaden through the pilot |
| M2: one source end to end | Implemented, live validation pending | A permitted production eBay search populates scored candidates with provenance in the review queue |
| M3: verification, metrics, notification | Implemented, live validation pending | Real review sessions produce honest metrics; notification path passes an authorized owned-bike integration test |
| M4: second source and staged ground truth | Partial foundation only | A permitted second source supplies case-led candidates, and a labeled staged experiment reports precision, FPR and misses |

## Next work packages, in order

### W1: Local review interface

**Status:** Next coding task. **Advances:** M2/M3.

Build a small local interface over the existing store and matcher. It must make
human evaluation practical without depending on eBay credentials.

- [ ] List ingested cases and their review queues.
- [ ] Show case and candidate photographs side by side with accessible navigation.
- [ ] Show object attributes, missing evidence, conflicts and score explanations.
- [ ] Show source links, capture times and the case snapshot used for scoring.
- [ ] Add manual candidate entry tied to an existing open case, including the query used.
- [ ] Record match / not_match / unsure with reviewer and evidence notes.
- [ ] Make stale/closed evidence and sandbox/staged data visibly distinguishable.
- [ ] Expose case metrics and active-time recording.
- [ ] Keep review/verification rules enforced by the application layer, not merely UI buttons.

**Done when:** Jalla can select an ingested case, enter a candidate, inspect both
objects, save a verdict, and see it in the existing persistent history and
metrics without editing JSON or using individual review commands. Verify both
ordinary and stale-evidence flows. This is a local single-operator tool; hosting
and multi-user accounts are not prerequisites.

### W2: Validate the eBay integration

**Status:** Waiting for credentials and provider-access confirmation. **Advances:** M2.

- [ ] Configure eBay developer credentials outside version control.
- [ ] Exercise OAuth, search and normalization against actual sandbox responses.
- [ ] Confirm appropriate production access and permission for the intended application use.
- [ ] Exercise a bounded production query for one open case.
- [ ] Inspect actual result fields and correct any adapter assumptions.
- [ ] Confirm source errors and empty responses remain understandable and auditable.
- [ ] Keep sandbox inventory out of real metrics and owner notifications.

**Done when:** A real permitted eBay search reaches the scored review queue with
accurate provenance. Mocked tests or sandbox inventory alone do not satisfy M2.
Do not substitute scraping when API access is unavailable.

### W3: Run a small real-case pilot

**Status:** Not started. **Advances:** M1/M2/M3.

Target approximately 5–10 cases initially, adjusted for available case density.
This is an exploratory batch, not enough to establish population accuracy.
Manual case-led searches can start before W2 is finished.

- [ ] Select a documented region and record why these cases were chosen.
- [ ] Collect a bounded candidate set using permitted access.
- [ ] Have Jalla inspect candidates and record real verdicts and notes.
- [ ] Record active search/review minutes and a comparable manual baseline.
- [ ] Report candidates per case, provisional reviewed precision, unresolved cases and time.
- [ ] Review poor queries, noisy attributes, sparse listings and false leads before changing weights.
- [ ] Record scoring-version changes so results remain interpretable.

**Done when:** A written pilot report contains actual observations, denominators,
verdict coverage, time measurements and limitations. Lack of useful candidates
is a reportable result, not a reason to replace observations with synthetic data.

### W4: Staged ground-truth experiment

**Status:** Not started; the synthetic text runner is available. **Advances:** M4.

- [ ] Choose owned bikes or distinctive owned objects with known identities.
- [ ] Capture separate report-style and listing-style photographs in different conditions.
- [ ] Include similar nonmatching distractors with permitted data use.
- [ ] Keep ground-truth labels separate from the reviewer during the blind exercise.
- [ ] Define the candidate pool, scoring version and threshold before interpreting results.
- [ ] Report TP, FP, TN, FN, precision, FPR and miss rate, including empty denominators.
- [ ] Distinguish within-pool matching errors from retrieval misses outside the collected pool.

**Done when:** The dataset/protocol and results are reproducible and actual
false positives/misses are visible. The existing five-item synthetic text
fixture is a mechanics check and does not satisfy this milestone. Photograph
collection and human inspection do not imply automated image matching exists.

### W5: Validate Bike Index notifications

**Status:** Provider setup and authorized test pending. **Advances:** M3.

- [ ] Arrange the documented approved-app or authorized own-bike test setup.
- [ ] Configure the appropriate scoped OAuth token without committing credentials.
- [ ] Test a verified lead through Bike Index's stolen-bike notification path.
- [ ] Confirm the actual provider response and expected receipt.
- [ ] Verify missing verdicts, changed/recovered cases, stale observations and test inventory are blocked.
- [ ] Verify duplicate attempts and uncertain delivery are handled without blind retries.

**Done when:** An authorized integration test is documented with its outcome.
Do not fabricate a public theft report, contact sellers, or use an unrelated
owner as the test recipient. Real notifications still require human verification.

### W6: Establish second-source coverage

**Status:** Source and permitted route undecided. **Advances:** M4.

- [ ] Select the second source based on useful bicycle coverage and permitted access.
- [ ] Document whether its route is official API, licensed data or operator-assisted manual search.
- [ ] Record provenance and keep all candidates tied to an open case.
- [ ] Exercise the route through the same scoring and review workflow.
- [ ] Describe coverage, access limits and maintenance requirements.

**Done when:** Actual case-specific candidates from a named second source have
been reviewed. The generic manual import capability alone is not proof of
second-source coverage. If automation is not permitted, retain a documented
manual workflow and state that limitation explicitly.

## What can proceed independently

| Work | Dependencies |
| --- | --- |
| W1 interface | Existing store and scorer; no external credentials required |
| W2 eBay validation | Developer credentials and provider access/purpose confirmation |
| W3 initial manual pilot | Candidate access, usable review workflow and Jalla's review time; can begin before W2 |
| W4 staged experiment | Owned objects, photographs, labels and agreed protocol |
| W5 notification validation | Authorized provider setup, scoped token and controlled recipient |
| W6 second source | Source selection and an established permitted route |

Jalla is the decision-maker and first human verifier. Coding agents implement
and document the workflow. Credentials, provider permissions, object ownership,
and human verdicts must never be inferred or fabricated to mark a task complete.

## MVP 1 exit criteria

- [ ] Real Bike Index cases flow into inspectable records.
- [ ] At least one permitted automated production listing source works end to end.
- [ ] Human review is usable and preserves evidence, verdicts and provenance.
- [ ] A real pilot reports candidate usefulness and active time against a manual baseline.
- [ ] A labeled staged experiment reports precision, false positives and misses honestly.
- [ ] Bike Index notification integration passes its authorized test.
- [ ] Second-source coverage is demonstrated and its access mode documented.
- [ ] No outward action is triggered by a score alone; no sellers are contacted.
- [ ] Test data stays separate from real metrics and notifications.
- [ ] Retention and audit behavior are documented and verified.

There is no agreed numeric accuracy or time-saving target yet. Record evidence
first; Jalla should set the acceptable operating threshold after the initial
pilot and staged results. Do not invent a success percentage or claim recovery
precision from provisional human judgments.

## Later work

Image similarity follows a measured text-only baseline. Production hosting,
multi-user accounts, background scheduling and tamper-evident evidence handling
need separate decisions. MVP 2 starts with object detection/attribute extraction
from Jalla's own phone stream, after MVP 1's core workflow has been evaluated.

## Keeping this roadmap current

At each milestone change, update the checklist, evidence, blockers and next task
in this file in the same change as the implementation. Link the relevant commit,
test result or experiment report. Keep README and BUILD_STATUS.md consistent.
Use **implemented**, **integration validated**, and **field evaluated** distinctly.
Do not mark a milestone complete on the basis of mocked tests alone when its
completion condition requires live evidence.

Current baseline references:

- Implementation: commit `096cba3`.
- Readability and contributor standards: commit `07b3ee6`.
- [Build status](BUILD_STATUS.md).
- [Implementation guide](IMPLEMENTATION_GUIDE.md).
- [Provider/API notes](API_NOTES.md).
- [Contributor instructions](../AGENTS.md).
