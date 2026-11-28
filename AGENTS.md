# Löyly agent instructions

The active cycle driver is Pi durable. Start at `README.md`, then read
`harness/pi-durable/README.md` and `harness/loyly-clj/README.md` when preparing
or operating a cycle. `bin/loyly-cycle` checks and runs a pinned live contract,
and `bin/loyly-clj` provides the production Clojure/ClojureScript harness
(`.cljc` core + `.cljs` Node backend wrappers + formal examiner). The driver
records checkpoints and audit entries in Pi; its replay projects committed
entries and bound Allure evidence. The original `harness/` scripts still
perform the self-check, fence, checklist, gate, score and scoreboard.

Keep planning and implementation separate. `raw/` is immutable source
evidence. `docs/wiki/` and `docs/plan/` carry the domain and behavior; `impl/`
is a disposable build product. A fresh builder sees only the fenced cut and
writes under `impl/`. An independent grader uses a different model, private
Gondolin rooms and the approved Allure schema. Preserve the grader's raw
results, the blind-review handoff, the filed legacy score and the Pi audit.

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
