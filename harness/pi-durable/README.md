# Pi durable harness

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
The approved first-cut product selection has 47 stamped items across slices
01 through 05. `whole-product.panel.json` assigns every selected item to one
raw grader check and keeps the independent `01-011` blind handoff. It adds
three parallel specialist VMs for browser, protocol and cross-runtime process
profiling. These specialists still
probe booking core; the raw grader shards cover every whole-product rule.
The candidate-emitted Node OpenTelemetry worker remains in the historical
booking-core calibration plan and is excluded here because the product spec
permits a non-Node implementation.
This expanded selection has not entered a scored cycle. The historical
cycle-06 score remains an eleven-item booking-core result.

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
Node's loader. The separate `panel-runtime.mjs` script collects panel-observed
process metrics and JFR, when applicable, under an approved plan entry. It
does not turn those observations into candidate-emitted OpenTelemetry.

The controller clones the source cut into private scratch, sends the builder at
most three same-session continuations on selected uncarried items, and runs
the legacy gate independently after each completed build. A red gate or a
failed builder process with a completed Pi session receipt starts a repair
attempt: Pi forks the prior conversation at its last committed entry, keeps
the existing `impl/`, and gives the fork the failure log. The cycle stops
after three attempts; a changed approved input or invalid receipt stops it
immediately. It then grades rule scopes in separate VMs, launches a
fresh blind Pi reviewer for `01-011`, and runs the selected specialist VMs in
parallel. The selected panel manifest is bound into the filed score input.
The current booking plan has three specialists and produces a 15-case Allure
report; another pinned plan may add result directories without merging them.

## Use the lifecycle with another project

The reusable control policy lives in [`lifecycle.ts`](lifecycle.ts): build,
independent gate, bounded repair, isolated grader shards, optional assessments,
then score. Its inputs and results, the panel policy, continuation selection,
and verdict validation use the shared types in [`contracts.ts`](contracts.ts).
`harness.pi-live-run.v2` names a `project` and pins the same source,
agent, schema, and image inputs. Its builder and grader instructions can have
project-specific file names. The blind handoff is absent in v2; a direct grader
result decides every selected item. A panel is optional. Java 21 is required
only if `runtime.java21` is true or the project's own gate needs it.

The source adapter supplies `harness/check.sh`, `harness/fence.sh`,
`harness/gen_checklist.clj`, `harness/verify.sh`, `harness/score.clj`, and
`harness/scoreboard.clj` under
the same command and file contracts used by this driver. Selected Gherkin
files follow `docs/plan/NN-name/spec.feature`; checklist items carry stamped
`NN-NNN` IDs and source line references. The controller keeps these source
scripts outside its reusable lifecycle module so an existing legacy scorer
can remain authoritative. The adapter also supplies the app in `impl/` with a
launch path its grader instruction explains.

For a v2 specialist panel, use `harness.grading-panel-plan.v2`. Every selected
item appears once in a `raw-grader` check with `scored` role. Specialists use
`corroborating` or `diagnostic` roles and name a `.mjs` script in the pinned
`bundle.path` directory. The controller hashes the bundle tree before build;
Gondolin mounts it read-only at `/worker`, the candidate read-only at
`/candidate`, core probe helpers at `/harness`, and each result directory
read-write at `/out`. Each VM writes an Allure case. The panel compiler checks
the receipts and passes the separate result directories to Allure. No blind
case is required for v2. The sample `test/fixtures/hello-panel/health.mjs`
passed a non-Löyly HTTP candidate in a real Gondolin VM.

The older `loyly.pi-live-run.v1` contract and its panel retain their blind
`01-011` handoff, Java preflight, and historical report identity. A new scored
live cycle still needs the exact approval described in `AGENTS.md`.

## Code quality checks

Run `npm run quality` to type-check the migrated modules with strict indexed
and optional-property checks, lint the harness and its tests, and check
formatting of the TypeScript and tool configuration. TypeScript source runs
directly on the host's Node 26 and in the panel VM's Node 24; `tsc` does not
emit JavaScript.
The runtime entrypoints and pinned VM worker filenames remain `.mjs` while
their imports cross into the typed modules. Changing those filenames would
invalidate existing panel plans and execution receipts.
The functional core keeps lifecycle and panel decisions as ordinary pure
functions. [`workspace-effects.ts`](workspace-effects.ts) provides injectable
file reads for continuation selection; [`gate-effects.ts`](gate-effects.ts)
defines the gate service and its candidate-bound observation. The Pi worker
supplies the live gate adapter and runs each Effect inside its existing task
phase. Pi still owns durable checkpoints, retries, and audit commits. Effect
captures local I/O requirements and typed failures within a phase.
Prettier is available for explicit files: `npm run format:check -- lifecycle.ts`
checks one file, and `npm run format -- lifecycle.ts` formats it. Keep the
file list explicit when editing a pinned grader instruction, panel worker, or
schema; formatting those files changes their approved digest.

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
