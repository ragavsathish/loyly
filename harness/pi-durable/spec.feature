# The Pi durable cycle and the formal-verification road, specified.
#
# This file describes the observable behaviour of:
#   - the pinned live cycle (harness/pi-durable)
#   - the formal examiner (harness/clj-spike formal 𝒜 + cycle 𝒞)
#
# CONVENTIONS:
#
# - Lives under harness/pi-durable/, NOT under docs/plan/. It is not a product
#   slice and must never enter the product checklist denominator.
# - Not part of the three-repository shared instrument (harness/spec.feature).
#   modules.sh does not require this file to be byte-identical across siblings.
# - Item ids are `@cycle-NNN` (live cycle / assurance) and `@formal-NNN`
#   (mathematical examiner). They are stamped by hand; stamp_item_ids does not
#   touch this file.
# - TypeScript under pi-durable remains authoritative for scored production
#   runs. Formal verification examines published contracts; it does not replace
#   the worker.
# - "no incident, no guard" still holds for refuse scenarios. Contract scenarios
#   that only state ordinary behaviour cite nothing.
#
# HOW IT IS JUDGED TODAY:
# - Live pins / checkLiveRun: node harness/pi-durable/run-live.mjs --check …
# - Formal prove: harness/clj-spike/bin/spike formal [--root REPO]
# - Formal theory print: harness/clj-spike/bin/spike formal --theory
# Oracle byte-parity for this file may follow; until then the CLIs above are the
# executable half.

