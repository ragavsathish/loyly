# THROWAWAY: Pi durable over the original Löyly harness

This branch starts at `scope-impact/master` (`17d68d2`). It asks whether Pi durable can run the **original legacy cycle** and preserve an interactive audit playback. It does not change `ragavsathish/main`, the accepted spec-v2 runner, or the upstream branch.

For the revised 01-011 run, the source is the separate spec-only cut
`b97e4eda015167c571eb3296fa03fe4fea366130` on `ragavsathish/spec/pi-booking-agent`.
That cut changes only `docs/plan/01-booking-core/spec.feature` and `decisions.md` from the
original baseline; the controller and test fixtures remain on this integration branch.
The new cut passes the unchanged legacy preflight and has not yet been built or scored.

The integration branch keeps that baseline and replaces the prototype's gate-log inference with a detached host that runs the unchanged `harness/verify.sh` in an independent copy of each candidate. The host writes an exit-code receipt tied to the candidate digest and gate log. If the controller dies, Pi reopens the same gate task and reads that receipt; it cannot treat a line of log prose as a gate verdict.

The score handoff has the same restart rule. Before invoking unchanged `harness/score.clj`, the
controller records the source commit, candidate, checklist, and final-verdict digests in
`score-input.json`. It checks the filed `scores.json` item by item against the bound inputs.
On restart, an existing file is accepted only when the cut and every scored item still match.

The branch also carries the existing Pi builder host under `.pi/harness/`, plus a process adapter with a stable session ID and launch receipt. Its controller SIGKILL test passes. The host's no-model smoke passed inside the `builder-clojure` Gondolin image: all seven selected tools ran, egress and host-path restrictions held, and reopening the same request made no second model call. `worker.mjs` has a `live` mode that requires the approved source commit, checklist digest, builder instruction digest, wrapper digest, image-manifest digest, image path, and model. It builds from the pinned original-source cut, so the builder room contains none of these prototype fixtures. A wrong instruction digest is refused before launch; a stub build produced three failed legacy gates and never reached grading.

The demo still uses fixture builders and a fixture grader. `live` mode accepts a separate grader model and pinned instruction, wrapper, image, settings, and the supplied Allure lifecycle schema. It divides the approved checklist by Gherkin `Rule` into three grader scopes by default (`LOYLY_GRADER_SHARDS=1..16` changes the count). Each scope gets a private candidate copy, checklist, process session, and Allure result directory; the Pi wrapper gives each process its own Gondolin VM. The controller waits for all shards, validates each result and attachment against the supplied schema, and checks exact item coverage. A failed or missing shard stops before scoring. The shard count is pinned in the durable cycle input. The controller then prepares a candidate-bound `blind-agent-packet/`. With `LOYLY_BLIND_AGENT_MODEL` and four approved digests set, it launches a fresh Pi reviewer through the same process adapter in a room with only the refusal and question, and a `read` tool. Without that configuration it sleeps until a separate response appears at `blind-agent-review.json` (plus `blind-agent-request.json` for a positive answer). It probes a named request in a fresh app copy, writes a supplemental Allure result, and derives `final-verdicts.json` from both results before calling the original scorer. The raw grader result stays pending. Live-mode stub tests prove both automatic launch and the manual wait across controller SIGKILL/restart. Stub scores are **fixture** evidence, never product acceptance.

The grading room has only the selected `01-booking-core` plan, the gated `impl/`, the approved checklist, the supplied Allure schema, and empty `work/`; it omits builder evidence, prototype fixtures, prior verdicts, and score files. Each shard room repeats those boundaries with a subset checklist. The room's plan, candidate, checklist, and schema digests are checked on creation and reopening. In the Pi VM, the plan and candidate are mounted read-only; app runtime copies and observations belong under `work/`. The revised grader instruction leaves `01-011` pending for a fresh blind subagent that sees only the refusal and question. The Allure instruction is a draft. Exploratory Terra shards produced zero passes on an uncarried fixture and ten behavioral passes plus pending blind review on a real Pi-built, legacy-gated app. See `SHARD-CALIBRATION.md` and `CARRIED-CALIBRATION.md`. Neither run filed a product score.

For a pinned fixture trial, set `LOYLY_APPROVED_COMMIT` to a full commit ID and `LOYLY_APPROVED_CHECKLIST_SHA256` to the expected checklist file digest, then run `node worker.mjs scratch-pinned repair`. The cycle clones that commit into `scratch-pinned/cut/project`, runs the original self-check and fence there, and records both approval values in its Pi task input. A wrong checklist digest stops before building; reopening the store with changed approval values is refused. At `17d68d2`, the checklist digest is `4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`. This is still a fixture trial and is not an approved scored product run.

```bash
cd harness/v2/prototypes/pi-orc-audit
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
open replay.PROTOTYPE.html
```

The demo runs a repaired cycle, a cycle with three failed gates, and a SIGKILL/restart. Its generated `scratch*/` directories contain the Pi SQLite ledger, fenced clone, logs, fixture verdicts, and an instrument clone. They are ignored by Git. [`example-replay.html`](example-replay.html) is a sanitized playback from a completed demo.

`export.mjs` writes `audit.v1.jsonl` from committed Pi entries and `evidence.v1.json` from
candidate-bound Allure results. The playback shows each grader item only after the committed
grade and the separate 01-011 review only after its committed blind-review event. It labels
those results as Allure projections, not Pi events. The generated local replay can contain
grader observations, so review it before publishing it anywhere.

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

**Limits:** The original upstream repo has no implementation. The demo's tiny app and grader are fixtures; its score is not an acceptance result. A separate live Pi build passed the legacy gate and an exploratory Terra calibration observed ten behaviors through HTTP, with the old blind review item pending. No approved score or promotion followed. The original Löyly identity probe only checks that the page says “sauna,” so grading remains essential. Grain projection, OpenTelemetry export, and the richer ORC event-storm UX remain separate experiments.

The prototype on `proto/pi-orc-audit` uses the later slice-06 spec and v2 adapters. This clean-base version intentionally uses the original harness without importing that later tree, making the differences visible and testable.

For the revised `01-011` usability check, a fresh independent subagent receives only the
exact `refusal.txt` and `question.txt`; the packet manifest, candidate, configuration, and
grader transcript stay outside its context. `blind-review-cli.mjs prepare` binds the packet
to the candidate, exact spec, checklist, and grader Allure digest. After the agent answers, `probe` confirms its
suggested request against a fresh candidate copy, and `file` writes a separate Allure result.
The operator checks that the HTTP request faithfully expresses the agent's answer. This
supplement does not edit the grader's pending result. The controller's durable review phase uses
the same validation and only then changes the score projection. The reviewer can be launched
automatically through the pinned Pi process adapter or supplied through the manual handoff.
The earlier candidate is calibration evidence under the previous spec wording; a new pinned
build is required for a scored cycle with the revised spec.
