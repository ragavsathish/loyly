# 0007 Rebuild the changed context and retain accepted contexts

## Status

Proposed (2026-11-17). Drafted after the operator accepted the cycle-23 runner as a complete
context. This decision has not changed the approved selection or the sealed grader of any
cycle.

## Context

Cycles 21–24 rebuilt all 61 items of the cycle-runner context from a fresh room. Cycle 23
scored 59/61 with a clean profile and matched the legacy instrument on one shared candidate;
cycle 24 scored 31/61 and regressed in that comparison. The contexts 01–05 already have
accepted builds. A fresh builder may not read prior candidates or score evidence from its
room. The legacy harness continues to build slice 06 until the replacement instrument is
accepted and compared.

## Proposed decision

For a spec change to one context, regenerate that context from a fresh clean room and retain
the accepted builds of unchanged contexts byte for byte. Record the exact spec cut, selected
context, dependency contracts, accepted context digests, and candidate digest in the cycle.
At acceptance, run an integration gate with the candidate and the retained contexts, then
compare instrument behavior with the previous instrument on the same cut and candidate.
If a consumed contract changes, rebuild each dependent context before accepting the new
assembly. Periodically run a full clean regeneration as a drift check; its result does not
silently replace accepted contexts.

The unit of reuse is a bounded context, not an individual checklist item. Slice 06 is one
context today: a failed `06-047` or `06-066` requires a fresh build of 06 under the current
spec. Extracting part of 06 into another context requires a separate spec and event-model
round, with a new seam, dependency contract, item allocation, and operator-approved selection.

## Consequences and proof

- Fresh builders still see only their selected context and declared contracts. Prior source
  and verdicts remain outside the room.
- The acceptance record names every retained digest. A missing or mismatched digest blocks
  assembly; a failed integration gate or instrument shadow blocks acceptance.
- Before this proposal becomes accepted, demonstrate a changed-context run and a full
  regeneration against the same integration fixture, including a contract-change case that
  invalidates a dependent context.

This proposal does not waive the two recorded cycle-23 failures or the cycle-25 preflight.
