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
| Measure | `measure/*` | ✅ | byte-parity with TS |
| Product | `project/loyly/*` | ✅ | + barrel `project/loyly.clj` |
| Score receipt | `score-receipt.ts` | ✅ | bind + verify |
| Evidence verdicts | `evidence-core/validate-verdicts.ts` | ✅ | + pi-durable wrapper |
| Live contract | `live-contract.ts` | ✅ partial | specs, image, derive; Ajv deferred |
| Grading room | `grading-room.ts` | ✅ | digests, prepare, verify |
| Blind review | `blind-review.ts` | ✅ partial | shapes + answer; Allure/HTTP deferred |
| Panel selection/policy | panel-* + evidence-core | ✅ | coverage + evaluate-panel |
| Panel VM workers | `panel-vm-run.ts` | ✅ partial | specialistWorkers / bundle; QEMU deferred |
| Grader shards | `grader-shards.ts` | ✅ partial | partition + prepare |
| Continuation | `continuation.ts` | ✅ | uncarried + prompt |
| Allure | identity + results + validate-result | ✅ partial | Ajv deferred |
| Gate adapter | `gate-adapter.ts` | ✅ partial | receipt reconcile; spawn deferred |
| Builder adapter | `builder-adapter.ts` | ✅ partial | launch lookup / validate; spawn deferred |
| Launch / worker config | `launch-config.ts`, `worker-config.ts` | ✅ | env mapping + parse |
| Blind probe | `project/loyly/blind-probe.ts` | ✅ partial | form action + resolve; HTTP JSON booking deferred |
| Cycle effects | `cycle-effects.ts` | ✅ | command / fence / cut / measure-log |
| Gate / workspace effects | `gate-effects.ts`, `workspace-effects.ts` | ✅ | without Effect-TS runtime |
| Panel adapter | `panel-adapter.ts` | ✅ partial | selectPanelAttempt; VM launch deferred |
| Replay evidence | `replay-evidence.ts` | ✅ partial | summary projection |
| Contracts | `contracts.ts` | ✅ | selected-checklist? |
| Cycle phases | `tasks/cycle-phases.ts` | ✅ partial | PHASES + cut/score helpers; Pi defineTask deferred |
| Panel Allure report I/O | compile report / QEMU | ⏳ | |
| Pi audit | `audit-rows.ts` | ⏳ | sqlite runtime |
| Ajv schemas | live-run / panel-plan / allure | ⏳ | structural checks used instead |

## Layout

```
harness/clj-spike/
  bin/spike  bb.edn
  src/loyly/spike/
    hjson.clj digest.clj receipt_fields.clj
    measure ports, score_receipt, live_contract, grading_room, …
    gate_adapter.clj builder_adapter.clj panel_vm.clj
    demo.clj
    evidence/…  project/loyly/…  project/loyly.clj
```

## Run

```sh
harness/clj-spike/bin/spike demo
harness/clj-spike/bin/spike gen-checklist --out checklist.json
```

## Invariant

TypeScript remains authoritative for Pi cycles until a spike slice is proven
and deliberately adopted. Do not delete or bypass `pi-durable` TS for production runs.
