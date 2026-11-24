# The live cycle and the formal-verification road, specified.
#
# This file describes the observable behaviour of:
#   - the pinned live cycle (assurance)
#   - the formal examiner (theory 𝒜 and cycle 𝒞)
#
# Language-agnostic: steps name contracts, digests, phases and reports — not
# an implementation language, runtime, or package manager. Any conforming
# implementation may satisfy them.
#
# CONVENTIONS:
#
# - Lives under harness/, NOT under docs/plan/. It is not a product slice and
#   must never enter the product checklist denominator.
# - Not part of the three-repository shared instrument (harness/spec.feature).
#   modules.sh does not require this file to be byte-identical across siblings.
# - Item ids are `@cycle-NNN` (live cycle / assurance) and `@formal-NNN`
#   (mathematical examiner). They are stamped by hand; stamp_item_ids does not
#   touch this file.
# - Formal verification examines published contracts; it does not replace the
#   live worker. Scored production runs use the ratified cycle driver of record.
# - "no incident, no guard" still holds for refuse scenarios. Contract scenarios
#   that only state ordinary behaviour cite nothing.
#
# HOW IT IS JUDGED: a live-contract check CLI and a formal prove / theory CLI
# (paths may vary by implementation). Oracle byte-parity for this file may
# follow; until then those CLIs are the executable half.

