# clj-spike — TypeScript harness → Clojure PoC

**Spike only.** The working Pi path stays on TypeScript
(`harness/pi-durable/`, including `measure/`). This folder explores rewriting
that TS surface into Babashka Clojure.

Shared oracle tools in `harness/*.clj` are untouched.

## Mapping (first vertical slice: measure)

| TypeScript (`pi-durable/measure/`) | Clojure spike |
|------------------------------------|---------------|
| `gen-checklist.ts` | `src/loyly/spike/gen_checklist.clj` |
| `score.ts` | `src/loyly/spike/score.clj` |
| `scoreboard.ts` | `src/loyly/spike/scoreboard.clj` |
| *(planned)* `stamp` parity | `src/loyly/spike/stamp_item_ids.clj` |
| helpers | `src/loyly/spike/hjson.clj` |

## Run

From the repository root:

```sh
bb --config harness/clj-spike/bb.edn gen-checklist --root . --out /tmp/spike-checklist.json
bb --config harness/clj-spike/bb.edn score --root . 02 --verdicts /tmp/verdicts.json
bb --config harness/clj-spike/bb.edn scoreboard --root . 02
```

Or via the wrapper:

```sh
harness/clj-spike/bin/spike gen-checklist --root . --out checklist.json
```

## Next slices (not in this PoC)

- Cycle effects / live-contract checklist derivation
- Score receipt binding
- Broader `pi-durable` task phases

Keep TypeScript authoritative until a slice is proven byte-compatible and adopted.
