# Codex-only whole-product cycle 08

This is the Codex arm of the approved paired run. `run-contract.json` is the exact pinned contract: controller `4080780ba45d44082902a14dc850b7ff0e3ce9be`, source `7e2fb1c0ba88c6b941a296a1298b89dd0bd5db5a`, and 47 selected items. A fresh Codex Sol subagent built the candidate; three independent Terra subagents graded disjoint shards in Gondolin VMs; a fresh blind Sol subagent reviewed `01-011`. No Pi agent runtime drove this arm.

The physical fence and preflight passed. The builder wrote only `impl/`; the sealed candidate, post-gate room, and pre-grading candidate cache checks passed. The independent legacy gate passed on attempt 1 with 47 HTTP acceptance tests, boot poll, and identity probe. The candidate SHA-256 is `0c6c1d6a6add1b4d5093dac3f8eaeddbd293a27af1da619b0bfe8e2854be78ab`; `gate-1.log` has SHA-256 `716108a63f67eec1acda69a0dc7b997097c82f276784da915581247960c1d855`.

The graders produced 47 schema-valid raw Allure results, 35 of which passed. The blind Sol reviewer saw only the refusal and question, proposed `pukuhuone 8 | Tuesday | 17:00`, and a fresh Gondolin VM confirmed that request through the public API with HTTP 200 and a standing booking. The final evidence validator passed with 47 raw and one blind Allure result. The legacy scorer filed **36/47**: slice 01 **11/11**, 02 **10/10**, 03 **9/14**, 04 **6/7**, 05 **0/5**.

The 11 failed items are `03-001`, `03-003`, `03-004`, `03-005`, `03-014`, `04-007`, and `05-001` through `05-005`. The graders recorded these as **not reached**. For the slice-03 items they could not establish the required queue in the default manager-mediated house. For slice 05 they could not establish a family-time class and cap or distinct house policies. For `04-007`, the later notice under revised policy was not observed. These verdicts record missing black-box evidence; they do not alone prove the corresponding product behavior is absent.

The single filed surprise is `01-010`: an initial in-script race count misread the response shape; the grader corrected counts from the recorded responses. The original note and supporting evidence remain in `grading-room/work/surprises.json` and `grading-room/work/shards/`.

`evidence-validation.json` contains `nextPhase: blind-review` despite the completed blind result. That field is a lifecycle hint from the current adapter, which unconditionally selects `blind-review` when a blind Allure directory is present. The validator checked the blind result and all 47 final verdicts before returning successfully; the phase hint is stale and did not affect the score.

Compared with official Codex cycle 06's **46/47**, `02-001` newly passes and the 11 items above newly fail, a net change of **−10**. This is a score, not an acceptance decision. Revalidate the archived evidence from the repo root with `node harness/codex-cycle/cli.ts evidence harness/cycles/08/evidence.json`.
