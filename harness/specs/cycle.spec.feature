# The live cycle and the formal-verification road, specified.
#
# This file describes product-agnostic behaviour of:
#   - the pinned live cycle (assurance)
#   - panel-only reassessment
#   - the builder/grader Gondolin VM host policy
#   - replay export and bound Allure rendering
#   - the formal examiner (theory 𝒜 and cycle 𝒞)
#
# Language-agnostic and project-agnostic: steps name contracts, digests,
# phases and reports — not an implementation language and not a product
# (Löyly booking, …). Project-specific cycle/formal behaviour lives under
# harness/project/<id>/cycle.spec.feature.
#
# CONVENTIONS:
#
# - Lives under harness/specs/, NOT under docs/plan/ (never enters the product
#   checklist denominator) and NOT directly in top-level harness/ (keeps the
#   shared three-repository adoption check in harness/modules.sh clean).
# - Item ids are `@cycle-NNN` (live cycle / assurance) and `@formal-NNN`
#   (mathematical examiner). They are stamped by hand; stamp_item_ids does not
#   touch this file. Existing ids are never renumbered.
# - Formal verification examines published contracts; it does not replace the
#   live worker. Scored production runs use the ratified cycle driver of record.
# - "no incident, no guard" still holds for refuse scenarios. Contract scenarios
#   that only state ordinary behaviour cite nothing.
#
# HOW IT IS JUDGED: `bin/loyly-clj spec` parses this file and
# `harness/project/loyly/cycle.spec.feature`, requires 1-to-1 executable
# coverage of every scenario tag, and runs every scenario against the harness
# and formal examiner (`bin/loyly-clj formal`).

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
    Scenario: A project policy may require a blind agent pin
      Given a project policy that requires a blind agent for the selected items
      And the contract has no blind agent pin
      When the contract is checked
      Then the check refuses because the blind agent is required

    @cycle-006
    Scenario: When blind-review is on the path it precedes score
      Given a cycle path that includes blind-review and score
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

    @cycle-009
    Scenario: Checking a live-run contract stays separate from starting the live worker
      Given a valid pinned live-run contract
      When the operator checks the contract without running a cycle
      Then the check validates pins and cleanliness without starting a live worker
      And no worker state or score record is written by the check alone

  # -------------------------------------------------------------------------------
  # Panel-only reassessment
  # -------------------------------------------------------------------------------

  Rule: Panel-only reassessment uses a separate pinned contract and preserves the original cycle

    @cycle-010
    Scenario: Panel reassessment refuses unpinned contracts or output outside the original scratch
      Given a panel reassessment contract with missing digests or an output path outside the original scratch
      When the reassessment check runs
      Then the check refuses before launching any specialist VM

    @cycle-011
    Scenario: Panel reassessment records an immutable receipt leaving the original cycle unchanged
      Given a verified reassessment run over a frozen candidate and filed score
      When the reassessment receipt is finalized
      Then the receipt records original_cycle_unchanged as true
      And a conflicting rewrite of that receipt is refused

  # -------------------------------------------------------------------------------
  # Builder and grader VM host policy
  # -------------------------------------------------------------------------------

  Rule: The builder and grader VM host enforces sandbox, timeout and lineage bounds

    @cycle-012
    Scenario: Bash timeouts are clamped to the configured floor and optional ceiling
      Given a configured bash timeout floor and an optional ceiling
      When a tool call requests a timeout below the floor or above the ceiling
      Then the timeout is raised to the floor or capped at the ceiling
      And when no ceiling is set an in-range timeout is left unchanged

    @cycle-013
    Scenario: Image additions and VM resources stay within safe bounds
      Given an image-additions path outside /workspace or containing parent traversal
      Or invalid VM memory or CPU resource values
      When the VM host policy validates those settings
      Then validation refuses the unsafe path or resource specification

    @cycle-014
    Scenario: Forked builder sessions reject mismatched stores or missing parent fork points
      Given a conversation receipt whose store differs or whose parent has no completed fork point
      Or a fork receipt reopened without its parent receipt
      When the session lineage is validated
      Then validation refuses before resuming the builder session

    @cycle-015
    Scenario: Steer inbox scans only unprocessed markdown messages in sorted order
      Given a steer directory with pending markdown files, already steered or refused files, and non-markdown entries
      When pending steer messages are collected
      Then only unprocessed markdown files with valid names are returned in sorted order

  # -------------------------------------------------------------------------------
  # Replay export and bound Allure rendering
  # -------------------------------------------------------------------------------

  Rule: Replay export and Allure rendering stay bound to committed audit digests

    @cycle-016
    Scenario: Portable replay export sanitizes host paths and classifies provenance
      Given committed Pi audit rows referencing a host-local scratch path
      When replay export runs for that scratch directory
      Then audit.v1.jsonl and evidence.v1.json replace the host scratch path with <scratch>
      And provenance distinguishes fixture evidence, live path and pre-agent refusal

    @cycle-017
    Scenario: Allure rendering refuses when candidate or audit bindings drift
      Given a scored cycle scratch whose candidate tree no longer matches score-input.json
      When Allure rendering is invoked
      Then rendering refuses before generating a report manifest

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
    Scenario: A published default panel plan validates as a panel plan
      Given the project's published default panel plan
      When the formal examiner loads that plan
      Then the plan satisfies Valid for panel-plan
      And the certificate records that the panel proof succeeded

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

  Rule: Bounded retry, panel attempt and shard invariants hold

    @formal-013
    Scenario: Panel attempts, grader shards and builder continuations stay bounded
      Given the formal property suite for invariants I11, I12 and I13
      When panel selections, grader shards and continuation limits are checked
      Then panel attempts are in {1, 2}
      And grader shards have between 1 and 16 unique ids
      And builder continuations are capped at 3

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
