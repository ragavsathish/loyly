# Harness modularization plan

## Implementation status

The first extraction is in place: `cycle-core` owns the Pi-independent
lifecycle, `evidence-core` owns the canonical Allure schema and generic
validation/panel decisions, and the Pi driver imports both. The live contract,
launch environment and cycle effects have typed interfaces. Builder, Gate,
Grade and Panel have moved to typed task modules. Stable `.mjs` entrypoints and
the old schema path remain for existing plans and grader instructions.

The parent Cycle task still orchestrates Pi checkpoints in `worker.mjs`.
Moving that task, and converting the remaining project-specific `.mjs`
adapters, are the next migration steps. They should retain the current
checkpoint and receipt shapes before the compatibility schema copy is
removed.

## Goal and scope

Make the active harness type first and functional: define contracts and
decisions before moving effects, keep cycle policy as pure functions, and make
the Pi driver an adapter. Move the lifecycle into its own folder,
`harness/cycle-core/`, with no Pi dependency. Convert implementation modules
from `.mjs` to `.ts` incrementally. Keep supported command paths and any
`.mjs` filenames pinned by run contracts or panel plans as thin entrypoints.

The first target is `worker.mjs` (1,018 lines). It currently parses launch
state, performs filesystem operations, defines five Pi tasks, selects
transitions, and opens the durable store. `run-live.mjs` mixes approved
contract validation with process launch. Existing `lifecycle.ts` already
contains pure decisions, but sits inside the Pi implementation and imports
a mixed contract file. The new folder makes its independence explicit and
independently checkable.

## Folder and dependency direction

```text
harness/cycle-core/
  types.ts                 cycle inputs, outcomes, decisions, policy
  lifecycle.ts             pure build/gate/grade/assessment transitions
  test/lifecycle.test.mjs  behavior through the public interface
  tsconfig.json            strict, standalone type check

harness/evidence-core/
  allure-lifecycle-result.schema.json  canonical generic result schema
  types.ts                 typed results, verdicts, panel observations
  validate-result.ts       pure schema and evidence-shape validation
  validate-verdicts.ts     pure selected-item coverage and verdict rules
  panel-policy.ts          pure panel evaluation against filed verdicts
  panel-selection.ts       pure generic panel coverage and role checks
  test/                    schema and validation cases

harness/pi-durable/
  run-live.mjs             stable CLI wrapper
  worker.mjs               stable Pi process entrypoint
  live-contract.ts         approved run validation
  launch-config.ts         typed, immutable launch configuration
  cycle-effects.ts         cut, fence, command logs, scope and gate copies
  tasks/{builder,gate,grade,panel,cycle}.ts
  ...grading-room, evidence I/O, blind, score, panel and replay adapters...
```

`cycle-core` takes plain data and returns tagged decisions. It imports no Pi,
Effect, Node I/O, process environment, or Löyly-specific evidence code. The
Pi task adapter translates committed task outcomes into core inputs and core
decisions back into checkpoints. It owns storage, retries, audit commits and
effect execution. The directly shared legacy files in `harness/` remain a
three-repository module and retain authority for self-check, fence,
checklist, gate, score and scoreboard.

`evidence-core` owns the generic Allure schema and pure validation of one
result, verdict coverage, and panel evaluation. It does not read a grading
room or know Pi audit rows. The Pi adapter still checks attachment bytes and
digests, maps results to selected items, checks specialist scripts, applies
the Löyly `01-011` blind-review rule, and projects evidence after committed
audit entries. `panel-summary.schema.json` remains with the panel: its
`loyly.*` identity and filed-score fields are project policy.

## Audit of other modules

