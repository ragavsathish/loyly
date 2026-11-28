# Pi & Gondolin extensions and probe assets

This directory holds the three minimal `@earendil-works/*` TypeScript shims
(`pi-extension.ts`, `pi-builder-extension.ts`, `gondolin-vm.ts`), the pinned
JSON Schemas, panel plans, agent instructions, and guest-VM specialist scripts
(`panel-*.mjs`, mounted read-only into Gondolin QEMU VMs). All cycle logic,
builder-host policy/prompt/receipt/steering logic, contract verification,
grading-room management, blind review, panel compilation, and scoring live in
[`../loyly-clj/`](../loyly-clj/) (`.cljc` primary core + thin `.cljs` Node
adapters). The original `harness/` scripts still perform the self-check,
physical fence, checklist, gate, score and scoreboard.

## Run a pinned live cycle

Install dependencies in `harness/loyly-clj` and `harness/pi-durable`. Set
`JAVA_HOME` to Java 21 when required by the contract. Create an ignored JSON
contract matching [`live-run.schema.json`](live-run.schema.json), then run from
the repository root:

```sh
bin/loyly-cycle --check scratch-production-cycle-XX/live-run.json
bin/loyly-cycle --run scratch-production-cycle-XX/live-run.json
```

The contract pins the clean controller and source commits, selected specs and
checklist, agent wrappers and instructions, model names (builder and grader
must differ), Allure schema, panel plan, and VM images.

## Multistack specialist VM image

Build the combined specialist Gondolin image from `Dockerfile.panel-multistack`:

```sh
cd harness/pi-durable
docker build --platform linux/arm64 \
  -f Dockerfile.panel-multistack -t loyly/panel-multistack:oci .
gondolin build --config panel-vm-multistack-build.json \
  --output ../../.pi/harness/.state/assets/panel-multistack \
  --tag loyly-panel:multistack-v1
```

## Panel-only reassessment & audit playback

- Panel-only reassessment (leaves the original cycle outcome unchanged):
  ```sh
  bin/loyly-panel-reassess --check <reassess.json>
  bin/loyly-panel-reassess --run <reassess.json>
  ```
- Export committed Pi audit entries and bound Allure evidence to replay HTML:
  ```sh
  bin/loyly-clj export-replay <cycle-scratch>
  ```
- Render scored Allure report:
  ```sh
  bin/loyly-clj render-allure <cycle-scratch>
  ```

## Typecheck & static analysis

```sh
# Minimal @earendil-works/pi-durable TypeScript extension
(cd harness/pi-durable && npm run check)

# Full Clojure/ClojureScript harness lint, static analysis & formal verification
bin/loyly-clj analyze
bin/loyly-clj formal
```

Read [`PRODUCTION-CANDIDATE.md`](PRODUCTION-CANDIDATE.md) before claiming a
generated app or grading panel is accepted.
