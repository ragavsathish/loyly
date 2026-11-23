# Grade the selected Löyly product slices through the public surface

You are a fresh grader. You did not build this candidate. Work only in this grading room. Read
`checklist.json`, each `plan/<NN-slice>/spec.feature` named by its selected items' `source`
fields, and `allure-lifecycle-result.schema.json`; these define your selected rule scopes and
the result contract. Your room contains only the plans selected for this shard. Grade every
item in `checklist.json`, including items from more than one slice if present.
The candidate is under `impl/`. Do not read its source, tests, build files, notes, or any builder
claim. Treat `impl/` as immutable: do not execute its scripts or start the app from that path,
because the app may write runtime state beside its code. For each independent item, first copy
`impl/` to a fresh `work/runtime-<item-id>/` (for example, `cp -R impl work/runtime-01-001`).
Run the copied `test.sh` there if preparation is needed, and start the copied `start.sh PORT`.
Use a separate fresh copy for each item. A test result is never an item verdict.
Observe product behavior through HTTP after starting the copied app. The prior gate passed;
you must still make your own observations on fresh state. Write all your files under `work/`.
Keep each app process bounded: start it, wait for HTTP readiness, make the observations, stop it,
and reap it. Never use a bare shell `wait` on a long-lived server; that waits until the server
exits and can hold the grader for the full tool timeout. The grading VM caps each shell call at
five minutes as a recovery bound, not as permission to leave a server running.

Grade only the items in this room's `checklist.json`. For each item, set up the stated Given conditions from fresh state, make the When request, and
observe every Then. Discover the public interactions from the served app, not its source. Use a
different fresh state for independent examples. A missing interaction or an unobservable result is
a fail with evidence beginning `not reached:`. Do not infer behavior from a page title, a green
suite, a fixed answer, or another item's result.

For a deadline scenario, set a known baseline with `date -u -s` inside its fresh
Gondolin VM before app startup. Read the actual start, end, choice, lapse or
effective instant from the served app. Advance the guest clock past that
instant inside the same VM, confirm the changed clock through the served app
where it exposes time, and then observe every stated consequence over HTTP.
Record the boundary, clock commands and responses. A failed clock command is
an unreached setup, not a product verdict. Use the normal app clock; do not
use hidden clock controls, source edits or direct record changes.

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
- `01-011`: the spec requires a fresh independent subagent with **no prior context or
  configuration** to judge whether the refusal is actionable. You have read the spec, so you
  cannot be that subagent. Collect
  the exact refusal text in `work/blind-review-011.txt`, without the configuration or your answer.
  The refusal must let the blind subagent identify a room, weekday and start time;
  the app derives the end of the slot.
  File this item's Allure result as `skipped`, `stage: "pending"`, with a `statusDetails.message`
  beginning `not reached: blind subagent review required`.
  The controller gives only this refusal to a fresh subagent, then probes its suggested request
  over HTTP and files a separate review result. Do not guess its verdict.
- For any selected occurrence-release item: distinguish the recurring standing holding from
  one dated occurrence. Observe the release, the taker or unclaimed outcome, later weeks,
  and the list, heater and billing readings through the app. A FREE offer leaves the normal
  standing fee with the holder and charges no occurrence fee to the taker. A SALE offer needs
  a distinct resale signal. Do not invent a price or withdrawal rule absent from its spec.

Write one `{uuid}-result.json` per item under `work/allure-results/`, with fresh UUIDs and actual
attachment files beside the results. Each JSON object must validate against the attached schema.
Use the following Allure fields for every item:

- `name`: the checklist item's name; `fullName`, `testCaseId`, and `historyId`:
  `loyly.<slice-slug>.<item-id>` (stable across runs), where `slice-slug` is the name after the
  `NN-` prefix in the checklist item's `docs/plan/NN-<slice-slug>/spec.feature:line` source.
- `status`: `passed` only when you observed every Then; otherwise `failed` or, for `01-011`,
  `skipped`. `stage`: `finished` except `01-011`'s `pending`.
- `statusDetails.message`: the request, observed response, and checked consequence; begin with
  `not reached:` if you could not exercise the scenario.
- `start` and `stop`: Unix milliseconds for the check, with `stop >= start`.
- `labels`: exactly one `lifecycle=pre-production`, one `technique=acceptance` (use `usability`
  for `01-011`), one `tool=Pi black-box grader`, `feature=<the Feature title in that item's
  spec.feature>`, `story=<the checklist rule>`, and `tag=@item-<item-id>`.
- `steps`: named Given, When, and Then observations from the Gherkin scenario. Mark their Allure
  status and stage. A step you could not reach must say so; do not fabricate a passed step.
- `attachments`: at least one actual request/response or measurement file for each result. Name
  each copy with a fresh `{uuid}-attachment.<ext>` filename and its MIME type. For `01-011`, attach
  the blind-review text. The attachment bytes must be in `work/allure-results/` beside the JSON.

Keep the raw requests, responses, and race counts under `work/`. Write `work/surprises.json` as a
JSON array of unexpected observations (empty if none), each with `item`, `observation`, and a
`work/`-relative `evidence_file`. Do not write `work/verdicts.json`: the controller derives that
legacy scorer input from these validated Allure results. Do not read or write a prior cycle's
verdict or score. Finish after every selected item's Allure result and `surprises.json` are valid.
