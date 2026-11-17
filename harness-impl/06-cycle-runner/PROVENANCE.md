# Provenance: cycle runner

This is the complete generated candidate from slice-06 cycle 23, attempt 2. The operator
accepted it as the running context on 2026-11-17. Its source was copied byte for byte from
`.pi/harness/.state/rooms/06-c23-a2/harness-impl/06-cycle-runner/`; generated source was not
edited during promotion.

| Evidence | Result |
| --- | --- |
| Spec cut | `cb19e87` |
| Candidate | cycle 23, gate attempt 2 (`06-c23-a2`) |
| Gate | `.pi/harness/.state/logs/gate-c23-a2-slice06.log`, passed |
| Installed-copy gate | `.pi/harness/.state/logs/gate-promoted-repo-slice06-c23.log`, passed after the copy |
| Independent score | `harness/v2/cycles/06/23/`, 59/61 |
| Profile | clean, `harness/v2/cycles/06/23/profile.json` |
| Instrument shadow | `harness/v2/shadow/06/23/comparison.md`, matched legacy on the shared HTTP cut and app |
| Source digest | SHA-256 `947d49609d24e2325fcb027a695b03c3b68c2b9cd9337a3401d39cf58df5231a` over 39 source files |

The two failed requirements remain open:

- `06-047`: checklist sources for a symbolic-link slice named the target path rather than
  the plan link path.
- `06-066`: the first researcher request did not contain the scenario, seam, and event-model
  text. Spec round 26 clarified the request contract after this candidate was scored; this
  candidate has not been regraded against that round.

This acceptance does not turn either failed verdict into a pass. The shadow comparison is
one same-cut observation, not a proof across all projects. The next regeneration of this
context must use a fresh room and the current spec. Do not edit this generated source by hand.