Feature: Pi durable cycle and formal verification

  # -------------------------------------------------------------------------------
  # Live cycle — pins and independence
  # -------------------------------------------------------------------------------

  Rule: A live run begins only from a pinned, clean contract

    @cycle-001
    Scenario: checkLiveRun accepts a pinned live-run contract
      Given a live-run JSON that matches live-run.schema.json
      And the controller commit equals the clean repository HEAD
      And the source commit equals the clean source HEAD
      And every pinned agent instruction, wrapper, Allure schema and panel plan digest matches the bytes on disk
      When the operator runs the live check on that contract
      Then the check reports that the pinned cycle contract is verified
      And the check exits 0

    @cycle-002
    Scenario: A dirty or mismatched commit refuses the live check
      Given a live-run JSON whose controller_commit differs from HEAD
      Or the controller working tree is dirty
      When the operator runs the live check on that contract
      Then the check refuses with a message that the checkout is dirty or differs from the approved commit
      And the check exits non-zero
      And no worker is started

    @cycle-003
    Scenario: Source, controller and scratch stay separate trees
      Given a live-run JSON whose scratch path is inside the source repo
      Or whose source repo is the controller root
      When the operator runs the live check on that contract
      Then the check refuses because source, controller and output must be separate
      And the check exits non-zero

  Rule: Builder, grader and blind stay independent

    @cycle-004
    Scenario: Builder and grader use different models
      Given a cycle contract that names the same model for builder and grader
      When the contract is checked
      Then the check refuses because builder and grader need different models

    @cycle-005
    Scenario: Booking refusal requires a fresh blind subagent
      Given the selected checklist includes item 01-011
      And the contract has no blind agent pin
      When the contract is checked
      Then the check refuses because booking refusal needs a fresh blind subagent

    @cycle-006
    Scenario: Blind review precedes score on the cycle path
      Given the Pi cycle phase list ALL-PHASES
      When the path from cut to done is read
      Then blind-review appears before score
      And done is the only terminal phase

  Rule: Certification artifacts cannot rewrite filed agent verdicts

    @cycle-007
    Scenario: Panel outcome does not change the original score
      Given a completed grade with filed Allure verdicts
      And a panel assessment that is not-ready
      When the panel report is compiled
      Then original_score_unchanged is true
      And the filed agent verdicts are unchanged on disk

    @cycle-008
    Scenario: Score files only against the approved checklist and pinned digests
      Given a score input whose checklist or schema digest differs from the live pins
      When score is invoked for that cycle
      Then scoring refuses
      And no scores.json is written for that refusal

  # -------------------------------------------------------------------------------
  # Formal verification road — 𝒜 and 𝒞
  # -------------------------------------------------------------------------------

  Rule: Formal theory 𝒜 is a closed many-sorted examiner

    @formal-001
    Scenario: The theory exports sorts, validity, functions and invariants
      Given the formal module loyly.formal.theory
      When the operator prints the theory
      Then the export names schema loyly.formal-theory.v1
      And the export includes the sort registry 𝒮
      And the export includes validity 𝒫
      And the export includes functions ℱ
      And the export lists invariants I1 through I13

    @formal-002
    Scenario: Every registered sort has a generative carrier
      Given the Malli Registry of formal sorts
      When a value is generated for each sort
      Then each generated value satisfies Valid_s for that sort
      And invariant I5 holds

    @formal-003
    Scenario: Digest carriers are hex SHA-256
      Given the formal sha256 sort
      When a string is digested
      Then the result is 64 lowercase hex characters
      And the same input always yields the same digest
      And a non-hex string is rejected by Valid_sha256

  Rule: Formal cycle 𝒞 is the labeled transition system of the live path

    @formal-004
    Scenario: The cycle spine is unique from cut to done
      Given cycle 𝒞 = (Q, q0, →, L, F)
      When the cycle invariants are proved
      Then q0 is cut
      And F is exactly {done}
      And there is exactly one path of length |Q| from cut to done
      And succ is total on Q minus F
      And invariants C1 through C5 hold

    @formal-005
    Scenario: Phase labeling only names registered sorts
      Given the labeling L that maps each phase to required models
      When L is checked against the Registry
      Then every model mentioned in any L(q) is a registered sort
      And invariant C5 holds

    @formal-006
    Scenario: Preflight obliges a live-run; score obliges score-input
      Given the labeling L
      Then L(preflight) includes live-run
      And L(score) includes score-input and verdicts
      And L(blind-review) includes blind-packet
      And L(panel) includes panel-plan

  Rule: Formal verification pins the TypeScript harness contracts

    @formal-007
    Scenario: JSON Schema pins are present and digested
      Given a Löyly repository root
      When the formal certificate is built
      Then panel-plan.schema.json is pinned with a sha256
      And panel-summary.schema.json is pinned with a sha256
      And live-run.schema.json is pinned with a sha256
      And allure-lifecycle-result.schema.json is pinned with a sha256
      And invariant I7 holds

    @formal-008
    Scenario: The default booking panel plan validates as PanelPlan
      Given harness/pi-durable/booking-core.panel.json
      When the formal examiner loads that file
      Then the file satisfies Valid_panel-plan
      And the certificate records panel-ok true
      And invariant I6 holds

    @formal-009
    Scenario: Formal prove succeeds on a clean checkout of the TS harness
      Given the repository root that holds harness/pi-durable
      When the operator runs bin/spike formal --root that repository
      Then the command prints a loyly.formal-run.v1 report with ok true
      And the report lists the cycle path from cut to done
      And the report lists invariants I1 through I13
      And the report lists cycle invariants C1 through C5
      And the command exits 0

  Rule: Formal examination stays outside the builder

    @formal-010
    Scenario: The builder does not mint the formal certificate
      Given a builder session under impl/
      When the cycle reaches score
      Then any formal certificate used for ratification was produced by the examiner or controller pins
      And the builder working tree is not the source of schema pin digests

    @formal-011
    Scenario: Formal verification does not require a CLJ worker
      Given only the TypeScript pi-durable harness and published JSON schemas
      When the operator runs the formal prove against that repository
      Then the prove uses the TS schema bytes and panel plan on disk
      And no Pi durable worker needs to have run for the prove to succeed

  # -------------------------------------------------------------------------------
  # Dual roads — assurance and formal stay distinct
  # -------------------------------------------------------------------------------

  Rule: Legacy assurance and formal verification are two roads to examination

    @formal-012
    Scenario: Assurance can pass while formal pins are what formal proves
      Given a scored live cycle that filed scores.json through the legacy score tool
      And the formal examiner pins live-run.schema.json and the panel plan
      When an operator asks what formal verification examined
      Then the answer names the published schema and panel digests
      And the answer does not claim the CLJ spike worker executed the live cycle

    @cycle-009
    Scenario: Spike cycle check may use CLJ check-live-run without replacing Node --run
      Given harness/clj-spike cycle pi --check
      When the operator checks a live-run contract without --ts
      Then validation goes through loyly.spike.live-contract/check-live-run
      And pi --run still starts the Node worker
      And TypeScript remains authoritative for scored production runs
