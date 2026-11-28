# loyly-clj — Production Clojure / ClojureScript Harness for Löyly

Production Clojure/ClojureScript implementation of the Löyly harness and formal
examiner under `harness/loyly-clj/`, with top-level entrypoint `bin/loyly-clj`.

- **Primary core (`.cljc`)**: `src/loyly/**.cljc` (60 namespaces) runs identically
  on **Babashka** (`bb`) and **Node ClojureScript** (`nbb`) via `loyly.platform`.
  Includes measure, contracts, digests, hjson, grading-room, blind-review,
  blind-agent, panel selection/policy/compile/vm/reassess, shards, evidence,
  Codex & Cursor adapters (preflight/candidate/decide/evidence/panel/reassess),
  replay export, Allure rendering, supplemental grading, tasks, and `project/loyly`.
- **Thin Node adapters (`.cljs`)**: `src/loyly/node/*.cljs` (5 namespaces) wraps
  Node async subprocess/HTTP/ESM execution, Pi durable worker phase wiring,
  panel reassessment, replay export, and Allure rendering directly on Node via `nbb`.
- **Minimal `@earendil-works/*` TS extensions**:
  - `harness/pi-durable/pi-extension.ts` — minimal `@earendil-works/pi-durable` /
    `chord` / `pi-ai` SDK bridge (SQLite audit reader + `Harness`/`defineTask`/`defineExtension`).
  - `.pi/harness/builder-host/` — minimal `@earendil-works/gondolin` +
    `@earendil-works/pi-env` + `@earendil-works/pi-coding-agent` builder/grader VM host.
- **Formal verification (`loyly.formal.*`)**: `formal/src/loyly/formal/*.clj`
  models theory $\mathcal{A}$ (28 Malli sorts, invariants I1–I13) and cycle LTS
  $\mathcal{C}$ (invariants C1–C5), pinned to the published JSON Schemas.
- **Shared three-repo oracle tools**: `harness/*.clj` stay untouched for sibling
  parity (`harness/modules.sh`).

## Architecture

| Layer | Files | Runtime | Role |
| --- | --- | --- | --- |
| Primary cross-platform core | `src/loyly/**/*.cljc` | `bb` and `nbb` | Measure, contracts, digests, hjson, grading-room, blind-review/agent, panel selection/policy/compile/vm/reassess, shards, evidence, Codex/Cursor preflight/reassess/decide/candidate/evidence/panel, replay export, Allure rendering, supplemental grade, `project/loyly` |
| Thin Node adapters | `src/loyly/node/*.cljs` | `nbb` (Node) | Async subprocess/HTTP/ESM runtime, Pi durable worker orchestration (`pi_worker.cljs`), Pi backend CLI (`pi_backend.cljs`), Codex/Cursor CLI (`adapters.cljs`, `cli.cljs`) |
| Minimal `@earendil-works/*` TS extensions | `harness/pi-durable/pi-extension.ts`, `.pi/harness/builder-host/*.ts` | Node TS | Thin SDK boundary for `@earendil-works/pi-durable`, `@earendil-works/gondolin`, `@earendil-works/pi-env`, `@earendil-works/pi-coding-agent` |
| Babashka CLI orchestration | `src/loyly/drivers.clj`, `src/loyly/demo.clj` | `bb` | Unified `bin/loyly-clj` front-end + full smoke verification |
| Formal examiner | `formal/src/loyly/formal/*.clj` | `bb` (Malli + `test.check`) | Many-sorted theory $\mathcal{A}$, cycle LTS $\mathcal{C}$, schema traceability |

## Libraries

| Concern | `:clj` (Babashka) | `:cljs` (Node `nbb`) |
| --- | --- | --- |
| Compact JSON | `cheshire` | `js/JSON` (order-preserving) |
| SHA-256 | `org.clj-commons/digest` / `MessageDigest` | `node:crypto` |
| Filesystem | `babashka.fs` | `node:fs`, `node:path`, `node:os` |
| Process / async | `babashka.process` | `node:child_process` + `promesa.core` |
| HTTP | injectable `:fetch-fn` | Node native `js/fetch` (`loyly.node.runtime/fetch-json`) |
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

# Unified cycle CLI (.cljc core + .cljs Node adapter for Pi durable backend)
bin/loyly-clj cycle list
bin/loyly-clj cycle pi --check <live-run.json>
bin/loyly-clj cycle pi --run <live-run.json>
bin/loyly-clj cycle codex preflight|candidate|decide|evidence|panel|reassess <input.json>
bin/loyly-clj cycle cursor preflight|candidate|decide|evidence|panel <input.json>

# Pi durable backend tools (.cljc core + thin .cljs Node adapter)
bin/loyly-clj panel-reassess --check|--run <reassess.json>
bin/loyly-clj worker <scratch> [mode]
bin/loyly-clj export-replay [scratch...] [--out <html-path>]
bin/loyly-clj render-allure <scored-cycle-scratch>
bin/loyly-clj blind-review prepare|probe|file <paths...>
bin/loyly-clj supplemental-grade <original-scratch> <probe-root>

# Direct Node ClojureScript CLI (nbb -m loyly.node.cli ...)
bin/loyly-clj node smoke
bin/loyly-clj node cycle list

# Formal verification (theory 𝒜 + cycle 𝒞)
bin/loyly-clj formal
bin/loyly-clj formal --theory

# Babashka end-to-end smoke
bin/loyly-clj demo
```

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
