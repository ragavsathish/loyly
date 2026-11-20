Feature: Time classes and class-scoped caps
  House policy can constrain family times without blocking other classes.

  Rule: A cap counts only bookings in its configured class

    @draft
    Scenario: A household with one family-time booking cannot take another
      Given a house caps family time at one active or upcoming booking per household
      And apartment 12 already has an upcoming family-time booking
      When apartment 12 requests another family-time window
      Then the request is refused with the family-time cap as its reason
      And the existing family-time booking is identified

    @draft
    Scenario: An unrelated class does not consume the family-time allowance
      Given a house caps family time at one active or upcoming booking per household
      And apartment 12 has an upcoming booking in a different time class
      When apartment 12 requests a free family-time window
      Then the unrelated booking does not trigger the family-time cap

    @draft
    Scenario: Family-time allowance does not block a different class
      Given a house caps family time at one active or upcoming booking per household
      And apartment 12 has an upcoming family-time booking
      When apartment 12 requests a free window in another time class
      Then the family-time cap does not refuse that request

    @draft
    Scenario: A house without the family-time cap does not inherit it
      Given house A caps its family-time class at one active or upcoming booking
      And house B has not configured that cap
      When an eligible house B household requests a free family-time window
      Then house A's cap is not used to decide the house B request
