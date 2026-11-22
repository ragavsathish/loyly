# Löyly agent instructions

## Philosophy

Documentation is the source of truth; code is a disposable **build product**.
The specification is what we look after over time. Deleting and regenerating
`impl/` is not a catastrophe — it is a measurement of how complete the docs
are.

The method comes from a real failure. At Soukanvuori a standing booking lived
as three hand-kept copies (posted list, heater programme, invoice charge).
They drifted; a resident stood in a cold sauna. The lesson applies to the app
and to this repo:

- **One record, derived views.** The booking record is the single source of
  truth; list, heater and billing are readings of it, never copies. In the
  repo, docs are the single source of truth and code is a reading of them.
- **One product, many houses.** House rules differ by configuration. A house
  the model cannot express is a design bug, not a hard-coded exception.

Read `docs/wow/way-of-working.md` and `docs/wow/invariants.md` before changing
domain behaviour. Rules without a named enforcement point are wishes.

### Layer pipeline (no drift)

```
raw/ (immutable) → docs/wiki/ → docs/plan/ → impl/ → gate → score
```

1. `raw/` — real sources; never edit, only cite.
2. `docs/wiki/` — domain distilled from sources; every claim cites `raw/`.
3. `docs/wow/` — the method, invariants, and agent harness.
4. `docs/plan/` — slices: plan, Gherkin, tickets, decisions.
5. `harness/` / cycle drivers — fence, gate, grade, score.
6. `impl/` — build product; intentionally regenerable.

### Load-bearing rules

- **No plan, no code.** Behaviour changes start as a slice under `docs/plan/`
  (plan, `spec.feature`, tickets). No slice → write the slice first.
- **Minimum reference.** Every internal document cites at least one other
  document. A claim that rests on nothing is not finished.
- **Spec/implementation firewall.** `docs/wiki/` and `docs/plan/` never name a
  language, framework, database, hosting, vendor or UI toolkit. Stack choices
  live only under `impl/`.
- **INV-1…5** in `docs/wow/invariants.md`: no invented domain rules; specs stay
  stack-free; standing-slot cap in one place; slots are domain coordinates;
  tests derive from `spec.feature` (RED/GREEN), never from existing code.
- **Same domain names at every layer.** A Gherkin/code name mismatch is a bug.

Keep planning and implementation as separate invocations. Plan only in plan
phases; implement only from an approved slice.

## Cycle operation

The active cycle driver is Pi durable. Start at `README.md`, then read
`harness/pi-durable/README.md` when preparing or operating a cycle.
`bin/loyly-cycle` checks and runs a pinned live contract. The driver records
checkpoints and audit entries in Pi; its replay projects committed entries and
bound Allure evidence. The original `harness/` scripts still perform the
self-check, fence, checklist, gate, score and scoreboard.

`harness/cursor-cycle/` is a Cursor-orchestrator adapter over the same
`cycle-core` and `evidence-core`. It does not replace Pi as the active driver.
Remote-session Cursor runs need no extra container; host-machine Cursor runs
isolate probes in Docker from `harness/pi-durable/Dockerfile.panel-multistack`.

`cycle-core` decides phases; `evidence-core` validates Allure and panel
evidence (one job each). Tool catalog, panel roles, and the
panel.tool → instruction → labels.tool → adapter seal chain live in
`harness/evidence-core/README.md`. Oracle/measure tools stay in
`harness/README.md`; do not confuse the two.

A fresh builder sees only the fenced cut and writes under `impl/`. An
independent grader uses a different model, isolated probe runtime, and the
approved Allure schema. Preserve the grader's raw results, the blind-review
handoff, the filed legacy score and the cycle audit. Derived views in a
candidate (list, heater, billing) must remain readings of one booking record;
disagreement between them is a product defect (see `01-008`).

Before a scored live cycle, present the exact source commit, selected item IDs
and checklist/spec digests, agent instruction and wrapper digests, panel plan
and image digests for operator approval. Pin them in the ignored JSON run
contract. A changed spec or grader instruction requires a new approval and a
fresh build. A panel-only reassessment uses `bin/loyly-panel-reassess` with a
separate pinned contract and leaves the original cycle outcome unchanged.

Promotion of a generated app requires a passing gate, reviewed item evidence,
a filed score and an explicit acceptance decision. The current Pi driver is
the repository's active workflow by operator direction; its latest integrated
cross-stack grading and specialist panel remain under review. Read
`harness/pi-durable/PRODUCTION-CANDIDATE.md` before claiming
the app or grading panel is accepted.

The directly shared legacy files in `harness/` are a three-repository module;
`harness/check.sh` verifies their adoption. Keep those bytes aligned with the
sibling repositories when changing them. Put Pi-specific commands in `bin/`
or the Pi implementation directory.
