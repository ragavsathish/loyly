# clj-spike — whole TypeScript harness → Clojure PoC

**Spike only.** The working Pi path stays on TypeScript under
`harness/pi-durable/` (including `measure/`). This folder explores rewriting
that surface into Babashka Clojure.

Shared oracle tools in `harness/*.clj` are untouched.

## Status

| Area | TS source | Spike | Notes |
|------|-----------|-------|-------|
| Measure | `measure/*` | ✅ | `gen_checklist`, `score`, `scoreboard`, `stamp_item_ids` |
| Product | `project/loyly/*` | ✅ | identity, blind-policy, schemas, blind-answer |
| Score receipt | `score-receipt.ts` | ✅ | bind + verify |
| Evidence verdicts | `evidence-core/validate-verdicts.ts` | ✅ | + pi-durable wrapper |
| Live contract | `live-contract.ts` | ✅ partial | specs, image, derive checklist; Ajv + panel VM deferred |
| Grading room | `grading-room.ts` | ✅ | digests, prepare, verify |
| Blind review | `blind-review.ts` | ✅ partial | shape/packet file checks + answer parse; Allure/HTTP probe deferred |
| Panel selection | `panel-selection.ts` + evidence-core | ✅ | coverage; Ajv schema deferred |
| Panel policy | `panel-policy.ts` + evidence-core | ✅ | `evaluate-panel` |
| Cycle phases / adapters | `tasks/*`, `*-adapter.ts` | ⏳ | orchestration + Pi |
| Panel VM / Allure | `panel-vm-*`, `allure-*` | ⏳ | heavy I/O |

## Layout

```
harness/clj-spike/
  bin/spike
  bb.edn
  src/loyly/spike/
    hjson.clj digest.clj
    gen_checklist.clj score.clj scoreboard.clj stamp_item_ids.clj
    score_receipt.clj live_contract.clj
    grading_room.clj validate_verdicts.clj blind_review.clj
    demo.clj
    evidence/validate_verdicts.clj
    project/loyly/{identity,blind_policy,schemas,blind_answer}.clj
```

## Run

```sh
harness/clj-spike/bin/spike gen-checklist --root . --out checklist.json
harness/clj-spike/bin/spike score --root . 02 --verdicts verdicts.json
harness/clj-spike/bin/spike scoreboard --root . 02
harness/clj-spike/bin/spike stamp --root .
harness/clj-spike/bin/spike demo --root .
```

## Invariant

TypeScript remains authoritative for Pi cycles until a spike slice is proven
and deliberately adopted. Do not delete or bypass `pi-durable` TS for production runs.
