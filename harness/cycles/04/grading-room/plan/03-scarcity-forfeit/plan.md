# Slice 03: Scarcity queue and standing-slot forfeit

status: ready-for-development

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

## Accepted first-cut behavior

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

## Decision record and limits

The operator approved the first-cut policies in `../whole-app-decisions.md`
on 2026-11-20: scoped FIFO queue, one notice per multi-holding household,
14-day choice and 30-day lapse clocks, next eligible claimant after a
decline, and a notice that persists after issuance. House policy names the
eligible resource group. `spec.feature` is the executable cut. Exceptional
priority, migration of already-held future occurrences, and payment collection
remain outside it.
