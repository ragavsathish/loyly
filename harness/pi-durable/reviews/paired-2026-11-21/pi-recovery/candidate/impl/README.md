# Löyly implementation

A portable Node.js HTTP application with a browser interface, a persistent booking record and derived posted-list, heater and billing views. Runtime needs only Node.js 18+. Tests install their locked development dependencies with npm: JSDOM, Prettier, and a tool-free WebAssembly language-model judge with pinned Qwen3-0.6B weights (about 397 MB). All artifacts come from the npm registry; no model-provider endpoint is needed. No runtime compilation or dependency installation occurs at boot.

```sh
./impl/test.sh
./impl/start.sh 8901
# open http://127.0.0.1:8901/
```

Both scripts work from any directory. See [API.md](API.md) for the complete public interface and configuration examples; it is also served at `/api-docs`.

## Scope and method

Built from all five ready-for-development slices in `docs/plan/`, in successive test-first increments: core, occurrence releases, scarcity, house policy, class caps, then browser and integrity checks. Tests name all 47 stamped scenarios. The independent blind-judge requirement now runs a separate Qwen3 language-model process with an empty environment, an empty working directory, no tools and no conversation history. Its only task input is the exact HTTP refusal and a neutral question. The judge initially chose the wrong room; HTTP replay failed. The refusal wording was clarified with request fields computed from a free configured slot, without changing the judge or its question. The fresh judge's resulting request is independently confirmed through HTTP against a fresh app record. `evidence/01-011-independent-verdict.json` records the pinned model hash, exact input, raw model output and replay result; no canned judgment, answer repair or fallback is used. [UNCARRIED.md](UNCARRIED.md) is empty. Red/green run logs in `evidence/` show the increments. Additional tests cover persistence across restart, configuration validation and browser workflows over live HTTP.

No list, heater or billing table exists. Each read computes those views from the booking history, occurrence offers and recorded succession outcomes. All writers use one synchronous transaction boundary and atomic replacement of the record before returning. Scope is one server process per record file, not a distributed deployment.

## Configuration choices

- Initial Soukanvuori: ph8 Tuesday only (no invented completion of its week), ph9 Thursday/Friday/Saturday; 90 minutes; shareholder/manager/maintenance/vastikekirjanpitaja roles; manager first-stop disputes. Starts 17:00 and 18:30 are editable fixture choices; 17:00 is the documented example, the second start provides spare capacity for exercising the model.
- Self-service and Masthugget family-cap examples are offered in the house configuration editor. They are not silently imposed on Soukanvuori. Example hours are clearly marked as demonstration calendars. Register households in a newly created house before booking there.
- UTC civil calendar throughout. Standing identity is room + weekday + named start, dated identity is room + date + named start; no fractional-hour slot values. Clock instants and effective dates are ISO UTC. Clock tool is for reproducible scenario exploration; clear it for real time.
- Class caps apply at the same decision boundary to confirmed bookings and accepted released occurrences. Completed dated occurrences do not consume the allowance.
- Scarcity is evaluated through the explicit public command/button; due recorded transitions settle automatically on the next HTTP operation. A notice lacking a selected holding stays visible awaiting the prescribed chooser rather than inventing a default selection. The supplied scenarios specify lapse once selected.
- Role fields are explicit acting-party assertions, not a production authentication system. No real heater control, invoice sending or payment collection is claimed.

Record storage defaults to `impl/data/record.json`; `LOYLY_DATA` can select a different path. Tests use private temporary records under `impl/` and delete them. Never run two processes against the same data path. For an empty local demo, stop the server and remove only its `impl/data/` directory.
