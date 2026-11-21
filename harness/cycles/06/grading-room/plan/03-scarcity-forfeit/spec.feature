Feature: Scarcity notice on a standing holding
  The queue and two clocks govern a recurring right, not one week's use.

  Rule: Scarcity requires both full capacity and a waiting household

    @item-03-001
    Scenario: A free eligible slot does not put a multi-slot household under notice
      Given a household holds two standing slots and an eligible slot is free
      And another household is waiting
      When the scarcity rule is evaluated
      Then neither standing holding is put under notice

    @item-03-002
    Scenario: An empty queue does not put a multi-slot household under notice
      Given all eligible standing slots are held and one household holds two
      And no household is waiting
      When the scarcity rule is evaluated
      Then neither standing holding is put under notice

    @item-03-003
    Scenario: A released occurrence is not a free standing slot
      Given every eligible standing slot is held and a household is waiting
      And one holder has offered a single week's occurrence to another household
      When the scarcity rule is evaluated
      Then the occurrence offer does not make a standing slot free
      And the scarcity decision uses the standing holdings and the waiting queue

    @item-03-004
    Scenario: Waiting in another resource group does not trigger notice here
      Given all standing slots in resource group A are held by households including one with two holdings
      And resource group B has a waiting household but group A has none
      When scarcity is evaluated for group A
      Then no group A holding is put under notice

    @item-03-005
    Scenario: The queue is ordered by accepted request within its eligible group
      Given group A is full and two eligible households request a standing slot in that group
      When the first request is accepted into the queue before the second
      Then the first household is queue-head for group A
      And neither request joins a queue for an unrelated resource group

    @item-03-014
    Scenario: One multi-holding household receives only one active notice
      Given one household holds three standing slots in a full eligible group
      And an eligible household is waiting in that group
      When scarcity is evaluated twice before the first notice lapses
      Then only one notice is active for that multi-holding household
      And no second holding is selected for loss by the repeated evaluation

  Rule: Choosing and losing a holding are different events

    @item-03-006
    Scenario: The holder chooses before the choose deadline
      Given a scarcity notice has started a 14-day choose clock and 30-day notice clock for a household with two holdings
      When the household chooses one holding before the choose deadline
      Then that holding is identified for loss at the notice deadline
      And the household keeps using it until the notice deadline
      And its other holding is not identified for loss

    @item-03-007
    Scenario: The choice right passes after the shorter clock
      Given a scarcity notice has started a 14-day choose clock and 30-day notice clock
      When the choose deadline passes without the holder choosing
      Then the queue-head gains the right to choose which holding will lapse
      And the original holder has not yet lost a holding

    @item-03-008
    Scenario: Passing the choose deadline does not pass the loss deadline
      Given a household with two holdings received a scarcity notice
      When the choose deadline passes without a choice
      Then the notice deadline remains the later deadline recorded at notice start
      And the household still holds both slots until that deadline

    @item-03-009
    Scenario: Lapse changes only the selected standing holding
      Given one of a household's two standing holdings was selected under notice
      When the notice deadline passes
      Then the household loses the selected standing holding
      And its other standing holding remains held
      And the posted list and billing signal reflect the same holding history

    @item-03-010
    Scenario: A confirmed queue claim takes effect only at lapse
      Given a queue-head has confirmed the selected holding under notice
      When the notice deadline has not yet passed
      Then the original household still holds and may use that standing slot
      And the queue-head is identified as the pending successor, not its current holder

    @item-03-011
    Scenario: A queue-head decline offers the holding to the next eligible entry
      Given a selected holding is under notice and two eligible households wait in order
      When the queue-head declines that holding
      Then the next eligible household is offered the pending claim
      And the original holder keeps using the holding until its recorded notice deadline

    @item-03-012
    Scenario: If all claimants decline, the selected holding returns to the pool at lapse
      Given a selected holding is under notice and every eligible claimant has declined
      When its recorded notice deadline passes
      Then the original household loses only that holding
      And the holding becomes available in its eligible group

    @item-03-013
    Scenario: A pending notice retains its original deadlines after the queue empties
      Given a selected holding is under notice with recorded choose and notice deadlines
      When the last waiting household withdraws before the notice deadline
      Then the notice remains in force with the same deadlines and policy version
      And the selected holding lapses into the available pool at its notice deadline
