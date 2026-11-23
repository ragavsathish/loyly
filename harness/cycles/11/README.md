# Cursor cloud-agent booking-core cycle 11

Second scored Cursor cycle through `harness/cursor-cycle/` over `cycle-core`
and `evidence-core`. Probe runtime was `cursor-remote-session` (no Docker).
This is a candidate measurement, not an acceptance decision.

- Controller/source: `84bd0ef365e9942c1199a9760f65fadefb314971`
- Selected checklist: 11 booking-core items, SHA-256
  `4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`
- Builder: `composer-2.5` ([Cycle 11 booking builder](bc-70a6c2de-e179-5fe9-9b9c-0b71d2915026))
- Grader: `grok-4.7-high` ([Cycle 11 booking grader](bc-631b019b-125d-55ff-b37f-cf96e5119992));
  a hung discover probe was cleared and evidence from that grader was sealed
- Blind: `composer-2.5` ([Cycle 11 blind review](bc-08e02616-06f6-579b-b47a-6ecbb5405d10))
- Candidate SHA-256: `4982f455df7039018d79bbd3f86140c765a923733760e0cfde67ac59910c9eca`
- Gate: passed attempt 1 (11/11 suite + boot)
- Score: **11/11 pass**. Blind `01-011` passed:
  REQUEST `pukuhuone 8 | Tuesday | 17:00` confirmed over HTTP.

Recheck:

```sh
node harness/cursor-cycle/cli.ts evidence harness/cycles/11/evidence.json
bb harness/scoreboard.clj 11
```
