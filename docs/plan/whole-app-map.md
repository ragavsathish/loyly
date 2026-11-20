# Löyly product scope beyond booking core

The Pi cycle currently builds and scores `01-booking-core` (11 items). That
slice deliberately excluded parts of the product already described in the
domain wiki. This map is the planning input for one **whole-product** Pi cut:
the accepted slices will be handed to one fresh builder and graded against
one running application. A draft below is not in the checklist until its
decisions are made, `spec.feature` is accepted and item IDs are stamped.

| Product capability | Source and current state | Next specification work |
| --- | --- | --- |
| Weekly standing booking, refusals, second slot, give-up and derived list/timer/billing views | `01-booking-core/spec.feature`; 11 stamped items; cycle 06 filed 11/11 | Retain as the regression core in every whole-product cut |
| Release one week's occurrence without losing the standing holding; FREE and SALE offers; unclaimed and taken outcomes | `docs/wiki/pages/slot-lifecycle-and-billing.md` Part B; settled lifecycle, open pricing and withdrawal | Draft slice 02; settle SALE pricing/collection and whether an untaken release can be withdrawn |
| Scarcity queue and standing-slot forfeit with separate choose and notice clocks | Same wiki Part A; settled sequence, ten listed open policy questions | `03-scarcity-forfeit/` drafts the invariants; settle queue order, scarcity scope, decline and withdrawal before stamping |
| Multiple house policies, tenure and operating roles, board rule changes and disputes | `actors-and-fairness.md`, `authority-and-disputes.md`, `slot-model.md` | `04-house-policy/` drafts configuration and effective-dated policy; settle who may book and adjudicate per house |
| Time classes, transfers and operations | `exceptional-bookings.md`; Masthugget family-time cap is documented, money and heater-control policy remain open | `05-time-classes/` drafts class-scoped caps; keep transfer fees, penalties and network heater commands out of an accepted cut until policy and compliance decisions are recorded |

The existing source does not define a complete release price, queue order,
queue-head decline disposition, notice withdrawal rule, or network heater
control policy. The builder must not invent them. `02-occurrence-release/`
holds a first draft of the behavior that *is* stated. Later product slices
will be drafted and reviewed before they change the scored denominator.

## Whole-product acceptance evidence

One Pi-controlled run must receive the accepted product cut, build a single
`impl/`, pass the independent legacy gate, and produce complete per-item
Allure evidence across every accepted slice. The blind `01-011` handoff stays
independent. The panel must cover the new journeys and their invariants, not
only the original booking probes. The original scorer files one honest
checklist and the replay binds the full set of shard results and receipts.
Only then can the generated whole-product build be considered for acceptance.
