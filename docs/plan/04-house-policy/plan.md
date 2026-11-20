# Slice 04: House policy, roles and disputes

status: planned

## Goal

One product runs different houses without treating Soukanvuori's rules as
universal. Each house has bookable resources, a tenure-based booker role,
an operating route, a billing role and effective-dated rules. A dispute
can point to the booking and the rule that governed it.

## Grounding

- `docs/wiki/pages/slot-model.md`: independently bookable resources and
  their per-weekday calendars.
- `docs/wiki/pages/actors-and-fairness.md`: shareholder versus tenant
  booker standing, and distinct booking, operations and billing roles.
- `docs/wiki/pages/authority-and-disputes.md`: board authority, effective
  dates and dispute history.
- `raw/domain/soukanvuori/2022-work-order-103016-and-drift.md`: a complaint
  needed the original booking thread after the list and timer diverged.

## Draft behavior

- A house policy names the resource calendars and roles used by that house.
  A household's booker standing is checked against its own house policy.
- A rule revision records authority and an effective date. Past bookings
  retain the rule version used for their decisions.
- Booking, operations and billing can be assigned to distinct parties.
- A dispute names a booking and exposes its confirmation, changes and
  applicable policy history to the configured first-stop role.

## Decisions needed before acceptance

The product owner must define who can administer a house policy, the
allowed booker roles for each initial configuration, how already booked
future occurrences respond to a policy revision, and which party is the
first stop for a dispute. Third-hand subtenant standing is still open in
the source. The drafts do not make those choices.
