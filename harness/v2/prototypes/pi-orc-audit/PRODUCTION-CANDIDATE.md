# Pi durable production candidate

This branch continues the Pi prototype itself. The accepted ORC runner and
the legacy harness are comparison instruments, not the implementation base.
The original `harness/` tools still perform the self-check, fence, gate,
score and scoreboard. Pi durable owns the cycle checkpoint and audit; Gondolin
executes the builder, agent grader and three deterministic specialist probes.

## Live cycle

```text
pinned source and instrument digests
  -> self-check -> fence -> builder (bounded same-session continuation)
  -> independent gate -> three black-box agent grader shards
  -> fresh blind subagent and HTTP confirmation
  -> three specialist Gondolin VMs in parallel
  -> legacy score and scoreboard -> one Allure report -> Pi audit conclusion
```

The specialist VM stage is an actual Pi durable task. It has a maximum of two
isolated attempts. A complete manifest is verified and reused after a
controller restart; an interrupted attempt remains on disk as evidence and
one fresh attempt may run. Each VM sees a read-only candidate and worker tree
and writes to its own directory. The selected manifest hash enters
`score-input.json`, so a later score or restart cannot silently use another
panel. The report reads the original grader, blind review and three VM result
directories directly with Allure. Its own output is likewise selected from
at most two attempts and verified on reopening.

The current booking-core plan is `booking-core.panel.json`, checked by
`panel-plan.schema.json`. Results use the unchanged supplied
`allure-lifecycle-result.schema.json`; `panel-summary.schema.json` checks the
item-level summary. The plan says which checks are scored, handoffs,
corroboration and diagnostics. A specialist failure remains visible and makes
the panel `not-ready`; it cannot rewrite the agent's filed verdict. No latency
threshold is invented where the behavior spec has none.

The builder may install npm packages while testing. After each builder turn,
the controller removes `impl/node_modules` and `impl/.tmp` before binding the
authored candidate digest. Gate and grader copies install dependencies from
the package lock when their tests run. The first integrated run stopped before
its gate because the earlier controller tried to hash a generated npm symlink;
its partial audit and VM transcript remain in ignored scratch. A diagnostic
legacy gate passed after this cleanup. The three specialist VMs were also run
against that candidate: Playwright, protocol races and OpenTelemetry passed in
parallel. These diagnostics are not a filed cycle score.

## Pinned launch

Create an ignored JSON contract matching `live-run.schema.json` with the
absolute source and scratch paths, full controller and source commits, exact
checklist and spec digests, and the builder, grader, blind and panel digests.
The grader model must differ from the builder model. The source and controller
worktrees must be clean. `--check` derives and checks the selected checklist;
`--run` then launches the durable cycle with the panel required.

```sh
cd harness/v2/prototypes/pi-orc-audit
npm ci --ignore-scripts --no-audit --no-fund
node run-live.mjs --check scratch-production/live-run.json
node run-live.mjs --run scratch-production/live-run.json
```

The contract must be fixed before `--run`. Credentials remain in the operator
environment; the JSON file contains only paths, model names and digests.

## Acceptance boundary

This candidate is **not yet the running harness**. It needs a fresh scored
live run with the integrated panel, a clean product profile, the controller
kill/restart matrix, itemwise comparison with the legacy and accepted
instruments on the same candidate, and an operator acceptance decision.
The historical Pi cycle filed 10/11 because its blind HTTP confirmation used
the wrong route; a separate same-candidate correction showed 11/11. Neither
historical result substitutes for the new integrated scored run.
