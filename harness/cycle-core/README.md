# Cycle core: phase decisions only

**One job:** decide the next cycle phase from plain outcomes. No filesystem,
no Allure, no models, no Löyly product ids.

```
build → gate → grading-room → [assessments…] → score
```

`createLifecycle({ maxBuildAttempts, assessments })` returns pure functions
`afterBuild`, `afterGate`, `afterGrade`, `afterAssessment`. Adapters (Pi,
Codex, Cursor) translate effects into `TaskOutcome` values and checkpoints
from the returned decisions.

Evidence validation lives in [`../evidence-core/`](../evidence-core/).
Legacy fence/gate/score scripts stay in `harness/`.
