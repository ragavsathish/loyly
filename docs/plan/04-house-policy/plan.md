# Slice 04: House policy, roles and disputes

status: ready-for-development

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

## Accepted first-cut behavior

- A house policy names the resource calendars and roles used by that house.
  A household's booker standing is checked against its own house policy.
- A rule revision records authority and an effective date. Past bookings
  retain the rule version used for their decisions.
- Booking, operations and billing can be assigned to distinct parties.
- A dispute names a booking and exposes its confirmation, changes and
  applicable policy history to the configured first-stop role.

## Decision record and limits

The operator approved configurable, house-specific roles and effective-dated
rules for the first cut in `../whole-app-decisions.md` on 2026-11-20. The
house configuration names its booker, booking operator, billing and dispute
roles; Soukanvuori remains manager-mediated. The policy authority must be
recorded. Existing future booking migration and third-hand subtenant standing
remain outside this cut. `spec.feature` is the executable cut.
