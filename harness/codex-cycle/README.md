# Codex subagent cycle assets

This directory holds the Codex-specific builder, booking/product grader and
blind instructions, subagent preambles, and panel plans. All adapter logic
(`preflight`, `candidate`, `decide`, `evidence`, `panel`, `reassess`) lives in
`harness/loyly-clj` (`loyly.adapters`, `.cljc`) and is invoked via
`bin/loyly-clj cycle codex ...`.

The orchestrator prepares a pinned contract, obtains the operator's exact
approval under `AGENTS.md`, fences the selected source, launches fresh builder
and independent grader subagents, runs the legacy gate, and uses the adapter
to decide the next phase and validate Allure before filing the legacy score.
The grader's app observations run in private Gondolin VMs. The blind reviewer
sees only the refusal and question.

After each builder turn, run `bin/loyly-clj cycle codex candidate candidate-input.json`
with `{ "room": "/absolute/path/to/builder-clean-room", "mode": "sealed" }`.
After a green gate, run it on the independent gate room with `"mode":
"post-gate"`; `test.sh` may legitimately have installed `node_modules` there,
but a package download cache inside `impl/` still fails. Run sealed mode once
more on the builder candidate immediately before copying it to the grading
room. The sealed check rejects disposable npm, Maven, uv, and installed
dependency caches anywhere under `impl/`, including nested projects. A green
suite that recreates a local download cache needs a builder repair; the check
is part of the gate handoff, not an item verdict.

`bin/loyly-clj cycle codex preflight contract.json` checks the clean controller
checkout at its approved commit, checks the source commit, derives the
checklist afresh and compares its bytes to the pin, then checks the run ID,
score cycle, output path, ordered item list, spec files, model separation,
instruction and concrete subagent preamble digests, exact panel coverage, the
Allure schema, panel plan, grader image manifest, and the Codex/Gondolin
runtime declarations. `bin/loyly-clj cycle codex decide attempt.json` applies
the three-attempt `loyly.cycle-core` policy to recorded builder and gate
outcomes. `bin/loyly-clj cycle codex evidence evidence.json` checks grader and
blind Allure schema, attachments, exact item coverage, tool labels, surprises
and final verdicts through `loyly.evidence.*`. `bin/loyly-clj cycle codex panel
panel.json` runs `evaluate-panel` over room Allure and filed verdicts. These
commands only read evidence and print reports. They do not fence, build, grade
or score.

For a grader-only reassessment of a frozen candidate, use a separate
`loyly.codex-grader-reassessment.v1` contract with
`bin/loyly-clj cycle codex reassess <contract.json>`. It checks the original
candidate, score and full checklist, requires exactly its failed items, pins
the new grader instruction, panel, schema and VM image, and refuses a reused
output path. The original score is never rewritten.
