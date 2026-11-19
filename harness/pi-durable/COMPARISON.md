# Clean-base experiment versus the spec-v2 prototype

Both prototypes run the same Pi durable control shape and export committed audit entries to an interactive replay. This one starts at `scope-impact/master` (`17d68d2`) and uses the original harness without changing any of its root-level modules. The later prototype starts from `ragavsathish/spec-v2` (`1f546b3`).

| Question | Original-master experiment | Later spec-v2 experiment |
| --- | --- | --- |
| Selection | Original sauna plan, 11 stamped items | Slice 06, 65 stamped items |
| Fence | Original `harness/fence.sh`; excludes `impl` and `harness/cycles` | Same shared fence with v2 configuration; excludes the accepted implementation and cycle records |
| Gate | Original `harness/verify.sh` inside the fenced clone | `harness/v2/gate.sh`, which adds event-store and slice identity checks |
| Grader handoff | Small fixture view built by this prototype; the original harness permits grading “however you grade” | `.pi/harness/bin/grading-room.sh` creates the restricted grader room |
| Score | Original `harness/score.clj` and `scoreboard.clj`, cycle 02 in a scratch clone | `harness/v2/score.sh` wraps the same scorer and scoreboard for slice 06 |
| Candidate and verdicts | Tiny sauna HTTP fixture and deterministic verdicts | Frozen cycle-28 candidate fixture and deterministic verdicts |
| Observed repaired path | Gate passed attempt 2; fixture score 10/11 | Gate passed attempt 2; fixture score 64/65 |
| Observed failure and restart | Three failed gates prevent grading; SIGKILL/resume leaves one committed builder start | Same control outcomes |

## What the experiment says

Pi durable can own the **original** sequence of fence, regeneration attempt, ratifying gate, measurement, and audit without importing the ORC controller or changing the legacy modules. The read-only replay reconstructs that sequence from Pi's committed entries. It is a viable control-plane direction.

It does **not** show that the original baseline can replace the accepted spec-v2 runner today. Upstream `master` has no built Löyly app, no slice-06 spec, no live agent adapters, and only a name-based identity probe. The fixture grader's 10/11 does not judge product behavior. A migration would next need live Pi builder/grader hosts, the actual Löyly app and spec, provenance-preserving audit projection into Grain, and a same-candidate comparison against the accepted runner before changing `main`.

The revised booking source cut is kept separate from the controller: `ragavsathish/spec/pi-booking-agent`
adds only the approved 01-011 wording and decision to the original baseline. The original
root harness modules remain byte identical. The Pi adapter, sharded grader, blind reviewer,
and replay code are an overlay on the integration branch, outside the fenced product cut.

The evidence is reproducible with `npm run demo`; `scratch/gate-2.log` contains `=== verify OK`, `scratch/scoreboard.log` reports 10/11, and the exporter reads the three Pi stores to make `example-replay.html`. Scratch evidence remains local and is not committed.
