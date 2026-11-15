# Slice 06 grading profile, draft for the next cycle

Cycle 16 passed its gate and all 61 checklist items, but its grader observed Gondolin QEMU
children still alive after grading. A host probe reproduced the cause: stopping the Gondolin CLI
reparented its QEMU child to PID 1; stopping the child cleared it. The candidate is not accepted.
The requirement to stop both already appears in spec round 20 and the cycle-runner seam.

The next slice-06 grader version adds a sidecar profile. For each checklist case it takes a
before snapshot, optional live samples, and an after snapshot before manual cleanup. The exact
check requires zero room-owned VM and runner processes at the boundaries. It records the model
request count, and either a Grain profile or a reason no store was created. The Grain reader
copies the SQLite store and WAL, then uses Grain's own reader to collect ORC trace lineage, node
outcomes, durations, event counts, instruction digests, and token usage when supplied. It does
not inspect candidate source.

Java 21 `jcmd`, `jstat`, and bounded JFR samples add thread, heap, GC, CPU, allocation and lock
evidence for a live JVM. Wall time, RSS and sampled JFR values are diagnostic rather than exact
grading thresholds. Raw command lines and prompts stay out of the filed profile; raw stores and
JFR files remain in ignored grading work. The report is digest-bound to the checklist, verdicts
and grader instruction. It emits OTLP/HTTP JSON trace and metric payloads following ADR 0005:
one grading trace, child spans per item, events for snapshots and Grain/JVM evidence, and metrics
for observed process memory, VM count, and thread count. The score files both payloads and their
digests. A failed profile accompanies the honest score and blocks acceptance.
This change to the grading instrument does not add a checklist item or alter cycle 16's score.

ORC's `ORC-PRINCIPLES.md` calls for a deterministic tree around model work, event-first evidence,
adversarial verification, and bounded cleanup. Its trace and GEPA guides show that node
instructions are versioned and GEPA can optimize them from train and validation examples. The
profile preserves node and instruction provenance for later dataset selection. Grading does not
run GEPA or mutate instructions. The revised grader digest and cycle 17's exact selection require
operator approval before the grader is used or the cycle is fenced.

The payload follows the [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/) with
`resourceSpans` and `resourceMetrics`. It uses the published
[`process.memory.usage` and `process.thread.count` conventions](https://opentelemetry.io/docs/specs/semconv/system/process-metrics/)
and keeps Löyly-specific checks under `loyly.*` attributes and metrics. No raw prompt content is
exported.
