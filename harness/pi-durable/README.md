# Löyly Pi durable harness

This directory contains the active Pi durable cycle driver. Pi owns cycle
checkpoints and committed audit entries. The original
`harness/` scripts still perform the self-check, physical fence, checklist,
gate, score and scoreboard. Gondolin runs the Pi builder, independent grader
shards, blind reviewer and project-specific specialist probes. The former
ORC runner remains historical comparison evidence.

## Run a pinned live cycle

Install this directory's npm dependencies and the `.pi/harness/builder-host`
dependencies. Set `JAVA_HOME` to Java 21. Create an ignored JSON contract
matching [`live-run.schema.json`](live-run.schema.json), then run:

```sh
node run-live.mjs --check scratch-production-cycle-XX/live-run.json
node run-live.mjs --run scratch-production-cycle-XX/live-run.json
```

The contract pins the clean controller and source commits, selected spec and
checklist, agent wrappers and instructions, model names, Allure schema, panel
plan and both VM images. The builder and grader use different models. The
multi-slice form uses `source.specs` (every selected `spec.feature` with its
SHA-256), may name `grader.instruction_file`, and may select a local panel
plan through `panel.plan_file` and its pinned `panel.plan_sha256`. The checker
requires the spec list to match the derived checklist exactly. The plan's
raw checks must cover that checklist exactly; its separate blind check must
cover `01-011`, and specialist checks must name selected items. This is
validated before the build starts. The plan's specialist checks launch in
parallel Gondolin VMs. Existing booking-core
checks retain their named scripts; each additional check must name a local
`panel-*.mjs` script and one selected item. Each script writes its own Allure
directory, and the panel compiler checks the result against the pinned plan.
The current product selection is still the eleven stamped booking-core items.
Slices 02 through 05 under `docs/plan/` are drafts and have not entered a
scored cycle.

For a candidate that may use Node, Babashka or the JVM, build the optional
combined specialist image from the Clojure builder OCI image at the digest
named in `Dockerfile.panel-multistack`:

```sh
docker build --platform linux/arm64 \
  -f Dockerfile.panel-multistack -t loyly/panel-multistack:oci .
gondolin build --config panel-vm-multistack-build.json \
  --output ../../.pi/harness/.state/assets/panel-multistack \
  --tag loyly-panel:multistack-v1
```

The base OCI image is a local prerequisite from the existing Clojure builder
toolchain; the build refuses a different digest. The Gondolin asset remains
gitignored and its manifest digest must be pinned in a live run contract.
This image adds Node and Chromium to the existing Java 21, Clojure CLI and
Babashka toolchain. In an exploratory run, the frozen cycle-06 Node candidate
passed the browser, protocol and Node OpenTelemetry workers in three
overlapping VMs, and the preserved cycle-04 Babashka candidate started and
served HTTP from the same image. The current OpenTelemetry worker still uses
Node's loader. A JVM or Babashka diagnostic needs its own panel script and
approved plan entry; the combined image alone does not provide that evidence.

The controller clones the source cut into private scratch, sends the builder at
most three same-session continuations on selected uncarried items, and runs
the legacy gate independently after each completed build. A red gate or a
failed builder process with a completed Pi session receipt starts a repair
attempt: Pi forks the prior conversation at its last committed entry, keeps
the existing `impl/`, and gives the fork the failure log. The cycle stops
after three attempts; a changed approved input or invalid receipt stops it
immediately. It then grades rule scopes in separate VMs, launches a
fresh blind Pi reviewer for `01-011`, and runs three specialist VMs in
parallel. The selected panel manifest is bound into the filed score input.
Five Allure result directories then generate one 15-case report.

## Panel-only reassessment

If a score has been filed but the panel instrument fails, use
[`reassess-panel.mjs`](reassess-panel.mjs) with a separately pinned contract.
It verifies the frozen candidate and the committed Pi score, launches new
specialist VMs, and compiles Allure from the existing grader and blind result
directories plus the new VM directories. It writes a separate immutable
receipt. It never changes the original cycle's audit, score or outcome. See
[`PRODUCTION-CANDIDATE.md`](PRODUCTION-CANDIDATE.md) for the contract fields.

## Current evidence

- The Pi regression suite passed 31/31 in a serialized run, including
  the live blind handoff and controller restart tests. The Pi host's fork
  and timeout tests passed separately.
- A fresh Pi cycle at controller `36bb97f` passed the legacy gate, independent
  grader shards and blind review, and filed **11/11** with the original scorer.
  Its original specialist checks failed for a generated UI variant, so the
  original cycle ended failed at panel report.
- Pinned panel reassessment at `e47f92a` ran Playwright, 100 protocol races
  and OpenTelemetry in three overlapping Gondolin VMs. It reused the frozen
  scored candidate and generated **15 Allure cases, ready-for-review**, with
  no gaps. Reopening the reassessment reused its verified receipts.
- A later fresh cycle generated a Babashka/Clojure app and passed the legacy
  gate. A grader shard stalled while waiting on its own long-lived servers;
  the cycle recorded a grade failure and filed no score. The bounded grader
  recovery fix and remaining panel portability work are tracked in
  [`PRODUCTION-CANDIDATE.md`](PRODUCTION-CANDIDATE.md).
- Cycle 05 passed the independent gate on attempt 1 and completed all three
  grader shards. Its blind reviewer rejected `01-011` under an end-time
  requirement added by the blind instruction, so the filed score is **10/11**.
  The original specialist panel failed to launch the generated `server.js`
  candidate because it hardcoded `server.mjs`. The corrected workers later
  passed all three Gondolin probes in a separate, pinned reassessment. The
  original score remains **10/11**, and that reassessment is still `not-ready`.
- Cycle 06 passed the independent gate, all ten direct behavior items, and the
  fresh blind review. The original scorer filed **11/11**. Its original panel
  failed on new UI and view shapes; a separately pinned reassessment of the
  same frozen candidate passed all three Gondolin specialists and produced
  **15 Allure cases, ready-for-review**, with no gaps. The original cycle
  audit and score remain unchanged.

Pi is the active driver by operator direction. The original cycle failure
remains visible; the reassessment is separately labelled. The generated app
and grading panel still need the acceptance checks in
[`PRODUCTION-CANDIDATE.md`](PRODUCTION-CANDIDATE.md).

## Audit playback

`node export.mjs <cycle-scratch>` exports committed Pi entries to
`audit.v1.jsonl`, validates the bound Allure evidence into
`evidence.v1.json`, and writes `replay.PROTOTYPE.html` in the current working
directory. The page distinguishes Pi events from Allure evidence projections.
The reassessment receipt and report remain separate from the original replay.