| Existing code | Disposition | Reason |
| --- | --- | --- |
| `panel-policy.ts` | Move to `evidence-core/panel-policy.ts` with its panel types | `evaluatePanel` is a pure decision over a plan, filed items and observations; it does not import Pi or I/O. |
| `panel-selection.mjs` | Split generic checklist coverage and role checks into `evidence-core`; keep legacy `01-011` policy and script/bundle checks in the Pi adapter | The current function mixes reusable selection rules with Löyly's v1 blind handoff and filesystem checks through `specialistWorkers`. |
| `validate-verdicts.ts` | Split pure verdict shape, order and completeness checks into `evidence-core`; keep room reads, attachment checks and the blind-review file check in the adapter | The scorer-facing denominator rule is reusable, while proof of a file is an effect. |
| `allure-results.mjs` | Split generic result validation into `evidence-core`; keep Gherkin identity, room reads, digests, surprises and blind policy in the adapter | Its current interface reads a particular room layout and applies project rules. |
| `grader-shards.mjs` | Convert to TypeScript in the grader adapter; leave `partitionByRule` there | The pure partition is small and tied to `docs/plan/NN-name/spec.feature` and grader shard IDs. Moving it alone would create a shallow interface. |
| `continuation.ts` | Keep builder policy and `UNCARRIED.md` handling in the adapter; extract pure parsing internally as needed | Its prompt, item syntax and file contract belong to this builder workflow. |
| `panel-adapter.mjs` | Keep durable attempt selection beside the Pi panel adapter | It coordinates filesystem receipts, atomic writes and restart behavior; a pure decision helper can be extracted only if the effect seam benefits. |
| `grading-room.mjs`, `score-receipt.mjs`, `replay-evidence.mjs`, `audit-rows.mjs` | Keep as typed I/O and Pi adapters | They bind candidate, score and audit bytes to concrete rooms and committed events. |
| `blind-review.mjs`, `blind-agent-adapter.mjs`, `panel-candidate.mjs`, `runtime-profile-evidence.mjs` | Keep with project and specialist adapters | They encode the refusal format, app HTTP surface, or Löyly-specific runtime metrics. |
| `live-run.schema.json`, `panel-plan.schema.json`, `panel-summary.schema.json`, `panel-otel-metrics.schema.json` | Keep beside the owning Pi, panel or project adapter | They contain Pi launch fields, legacy v1 rules, filed score identity, or specialist metric names. |
| `.pi/harness/builder-host/` | Keep as its own typed Pi/Gondolin adapter | `host.ts`, `turn.ts`, `vm-tools.ts` and `vm-daemon.ts` depend on Pi or Gondolin; `policy.ts` names this builder VM's mounts, user and allowed hosts. Pure timeout helpers in `host.ts` can be tested in place. |
| `bin/loyly-cycle`, `bin/loyly-panel-reassess` | Keep as stable shell entrypoints | They only dispatch to the corresponding Pi CLI. |
| Directly shared legacy files in `harness/` | Keep in the three-repository module | Their byte identity and adoption are enforced by `harness/check.sh`; moving them would change that separate contract. |

This audit covers the top-level Pi driver, builder host, entrypoints and
legacy harness. A `.ts` conversion is still useful for modules that stay in
an adapter; file type alone does not make a module part of a core.

## Invariants to preserve

1. A scored live run starts only from a checked, operator-approved JSON
   contract with the exact source commit, selected item IDs, spec/checklist
   digests, agent instruction and wrapper digests, panel plan and image
   digests. A changed approved input requires a fresh approval and build.
2. The fence, self-check, checklist, gate, score, and scoreboard remain the
   original `harness/` commands. The builder writes only under `impl/` in its
   fenced cut; grading remains independent and isolated.
3. Pi task names, versions, checkpoint phase names and shapes, audit schema
   and entry order, receipt paths and contents, and replay projection remain
   compatible with existing scratch stores and controller restarts.
4. Raw grader results, the `01-011` blind handoff in the v1 contract, filed
   legacy score, panel manifest, Allure directories, and Pi audit remain
   separately bound. A panel reassessment never changes the original cycle.
5. Runtime entrypoint and pinned panel-worker `.mjs` filenames stay stable;
   renaming them would invalidate plans and receipts. Do not change the v1/v2
   contract or approved schema as part of this refactor.

## Type-first module interfaces

1. Define the core input and decision unions in `cycle-core/types.ts` first.
   Express success, retryable failure and terminal failure explicitly,
   including attempt bounds and optional evidence references. Keep these
   types free of Pi tasks and checkpoints.
2. Define a typed `ValidatedRun` produced by `live-contract.ts`. Validate
   JSON and digests at the edge; pass the validated value inward rather than
   re-reading untrusted JSON or environment values in every task.
3. Define narrow effect interfaces for legacy commands, candidate
   preparation, agent runs, evidence verification and audit append. Use
   explicit input/output types and structured failures.
