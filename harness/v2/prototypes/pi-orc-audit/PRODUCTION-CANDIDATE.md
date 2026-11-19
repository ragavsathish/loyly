# Pi durable production candidate

This branch promotes the Pi prototype itself as the active cycle driver. The
former ORC runner is historical comparison evidence; the legacy harness is
still the ratifying and scoring instrument.
The original `harness/` tools still perform the self-check, fence, gate,
score and scoreboard. Pi durable owns the cycle checkpoint and audit; Gondolin
executes the builder, agent grader and three deterministic specialist probes.

## Live cycle

```text
pinned source and instrument digests
  -> self-check -> fence -> builder (bounded same-session continuation)
  -> independent gate -> three black-box agent grader shards
  -> fresh blind subagent and HTTP confirmation
  -> three specialist Gondolin VMs in parallel
  -> legacy score and scoreboard -> one Allure report -> Pi audit conclusion
```

The specialist VM stage is an actual Pi durable task. It has a maximum of two
isolated attempts. A complete manifest is verified and reused after a
controller restart; an interrupted attempt remains on disk as evidence and
one fresh attempt may run. Each VM sees a read-only candidate and worker tree
and writes to its own directory. The selected manifest hash enters
`score-input.json`, so a later score or restart cannot silently use another
panel. The report reads the original grader, blind review and three VM result
directories directly with Allure. Its own output is likewise selected from
at most two attempts and verified on reopening.

The current booking-core plan is `booking-core.panel.json`, checked by
`panel-plan.schema.json`. Results use the unchanged supplied
`allure-lifecycle-result.schema.json`; `panel-summary.schema.json` checks the
item-level summary. The plan says which checks are scored, handoffs,
corroboration and diagnostics. A specialist failure remains visible and makes
the panel `not-ready`; it cannot rewrite the agent's filed verdict. No latency
threshold is invented where the behavior spec has none.

The builder may install npm packages while testing. After each builder turn,
the controller removes `impl/node_modules` and `impl/.tmp` before binding the
authored candidate digest. Gate and grader copies install dependencies from
the package lock when their tests run. The first integrated run stopped before
its gate because the earlier controller tried to hash a generated npm symlink;
its partial audit and VM transcript remain in ignored scratch. A diagnostic
legacy gate passed after this cleanup. The three specialist VMs were also run
against that candidate: Playwright, protocol races and OpenTelemetry passed in
parallel. These diagnostics are not a filed cycle score.

The next fresh run passed the gate and three independent grader shards, then
stopped at the panel before scoring: its server-rendered app has no
`contract.json`, which the probe had assumed. The separate blind Pi agent
read only the refusal and named the right room, weekday and time; the HTTP
adapter submitted an assumed internal room ID and received 400. Against this
same candidate, revised probes passed in three parallel Gondolin VMs, and
the unchanged blind answer was confirmed over fresh HTTP with status 201
after resolving the room through the public booking form. Those are
diagnostics for the revised instrument, not retrospective changes to the
failed run's audit or score.

## Pinned launch

Create an ignored JSON contract matching `live-run.schema.json` with the
absolute source and scratch paths, full controller and source commits, exact
checklist and spec digests, and the builder, grader, blind and panel digests.
The grader model must differ from the builder model. The source and controller
worktrees must be clean. `--check` derives and checks the selected checklist;
`--run` then launches the durable cycle with the panel required.

```sh
cd harness/v2/prototypes/pi-orc-audit
npm ci --ignore-scripts --no-audit --no-fund
node run-live.mjs --check scratch-production/live-run.json
node run-live.mjs --run scratch-production/live-run.json
```

The contract must be fixed before `--run`. Credentials remain in the operator
environment; the JSON file contains only paths, model names and digests.

## Panel-only reassessment

When a filed score exists but the specialist instrument needs correction,
`reassess-panel.mjs` takes a second pinned JSON contract: `schema` is
`loyly.pi-panel-reassessment.v1`; supply the clean controller commit, source
commit, candidate and filed score SHA-256, panel plan and image manifest
SHA-256, the original cycle scratch path, a private output path inside it,
and the image path. `--check` verifies the frozen candidate and committed Pi
score. `--run` launches three parallel VMs, compiles Allure from the original
grader and blind directories plus the new specialist directories, then writes
an immutable `reassessment.json`. The filed score, original panel manifest
and failed cycle audit remain unchanged. This is a separately named
reassessment, never a rewrite of the original cycle outcome.

```sh
node reassess-panel.mjs --check scratch-production-cycle-03/reassessment-01/config.json
node reassess-panel.mjs --run scratch-production-cycle-03/reassessment-01/config.json
```

## Acceptance boundary

Pi is the active harness by operator direction. This is a workflow cutover,
not acceptance of a generated app or the specialist panel. Cycle 03 filed a real
**11/11** score and passed the legacy gate, but its original panel checks
failed and its report phase ended the cycle failed. The pinned panel-only
reassessment on the frozen candidate passed Playwright, protocol and OTel
probes in parallel and compiled 15 Allure cases with no gaps and
`ready-for-review`. It preserves the original failed audit. Acceptance still
needs review of the candidate and attachments, a clean product profile, the
controller kill/restart matrix on the live path, itemwise comparison with the
accepted instrument, and an operator decision. The historical Pi cycle's
10/11 score is calibration evidence only.

## Promotion review, 2026-11-20

A fresh pinned cycle 04 at controller `84218c0` selected the same 11 booking-core
items and generated a **Babashka/Clojure** app. Its self-check, fence, builder
continuation and independent legacy gate passed on attempt 1. Two Terra grader
shards returned seven behavioral passes and a pending blind-review item. The
third shard started four long-lived test servers in one shell command and
called an unbounded `wait`; we terminated that stuck shard and Pi recorded
`grade failed` and `cycle failed`. No cycle-04 score was filed. The raw scratch
and launch receipts remain intact.

The grader now has a five-minute shell-call recovery bound, and its instruction
requires explicit server cleanup. The controller records that bound in the
launch receipt and rejects a different value on resume. This correction has
adapter regression coverage; it has **not** been exercised in a new live cycle.

The specialist panel remains specific to Node candidates: its workers launch
`server.mjs`, assume particular JSON routes and record files, and its image
does not contain Babashka. Cycle 03's successful reassessment proves that
panel on one Node candidate only. The booking spec deliberately leaves the
implementation stack open, so this is an instrument limitation, not a failed
booking behavior. Before production cutover, the panel must launch the public
`start.sh` seam in a suitable pinned runtime image and report project-specific
observations honestly across both generated shapes.

The pre-reset `ragavsathish/main` ran the ORC harness over the wider spec-v2
system. Its exact tip `a733b7e` is preserved at
`ragavsathish/archive/orc-main-a733b7e`. This Pi driver currently covers the original booking-core 11-item plan,
not the other contexts. Those contexts still need to migrate and be compared
with the archived instrument. The next booking-core acceptance review needs a
complete integrated live cycle, product profile and restart checks.
