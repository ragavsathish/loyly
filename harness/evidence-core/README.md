# Evidence core: Allure schema, panel roles, tool catalog

Adapter-agnostic package shared by Pi durable, Codex cycle, and Cursor cycle.
It owns the approved Allure lifecycle result schema, pure validation of one
result and of projected verdicts, and panel-plan selection / evaluation policy.
Adapters seal digests and runtimes; this package does not launch VMs or call
models.

The legacy measure module under `harness/` (stamp, checklist, score, oracle)
guards denominators. This package validates the Allure bytes those adapters
hand to `score.clj`. Oracle does **not** golden-check Allure.

## Alignment chain

Pin the same freeform **tool** string end to end:

```
panel plan check.tool
  → grader / specialist instruction
  → Allure labels.name=tool
  → evidence-core / adapter seal
  → filed verdicts → score.clj
```

Required Allure labels on every lifecycle result:

| Label | Constraint |
| --- | --- |
| `lifecycle` | exactly one |
| `technique` | ≥1; value from the schema enum |
| `tool` | ≥1; freeform string that must match the pinned producer |

`technique` is closed (see `allure-lifecycle-result.schema.json`). `tool` is
open so a new producer can land without a schema bump — but the panel plan and
adapter must name it before a scored cycle uses it.

## Panel roles

From `types.ts` / `panel-policy.ts`. The filed legacy score remains authority;
the panel cannot silently rewrite it.

| Role | Authority | Rule |
| --- | --- | --- |
| `scored` | files the item verdict | status must be `passed` or `failed` |
| `handoff` | leaves independent review pending | status must be `skipped` (blind raw case) |
| `corroborating` | extra observation | never replaces a scored verdict; non-pass becomes a gap / not-ready |
| `diagnostic` | observability only | non-pass is a gap; never acceptance |

Exactly one `scored` (or handoff→later scored blind) check per selected item.

## Allure instrumentation catalog

Concrete producers used on `feat/pi-whole-loyly` / cursor-cycle. Product panels
(`harness/pi-durable/GRADING-PANEL.md`, `*.panel.json`) instantiate a subset.

| Tool | Technique | Role | Source | Adapters | Runtime | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Pi black-box grader | acceptance / usability | scored + handoff | raw-grader | Pi | gondolin-qemu-vm | HTTP observations; leaves `01-011` pending |
| Codex black-box grader | acceptance / usability | scored + handoff | raw-grader | Codex | gondolin-qemu-vm | Same duty; adapter seals tool string |
| Cursor black-box grader | acceptance / usability | scored + handoff | raw-grader | Cursor | cursor-remote-session or Docker multistack | Remote session needs no container |
| fresh blind subagent | usability | scored | blind-review | Pi · Codex · Cursor | same as grader probe | Sees only refusal+question; HTTP confirm is controller-side |
| Playwright | ui-ux | corroborating | specialist | Pi | gondolin-qemu-vm | Browser journey; screenshots + trace |
| Node.js | acceptance | corroborating | specialist | Pi | gondolin-qemu-vm | Overlapping two-household race |
| OpenTelemetry | tracing | diagnostic | specialist | Pi (booking-core) | gondolin-qemu-vm | Candidate-bound spans/metrics |
| procfs/JFR | profiling | diagnostic | specialist | Pi (whole-product) | gondolin / multistack | `panel-runtime.mjs`; optional JFR |

## Oracle and measure tools (not Allure)

Owned by the shared three-repo harness module. Documented in
[`harness/README.md`](../README.md). Listed here only so agents do not confuse
measure tools with Allure producers.

| Tool | Role | Link to Allure |
| --- | --- | --- |
| `stamp_item_ids.clj` | measure | not Allure |
| `gen_checklist.clj` | measure | not Allure |
| `score.clj` | measure | consumes validated verdicts |
| `scoreboard.clj` | measure | not Allure |
| `oracle.sh` | meta-instrument | guards measure goldens, not Allure bytes |
| `fence.sh` / `verify.sh` | harness loop | precondition to grading |
| **evidence-core** (this package) | validate | owns `allure-lifecycle-result.schema.json` |

## How to add a tool

1. Pick a schema `technique`.
2. Choose a stable `tool` name (the string that will appear in Allure).
3. Add a panel check with `role`, `source` intent, and `target_runtime`.
4. Teach the worker to emit schema-valid Allure with that tool label.
5. Seal the string in the adapter (instruction digest / panel digest).
6. Leave scored authority with the raw grader unless the check is itself
   scored (blind).

Do **not** put this catalog into digest-pinned `grader-instruction*.md`
files; those stay task-narrow. Point agents here from `AGENTS.md` and
`harness/README.md`.

## Adapter coverage (Pi · Codex · Cursor)

| Core API | Pi durable | Codex cycle | Cursor cycle |
| --- | --- | --- | --- |
| `createLifecycle` (via cycle-core) | full build→gate→grade→blind→panel→score | build/gate decide + post-grade next phase | same as Codex |
| `validatePanelCoverage` | yes (live contract / panel) | yes (contract) | yes (contract) |
| `validateVerdictData` | yes | yes | yes |
| `validateResultEvidence` | yes (plus room I/O) | yes (inside checkEvidence) | yes (inside checkEvidence) |
| Ajv full schema compile | Pi allure / panel paths | duplicated in adapter | duplicated in adapter |
| `evaluatePanel` | yes (`panel-compile.mjs`) | not wired (panel reassessment separate) | not wired |

Product blind item `01-011` stays in adapters (instruction digests, pending
rules). Cores take an optional `handoffItem` and never hard-code that id.
Schema Ajv validation and Gherkin identity (`loyly.<slice>.<item>`) still live
in adapters; lifting a pure schema helper into this package is the next
extraction step.

## Package surface

| Path | Duty |
| --- | --- |
| `allure-lifecycle-result.schema.json` | approved result shape |
| `validate-result.ts` | one result evidence shape (timing, steps, attachments) |
| `validate-verdicts.ts` | projected checklist verdicts |
| `panel-selection.ts` | which checks apply to a cut |
| `panel-policy.ts` | evaluate observations vs plan and filed score |
| `types.ts` | `PanelRole`, plan and evaluation types |
