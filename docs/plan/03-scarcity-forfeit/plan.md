# Slice 03: Scarcity queue and standing-slot forfeit

status: planned

## Goal

When a house has no eligible standing slot and a household is waiting, a
household holding multiple standing slots can be placed under notice. The
holder's choice deadline and the later loss deadline are separate clocks.
This acts on a standing holding, not a single released occurrence.

## Grounding

- `docs/wiki/pages/slot-lifecycle-and-billing.md`, Part A and its open
  questions, records the product-owner forfeit rule and the gap with
  Soukanvuori's manager-mediated practice.
- `docs/wiki/pages/actors-and-fairness.md`, "The fairness pressure", places
  the rule on a household unit and distinguishes house policies.
- `docs/plan/01-booking-core/spec.feature` covers the second slot while
  there is room; this slice covers the later scarcity case.

## Draft behavior

- Scarcity needs both full eligible capacity and a nonempty queue. Neither
  condition alone starts notice.
- A notice starts a configurable choose clock and a longer notice clock at
  the same time. The holding remains usable until the notice clock elapses.
- The household chooses which of its holdings to yield before the choose
  deadline. If it does not, the right to choose passes to the queue-head.
- At the notice deadline, only the selected holding lapses. Other holdings
  remain with the original household.
- Every transition is recorded so the posted list and billing read the
  same holding history.

## Decisions needed before acceptance

The source does not settle queue priority, whether fullness is per resource
or house-wide, how many holdings above two trigger notice, the exact clock
durations, notice withdrawal if scarcity clears, or what follows a
queue-head decline. These are policy choices, not builder defaults. The
draft scenarios cover only invariant behavior and do not enter the
checklist until those choices are recorded and item IDs are stamped.
