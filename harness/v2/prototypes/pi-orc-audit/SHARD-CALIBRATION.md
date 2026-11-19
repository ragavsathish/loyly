# Exploratory rule-sharded grader calibration

On 2026-11-19, three fresh `openai-codex/gpt-6.1-terra` Pi sessions graded the gate-green
legacy fixture in parallel. Each host reported an isolated aarch64 Gondolin VM and held its own
room, checklist and SQLite session. The rule scopes were:

| Shard | Selected items |
| --- | --- |
| 01 | 01-001, 01-002, 01-007, 01-008 |
| 02 | 01-003, 01-004, 01-009, 01-010 |
| 03 | 01-005, 01-006, 01-011 |

All three hosts exited zero and their launch receipts reconciled on reopening without launching
another model session. Each shard wrote schema-valid Allure result files and attachments. The
collector covered the approved eleven items exactly once, merged eleven results and eleven
surprises, and derived zero passes. The fixture serves only a static sauna heading; the graders
reported the product interactions as unreached. Item 01-011 stayed skipped and pending for blind
human review. The merged Allure directory digest was
`25fcae379102acdcd57c8573c7b13ff0817706aeeccafb9dfe2e0ffe8980482c`.

The first collector attempt refused two forms of otherwise local surprise references: bare
filenames instead of `work/` paths, and one comma-separated set of selected item IDs. The
collector now makes those two deterministic projections after checking that every referenced
file is a regular file within the shard's `work/` and every item is selected. The raw grader
outputs remain in each shard room. A traversal, unknown item, missing evidence file, missing
Allure result, or duplicate item still stops the merge before scoring.

This is calibration against an **uncarried fixture**, not a product score. The raw rooms and
session receipts are ignored local artifacts under `scratch-terra-shards/`. A carried candidate,
approved instruction digest, and blind human review remain necessary before acceptance.
