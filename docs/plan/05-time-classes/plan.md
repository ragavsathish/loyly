# Slice 05: Time classes and class-scoped fairness

status: planned

## Goal

A house may mark time windows with classes and apply a cap to one class
without restricting unrelated sauna time. This covers the documented
family-time rule at Masthugget while keeping the class names and limits
as house policy.

## Grounding

- `docs/wiki/pages/slot-model.md`, "Time classes", describes classed
  resource calendars.
- `docs/wiki/pages/exceptional-bookings.md`, "Special time classes",
  records Masthugget's family-time cap and gender-separated weekday hours.
- `raw/domain/public/brf-masthugget.md` provides the public-source
  provenance for that specific configuration.

## Draft behavior

- A house assigns a time class to eligible windows and a class-scoped
  active-or-upcoming booking cap to household units.
- A family-time booking counts against the family-time cap; unrelated
  classes do not consume that allowance.
- A refusal explains the class cap and identifies the existing booking
  that makes the household ineligible.

## Decisions needed before acceptance

The first accepted house configurations, their time-class names and
limits, and the lifecycle definition of "active or upcoming" must be
recorded. Transfer surcharges, no-show penalties, discounts and network
heater control remain outside this slice because their policy or
compliance rules are open in the source.
