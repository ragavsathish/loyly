# Löyly product scope beyond booking core

The historical Pi cycle built and scored `01-booking-core` (11 items). That
slice deliberately excluded parts of the product already described in the
domain wiki. The operator approved the first-cut policies on 2026-11-20;
slices 02–05 are now stamped product specifications. The 47-item next **whole-product**
Pi cut will hand all five slices to one fresh builder and grade one running
application. The historical 11-item score does not prove the expanded cut.

| Product capability | Source and current state | First product cut |
| --- | --- | --- |
| Weekly standing booking, refusals, second slot, give-up and derived list/timer/billing views | `01-booking-core/spec.feature`; 11 stamped items; cycle 06 filed 11/11 | Retain as the regression core in every whole-product cut |
| Release one week's occurrence without losing the standing holding; FREE and SALE offers; unclaimed and taken outcomes | `docs/wiki/pages/slot-lifecycle-and-billing.md` Part B | `02-occurrence-release/spec.feature`; house price reference, withdrawal and expiry are approved first-cut choices |
| Scarcity queue and standing-slot forfeit with separate choose and notice clocks | Same wiki Part A | `03-scarcity-forfeit/spec.feature`; scoped FIFO, two clocks, decline and notice persistence are approved first-cut choices |
| Multiple house policies, tenure and operating roles, board rule changes and disputes | `actors-and-fairness.md`, `authority-and-disputes.md`, `slot-model.md` | `04-house-policy/spec.feature`; house roles and effective-dated policy are accepted for the cut |
| Time classes, transfers and operations | `exceptional-bookings.md`; Masthugget family-time cap is documented | `05-time-classes/spec.feature` covers class-scoped caps; fees, penalties and network heater commands stay outside the cut |

The approved first-cut choices and their consequences are recorded in
[`whole-app-decisions.md`](whole-app-decisions.md). The builder must implement
the stamped scenarios and must not invent numeric resale prices, payout
distribution, third-hand subtenant standing or network heater control.

## Whole-product acceptance evidence

One Pi-controlled run must receive the accepted product cut, build a single
`impl/`, pass the independent legacy gate, and produce complete per-item
Allure evidence across every accepted slice. The blind `01-011` handoff stays
independent. The panel must cover the new journeys and their invariants, not
only the original booking probes. The original scorer files one honest
checklist and the replay binds the full set of shard results and receipts.
Only then can the generated whole-product build be considered for acceptance.
