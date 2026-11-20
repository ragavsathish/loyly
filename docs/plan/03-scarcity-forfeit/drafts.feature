Feature: Scarcity notice on a standing holding
  The queue and two clocks govern a recurring right, not one week's use.

  Rule: Scarcity requires both full capacity and a waiting household

    @draft
    Scenario: A free eligible slot does not put a multi-slot household under notice
      Given a household holds two standing slots and an eligible slot is free
      And another household is waiting
      When the scarcity rule is evaluated
      Then neither standing holding is put under notice

    @draft
    Scenario: An empty queue does not put a multi-slot household under notice
      Given all eligible standing slots are held and one household holds two
      And no household is waiting
      When the scarcity rule is evaluated
      Then neither standing holding is put under notice

  Rule: Choosing and losing a holding are different events

    @draft
    Scenario: The holder chooses before the choose deadline
      Given a scarcity notice has started both configured clocks for a household with two holdings
      When the household chooses one holding before the choose deadline
      Then that holding is identified for loss at the notice deadline
      And the household keeps using it until the notice deadline
      And its other holding is not identified for loss

    @draft
    Scenario: The choice right passes after the shorter clock
      Given a scarcity notice has started both configured clocks
      When the choose deadline passes without the holder choosing
      Then the queue-head gains the right to choose which holding will lapse
      And the original holder has not yet lost a holding

    @draft
    Scenario: Lapse changes only the selected standing holding
      Given one of a household's two standing holdings was selected under notice
      When the notice deadline passes
      Then the household loses the selected standing holding
      And its other standing holding remains held
      And the posted list and billing signal reflect the same holding history
