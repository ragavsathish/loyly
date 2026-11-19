# Pi durable cycle on the original Löyly harness: release evidence

This branch starts at `scope-impact/master` and leaves the original root `harness/` modules
unchanged. The Pi controller is an overlay. Its source cut selects a full original commit, proves
the original self-check and fence, and derives the original eleven-item checklist. The candidate
is graded and scored only after the original gate passes. The interactive replay is a projection
of Pi's committed audit entries; it never invents ORC ticks.

| Requirement | Current evidence | Still required |
| --- | --- | --- |
| Original harness | `harness/check.sh --local` passes; the pinned room is one commit with no prototype files. The root `harness/*` files are byte unchanged from the pinned original cut. | Repeat the byte comparison at release. |
| Live builder | A fresh Sol Pi/Gondolin builder regenerated the pinned original cut on attempt 1. The candidate digest and launch receipt are recorded in `CARRIED-CALIBRATION.md`. The earlier no-model smoke passed seven tools and session reopening; adapter controller-kill tests pass. | Approve an exact scored cycle, prove bounded same-session continuation and the full crash matrix, and review host, settings and image provenance. |
| Gate and repair | The unchanged `verify.sh` ran in a separate copy of the real candidate: 20 tests and the HTTP identity probe passed. Receipt-backed retries stopped at three failures in a stub trial. | Real failure repair with a fresh Pi session and the full crash matrix. The original identity probe only checks the word `sauna`, so behavioral grading remains essential. |
| Independent grader | Three fresh Terra VM shards merged eleven schema-valid Allure results on the real gated candidate: 10 behavioral passes and 01-011 pending. The uncarried fixture produced zero passes. The carried run exposed runtime writes in the source room; fresh per-item runtime copies fixed that. A third carried run with enforced read-only Gondolin mounts also merged 10 behavioral passes and 01-011 pending. See both calibration records. | Seal and obtain approval of the grader instruction digest, then perform an approved scored cycle. Review each black-box observation. |
| Blind review | The revised spec calls for a fresh blind subagent. A candidate-bound packet contains only the exact refusal and a question. The response intake requires an isolation attestation and an independent HTTP probe of the suggested request before writing a separate agent Allure result; tests reject a refused request. A tool-less fresh subagent named a Thursday request on the old candidate, and the real app returned HTTP 201. This is calibration evidence. | Run the blind review on a newly pinned candidate, record the minimal-context launch receipt, integrate the result into a scored cycle, and inspect the answer-to-request transcription before acceptance. |
| Measurement and audit | Original `score.clj` and `scoreboard.clj` ran on fixture verdicts derived from the supplied Allure lifecycle result schema; Pi entries record each shard's checklist digest and the combined Allure digest. | Honest real verdicts, versioned redacted export into the desired Grain/replay UX, rendered Allure HTML, and OTLP profiles. |
| Acceptance | A live candidate passed the legacy gate and a separate exploratory grader calibration. No score was filed. `ragavsathish/main` retains the accepted ORC runner for comparison. | Same-candidate legacy/accepted-instrument shadow, operator review, rollback and explicit promotion decision. |

The fixture score is a process test, never product evidence. The attached-schema, rule-sharded instruction passed both uncarried and carried exploratory calibrations. A live run remains nonzero even after
scoring while the blind review is outstanding. The grader instruction in this branch is a draft,
not a sealed or operator-approved instrument.
