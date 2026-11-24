# formal — Löyly verification modules

Own Clojure modules for the **formal-verification road**. Separate from the
spike ports under `../src/loyly/spike/` (legacy assurance).

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
# from harness/clj-spike
bin/spike formal
bin/spike formal --theory
bb -m loyly.formal.main --root ../..
```

Depends on spike product constants and phase lists (`loyly.spike.project.loyly`,
`loyly.spike.tasks.cycle-phases`, digests/hjson). Spike ports may call models
for structural validation; they do not own the theory.
