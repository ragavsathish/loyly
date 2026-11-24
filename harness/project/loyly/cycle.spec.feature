# Löyly project-specific live cycle and formal behaviour.
#
# Complements the product-agnostic harness/cycle.spec.feature. Product slice
# behaviour (booking rooms, slots, …) stays under docs/plan/*/spec.feature.
# This file only covers how the Löyly project specialises the cycle examiner
# and formal pins — still outside the product checklist denominator.
#
# Item ids: `@loyly-cycle-NNN` and `@loyly-formal-NNN`. Stamped by hand;
# stamp_item_ids does not touch this file.

Feature: Löyly project cycle and formal pins

  Rule: Booking-core refusal forces a fresh blind subagent

    @loyly-cycle-001
    Scenario: Checklist item 01-011 without a blind pin is refused
      Given the project is loyly
      And the selected checklist includes item 01-011
      And the cycle contract has no blind agent pin
      When the contract is checked
      Then the check refuses because booking refusal needs a fresh blind subagent

    @loyly-cycle-002
    Scenario: Blind review is on the Löyly path before score
      Given the project is loyly
      And the booking-core cycle phase list
      When the path from cut to done is read
      Then blind-review appears on the path
      And blind-review appears before score
      And formal cycle invariant C4 holds

  Rule: Löyly publishes a default booking panel plan for formal proof

    @loyly-formal-001
    Scenario: booking-core.panel.json validates as a panel plan
      Given the published file booking-core.panel.json for project loyly
      When the formal examiner loads that plan
      Then the plan satisfies Valid for panel-plan
      And the formal certificate records that the panel proof succeeded
      And formal invariant I6 holds

    @loyly-formal-002
    Scenario: Formal prove against a Löyly checkout pins the booking panel
      Given a repository root that publishes the Löyly live cycle contracts
      And the default panel plan is booking-core.panel.json
      When the operator runs formal prove for that repository
      Then the certificate names the booking-core panel plan
      And the certificate records panel proof success
      And the command exits successfully

  Rule: Löyly blind packet carries the fixed refusal item

    @loyly-formal-003
    Scenario: A generated blind packet names item 01-011
      Given the project is loyly
      When a blind packet is generated from the formal sort
      Then the packet's item is 01-011
      And the packet satisfies Valid for blind-packet
