# formal — Löyly verification modules

Own Clojure modules for the **formal-verification road**. Separate from the
assurance modules under `../src/loyly/` (`.cljc` core + `.cljs` Node wrappers).

**Behaviour specs** (outside `docs/plan/` and shared `harness/spec.feature`):

| File | Scope |
|------|--------|
| [`../../cycle.spec.feature`](../../cycle.spec.feature) | Language- and project-agnostic (`@cycle-*`, `@formal-*`) |
| [`../../project/loyly/cycle.spec.feature`](../../project/loyly/cycle.spec.feature) | Löyly pins (`@loyly-cycle-*`, `@loyly-formal-*`) |

| Module | Role |
|--------|------|
| `loyly.formal.models` | Many-sorted carriers 𝒜 (Malli Registry) |
| `loyly.formal.cycle` | Cycle LTS 𝒞 = (Q,q₀,→,L,F) |
| `loyly.formal.props` | Property / generative proofs (I*, C*) |
| `loyly.formal.trace` | Pins to TS JSON Schema + fixtures |
| `loyly.formal.theory` | Closed theory export |
| `loyly.formal.main` | CLI: prove / `--theory` |

```sh
# from repository root
bin/loyly-clj formal
bin/loyly-clj formal --theory
# or from harness/loyly-clj
bb -m loyly.formal.main --root ../..
```

Depends on production product constants and phase lists (`loyly.project.loyly`,
`loyly.cycle-core`, `loyly.digest`, `loyly.hjson`). Assurance modules
call formal models for validation on `:clj`; they do not own the theory.
