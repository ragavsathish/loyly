# clj-spike — whole TypeScript harness → Clojure PoC

**Spike only.** The working Pi path stays on TypeScript under
`harness/pi-durable/` (including `measure/`). This folder explores rewriting
that surface into Babashka Clojure.

Shared oracle tools in `harness/*.clj` are untouched.

## Libraries

Prefer Babashka / CLJ libs over hand-rolled plumbing:

| Concern | Library |
|---------|---------|
| Compact JSON | `cheshire` (built into bb) |
| SHA-256 | `org.clj-commons/digest` (`bb.edn` `:deps`) |
| Files | `babashka.fs` |
| Process / git | `babashka.process` |

**Kept custom:** pretty JSON write + order-preserving read in `hjson.clj` — checklist/score byte shape (`@harness-012`) and key order (`@harness-029`). Cheshire’s defaults do not honour those.

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
| Grader shards | `grader-shards.ts` | ✅ partial | `partition-by-rule` + prepare; combine/Allure deferred |
| Continuation | `continuation.ts` | ✅ | uncarried extract + prompt |
| Allure identity | `evidence-core/validate-identity.ts` | ✅ | pure helpers |
| Allure results | `allure-results.ts` + validate-result | ✅ partial | reader/judge; Ajv schema deferred |
| Cycle phases / adapters | `tasks/*`, `*-adapter.ts` | ⏳ | orchestration + Pi |
| Panel VM | `panel-vm-*` | ⏳ | heavy I/O |
| Pi audit | `audit-rows.ts` | ⏳ | needs Pi sqlite runtime |

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
    panel_selection.clj panel_policy.clj
    grader_shards.clj continuation.clj allure_results.clj
    demo.clj
    evidence/{validate_verdicts,validate_identity,validate_result,panel_*}.clj
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
