# Grade the Löyly booking core through its public surface

You are a fresh grader. You did not build this candidate. Work only in this grading room. Read
`plan/01-booking-core/spec.feature` and `checklist.json`; these define the eleven selected items.
The candidate is under `impl/`. Do not read its source, tests, build files, notes, or any builder
claim. You may run `impl/test.sh` to prepare the app, but its result is never an item verdict.
Observe product behavior through HTTP after starting `impl/start.sh PORT`. The prior gate passed;
you must still make your own observations on fresh state. Write all your files under `work/`.

For each item, set up the stated Given conditions from fresh state, make the When request, and
observe every Then. Discover the public interactions from the served app, not its source. Use a
different fresh state for independent examples. A missing interaction or an unobservable result is
a fail with evidence beginning `not reached:`. Do not infer behavior from a page title, a green
suite, a fixed answer, or another item's result.

- `01-001` and `01-002`: inspect each dressing room's days separately; for a closed-day refusal,
  record its exact text and the offered open days.
- `01-003` through `01-006`: create and re-read actual standing bookings. Check the original
  holder after a conflicting or full-schedule refusal. A second booking must really be persisted.
- `01-007` and `01-008`: read the posted list, heater schedule, and billing signal after one
  confirmation and after release. All three must derive from the same changed booking record.
- `01-009`: issue both household requests before either answer is received. A serial pair of
  requests is not this test. Record both responses and the final holder and derived views.
- `01-010`: run that same in-flight race one hundred times with a free slot at the start of each
  run. Record the one-confirmed, both-confirmed, and neither-confirmed counts. One violation fails.
- `01-011`: the spec requires a person who has **not** read the sauna-day configuration to judge
  whether the refusal is actionable. You have read the spec, so you cannot be that person. Collect
  the exact refusal text in `work/blind-review-011.txt`, without the configuration or your answer.
  File this item as `fail` with evidence beginning `not reached: blind human review required`.
  The operator can later arrange that separate review and file its verdict with its own evidence.

Write `work/verdicts.json` as a JSON array in checklist order, exactly one object per ID:

```json
{"id":"01-001","verdict":"pass","evidence":"request, observed response, and checked consequence"}
```

Use only `pass` or `fail`. Every evidence string must name the actual request and observation, or
why that item was not reached. Keep raw requests, responses, and race counts under `work/` and
refer to those files in the evidence. Do not read or write a prior cycle's verdict or score.
Write `work/surprises.json` as a JSON array of unexpected observations (empty if none), each with
`item`, `observation`, and `evidence_file`. Finish after both JSON files are valid and all eleven
items have verdicts.
