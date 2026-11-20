Feature: One-week occurrence release
  A released occurrence and its standing weekly holding have different lives.
  A release affects one named week; the original household retains its holding.

  Rule: Releasing one week preserves the standing holding

    @item-02-001
    Scenario: A free release offers only the selected occurrence
      Given apartment 12 holds a Tuesday 17:00 standing slot in pukuhuone 8
      When apartment 12 releases the occurrence for one named Tuesday for free
      Then that week's occurrence is available for another household to take
      And apartment 12 still holds the standing slot for later Tuesdays

    @item-02-002
    Scenario: Releasing one week does not offer a different week
      Given apartment 12 holds a Tuesday 17:00 standing slot in pukuhuone 8
      When apartment 12 releases the occurrence on one named Tuesday
      Then another household can take that named Tuesday occurrence
      And the occurrence on the following Tuesday remains assigned to apartment 12

    @item-02-003
    Scenario: An untaken release does not cancel the holding or its normal fee
      Given apartment 12 has released one Tuesday occurrence for free
      When nobody takes it before that occurrence ends
      Then the occurrence is unclaimed and unused
      And apartment 12 still holds its standing slot
      And apartment 12's normal standing-slot fee remains due

  Rule: Free and paid taking have different billing consequences

    @item-02-004
    Scenario: Taking a free occurrence charges no fee to the taker
      Given apartment 12 has released one Tuesday occurrence for free
      When apartment 3 takes that occurrence
      Then apartment 3 may use that one Tuesday occurrence without an occurrence charge
      And apartment 12 remains responsible for its normal standing-slot fee
      And apartment 12 holds the standing slot on later Tuesdays

    @item-02-005
    Scenario: Taking a sale occurrence raises a distinct resale signal
      Given apartment 12 has released one Tuesday occurrence for sale
      When apartment 3 buys that occurrence under the house's sale policy
      Then apartment 3 is the taker for that one Tuesday occurrence
      And a resale billing signal identifies apartment 3, that occurrence, the charge kind, the governing policy version and the house price reference
      And apartment 12's normal standing-slot fee remains due
      And apartment 12 still holds the standing slot on later Tuesdays

    @item-02-006
    Scenario: Withdrawing an untaken offer before its occurrence begins
      Given apartment 12 has offered one Tuesday occurrence and nobody has taken it
      When apartment 12 withdraws the offer before that occurrence begins
      Then apartment 12 may use that occurrence again
      And no other household can take the withdrawn offer
      And the standing holding remains with apartment 12

    @item-02-007
    Scenario: An accepted transfer cannot be withdrawn by the original holder
      Given apartment 3 has taken apartment 12's released Tuesday occurrence
      When apartment 12 tries to withdraw that offer
      Then the withdrawal is refused and apartment 3 remains the taker

    @item-02-008
    Scenario: An untaken offer expires when its occurrence begins
      Given apartment 12 has released one Tuesday occurrence and nobody has taken it
      When that occurrence begins
      Then the offer is unclaimed and cannot be taken afterward
      And apartment 12 keeps its standing holding and still owes the normal fee

  Rule: The three derived views describe one occurrence holder

    @item-02-009
    Scenario: A taken occurrence has one taker in every view
      Given apartment 12 has released one Tuesday occurrence
      When apartment 3 takes it
      Then no other household can take that same occurrence
      And the posted list names apartment 3 while the heater schedule heats that occurrence
      And the billing signal follows the release mode without a second stored copy

    @item-02-010
    Scenario: Two households try to take the same released occurrence
      Given apartment 12 has released one named Tuesday occurrence
      When apartments 3 and 4 each try to take it before either request is answered
      Then exactly one request succeeds
      And the posted list, heater schedule and billing signal agree on that one outcome
