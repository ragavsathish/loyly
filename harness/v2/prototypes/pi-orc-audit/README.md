# THROWAWAY: Pi durable cycle and Löyly audit replay

**Question:** Can Pi durable own the legacy regeneration cycle while preserving the stage-by-stage audit playback people like in the current Löyly replay page? This branch is an experiment. It does not modify the accepted `harness-impl/` runner or the approved spec.

```bash
cd harness/v2/prototypes/pi-orc-audit
npm ci --ignore-scripts --no-audit --no-fund
npm run demo
open replay.PROTOTYPE.html
```

`scratch*/` holds disposable Pi SQLite stores, fenced rooms, the instrument clone, gate logs, and exported JSONL. The HTML is self-contained. The demo runs a repaired cycle, a three-red-gate cycle, and a process-kill/restart cycle; it checks the committed audit events after each. It uses no model credentials. If interrupted, rerunning `npm run demo` resumes the existing Pi tasks.

[`example-replay.html`](example-replay.html) is the sanitized, self-contained output of one completed demo. The same exporter regenerates `replay.PROTOTYPE.html` from the local stores.

| Legacy behavior | Prototype implementation |
| --- | --- |
| Instrument self-check and oracle | Calls `harness/check.sh --local`; the fence calls it again before creating a room. |
| Stable stamped IDs and checklist | The self-check exercises the legacy stamper; calls `harness/gen_checklist.clj` to derive the current 65-item slice-06 checklist. |
| Physical clean room | Calls unchanged `harness/fence.sh` with `SLICE=06`; on restart, reconciles a completed one-commit room before advancing. |
| Builder prompt | Calls `harness/v2/prompt.clj` and records its output digest. |
| Fresh builder and same-session continuation | Pi durable child task, with a delayed checkpoint to test restart. **Fixture:** copies the unaccepted cycle-28 gate-passing candidate into the fenced room; it does not invoke a model. Records the same session ID for the continuation and the candidate's 22 still-uncarried items. |
| Independent ratifying gate and bounded repair | Calls unchanged `harness/v2/gate.sh`, which calls legacy `verify.sh`, suite, identity probe, and Grain store check. The first candidate's suite is made red; repair uses a fresh child and the prior gate log. At most three gates, no grading after three failures. |
| Grading room and independent grader | Calls unchanged `.pi/harness/bin/grading-room.sh` to create the limited view, then a separate Pi child task files 65 deterministic fixture verdicts from that room's checklist. This tests the handoff and denominator, **not** black-box grader quality, model independence, process separation, or Gondolin isolation. |
| Score and scoreboard | Calls unchanged `harness/v2/score.sh` in a scratch clone. That wrapper invokes the legacy `score.clj` and `scoreboard.clj`. A scored-cycle receipt is reconciled after a crash. |
| Audit and playback | Each phase appends a versioned Pi audit entry in the same commit as its checkpoint. `export.mjs` reads entries through a read-only Pi Harness and produces `audit.v1.jsonl` and the interactive HTML. Pi events are labeled as Pi, never fabricated as ORC ticks. |

The frozen candidate fixture comes from cycle 28's gate-passed attempt 3, **not** from the accepted running build. It is here only to let the unchanged legacy gate complete quickly enough for a control-plane experiment. Its independent grade scored 48/65, so this prototype does not promote it. The fixture can be replaced by a live Pi builder host in a later experiment.

Observed demo: the repaired path passed the real gate on attempt 2, prepared a 65-item grading room, and filed the fixture score 64/65. A separate path exhausted three failed gates without grading. After a SIGKILL during builder startup, the restarted worker completed the three-gate path with one committed first-builder start. The generated audit page shows all three histories from their SQLite stores. The console can print the first builder start twice around the kill because output precedes the transaction commit; the ledger contains it once.

The HTML carries the same stage-story and timeline ideas as [`tools/spec/replay`](../../../../tools/spec/replay/README.md), but is intentionally a much smaller UI. It currently shows Pi's control lane only. The existing page's Grain event storm, Allure links, and ORC analyst ticks remain separate integration work. Pi telemetry-to-Grain is also unimplemented: the [research note](../../research/pi-durable-orc-audit.md) explains why diagnostic spans alone are not a complete cycle ledger.
