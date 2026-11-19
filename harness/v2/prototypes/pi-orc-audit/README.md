# THROWAWAY: Pi durable over the original Löyly harness

This branch starts at `scope-impact/master` (`17d68d2`). It asks whether Pi durable can run the **original legacy cycle** and preserve an interactive audit playback. It does not change `ragavsathish/main`, the accepted spec-v2 runner, or the upstream branch.

The integration branch keeps that baseline and replaces the prototype's gate-log inference with a detached host that runs the unchanged `harness/verify.sh` in an independent copy of each candidate. The host writes an exit-code receipt tied to the candidate digest and gate log. If the controller dies, Pi reopens the same gate task and reads that receipt; it cannot treat a line of log prose as a gate verdict.

The same directory also contains a process adapter for a future live Pi builder. Its stable session ID and launch receipt survive controller SIGKILL in tests. The demo still uses fixture builders and a fixture grader; the live builder host has not been connected to this clean-base branch. A live room must be cut from the approved original commit so it cannot see these prototype fixtures.

For a pinned fixture trial, set `LOYLY_APPROVED_COMMIT` to a full commit ID and `LOYLY_APPROVED_CHECKLIST_SHA256` to the expected checklist file digest, then run `node worker.mjs scratch-pinned repair`. The cycle clones that commit into `scratch-pinned/cut/project`, runs the original self-check and fence there, and records both approval values in its Pi task input. A wrong checklist digest stops before building; reopening the store with changed approval values is refused. At `17d68d2`, the checklist digest is `4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`. This is still a fixture trial and is not an approved scored product run.

```bash
cd harness/v2/prototypes/pi-orc-audit
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
open replay.PROTOTYPE.html
```

The demo runs a repaired cycle, a cycle with three failed gates, and a SIGKILL/restart. Its generated `scratch*/` directories contain the Pi SQLite ledger, fenced clone, logs, fixture verdicts, and an instrument clone. They are ignored by Git. [`example-replay.html`](example-replay.html) is a sanitized playback from a completed demo.

| Stage | What actually runs |
| --- | --- |
| Instrument preflight | Unchanged `harness/check.sh --local`, including the oracle, stamper checks, scorer checks, and module adoption check. |
| Physical fence | Unchanged `harness/fence.sh`. Its one-commit clone excludes `impl` and `harness/cycles`; restart reconciles the proven room. |
| Checklist | Unchanged `harness/gen_checklist.clj` derives the **11** stamped items in the original sauna spec. |
| Builder instruction | The prototype saves the original harness README and `docs/plan/01-booking-core/spec.feature`. The legacy harness has no prompt renderer. |
| Build, continuation, repair | Separate Pi child tasks. The builder is a fixture that copies a tiny sauna HTTP app into the fenced `impl/`. Attempt 1 is deliberately red; a fresh repair child sees the prior gate log. The continuation is a labeled fixture fact in the same child session. |
| Ratifying gate | Unchanged `harness/verify.sh` runs in an independent copy of the fenced candidate. It repeats the instrument check, runs `impl/test.sh`, boots `impl/start.sh`, and calls the original `harness/probe.sh`. At most three attempts; no grading after three failures. |
| Grading | The prototype makes a small read-only view of the app, spec, and checklist, then a separate Pi child task files deterministic fixture verdicts. The original harness says to grade “however you grade”; it has no grading-room script. |
| Measurement | Unchanged `harness/score.clj` and `harness/scoreboard.clj` run in a scratch instrument clone, filing cycle 02. One fixture item fails, producing 10/11. No score files enter the fenced builder room. |
| Audit | Each stage appends a versioned Pi entry in the same transaction as its checkpoint. `export.mjs` opens the store read-only and rebuilds the self-contained replay and JSONL from committed entries. It does not invent ORC ticks. |

**Limits:** The original upstream repo has no implementation. The tiny app and grader are fixtures, and the original Löyly identity probe only checks that the page says “sauna.” Therefore a green gate here proves the control path and the original gate contract, not the 11 product behaviors. The fixture score is not an acceptance result. Live Pi agent hosts, Grain projection, OpenTelemetry export, and the richer ORC event-storm UX remain separate experiments.

The prototype on `proto/pi-orc-audit` uses the later slice-06 spec and v2 adapters. This clean-base version intentionally uses the original harness without importing that later tree, making the differences visible and testable.
