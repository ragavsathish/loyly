# loyly-clj — Production Clojure / ClojureScript Harness for Löyly

Production Clojure/ClojureScript implementation of the Löyly harness and formal
examiner under `harness/loyly-clj/`, with top-level entrypoint `bin/loyly-clj`.

- **Shared core (`.cljc`)**: `src/loyly/**.cljc` (55 namespaces) runs identically
  on **Babashka** (`bb`) and **Node ClojureScript** (`nbb`) via `loyly.platform`.
- **Node async & backend adapters (`.cljs`)**: `src/loyly/node/*.cljs` wraps Node
  async execution, native `fetch`, Pi durable workers (`worker.mjs`,
  `reassess-panel.mjs`, sqlite `audit-rows.mjs`), and Codex/Cursor preflight &
  reassessment CLIs directly on Node 22 via `nbb`.
- **Formal verification (`loyly.formal.*`)**: `formal/src/loyly/formal/*.clj`
  models theory $\mathcal{A}$ (28 Malli sorts, invariants I1–I13) and cycle LTS
  $\mathcal{C}$ (invariants C1–C5), pinned to the published JSON Schemas.
- **Shared three-repo oracle tools**: `harness/*.clj` stay untouched for sibling
  parity (`harness/modules.sh`).

## Architecture

| Layer | Files | Runtime | Role |
| --- | --- | --- | --- |
| Cross-platform core | `src/loyly/**/*.cljc` | `bb` and `nbb` | Measure, contracts, digests, hjson, grading-room, blind-review, panel selection/policy/compile/vm, shards, evidence, adapters, tasks, `project/loyly` |
| Node async & backend wrappers | `src/loyly/node/*.cljs` | `nbb` (Node 22) | Async subprocess/HTTP/ESM runtime, Pi `--run` / `panel-reassess` / sqlite audit rows, Codex & Cursor adapters + hook factories (`make-http-fetch-fn`, `make-allure-cli-fn`, `make-spawn-hook`) |
| Babashka CLI orchestration | `src/loyly/drivers.clj`, `src/loyly/demo.clj` | `bb` | Unified `bin/loyly-clj` front-end + full smoke verification |
| Formal examiner | `formal/src/loyly/formal/*.clj` | `bb` (Malli + `test.check`) | Many-sorted theory $\mathcal{A}$, cycle LTS $\mathcal{C}$, schema traceability |

## Libraries

| Concern | `:clj` (Babashka) | `:cljs` (Node `nbb`) |
| --- | --- | --- |
| Compact JSON | `cheshire` | `js/JSON` (order-preserving) |
| SHA-256 | `org.clj-commons/digest` / `MessageDigest` | `node:crypto` |
| Filesystem | `babashka.fs` | `node:fs`, `node:path`, `node:os` |
| Process / async | `babashka.process` | `node:child_process` + `promesa.core` |
| HTTP | injectable `:fetch-fn` | Node 22 `js/fetch` (`loyly.node.runtime/fetch-json`) |
| Formal models | `metosin/malli` + `org.clojure/test.check` | structural predicates + injectable Ajv |

**Kept custom (`.cljc`):** pretty JSON write + order-preserving read in
`loyly.hjson` — checklist/score byte shape (`@harness-012`) and key order
(`@harness-029`) are byte-identical across Babashka and Node.

## Usage

Install Node `nbb` once inside `harness/loyly-clj/`:

```sh
cd harness/loyly-clj && npm install
```

Run via the top-level `bin/loyly-clj` entrypoint from the repository root:

```sh
# Measure tools (.cljc)
bin/loyly-clj gen-checklist --out checklist.json
bin/loyly-clj score 01 --verdicts verdicts.json
bin/loyly-clj scoreboard 01
bin/loyly-clj stamp

# Unified cycle CLI (.cljc core + .cljs Node wrapper for async/backend steps)
bin/loyly-clj cycle list
bin/loyly-clj cycle pi --check <live-run.json>
bin/loyly-clj cycle pi --run <live-run.json>
bin/loyly-clj cycle codex decide|candidate|evidence|panel <input.json>
bin/loyly-clj cycle codex preflight <contract.json>
bin/loyly-clj cycle codex reassess <contract.json>
bin/loyly-clj cycle cursor decide|candidate|evidence|panel|preflight <input.json>

# Panel-only reassessment (.cljs Node wrapper)
bin/loyly-clj panel-reassess --check|--run <reassess.json>

# Direct Node ClojureScript CLI (nbb -m loyly.node.cli ...)
bin/loyly-clj node smoke
bin/loyly-clj node cycle list

# Formal verification (theory 𝒜 + cycle 𝒞)
bin/loyly-clj formal
bin/loyly-clj formal --theory

# Babashka end-to-end smoke
bin/loyly-clj demo
```

Pass `--ts` on `cycle` commands to delegate directly to the underlying TypeScript
CLIs when comparing parity.

## Two roads (assurance ↔ formal models)

Gherkin behaviour specs live in `harness/cycle.spec.feature` (language- and
project-agnostic) and `harness/project/loyly/cycle.spec.feature` (Löyly pins).

| Symbol | Meaning | Code |
| --- | --- | --- |
| $\mathcal{S}$ | sorts (carriers) | `loyly.formal.models/Registry` (28 sorts) |
| $\mathcal{P}$ | $\mathrm{Valid}_s(x)$ | `loyly.formal.models/valid?` |
| $\mathcal{F}$ | $H$, $\delta$, $\Delta$, $\iota$ | `loyly.digest` + `loyly.formal.trace` |
| $\mathcal{I}$ | I1–I13 | `loyly.formal.props` + `loyly.formal.trace` |
| $Q$ | ALL-PHASES | `loyly.formal.cycle/Q` |
| $q_0$ | cut | `loyly.formal.cycle/q0` |
| $\to$ | linear succ | `loyly.formal.cycle/succ` |
| $L$ | phase $\mapsto$ model obligations | `loyly.formal.cycle/labeling` |
| $F$ | $\{\mathrm{done}\}$ | `loyly.formal.cycle/F` |
| C1–C5 | cycle invariants | `loyly.formal.cycle/prove-cycle!` |

## Static analysis

Mirrors `harness/pi-durable` `npm run lint` / `npm run analyze` across `.clj`,
`.cljc`, and `.cljs`:

| TS (`pi-durable`) | `loyly-clj` |
| --- | --- |
| eslint (+ loyly plugin) | `clj-kondo` + `scripts/analyze.clj` product-literal / deep-import rules |
| madge (cycles) | `analyze:deps` |
| knip (unused) | `analyze:dead` (unused namespaces and unused public defs fail) |
| jscpd | `analyze:dupes` (advisory) |
| metrics.mjs | `analyze:metrics` |

```sh
bin/loyly-clj lint
bin/loyly-clj analyze
# or: cd harness/loyly-clj && bb lint && bb analyze
```

Product literals and deep `project.loyly.*` imports are banned outside
`project/loyly/` — import the barrel `loyly.project.loyly` instead.
