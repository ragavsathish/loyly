Feature: One-week occurrence release
  A released occurrence and its standing weekly holding have different lives.
  A release affects one named week; the original household retains its holding.

  Rule: Releasing one week preserves the standing holding

    @draft
    Scenario: A free release offers only the selected occurrence
      Given apartment 12 holds a Tuesday 17:00 standing slot in pukuhuone 8
      When apartment 12 releases the occurrence for one named Tuesday for free
      Then that week's occurrence is available for another household to take
      And apartment 12 still holds the standing slot for later Tuesdays

    @draft
    Scenario: An untaken release does not cancel the holding or its normal fee
      Given apartment 12 has released one Tuesday occurrence for free
      When nobody takes it before that occurrence ends
      Then the occurrence is unclaimed and unused
      And apartment 12 still holds its standing slot
      And apartment 12's normal standing-slot fee remains due

  Rule: Free and paid taking have different billing consequences

    @draft
    Scenario: Taking a free occurrence charges no fee to the taker
      Given apartment 12 has released one Tuesday occurrence for free
      When apartment 3 takes that occurrence
      Then apartment 3 may use that one Tuesday occurrence without an occurrence charge
      And apartment 12 remains responsible for its normal standing-slot fee
      And apartment 12 holds the standing slot on later Tuesdays

    @draft
    Scenario: Taking a sale occurrence raises a distinct resale signal
      Given apartment 12 has released one Tuesday occurrence for sale
      When apartment 3 buys that occurrence under the house's sale policy
      Then apartment 3 is the taker for that one Tuesday occurrence
      And a resale billing signal identifies apartment 3 and that occurrence
      And apartment 12 still holds the standing slot on later Tuesdays

  Rule: The three derived views describe one occurrence holder

    @draft
    Scenario: A taken occurrence has one taker in every view
      Given apartment 12 has released one Tuesday occurrence
      When apartment 3 takes it
      Then no other household can take that same occurrence
      And the posted list names apartment 3 while the heater schedule heats that occurrence
      And the billing signal follows the release mode without a second stored copy
