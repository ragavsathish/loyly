# Decisions: slice 01-booking-core

A decision selects one branch and prunes the rest (`docs/wow/way-of-working.md` §6).
Divergences from `plan.md` discovered during implementation are appended here, along
with the verification trail when the slice is audited.

## D1: Occurrence release and the forfeit clocks are excluded from slice 1

The product-owner rules of 2026-08-26 (the wiki's slot-lifecycle-and-billing page)
define a released occurrence (free or sale) and a scarcity forfeit with two nested
clocks. Both act on a standing slot that must first exist, be confirmable, and drive
the derived views correctly; that substrate is this slice. *Pruned:* occurrence
states, the release modes, the notice and choose clocks, and the queue. They become
the next slice, where their ten open questions are already listed on the wiki page.

## D2: The booking lifecycle is modelled once; the manager is a channel, not a model

At Soukanvuori the request arrives through the manager's web form and a person
confirms it; the generic product also offers self-service. Both are the same
lifecycle (request, availability check, confirmation with a reason on refusal), so
the domain models the lifecycle once and treats who submits and who confirms as
configuration, per the actors-and-fairness wiki page. *Pruned:* a separate
manager-mediated booking model, and any work-order concept inside the domain (the
2022 work order is evidence of the drift problem, not a thing to rebuild).

## D3: "When there is room" is read as a cap that refuses when the schedule is full

The corpus documents the grant direction only: a second slot was asked for and given
"koska tilaa on" (because there is room). The policy's refusal direction, no room
means no second slot, is the plain reading and the spec encodes it, but it is an
inference, not a documented refusal. If a real configuration turns out to allow
queueing for a second slot instead, that is a policy variant, not a broken model.
*Pruned:* treating the second-slot rule as unconditional, in either direction.

## D4: Slot length and sauna days are configuration, stated per scenario

The spec's example configuration is Soukanvuori's documented one: 90 minute slots,
pukuhuone 9 open Thursday, Friday, Saturday, pukuhuone 8 open at least Tuesday. The
corpus does not document pukuhuone 8's full week, so no scenario asserts it; scenarios
state the configuration they need in their Given steps and assert nothing beyond it.
*Pruned:* a hardcoded weekly grid, and any invented completion of ph 8's days.

## D5: The list, the timer and the billing are read models, never stored copies

The drift incident is the strongest evidence in the corpus: three hand-kept
representations of one booking, two changed, one not, one cold sauna. The three
views are therefore derived from the booking record at read time. A view that is
written separately from the record it claims to reflect is the defect this project
exists to remove. *Pruned:* any write path that updates a view directly, and any
"sync" mechanism between views (there is nothing to sync when there is one record).

## D6: The closed-day refusal is judged by a fresh blind subagent

On 2026-11-19 the operator replaced the named person in `@item-01-011` with a fresh
independent subagent. The judged quality remains whether a newcomer can act from the
refusal alone. The subagent receives only the exact refusal and a question, in a new
session with no inherited context, plan, configuration, candidate or prior verdicts.
It names a request; a separate HTTP probe must confirm that request against a fresh
copy of the gated app. The subagent's claim alone is not a pass. A failed or unclear
answer fails the item and requires a wording change before acceptance. This change
alters the scenario text and therefore requires a new approved cut and build; the
earlier human-worded candidate remains calibration evidence only.

## D7: The refusal supplies the request fields, not a calculated end time

The closed-day refusal is usable when a newcomer can name a dressing room,
weekday and start time from it, and a fresh app confirms that exact standing-slot
request. The app derives the end from its configured 90-minute slot length. The
cycle-05 blind instruction required an end time in the refusal even though the
scenario and the public request did not. That added an instrument requirement and
failed an otherwise actionable refusal. The blind judge still cannot use hidden
configuration or invent a room, day or start time; its answer is still checked by
HTTP. The filed cycle-05 result remains unchanged.
