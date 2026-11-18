Feature: Cycle runner, draft scenarios
  Drafts for the Allium obligations of this context. The harness does not read this file.
  Only the product owner moves a draft into spec.feature, under the Rule it names, where the
  stamper gives it an @item id and the @draft tag is dropped. Every noun is a term of
  .pi/model/GLOSSARY.md.
  The drafts below explore ADR 0008. They do not change the accepted grade.v1 contract or
  the 62 stamped slice-06 items until a spec round moves them into spec.feature.

  Rule: A grader agent session supplies evidence to ORC without owning the score

    @draft
    Scenario: An item grader session returns evidence and a reason before ORC records its score
      Given a passed gated candidate and a sealed grade.v2 host contract approved for the run
      And a grader session for item 01-001 returns observed seam evidence, a nonempty reason and level 2 in the specified result schema
      When ORC grades item 01-001
      Then ORC records judge score 1.0 under checklist/01-001 in that item's child tick
      And Measurement files the item pass with the same evidence and reason

    @draft
    Scenario: A host command that exits successfully without a valid item result leaves the item unreached
      Given a passed gated candidate and a sealed grade.v2 host contract approved for the run
      And a grader host command exits zero but writes no valid result for item 01-001
      When ORC grades item 01-001
      Then ORC records no judge score for the item
      And Measurement files item 01-001 as an unreached fail in the full checklist

    @draft
    Scenario: A grader session has no access to the builder or another item's evidence
      Given a grader session for item 01-002 receives only its scenario, approved seam, rubric and fresh grading capability
      When that session attempts to read the builder room, gate evidence, host credentials and item 01-001's evidence
      Then each read is denied by the host boundary and recorded in the grader's trace
      And the session can still drive item 01-002 through the candidate's public seam
      And its verdict does not use candidate source as evidence

    @draft
    Scenario: A grader host command stopped at its deadline leaves no running child and no score
      Given a grader host command for item 01-001 starts a child program and does not return by its item deadline
      When ORC ends that grading attempt
      Then the grader host command and its child are stopped and the item has no judge score
      And Measurement files item 01-001 as an unreached fail without starting another builder

    @draft
    Scenario: The builder and grader sessions report distinct model identities
      Given the builder launch recorded model A and the grader session reports model A
      When ORC checks the grader session result for an item
      Then ORC refuses that result and records no judge score
      And a grader session reporting a different model B may be scored on its valid result
