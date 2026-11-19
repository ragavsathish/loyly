# Pi durable cycle on the original Löyly harness: release evidence

This branch starts at `scope-impact/master` and leaves the original root `harness/` modules
unchanged. The Pi controller is an overlay. Its source cut selects a full original commit, proves
the original self-check and fence, and derives the original eleven-item checklist. The candidate
is graded and scored only after the original gate passes. The interactive replay is a projection
of Pi's committed audit entries; it never invents ORC ticks.

| Requirement | Current evidence | Still required |
| --- | --- | --- |
| Original harness | The new spec-only source cut `b97e4eda015167c571eb3296fa03fe4fea366130` differs from the original `17d68d2` in only `spec.feature` and `decisions.md`; all root `harness/*` bytes are unchanged. Its clean legacy preflight passes, and it contains no prototype tooling. The Pi controller stays on the separate integration branch. | Run the approved real cycle from this cut and repeat the byte comparison at release. |
| Live builder | A fresh Sol Pi/Gondolin builder regenerated the pinned original cut on attempt 1. The candidate digest and launch receipt are recorded in `CARRIED-CALIBRATION.md`. The earlier no-model smoke passed seven tools and session reopening; adapter controller-kill tests pass. | Approve an exact scored cycle, prove bounded same-session continuation and the full crash matrix, and review host, settings and image provenance. |
| Gate and repair | The unchanged `verify.sh` ran in a separate copy of the real candidate: 20 tests and the HTTP identity probe passed. Receipt-backed retries stopped at three failures in a stub trial. | Real failure repair with a fresh Pi session and the full crash matrix. The original identity probe only checks the word `sauna`, so behavioral grading remains essential. |
| Independent grader | Three fresh Terra VM shards merged eleven schema-valid Allure results on the real gated candidate: 10 behavioral passes and 01-011 pending. The uncarried fixture produced zero passes. The carried run exposed runtime writes in the source room; fresh per-item runtime copies fixed that. A third carried run with enforced read-only Gondolin mounts also merged 10 behavioral passes and 01-011 pending. See both calibration records. | Seal and obtain approval of the grader instruction digest, then perform an approved scored cycle. Review each black-box observation. |
| Blind review | The revised spec calls for a fresh blind subagent. A candidate-bound packet records the exact refusal, spec, checklist, candidate and raw Allure digests. The durable cycle sleeps before scoring, survives controller SIGKILL, and resumes from a separate agent response. It also supports an automatic Pi process adapter: a fresh Sol session saw only the two blind text files through a read-only tool, named Thursday 17:00–18:30 in pukuhuone 9, and reopened with the same receipt and no second model call. Live-mode stubs exercised automatic launch, HTTP probe, supplemental Allure, and an 11/11 **fixture** score; a controller kill while the reviewer process ran rejoined that same launch with no duplicate. The real Pi observation remains calibration on the old cut. | Run the automatic reviewer on a newly pinned real candidate, inspect its answer and launch receipt, and complete an approved scored cycle before acceptance. |
| Measurement and audit | Original `score.clj` and `scoreboard.clj` ran on fixture verdicts derived from the supplied Allure lifecycle result schema; Pi entries record each shard's checklist digest and the combined Allure digest. A live-mode stub handoff proved scoring happens only after the blind result and that a controller restart preserves the wait. | Honest real verdicts, versioned redacted export into the desired Grain/replay UX, rendered Allure HTML, and OTLP profiles. |
| Acceptance | A live candidate passed the legacy gate and a separate exploratory grader calibration. No score was filed. `ragavsathish/main` retains the accepted ORC runner for comparison. | Same-candidate legacy/accepted-instrument shadow, operator review, rollback and explicit promotion decision. |

The fixture score is a process test, never product evidence. The attached-schema, rule-sharded
instruction passed both uncarried and carried exploratory calibrations. The live cycle now
waits for the blind review before scoring and still exits nonzero after measurement until a
separate acceptance decision. The grader instruction in this branch is a draft, not a sealed
or operator-approved instrument.

The next source cut is published at `ragavsathish/spec/pi-booking-agent`. It selects the same
eleven item IDs (`01-001` through `01-011`) and checklist SHA-256
`4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`.
The exact revised `spec.feature` SHA-256 is
`8dfa0eb3369fd1176e188bb84fbd229593ac6fe20aca3afce5f70d02807cc89e`.
This cut has not yet been built or scored.
