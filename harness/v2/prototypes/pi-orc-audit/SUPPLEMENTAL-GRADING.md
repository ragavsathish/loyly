# Specialist VM grading of the last live candidate

The 2026-11-19 live Pi cycle remains filed at **10/11**. Its source cut is
`b97e4eda015167c571eb3296fa03fe4fea366130`; the gated candidate tree is
`79481d7eb90f617d58017cb3ec9676c2a00bd0633b58aff918847c10b9bf2657`.
The original score file remains SHA-256
`95405da343022aaf0ce928881f2df2e02ab9f5e1fec93c64ba04a307441fb4ab`.

A **grading-only**, same-candidate experiment then launched three different tool
workers concurrently. It did not rebuild the candidate, reopen the Pi cycle, or
replace any of its 11 verdicts. Its output is under the ignored
`scratch-real-cycle-01/hetero-grade/concurrent2/combined/` directory.

| Worker | Isolation | Observed result | Allure item |
| --- | --- | --- | --- |
| Playwright | Disposable container in Docker Desktop's shared Linux VM; read-only candidate mount, read-only root filesystem, no network | Native form booking, persistent holding, all three derived views, screenshots and trace | `01-003` passed |
| Protocol | Separate Gondolin QEMU VM with a fresh candidate copy | 101 overlapping two-household races: exactly one confirmation and one held refusal each time, plus derived views and release | `01-010` passed |
| OpenTelemetry | Separate container in Docker Desktop's shared Linux VM; read-only candidate and probe mounts, bounded local OTLP receiver | HTTP 201 booking, three candidate-bound spans, five metric export requests with 14 metric rows, persisted booking and three views | `01-003` passed |

All three result intervals overlap by **1,504 ms**. The workers are independent
processes and isolated runtimes; Docker Desktop does not provide a dedicated VM
per container. The protocol worker uses its own Gondolin VM. This distinction is
recorded in each result's execution receipt.

`supplemental-grade.mjs` verifies the same candidate and original score,
validates all three results with the exact supplied Allure lifecycle JSON Schema
(SHA-256 `0eef607c5d9eef4a190ea0deb7c7a61228267d8ec556b722b37dd83ef253fee1`),
checks each attachment and VM execution receipt, requires positive time overlap,
and renders a **three-case supplemental Allure report**. The separate manifest
records each producer's file hashes and the report hash. The original Pi audit,
original 12-case Allure report, and corrected 11/11 same-candidate legacy score
remain distinct evidence.

The probe launch scripts and raw runtime files are retained in ignored scratch,
not in the fenced source cut. This is an exploratory demonstration of
capability-specific parallel grading, not a new release profile or acceptance
decision. A future scored cycle needs a pinned tool plan, durable specialist
launch receipts, coverage policy, and explicit profile budgets in the grader
contract before these results can affect its score.
