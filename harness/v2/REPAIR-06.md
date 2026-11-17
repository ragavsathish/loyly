# Draft repair slice for the accepted cycle-23 runner

This draft is the proposed workflow contract under ADR 0007. It does not authorize fencing,
building, or grading until the operator approves the exact inputs and the preflight proves
the legacy comparison and room boundary.

| Input | Pinned value |
| --- | --- |
| Accepted base | `harness-impl/06-cycle-runner/`, cycle 23 attempt 2 |
| Base source digest | `947d49609d24e2325fcb027a695b03c3b68c2b9cd9337a3401d39cf58df5231a` over 39 files, excluding caches and provenance |
| Repair selection | `06-047`, `06-066` |
| Full protected selection | 61 item IDs; ordered list SHA-256 `19b3d887e008a60ac9270c9a5845c2e5ecf0b9f0174439b7d8d7a91072a35c42` |
| Current spec.feature | SHA-256 `e3facb847152b9c183e8613fc5d0a394e84c3ee32f45f5582f0cc23c46e0774c` |
| Current sealed grader instruction | SHA-256 `677b1d9a7c8ac3c56602528a17abdd7450c21158bf90e5a48c156ab32553297c` |

The builder's room is the fenced current cut plus one instrument-supplied,
`repair-input/accepted-base/` copy of the pinned source. The builder may read that copy and
write only the new `harness-impl/06-cycle-runner/` candidate. The instrument verifies the
base digest before and after the build, records every candidate-source difference against
the base, and refuses any undeclared input or output. The builder receives the two selected
item IDs and their current spec, without prior verdicts or grader transcripts.

The independent gate runs the complete suite, fresh identity probe, and Grain store check.
The independent grader scores all 61 current items. Accept only if 047 and 066 pass, none of
the other 59 newly fail, the profile is clean, and a same-cut instrument shadow matches
legacy on the shared fixture. Promotion replaces the complete context and records both the
base digest and repair diff in provenance.

Before opening this repair room, finish `preflight/06/25.md`: compare the proposed exception
with legacy's gate repair, add a built-in-gate identity fixture that catches cycle 24's gap,
and prove the repair-room source boundary. The accepted cycle-23 runner stays in service
until a replacement meets all checks.
