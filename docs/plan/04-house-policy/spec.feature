Feature: Multiple houses and traceable policy
  A booking uses the rules of its own house and keeps the decision history.

  Rule: A house owns its calendars and eligible booker roles

    @item-04-001
    Scenario: Different houses can open different resources and days
      Given house A has a Tuesday bookable resource
      And house B has no Tuesday bookable resource
      When both houses show their weekly schedules
      Then house A shows its Tuesday resource
      And house B does not offer a Tuesday booking

    @item-04-002
    Scenario: Booker standing is checked within the household's house
      Given house A allows its configured booker role to request a slot
      And house B uses a different configured booker role
      When an eligible house A household requests in house A and a house B household requests in house B
      Then each decision uses that house's role policy
      And neither house inherits the other house's eligibility rule

    @item-04-003
    Scenario: A manager-mediated house does not expose a resident self-service queue
      Given house A routes booking requests to its manager
      And house B permits resident self-service with a waiting queue
      When residents view the booking route for their own house
      Then house A directs them to its manager and does not offer the queue
      And house B offers the route configured for its residents

  Rule: Policy revisions and disputes preserve their evidence

    @item-04-004
    Scenario: A rule change records its authority and effective date
      Given a house has a current booking rule
      When the authorized party records a revised rule with a future effective date
      Then decisions before that date identify the earlier rule
      And decisions after that date identify the revised rule

    @item-04-005
    Scenario: A dispute can reconstruct one booking's decision
      Given a household has a confirmed booking that was later changed
      When the configured first-stop role opens a dispute about that booking
      Then the confirmation and change history identify that booking
      And the governing policy version is visible with each decision

    @item-04-006
    Scenario: A policy revision does not rewrite an earlier refusal
      Given a house refused a request under an identified policy version
      When an authorized party records a later policy revision
      Then the refusal still names the version and reason used at its decision time

    @item-04-007
    Scenario: A notice keeps the policy version that created its deadlines
      Given a scarcity notice was recorded under a house rule with 14 and 30-day clocks
      When an authorized party revises those clock lengths for future notices
      Then the existing notice keeps its original choose and lapse instants
      And a later notice uses the revised rule version
