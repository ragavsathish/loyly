# Cycle 04 clock-aware grader reassessment

This is a separate, operator-approved black-box reassessment of cycle 04's
unchanged candidate. It grades only the eleven items originally filed as
`not reached`. It does not replace cycle 04's score, Allure results, or
acceptance decision.

- Pinned contract: `contract.json`. Controller `448ad117`, source `7e2fb1c0`,
  candidate SHA-256 `c7cca9085c5d9b584b3710be78f5b5b68318a18342ec5f0cfb654d9366634340`.
- Selection: `checklist.json`, eleven IDs; SHA-256
  `8094d23f4322d39d64eb5927bf2464c7393c2b6bd52595c74fbf7ecb3969a427`.
- Independent grader: `gpt-6.1-terra`, pinned instruction and panel in the
  contract. Each item used a fresh Gondolin VM with the candidate mounted
  read-only. The grader advanced the guest clock past returned deadlines.
- Result: **11/11 passed** in this reassessment. All eleven were originally
  failures due to unreached observations; `comparison.json` lists each change.
  `work/surprises.json` is empty. Combining these observations with the
  original 36 passes would project 47/47, but that is **not a new official
  cycle score** and the original 36 items were not regraded here.

The `grading-room/` copy holds the frozen candidate, selected Gherkin plans,
per-item VM commands and HTTP logs, and eleven raw Allure results with their
attachments. The first `04-007` VM attempt did not create a later notice;
its fresh rerun did, recording both the original v1 notice and a later v2
notice with revised 7/20-day clocks. Both logs remain in the record. The
grader corrected Allure identity metadata to match the source-folder slug;
the HTTP observations and statuses did not change.

`evidence-validation.json` records the project's Allure schema, checklist
coverage, label, attachment, and verdict check. `receipt-validation.json`
records the eleven VM exit, runtime, and HTTP receipts. The grading-room
receipt verifies the candidate, selected plans, checklist, and schema copies.
Recheck the evidence from the repository root:

```sh
node harness/codex-cycle/cli.ts evidence harness/cycles/04/reassessment-01/evidence.json
shasum -a 256 harness/cycles/04/scores.json
```

The original score file's SHA-256 remains
`bd830a644b5f8c9057051038a8fd135d08471e89f4d4b1696b6065934b432d87`
and still reports **36/47**. App promotion requires a separate explicit
acceptance decision under `AGENTS.md`.
