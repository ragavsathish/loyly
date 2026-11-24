# formal — Löyly verification modules

Own Clojure modules for the **formal-verification road**. Separate from the
spike ports under `../src/loyly/spike/` (legacy assurance).

**Behaviour spec:** [`../pi-durable/spec.feature`](../pi-durable/spec.feature)
(`@formal-*` and `@cycle-*`). Outside `docs/plan/` so it never enters the
product checklist; outside shared `harness/spec.feature` so the three-repo
instrument stays untouched.

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
