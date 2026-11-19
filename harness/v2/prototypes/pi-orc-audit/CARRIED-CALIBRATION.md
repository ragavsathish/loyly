# Exploratory carried grader calibration

On 2026-11-19, a fresh `openai-codex/gpt-6.1-sol` Pi/Gondolin builder ran on the pinned original
Löyly cut `17d68d279f1a2b98840ebebd5b2dd794059350ed` with the eleven-item checklist
`4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`. The builder
finished on attempt 1. The unchanged legacy `harness/verify.sh` ran in a separate candidate copy:
20 tests passed, including booking over HTTP and a 100-run race, and the HTTP identity probe
passed. Candidate tree digest: `0281e10451682a30ef14a82902a035530d03beb8c6074900b60a19181221c547`.
The cycle stopped at its explicit `grader-not-connected` boundary and filed **no score**.

A first exploratory Terra shard run returned ten pass results and one pending blind review, but
the collector rejected it because the app wrote bookings under each shard's `impl/data/` while
running. The instruction now requires a fresh app copy under `work/runtime-<item-id>/` for each
item. A fresh second run used three independent `openai-codex/gpt-6.1-terra` Pi/Gondolin
sessions with that instruction. All three passed their plan, candidate, checklist, and schema
receipt checks. The collector merged eleven schema-valid Allure results and attachments, with
the following projection:

- `01-001` through `01-010`: passed on HTTP observations.
- `01-011`: skipped and pending for a separate blind human review.
- Surprises: zero. Merged Allure directory SHA-256:
  `90a5a04e5256af2b111e35fd15e240d8af8a9045b112796ce452fa9cb7d29ff0`.

The grader's race attachment contains 100 individual runs, 100 HTTP 201 responses, 100 HTTP 409
responses, and 100 successful releases. Its client opens both sockets and sends both requests
before reading either response. The refusal evidence for `01-011` contains only the refusal
shown to a resident, without the schedule configuration or a grader judgment.

After this run, Gondolin's nested read-only mounts were exercised directly: writes to
`/workspace/impl` and `/workspace/plan` failed in the VM, while `/workspace/work` accepted a
write. The grader process adapter now requests that policy and pins it in the launch receipt.
A third fresh Terra run used all three VMs with `room_readonly_inputs=1`. It again merged eleven
valid results: ten behavioral passes, `01-011` pending, zero surprises, and Allure directory
SHA-256 `92dcfd529c2a5b5ad0e6f5f7290415a69d0d701dffd4111e359a163a78bcbf57`.
All three candidate and plan digests remained unchanged. The race attachment contains 100
individual observations, with one-confirmed=100, both-confirmed=0, neither-confirmed=0,
orderingFailures=0, and no run starting with the target slot held.

These are **calibration observations**, not an approved scored cycle or acceptance. The candidate
is a single-process demo without household authentication, as its own README states. Raw
candidate, gate and grader rooms are ignored local artifacts under `scratch-real-builder-01/`
and `scratch-carried-terra-3/`. The grader instruction digest is a draft until operator approval;
the revised subagent review on a new pinned cut, same-candidate legacy shadow, and release decision remain open.

The candidate-bound blind packet is under `scratch-real-builder-01/blind-review-packet/`.
Its `refusal.txt` is the exact grader-captured refusal (SHA-256
`c98f2ea982409d5b25e8bc57f474ac646d4cb7735b036c6c252765d0ae103f28`); the packet
manifest SHA-256 is `6d1523849854e8dca562ed1419e6f8532670ac779617793de55c928f905b7f07`.
Only `refusal.txt` and `question.txt` should be shown to the blind reviewer. Under the
operator-approved revision, the reviewer is a fresh subagent with no inherited context or
tools. `blind-review-cli.mjs` validates its separate response against the packet and probes
the named request against a fresh candidate copy before it can file a passed agent Allure
result. It does not change the grader's pending result or auto-accept the build. The old
grader result remains pending under its original human-worded cut. The checklist digest
remains `4acbadbce0e08cafd19ac89d2a0d909a564abd242ffecdb06b6184a1bbe631cc`
because the item ID, title, rule, and source line did not change; the spec bytes did change.

### Blind subagent calibration on the old candidate

The operator authorized a fresh blind subagent. It was launched with no inherited history,
tools, project files, or configuration; its prompt held only the exact refusal above and the
question of what request to make. It answered: “Book pukuhuone 9 on Thursday from 17:00 to
18:30.” It also noted that the refusal did not say which calendar Thursday. The controller
transcribed the suggested recurring slot to `POST /book` with household 12, resource `ph9`,
weekday `Thursday`, and start `17:00`. A separate fresh candidate copy returned HTTP 201 and
confirmed every Thursday from 17:00 to 18:30. The new packet, review response, HTTP receipt,
and supplemental schema-valid Allure result are under `scratch-real-builder-01/blind-agent-*`
(ignored local artifacts). The corrected packet also binds the original spec SHA-256
`b28ee83dfaada8df0ed99b90121a50f3c55885ade4db323b68e03c4d5f15005e`.
Its packet SHA-256 is
`3b344c829213f51f67f4bd6e5d432477fe20aeace853306b681d57f457ab9b63`;
the rebound review response SHA-256 is
`95fd32704bfc63de3f0abc89cfab0c30c9acfb0f58430f25659a5f53b974ffbb`.
The ignored `-v2` artifacts hold this binding and another HTTP 201 confirmation.
This calibrated the revised method on a previously built candidate. It did not alter the
old raw grader result, produce a scored cycle, or approve that candidate under the new spec.
