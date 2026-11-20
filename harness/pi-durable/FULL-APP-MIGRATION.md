# Whole Löyly app through Pi durable

The target is one generated spec-v2 application containing all six contexts,
driven, verified, graded, scored and replayed by Pi durable. The booking-core
11-item cycle is evidence for the controller mechanics, not coverage of this
target. The old ORC runner and legacy shell harness remain comparison
instruments during migration; Pi owns the new cycle checkpoints and recovery.

## Source cuts observed on 2026-11-20

`full-app-preflight.mjs` invokes the selected source's own
`harness/gen_checklist.clj`; it does not parse Gherkin a second way.

| Cut | 01 specification | 02 measurement | 03 grader lifecycle | 04 regeneration cycle | 05 cycle preparation | 06 cycle runner | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Archived accepted ORC main `a733b7e` | 15 | 43 | 11 | 76 | 4 | 62 | 211 |
| Current `ragavsathish/spec-v2` `1f546b3` | 18 | 43 | 11 | 76 | 4 | 65 | 217 |

The current 217-item cut is the full selection to carry forward. Its legacy
checklist SHA-256 is
`13ae9eec9eadc263c075ba27bb760d9e287235b81a1413b2d2c3c7888dd93a5f`;
the ordered item-ID-list SHA-256 is
`e02ce7522fab338778f778137071477df35c7281d528380cf68dec48dfdb1efc`.
These are inventory facts, not an approval or a scored Pi run. The archived
211-item cut supplies a same-source behavior baseline. Cycle 28 on the newer
spec-v2 branch scored 48/65 for slice 06, so its candidate is not an accepted
replacement for the archived runner.

## Controller changes required

| Boundary | Booking-core Pi today | Whole-app Pi requirement |
| --- | --- | --- |
| Source cut | Clones the pinned `source.repo`, but derives only the `docs/plan` checklist | Derive the six-context checklist from that source and prove its exact commit and digests |
| Fence and build | `impl/`, HTTP `start.sh` and `test.sh` | Use the spec-v2 fence, render, and `harness-impl/06-cycle-runner/` build contract; one candidate contains contexts 01–05 and the runner |
| Gate | Original booking HTTP probe | Run the source's `harness/v2/gate.sh 06`, including its stdio identity and Grain store check, in a separate room |
| Grading | Eleven booking items, three HTTP grader shards, special 01-011 blind handoff | Grade every selected context item against its own public seam; give graders only the selected specs, sibling seams and event models, candidate, and approved tools; shard by compatible scope |
| Results | Booking-specific Allure identities and panel plan | Preserve the supplied Allure schema, bind each item to its context, copy shard result directories, reject missing or duplicate items, and profile the Clojure/JVM runtime as well as VM behavior |
| Score and replay | Booking legacy scorer and 23 Pi cycle facts | File every selected item with the spec-v2 scorer and scoreboard; replay committed Pi facts with bound evidence for all six contexts and explicit shard receipts |

The original booking flow remains supported while the spec-v2 adapter is built.
Do not treat a green booking cycle as proof that the whole-app cut works.

The Pi gate process adapter now has a `spec-v2` mode that runs the pinned
source's `harness/v2/gate.sh` against a separate candidate room. It checks the
instrument commit before launch and again in the gate host, binds the mode,
slice and instrument identity into its durable receipt, and retains restart
reconciliation. A fixture proves that mode and the original booking mode.
The live cycle has not yet selected this mode; it still needs the spec-v2
fence, candidate path and builder instruction wiring.

## Execution order

1. Add a versioned `spec-v2` run profile to the Pi controller. Bind a separate
   source repository and commit, all six spec digests, checklist, builder and
   grader instructions, VM images, and panel plan. Keep the exact selection
   approval rule before any scored run.
2. Wire the source's legacy self-check, physical fence, prompt rendering and
   gate. Prove that a fresh Pi builder sees only the fenced six-context cut,
   writes only the declared candidate directory, and can continue its own
   uncarried items before up to three independently gated attempts.
3. Make the independent grader room and Allure validator context-aware. Run
   VM shards in parallel, preserve raw results, and require unique complete
   coverage of the approved checklist. The blind booking handoff is a
   booking-specific rule, not a requirement on unrelated contexts.
4. Add specialist probes selected by the spec-v2 plan, including JVM/Clojure
   diagnostics and a Grain store check. Bind their VM receipts and traces to
   the candidate. A probe failure remains visible and cannot rewrite item
   verdicts.
5. Score with the unchanged spec-v2 reference, compare against the same
   candidate and archived legacy/ORC behavior, verify restart recovery, then
   request an explicit acceptance decision. Publish the complete Pi replay
   and combined Allure report after reviewing evidence.

Whole-app completion requires an approved cut, a fresh Pi-controlled build,
passing independent gate, reviewed item-by-item evidence for the full
selection, a filed score, a clean specialist profile or recorded exception,
restart evidence, legacy comparison and explicit acceptance. None of those
claims follows merely from this inventory.