4. Make pure functions calculate transitions and assessment order. Keep file
   writes, subprocesses, clocks and Pi commits in adapters. Avoid wrappers
   that merely rename a single call.
5. Define a typed Allure result and pure validator in `evidence-core`. Split
   generic shape checks from `allure-results.mjs`; keep grading-room reads,
   attachment existence and digest checks, checklist identity, surprise
   handling and Pi replay projection in typed adapters.
6. Move `evaluatePanel` and generic verdict and panel selection rules into
   `evidence-core`. Let adapters supply already-read, validated data and
   perform project-specific v1 blind and specialist script checks.

Existing `contracts.ts` mixes lifecycle, panel and checklist types. Move only
lifecycle types to `cycle-core/types.ts`; keep panel/checklist types with
their owning modules. The independent core must not import the Pi directory
to reuse a type.

## Sequence

1. **Capture compatibility.** Record Pi task names, versions, checkpoint
   phase names and shapes, audit schema and entry order, receipt paths and
   contents, score input, panel manifest and replay output. Use the fixture
   and restart tests as the baseline.
2. **Extract cycle core.** Move `createLifecycle` and its types to
   `harness/cycle-core/`; update imports and tests. Add a standalone strict
   type check and a dependency check rejecting Pi, Effect, Node I/O and
   project imports in that folder. Preserve current decision values.
3. **Type the run contract.** Extract validation from `run-live.mjs` into
   `live-contract.ts`; extract worker environment parsing into
   `launch-config.ts`. Keep `run-live.mjs` as the CLI and retain its
   `checkLiveRun` export for existing callers. Test v1 blind selection, v2
   direct grading, multi-spec matching, dirty trees, changed digests and
   invalid panel bundles.
4. **Type the effects.** Move cut, fence, command logging, builder scope and
   gate-copy operations to `cycle-effects.ts`. The interface returns bound
   evidence or structured failure; legacy scripts still execute the checks.
   Test digest mismatch and restart cases at this seam.
5. **Convert tasks one at a time.** Move Builder, Gate, Grade and Panel into
   `tasks/*.ts`, then the parent Cycle task. Preserve Pi registration names
   and versions, checkpoint payloads, commit ordering, raw grader results,
   blind handoff, score filing and panel separation. Compare receipts and
   audit rows after each move.
6. **Convert remaining internal `.mjs` modules by responsibility.** Start
   with pure or nearly pure modules; migrate I/O adapters after their
   interfaces are typed. Keep `worker.mjs`, `run-live.mjs` and pinned panel
   worker filenames as `.mjs` entrypoints importing `.ts` modules. Update
   test imports and runtime packaging together, including the Node 24 panel
   VM. Do not rename a filename embedded in an approved plan or receipt.
7. **Extract generic evidence policy.** Move the canonical Allure result
   schema, pure result validation, panel evaluation, and generic verdict and
   panel selection rules into `harness/evidence-core/`. First
   preserve the current schema bytes and pinned digest. Update every schema
   path in contract checking, grading-room copies, panel workers, tests and
   docs together. Keep the grading-room filename unchanged. A temporary
   compatibility copy at the old source path must be checked byte for byte
   and removed once no caller needs it. Keep `replay-evidence` in the Pi
   adapter because it follows committed audit rows.
8. **Finish composition and documentation.** `worker.mjs` should only load
   validated configuration, compose adapters and tasks, open Pi storage and
   start or resume the cycle. Update the Pi guide without rewriting
   historical evidence or acceptance claims.

## Verification and completion

- Run standalone cycle and evidence core type checks and tests, Pi
  `npm run quality` and the serialized `npm test` in `harness/pi-durable`.
- Run the legacy `harness/check.sh` self-check and verify shared-file adoption;
  this refactor should not edit directly shared legacy bytes.
- Exercise fixture cycle, failed gate and bounded repair, interrupted builder,
  resumed grading/panel, v1 blind handoff, and v2 direct-grade paths. Compare
  checkpoint names, audit entries, receipt bindings, filed score input and
  replay evidence against the captured baseline.
- Use fixture runs and read-only contract checks for refactor verification.
  A scored live cycle is a separate operator-approved activity.

Complete when both core folders pass independently, internal behavior is
typed and functional at decision seams, both contract versions behave as
before, existing Pi stores reopen, evidence remains bound and separate, and
`worker.mjs` only composes modules and starts the durable runtime.
