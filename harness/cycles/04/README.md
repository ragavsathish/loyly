# Codex subagent whole-product cycle 04

This scored run used the general `cycle-core` decision policy and
`evidence-core` validation through `harness/codex-cycle/`. Fresh Codex
subagents built the app and graded it on different models; a third fresh
subagent made the blind refusal judgment. This is a candidate measurement,
not an acceptance decision.

- Approved controller: `b1bdb4d78390882f7c7c796eeb6b4832b8684734`.
- Approved source: `7e2fb1c0ba88c6b941a296a1298b89dd0bd5db5a`.
- Selected checklist: 47 items, SHA-256
  `06f0dba7ba9aa07152950cd0bc6c38560f6c6b95a3fa88354909a4561434dda2`.
- Builder: `gpt-6.2-sol`; grader: `gpt-6.1-terra`; blind reviewer:
  `gpt-6.2-sol`. The exact instruction, wrapper, image, schema and panel
  digests are in `run-contract.json`.
- Gate: passed on attempt 1, 47 local tests passed, boot answered on poll 2/20.
  `attempt-1.json` binds the gate log to candidate SHA-256
  `c7cca9085c5d9b584b3710be78f5b5b68318a18342ec5f0cfb654d9366634340`.
- Score: **36/47 pass**. By slice: 01 **11/11**, 02 **8/10**, 03 **9/14**,
  04 **5/7**, 05 **3/5**. The eleven failing IDs are `02-003`, `02-008`,
  `03-007`, `03-008`, `03-009`, `03-012`, `03-013`, `04-004`, `04-007`,
  `05-004`, and `05-005`.
- Against the prior cycle 02 booking score, all eleven shared items still
  pass: **zero newly passing and zero newly failing**. The other 36 items are
  new to this comparison. Cycle 03 has no filed score in this branch, so the
  legacy `scoreboard.clj 04` correctly reports no immediate predecessor.

`candidate/impl/` is the exact gated implementation. `grading-room/` retains
the restricted candidate copy, selected plans, raw per-item Gondolin VM
commands and output, 47 raw Allure results with attachments, the blind
handoff, one blind Allure result, and `work/surprises.json`. Every item has a
VM command and exit receipt. The blind subagent saw only the refusal and
question, suggested `pukuhuone 8 | Tuesday | 17:00`, and a fresh VM confirmed
that exact standing request with HTTP 201. `evidence-validation.json` records
the schema and coverage check. `phase-decision.json` records the `cycle-core`
transition from grading through the completed blind review to scoring.
Recheck from the repo root with:

```sh
node harness/codex-cycle/cli.ts evidence harness/cycles/04/evidence.json
bb harness/scoreboard.clj 04
```

The approved Alpine grader image had no Node runtime. Each fresh item VM
installed Node 24.22.3 and full ICU; the initial minimal-ICU dated endpoint
failure and the corrected run are recorded in `work/surprises.json` and
`work/icu-probe/`. The grader marked time-dependent scenarios `not reached`
where it could not observe deadline passage through the public surface. Those
are failing evidence, not inferred passes. The candidate is **not ready for
acceptance** at this score; its time-control and precondition coverage need
review before any promotion decision.
