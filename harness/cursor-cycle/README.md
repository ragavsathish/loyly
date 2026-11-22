# Cursor cloud-agent cycle adapter

This adapter lets a Cursor orchestrator use `cycle-core` and `evidence-core` for
a selected Löyly slice or the whole-product cut. It does not start agents or
act as a durable driver. The orchestrator prepares a pinned contract, obtains
the operator's exact approval under `AGENTS.md`, fences the selected source,
launches fresh Cursor builder and independent grader agents, runs the legacy
gate, and uses this adapter to decide the next phase and validate Allure before
filing the legacy score.

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

`node cli.ts preflight contract.json` checks the clean controller checkout,
source commit, selected checklist (an ordered subset of the source-derived
items), model separation, instruction digests, panel coverage, Allure schema,
and the remote-or-docker probe boundary.
`node cli.ts candidate candidate-input.json` seals disposable package caches
under `impl/`. `node cli.ts decide attempt.json` applies the three-attempt
`cycle-core` policy. `node cli.ts evidence evidence.json` validates grader and
blind Allure through `evidence-core`. `node cli.ts panel panel.json` runs
`evaluatePanel` over the room's Allure dirs and filed verdicts.

These commands only read evidence and print reports. They do not fence, build,
grade or score. A new scored run needs fresh Cursor agents and a newly approved
pin; no historical Pi or Codex receipt becomes a Cursor score.