Feature: Live cycle and formal verification

  # -------------------------------------------------------------------------------
  # Live cycle — pins and independence
  # -------------------------------------------------------------------------------

  Rule: A live run begins only from a pinned, clean contract

    @cycle-001
    Scenario: The live check accepts a pinned live-run contract
      Given a live-run document that conforms to the published live-run schema
      And the controller commit equals the clean repository HEAD
      And the source commit equals the clean source HEAD
      And every pinned agent instruction, wrapper, result schema and panel plan digest matches the bytes on disk
      When the operator runs the live check on that contract
      Then the check reports that the pinned cycle contract is verified
      And the check exits successfully

    @cycle-002
    Scenario: A dirty or mismatched commit refuses the live check
      Given a live-run document whose controller commit differs from HEAD
      Or the controller working tree is dirty
      When the operator runs the live check on that contract
      Then the check refuses because the checkout is dirty or differs from the approved commit
      And the check exits with failure
      And no live worker is started

    @cycle-003
    Scenario: Source, controller and scratch stay separate trees
      Given a live-run document whose scratch path is inside the source tree
      Or whose source tree is the controller root
      When the operator runs the live check on that contract
      Then the check refuses because source, controller and output must be separate
      And the check exits with failure

  Rule: Builder, grader and blind stay independent

    @cycle-004
    Scenario: Builder and grader use different models
      Given a cycle contract that names the same model for builder and grader
      When the contract is checked
      Then the check refuses because builder and grader need different models

    @cycle-005
    Scenario: Booking refusal requires a fresh blind subagent
      Given the selected checklist includes the booking refusal item
      And the contract has no blind agent pin
      When the contract is checked
      Then the check refuses because booking refusal needs a fresh blind subagent

    @cycle-006
    Scenario: Blind review precedes score on the cycle path
      Given the published cycle phase list
      When the path from cut to done is read
      Then blind-review appears before score
      And done is the only terminal phase

  Rule: Certification artifacts cannot rewrite filed agent verdicts

    @cycle-007
    Scenario: Panel outcome does not change the original score
      Given a completed grade with filed lifecycle verdicts
      And a panel assessment that is not-ready
      When the panel report is compiled
      Then the report records that the original score is unchanged
      And the filed agent verdicts are unchanged on disk

    @cycle-008
    Scenario: Score files only against the approved checklist and pinned digests
      Given a score input whose checklist or schema digest differs from the live pins
      When score is invoked for that cycle
      Then scoring refuses
      And no cycle score record is written for that refusal

  # -------------------------------------------------------------------------------
  # Formal verification road — 𝒜 and 𝒞
  # -------------------------------------------------------------------------------

  Rule: Formal theory 𝒜 is a closed many-sorted examiner

    @formal-001
    Scenario: The theory exports sorts, validity, functions and invariants
      Given the published formal theory
      When the operator prints the theory
      Then the export identifies itself as the formal theory document
      And the export includes the sort registry S
      And the export includes validity P
      And the export includes functions F
      And the export lists the model invariants I1 through I13

    @formal-002
    Scenario: Every registered sort has a generative carrier
      Given the closed registry of formal sorts
      When a value is generated for each sort
      Then each generated value satisfies Valid for that sort
      And invariant I5 holds

    @formal-003
    Scenario: Digest carriers are hex SHA-256
      Given the formal digest sort
      When a string is digested
      Then the result is 64 lowercase hex characters
      And the same input always yields the same digest
      And a non-hex string is rejected as an invalid digest

  Rule: Formal cycle C is the labeled transition system of the live path

    @formal-004
    Scenario: The cycle spine is unique from cut to done
      Given cycle C = (Q, q0, transition, L, F)
      When the cycle invariants are proved
      Then q0 is cut
      And F is exactly the set containing done
      And there is exactly one path of length |Q| from cut to done
      And the successor map is total on Q except F
      And invariants C1 through C5 hold

    @formal-005
    Scenario: Phase labeling only names registered sorts
      Given the labeling L that maps each phase to required models
      When L is checked against the sort registry
      Then every model mentioned in any L(q) is a registered sort
      And invariant C5 holds

    @formal-006
    Scenario: Preflight obliges a live-run; score obliges score-input
      Given the labeling L
      Then L(preflight) includes live-run
      And L(score) includes score-input and verdicts
      And L(blind-review) includes blind-packet
      And L(panel) includes panel-plan

  Rule: Formal verification pins the published harness contracts

    @formal-007
    Scenario: Published schema pins are present and digested
      Given a repository that publishes the live cycle contracts
      When the formal certificate is built
      Then the panel-plan schema is pinned with a sha256
      And the panel-summary schema is pinned with a sha256
      And the live-run schema is pinned with a sha256
      And the lifecycle-result schema is pinned with a sha256
      And invariant I7 holds

    @formal-008
    Scenario: The default booking panel plan validates as a panel plan
      Given the published default booking panel plan
      When the formal examiner loads that plan
      Then the plan satisfies Valid for panel-plan
      And the certificate records that the panel proof succeeded
      And invariant I6 holds

    @formal-009
    Scenario: Formal prove succeeds against the published contracts
      Given a repository root that holds the published live cycle contracts
      When the operator runs formal prove for that repository
      Then the command emits a formal-run report with success
      And the report lists the cycle path from cut to done
      And the report lists invariants I1 through I13
      And the report lists cycle invariants C1 through C5
      And the command exits successfully

  Rule: Formal examination stays outside the builder

    @formal-010
    Scenario: The builder does not mint the formal certificate
      Given a builder session writing under the candidate output tree
      When the cycle reaches score
      Then any formal certificate used for ratification was produced by the examiner or controller pins
      And the builder working tree is not the source of schema pin digests

    @formal-011
    Scenario: Formal verification does not require a live worker run
      Given only the published schemas and panel plan on disk
      When the operator runs formal prove against that repository
      Then the prove uses those published contract bytes
      And no live worker needs to have run for the prove to succeed

  # -------------------------------------------------------------------------------
  # Dual roads — assurance and formal stay distinct
  # -------------------------------------------------------------------------------

  Rule: Legacy assurance and formal verification are two roads to examination

    @formal-012
    Scenario: Assurance filing and formal pins answer different questions
      Given a scored live cycle that filed a cycle score record through the score tool
      And the formal examiner pins the live-run schema and the panel plan
      When an operator asks what formal verification examined
      Then the answer names the published schema and panel digests
      And the answer does not claim the formal examiner executed the live worker

    @cycle-009
    Scenario: An alternate live-check implementation may exist without replacing the worker of record
      Given more than one conforming live-check implementation
      When the operator checks a live-run contract with either implementation
      Then both refuse or accept according to the same pin and cleanliness rules
      And starting the live worker remains a separate action from checking the contract
      And the ratified cycle driver of record remains authoritative for scored production runs
