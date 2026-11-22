# Paired whole-product run: Pi durable 07 and Codex-only 08

The operator approved the same 47 stamped items on controller `4080780ba45d44082902a14dc850b7ff0e3ce9be` and source `7e2fb1c0ba88c6b941a296a1298b89dd0bd5db5a`. The ordered checklist SHA-256 is `06f0dba7ba9aa07152950cd0bc6c38560f6c6b95a3fa88354909a4561434dda2`. Both arms used fresh Sol builders, independent Terra graders, fresh Sol blind reviewers, the same grader image and the same Allure schema. They ran in sequence because the host had about 13 GiB free.

| Stage | Pi durable 07 | Codex-only 08 |
| --- | --- | --- |
| Build | One Pi session, three bounded continuations, no uncarried items | One fresh Codex Sol builder, no uncarried items |
| Independent legacy gate | Passed attempt 1; 64 tests | Passed attempt 1; 47 tests and boot probe |
| Raw grader | Six Terra VM shards; 46 passes, `01-011` pending | Three Terra VM shards; 35 passes, 11 fails, `01-011` pending |
| Blind review | Fresh Sol named room 8, Tuesday 17:00; host confirmer could not resolve the house | Fresh Sol named the same request; fresh VM confirmed it over HTTP 200 |
| **Official outcome** | **Terminal failed before panel and score** | **36/47 scored** |
| Separate diagnostic | Fresh VM confirmed the blind request; validated 47/47 **projection** | None added to the filed score |

The Pi audit stopped at `blind-review failed`: the pinned host adapter assumed one unique self-service room and threw `blind room is not unique in the public self-service API`. This candidate has a manager-mediated house and requires its public house route and role fields. The preserved supplemental probe first observed HTTP 404 on the wrong route and 403 without role fields, then used the public UI and `/api/houses` to confirm the blind agent's request with HTTP 200. The projection validated the 47 Allure results and ran the legacy scorer in an isolated clone; it did **not** add a panel or score fact to the original Pi audit. `pi-07/audit.v1.jsonl`, `pi-07/blind-review-error.log`, `pi-07/allure-results/`, and `pi-07/supplemental-receipt.json` preserve this distinction. Pi surprises: `[]`.

Codex's official failed IDs are `03-001`, `03-003`, `03-004`, `03-005`, `03-014`, `04-007`, and `05-001`–`05-005`. All 11 were recorded as **not reached**. The grader could not establish a self-service queue or family-time cap in the default manager-mediated house; `04-007` lacked an observed later notice under revised policy. This is insufficient black-box evidence for those scenarios, not proof that their behavior is absent. Codex's one surprise was an initially misread race response count for `01-010`, corrected from recorded responses. See `harness/cycles/08/` for the filed score, raw Allure evidence, blind VM confirmation, and exact pins.

There is **no official score-to-score comparison** for this pair. Comparing Codex's filed 36/47 with Pi's separately labeled 47/47 projection gives 11 failing IDs in Codex and no uniquely passing ID. Against the previous official Codex cycle 06 (46/47), cycle 08 newly passes `02-001`, newly fails the 11 IDs above, and changes by −10 net. Neither generated app is accepted. The next instrument work is to make the Pi blind confirmer follow the candidate's public house/role contract and to make black-box grading establish each scenario's configured house and clock before interpreting a missing observation as a product failure. Any revised grader instrument needs a new pinned approval before a scored run.
