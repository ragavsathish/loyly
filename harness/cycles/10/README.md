# Cursor cloud-agent booking-core cycle 10

First scored Cursor cycle through `harness/cursor-cycle/` over `cycle-core`
and `evidence-core`. Probe runtime was `cursor-remote-session` (no Docker).
This is a candidate measurement, not an acceptance decision.

- Controller/source: `41c9b4f8e7884a70ff36639910b85467475c70a0`
- Selected checklist: 11 booking-core items, SHA-256
  `4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`
- Builder: `composer-2.5` ([Cursor cycle builder](bc-ef3f92f4-23ce-59c2-a826-80f7457ca22d))
- Grader: `grok-4.7-high` ([Cursor cycle grader](bc-e225eb6d-e688-5564-9e15-a351138d7762));
  repinned from `claude-sonnet-5-5-high` after weekly usage blocked Sonnet
- Blind: `composer-2.5` ([Cursor cycle blind review](bc-ac57808a-89ac-582a-8a14-9583394411e6))
- Candidate SHA-256: `7bf3159d45936fd09905e8f397dfb93c6002e62845ba36d637b1ab6ee5c51e5f`
- Gate: passed attempt 1 (11/11 suite + boot)
- Score: **10/11 pass**. Fail: `01-008` (after give-up, invoicing still retained
  `standing_slot_charge` while list and heater cleared). Blind `01-011` passed:
  REQUEST `pukuhuone 8 | Tuesday | 17:00` confirmed over HTTP.

Recheck:

```sh
node harness/cursor-cycle/cli.ts evidence harness/cycles/10/evidence.json
bb harness/scoreboard.clj 10
```
