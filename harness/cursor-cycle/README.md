# Cursor cloud-agent cycle assets

This directory holds the Cursor-specific builder, booking/product grader and
blind instructions, subagent preambles, and panel plans. All adapter logic
(`preflight`, `candidate`, `decide`, `evidence`, `panel`) lives in
`harness/loyly-clj` (`loyly.adapters`, `.cljc`) and is invoked via
`bin/loyly-clj cycle cursor ...`.

## Isolation

| Launch | Probe runtime | Extra container |
| --- | --- | --- |
| Cursor remote session | `cursor-remote-session` | None — the remote session is the boundary |
| Host machine | `docker` | Required — candidate setup, HTTP probes and blind confirmation run in Docker |

Host Docker isolation reuses the existing multistack image from
[`../pi-durable/Dockerfile.panel-multistack`](../pi-durable/Dockerfile.panel-multistack)
(Node, Chromium, Babashka, Clojure, Java 21). Build it as in the Pi guide:

```sh
cd harness/pi-durable
docker build --platform linux/arm64 \
  -f Dockerfile.panel-multistack -t loyly/panel-multistack:oci .
```

Pin the Dockerfile bytes and the built image digest/manifest in the contract.
A remote-session contract must not pin Docker inputs.

## CLI

`bin/loyly-clj cycle cursor preflight contract.json` checks the clean
controller checkout, source commit, selected checklist (an ordered subset of
the source-derived items), model separation, instruction digests, panel
coverage, Allure schema, and the remote-or-docker probe boundary.
`bin/loyly-clj cycle cursor candidate candidate-input.json` seals disposable
package caches under `impl/`. `bin/loyly-clj cycle cursor decide attempt.json`
applies the three-attempt `loyly.cycle-core` policy.
`bin/loyly-clj cycle cursor evidence evidence.json` validates grader and blind
Allure through `loyly.evidence.*`. `bin/loyly-clj cycle cursor panel panel.json`
runs `evaluate-panel` over the room's Allure dirs and filed verdicts.

These commands only read evidence and print reports. They do not fence, build,
grade or score. A new scored run needs fresh Cursor agents and a newly approved
pin; no historical Pi or Codex receipt becomes a Cursor score.
