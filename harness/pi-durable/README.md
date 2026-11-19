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
controller clones the source cut into private scratch, sends the builder at
most three same-session continuations on selected uncarried items, and runs
the legacy gate independently after each build. A red gate starts a fresh
repair builder with the gate log; the cycle stops after three build and gate
attempts. It then grades rule scopes in separate VMs, launches a
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

- The prototype regression suite passed 28/28 in a serialized run, including
  the live blind handoff and controller restart tests.
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
