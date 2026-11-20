# Booking-core grading panel

The production-candidate cycle now runs this panel as a durable task before
scoring and compiles the five Allure directories after scoring. The historical
last-run demonstration below remains separate from that new cycle; see
[PRODUCTION-CANDIDATE.md](PRODUCTION-CANDIDATE.md).

The panel is a project-specific evaluation plan, not another agent that talks
about a build. The original independent Pi grader remains the scored black-box
judge for the stamped Gherkin items. A fresh blind subagent judges item 01-011
from only the refusal; its exact suggested request is checked over HTTP. Three
specialist tools exercise the same frozen candidate in **parallel Gondolin QEMU
VMs**. Every worker writes one standard Allure result and its evidence files to
its own directory. Allure reads those directories directly when making the one
panel report. There is no result-merging format or rewritten verdict file.

| Check | Selected behavior | Evidence and failure |
| --- | --- | --- |
| Pi black-box grader | 01-001 through 01-010 | Independent HTTP observations for schedule, booking, refusal, second slot, derived views and overlapping requests. A missing or contradicted scenario fails its scored item. |
| Blind subagent | 01-011 | The refusal alone must let a fresh judge name a request confirmed by a fresh app. A non-confirmed exact request fails. The raw grader's pending case remains visible as a handoff. |
| Playwright | 01-003 | Public browser form, persisted holding, three derived views, screenshots and trace. A broken user journey contradicts a pass even if an API works. |
| Node protocol probe | 01-010 | One hundred fresh, overlapping two-household requests; every run must yield one HTTP 201, one held HTTP 409, one holder, consistent views and a clean release. Any deviation fails. |
| OpenTelemetry | 01-003 | A real candidate process handles HTTP 201 and exports a booking span and request metric bound to the candidate, process and probe ID. Missing binding is a diagnostic failure. |

The plan is [booking-core.panel.json](booking-core.panel.json), checked by
`panel-plan.schema.json`. Each worker's result uses the supplied, unchanged
`allure-lifecycle-result.schema.json`; the compiler checks the result and its
attachment hashes and emits `panel-summary.json` under
`panel-summary.schema.json`. The summary groups checks by stamped item and
states the filed score, tool status, runtime, candidate hash, failure criterion,
and remaining gaps. A `passed` specialist case is corroboration or diagnostic
evidence; it never silently replaces a scored verdict. A scored failure or a
conflicting specialist case makes the panel `not-ready`.

The VM launcher verifies the Gondolin image asset, then mounts the candidate
and worker code read-only and a fresh output directory read-write into each
QEMU VM. The three child processes start concurrently with no permitted network
egress except the deliberately nonexistent host; they can use their own
loopback for the app and OTLP receiver. The host appends a VM execution receipt
with the image manifest digest, candidate digest, mount policy, exit code and
timing. It validates each result with the Allure schema before writing the run
manifest. No API key or model call is needed for these deterministic probes.

The candidate launch contract for every specialist is `impl/start.sh PORT` on a
writable copy of the frozen candidate. The public behavior is the measurement;
`server.mjs`, `server.js`, and a particular source language are not part of the
booking specification. A probe that cannot launch the candidate through this
contract reports an instrument failure and leaves that specialist behavior
unobserved. Cycle 05 exposed an older worker revision that hardcoded
`server.mjs`; the revised workers use `start.sh` and support both combined and
separate public derived-view endpoints. The telemetry worker still uses Node's
OpenTelemetry loader, so a non-Node candidate needs a runtime-specific
instrumentation adapter before that diagnostic can be assessed.
`Dockerfile.panel-multistack` and `panel-vm-multistack-build.json` provide a
separate image with Node, Chromium, Babashka, Clojure, Java 21, `jcmd` and
`jfr`. Its smoke run passed the three existing probes against the frozen
cycle-06 Node candidate, and it launched the preserved cycle-04 Babashka app
over HTTP. No JVM or Babashka telemetry claim follows from those smoke runs.

From `harness/pi-durable` after `npm ci`:

```sh
gondolin build --config panel-vm-build.json \
  --output ../../.pi/harness/.state/assets/panel-browser-node \
  --tag loyly-panel:chromium-v1
node panel-vm-run.mjs <scored-cycle-scratch> \
  <Gondolin-image-assets> <new-panel-vm-output>
node panel-compile.mjs <scored-cycle-scratch> \
  <new-panel-vm-output> <new-panel-report-output>
```

The image assets and VM output stay ignored scratch; the build configuration,
worker code, plan and schemas are versioned. The compiler takes the original
grader, blind-review, browser, protocol and telemetry result directories as
**five inputs to `allure generate`**. It verifies the old Pi score and audit
binding and writes a panel summary and report manifest beside the HTML. The
original score file is checked again after compilation.

The last-run demonstration used the candidate at SHA-256
`79481d7eb90f617d58017cb3ec9676c2a00bd0633b58aff918847c10b9bf2657`.
The three QEMU workers passed with 4,030 ms of host execution overlap:
Playwright completed the booking journey; the protocol probe passed 100/100
races; telemetry recorded three candidate-bound spans and 17 metric rows.
The combined Allure report has 15 cases: 13 passed, one raw blind handoff
skipped, and one original blind-review failure. The immutable Pi score is still
**10/11**, so this historical panel is **not ready for acceptance**. The
separate same-candidate 11/11 route correction remains separate evidence.

This panel makes the grading observable and repeatable. It does not invent a
latency budget or turn telemetry presence into a performance pass: the booking
spec gives no duration threshold. JVM/JFR probes belong to the Clojure harness
runtime and can be added when a JVM behavior is selected; this Node booking
candidate is judged through its own HTTP, browser and telemetry behavior.
