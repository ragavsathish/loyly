# @item-01-011: independent blind refusal judgment

The earlier inability to delegate to a hosted agent was worked around by running a separate, generally trained local language-model agent. This is real neural inference, not a hand-written reader, a canned answer, an assessment by the builder, or a replay using the API's structured `alternative` property.

## Identity and isolation

- Model: Qwen3-0.6B, Q4_K_M, original artifact SHA-256 `ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a`.
- Five immutable npm byte-fragment dependencies assemble that artifact. `package-lock.json` pins their tarball integrity. The runner checks the assembled model hash before inference. Model license: Apache-2.0; notices and provenance ship with those dependencies.
- Inference: `@hpcc-js/wasm-llama@1.7.0`, llama.cpp in WebAssembly. This works on Linux and macOS without platform-specific builds or an inference service.
- New process and model context for the judgment, empty environment and temporary empty working directory, no inherited transcript or system prompt, no agent tools or model-side filesystem/network interfaces. The model sees only the exact human-facing refusal and neutral question via its input tokens. The inference runtime's virtual filesystem holds the model, not candidate files.
- The runner imports no application code and reads no calendar, house policy, examples, request, API `alternative` object, candidate URL or previous judgment.

## Red → real product change → green

`red-independent-judge.log` records the initial missing agent. More importantly, `independent-judge-attempt.log` records actual independent inference on the original refusal: the model chose the closed room and fresh-state replay returned HTTP 400. `red-independent-first-wording.log` records another failed wording: the judge found it insufficient.

Only the product refusal wording changed after those judgments. It now explicitly identifies an open, free alternative and appends its request fields, derived from the same configured availability record. The judge model, inference settings, question and pass criteria were unchanged. No answer field is inferred or repaired by the test harness.

`green-independent-judge.log` and `01-011-independent-verdict.json` record the successful independent answer and its separate fresh-state HTTP 201 confirmation. The test fails if inference fails, the answer is insufficient or missing fields, or HTTP replay does not confirm those exact coordinates.

The earlier direct `alternative`-based prerequisite test remains intact; it is not counted as a substitute for this new independent test. The externally controlled scoring panel remains free to repeat its own blind assessment.
