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

## Two roads (assurance ↔ models)

The spike mirrors the harness’s dual path to independent examination:

| Road | In the spike |
|------|----------------|
| **Legacy assurance** | Gate / grade / blind / panel workers — systematic evaluation with injectable spawn/QEMU/HTTP |
| **Formal / model traceability** | Digests, receipts, structural schema validators (`evidence/validate_schema.clj`), live-contract pins |

Certification stays outside the builder: an independent grader + panel confirms the process. Runtime backends (Pi sqlite, Gondolin, Ajv compile, Effect/`defineTask`) remain injectable hooks so the CLJ API is complete without claiming those infra pieces run in Babashka.

## Status

| Area | TS source | Spike | Notes |
|------|-----------|-------|-------|
| Measure | `measure/*` | ✅ | byte-parity with TS |
| Product | `project/loyly/*` | ✅ | + barrel; `public-json-booking` (`:fetch-fn`) |
| Score receipt | `score-receipt.ts` | ✅ | bind + verify |
| Evidence verdicts | `evidence-core/validate-verdicts.ts` | ✅ | + pi-durable wrapper |
| Live contract | `live-contract.ts` | ✅ | specs, pins, `check-live-run`; schema structural |
| Grading room | `grading-room.ts` | ✅ | digests, prepare, verify |
| Blind review | `blind-review.ts` | ✅ | prepare/validate/Allure; probe via `:probe-fn` |
| Panel selection/policy | panel-* + evidence-core | ✅ | coverage + evaluate-panel |
| Panel VM | `panel-vm-run.ts` | ✅ | verify + `run-panel-vms` (`:gondolin-fn`) |
| Grader shards | `grader-shards.ts` | ✅ | partition + prepare + combine |
| Continuation | `continuation.ts` | ✅ | uncarried + prompt |
| Allure | identity + results + validate-result | ✅ | + structural schema stand-in |
| Gate / builder | `*-adapter.ts` | ✅ | reconcile + `run-*` injectables |
| Launch / worker config | `launch-config.ts`, `worker-config.ts` | ✅ | env mapping + parse |
| Cycle / gate / workspace effects | `*-effects.ts` | ✅ | without Effect-TS runtime |
| Panel adapter / compile | `panel-*.ts` | ✅ | durable panel + compile (`:allure-cli-fn`) |
| Replay evidence | `replay-evidence.ts` | ✅ | `project-replay-evidence` (injected rows) |
| Contracts | `contracts.ts` | ✅ | selected-checklist? |
| Cycle phases / tasks | `tasks/*` | ✅ | ALL-PHASES + thin task wrappers; Pi runtime injectable |
| Pi audit | `audit-rows.ts` | ✅ | `audit-rows.json` / `:read-fn` (sqlite deferred) |
| Schema compile | Ajv | ✅ | structural validators; real Ajv injectable |

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

## Static analysis (TS parity)

Mirrors `harness/pi-durable` `npm run lint` / `npm run analyze`:

| TS | CLJ spike |
|----|-----------|
| eslint (+ loyly plugin) | `clj-kondo` + `scripts/analyze.clj` product-literal / deep-import rules |
| madge (cycles) | `analyze:deps` |
| knip (unused) | `analyze:dead` (unused namespaces and unused public defs fail) |
| jscpd | `analyze:dupes` (advisory) |
| metrics.mjs | `analyze:metrics` |

```sh
harness/clj-spike/bin/spike lint
harness/clj-spike/bin/spike analyze
# or: cd harness/clj-spike && bb lint && bb analyze
```

Install `clj-kondo` on `PATH` (or `~/.local/bin`) for the lint gate. Product literals and deep `project.loyly.*` imports are banned outside `project/loyly/` — import the barrel `loyly.spike.project.loyly` instead (Clojure best practice matching the TS eslint plugin).

## Invariant

TypeScript remains authoritative for Pi cycles until a spike slice is proven
and deliberately adopted. Do not delete or bypass `pi-durable` TS for production runs.
