# Reassess the selected Löyly items against the frozen candidate

You are a fresh independent black-box Codex grader. Your only working tree is
the private grading room supplied by the operator. Read `checklist.json`, the
selected `plan/<slice>/spec.feature` files, and
`allure-lifecycle-result.schema.json`. Do not read candidate source, tests,
README, a builder transcript, the earlier grade, score, or another checkout.
Treat `impl/` as immutable. Write only under `work/`.

Grade every item in this room's checklist from its own fresh state. The
candidate is mounted read-only into one **new Gondolin VM per item** from the
pinned image. Mount only that item's `work/<id>/` directory writable. In the
VM, copy `/candidate` into a private runtime directory. Install and record
`nodejs=24.22.3-r0` and `icu-data-full=78.1-r0` in that VM, confirm the Node
version, and start the copied app with its normal `start.sh PORT`. Make every
candidate setup call, HTTP observation, and clock change inside that VM.
Record the VM launch command, package install output, clock commands, exit
code, and HTTP requests/responses. Stop and reap the server. A failed VM is
an unreached observation; never infer a pass from the app's own tests.

## Reach real deadlines

Set the **guest system clock** to a known baseline before starting the app,
for example `date -u -s 2030-01-01T08:00:00Z`. Use a future valid date and
time for bookings, offers, and revisions. The app's normal production clock
is the clock under test; do not use a hidden app clock route, demo environment
variable, source code, or direct record edits. Discover the public API from
the served app and its responses.

When a scenario says that an occurrence starts or ends, a choice or lapse
deadline passes, or a policy takes effect, read the actual `startsAt`,
`endsAt`, `chooseAt`, `lapseAt`, or `effectiveAt` returned by the app. Then run
`date -u -s <instant-after-that-boundary>` **inside the same VM** and confirm
the new time from the served app before making the Then observations. Record
the boundary value and both clock readings. Keep the VM and server bounded;
do not wait for a real 14 or 30 days. A clock command that fails is a setup
failure, not a product verdict.

For each item, establish every Given from fresh state, perform its When, and
observe every Then through HTTP. In particular:

- `02-003`, `02-008`: establish a standing holding and a dated offer. Cross
  the offer's actual end or start respectively, then read the offer state,
  standing holding, dated views, and billing consequence required by the
  scenario.
- `03-007`, `03-008`, `03-009`, `03-012`, `03-013`: establish the stated
  holdings, eligible queue, notice, choice, declines, or withdrawal before
  advancing the guest clock. Read actual notice deadlines, then inspect the
  chooser, holdings, queue, posted list, heater, billing, and history needed
  for each Then. Do not infer a lapse from the deadline timestamp alone.
- `04-004`, `04-007`: record an authorized future policy revision. Make
  decisions or create notices on both sides of its effective date as the
  scenario requires. Compare the policy versions and clock lengths actually
  attached to those outcomes.
- `05-004`: read both houses' class-cap policies, establish that house A is
  capped and house B is not, and make the eligible family-time request in B.
  Do not invent a required earlier B booking. A second request in each house
  is a useful discriminating check if free windows remain.
- `05-005`: book a family-time occurrence, cross its actual `endsAt`, then
  request another free upcoming family-time window for the same household.

Use a different fresh state for independent examples. If any Given or Then
cannot be observed, file `failed` with a `statusDetails.message` beginning
`not reached:` and state exactly what was attempted. Never convert a missing
observation into a pass. If an observed response contradicts the spec, file
`failed` and quote the request and response in an attachment.

## Allure result contract

Write one fresh `{uuid}-result.json` per selected item under
`work/allure-results/`, with real attachment files beside it. Each object
must validate against the attached schema. Use:

- `name`: the checklist item name. `fullName`, `testCaseId`, and `historyId`:
  `loyly.<slice-slug>.<item-id>`, where the slug comes from the checklist
  source path.
- `status`: `passed` only after every Then is observed; otherwise `failed`.
  `stage`: `finished`. Include an informative `statusDetails.message`, Unix
  millisecond `start` and `stop`, and named Given, When, and Then `steps` with
  honest statuses.
- `labels`: exactly one each of `lifecycle=pre-production`,
  `technique=acceptance`, `tool=Codex black-box grader`,
  `feature=<Feature title>`, `story=<checklist rule>`, and
  `tag=@item-<item-id>`.
- `attachments`: at least one actual request/response and clock/VM receipt
  file, copied beside the result with a fresh UUID attachment filename and
  its MIME type.

Write `work/surprises.json` as an array (empty if none); each entry has
`item`, `observation`, and an existing `work/`-relative `evidence_file`.
Do not write verdicts or a score. The operator validates and files the
separate reassessment while preserving cycle 04's original evidence and score.
