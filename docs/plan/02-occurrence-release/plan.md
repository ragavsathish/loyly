# Slice 02: One-week occurrence release

status: planned

## Goal

A resident can offer one occurrence of a standing slot to another household
without giving up the recurring holding. The offer can be free or for sale;
the posted list, heater schedule and billing signal remain readings of the
same record. This slice adds the single-week lifecycle described in
`docs/wiki/pages/slot-lifecycle-and-billing.md`, Part B, on top of the
standing holding from slice 01.

## Grounding

- `docs/wiki/pages/slot-lifecycle-and-billing.md`, "Two slot concepts", Part B
  and Part C, based on Sami's 2026-08-26 product-owner brief in
  `raw/domain/elicitation-2026-08-26.md`.
- `docs/wiki/pages/standing-slots-lifecycle.md`, "Holding": a one-week release
  does not end a standing holding.
- `docs/wiki/pages/exceptional-bookings.md`, "Handing a turn to someone else":
  actual transfers and the unsettled money tension.
- `docs/plan/01-booking-core/decisions.md` D1 and D5: the release was deferred,
  and all views must derive from the booking record.

## Draft behavior

- A release names a particular week and a standing holding owned by the
  releasing household.
- FREE keeps the normal standing fee with the holder; the taker owes no
  occurrence charge.
- SALE creates a paid occurrence for its taker and a billing signal that
  distinguishes that sale from the holder's normal standing fee.
- If nobody takes the released occurrence, it remains unused and the holder
  still pays the normal fee.
- The next week's occurrence and the standing holding remain with the original
  household. One occurrence has at most one taker. Derived views agree.

## Decisions needed before acceptance

The source leaves the SALE price and collector unspecified. It also does not
say whether a release can be withdrawn before taking, or exactly when an
untaken offer becomes UNCLAIMED. These are product-owner decisions, not
builder choices. `drafts.feature` deliberately avoids an amount and a
withdrawal scenario. The plan stays `planned` until the policy is recorded,
the executable scenarios are accepted and the item IDs are stamped.
