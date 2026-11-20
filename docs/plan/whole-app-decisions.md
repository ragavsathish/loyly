# Whole-product policy decisions for review

status: proposed; no rule on this page is approved for a scored cut

The generic Löyly product is the working target. Soukanvuori is its first
documented configuration, not evidence that every house uses self-service,
a queue or resale. These proposals close the gaps identified in
`docs/wiki/pages/slot-lifecycle-and-billing.md` and the planned slices.
They need a product-owner decision before any `drafts.feature` becomes a
stamped `spec.feature`.

| Decision | Proposed policy | Why it matters |
| --- | --- | --- |
| Product scope | Support multiple houses with house-specific roles, calendars and rules; keep manager-mediated Soukanvuori distinct from an opt-in self-service configuration. | A self-service queue must not silently become Soukanvuori's operating model. |
| Queue order and scope | FIFO by accepted request sequence within the requested eligible resource or resource group. A house may define the eligible group; the queue does not jump between unrelated resources. | A resident waiting for ph 8 should not trigger forfeiture of ph 9 unless both are in the same explicitly eligible group. |
| Scarcity trigger | Full capacity in that eligible group plus at least one waiting household. A holder with more than one standing slot in the group may receive one notice at a time. | Makes the second-slot-when-room rule reversible under actual scarcity without starting several simultaneous forfeits. |
| Two clocks | Configure 14 days to choose and 30 days to lapse as the initial self-service policy. Record exact instants and policy version when notice begins. | The two deadlines remain independently testable; an edited policy cannot move an existing deadline. |
| Queue-head decline | Offer the selected holding to the next eligible queue entry. At lapse, if nobody confirms, return it to the available pool. | A decline cannot silently reassign the slot or make it disappear. |
| Notice withdrawal | Keep a notice once issued; a confirmed queue claim remains pending until lapse. If all claimants decline, the selected holding still lapses into the pool. | This follows the brief's stated one-month loss, but may feel unfair if scarcity disappears. **Explicit owner review is important.** |
| FREE release | Holder keeps the normal standing fee; taker owes no occurrence charge. | This is stated in the source; no credit or second fee is inferred. |
| SALE release | House policy sets a resale price reference; the billing role collects from the buyer. The holder's normal standing fee remains due unless a later house policy explicitly gives a credit. | Avoids direct resident-to-resident collection and lets billing resolve the actual amount. **Owner must confirm who receives the resale proceeds.** |
| Billing signal | Emit payer, holding or occurrence identity, charge kind, policy version and price reference from the booking history; the billing role resolves the monetary amount. | Keeps invoicing downstream of the booking record and avoids a fourth mutable copy. Delivery and acknowledgement still need design. |
| Release withdrawal and expiry | Let the holder withdraw an untaken offer until its occurrence begins; mark an untaken offer unclaimed at that start instant. An accepted transfer cannot be withdrawn unilaterally. | Gives both parties a visible cutoff. The source does not state one. |
| Policy revisions | Record authority, effective instant and version. Evaluate a new request under the rule effective at its decision instant; keep earlier decisions and notice deadlines bound to their original version. | Prevents a later board edit from rewriting past booking evidence. Existing future holdings need an explicit migration rule if their terms change. |
| Initial roles and disputes | Configure the permitted booker role, booking operator, billing role and first dispute contact per house. Start with documented shareholder/manager/billing separation for Soukanvuori; leave third-hand subtenant standing unset. | A tenant, shareholder, manager and billing clerk are not interchangeable actors. |
| Time-class cap | Configure a cap per household and class. For a one-occurrence class, count confirmed bookings from confirmation until the occurrence ends; other classes do not consume the allowance. | Makes Masthugget's family-time limit testable without applying it to every sauna slot. |

## Still outside the first whole-product cut

Network heater commands, exceptional-access enforcement, transfer
surcharges, no-show penalties, discounted cancelled times, payment
collection and invoice delivery require policy or compliance decisions
that the current sources do not supply. The app may expose derived heater
and billing **signals**; it must not claim to operate equipment or collect
money based on these proposals.

## What approval would unlock

After the owner confirms or edits this table, the relevant draft scenarios
can become stamped acceptance items. The next Pi cut would pin all selected
product specs and one panel plan, build one fresh `impl/`, run up to three
build/verify attempts, grade rule scopes in parallel Gondolin VMs, run the
independent blind handoff, and compile the Allure directories into one
candidate report. The current 11-item score remains historical evidence;
it is not a score for the whole product.
