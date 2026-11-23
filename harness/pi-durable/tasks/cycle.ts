// @ts-nocheck
// Parent cycle: cut through score/panel-report over typed child tasks.
// Phase bodies live in cycle-phases.ts.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import { createCyclePhases } from './cycle-phases.ts';
import { type CycleDependencies } from './cycle-types.ts';

export function createCycleTask(deps: CycleDependencies) {
  const ctx = BACKGROUND_CONTEXT;
  // Checkpoint/outcome shapes stay byte-compatible with existing Pi stores.
  return defineTask({
    name: 'loyly.proto.cycle',
    version: 1,
    initial: () => ({ phase: 'cut' }),
    phases: createCyclePhases(deps, ctx),
    abort: (_task, runtime) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  } as any);
}

export type { CycleDependencies, CommandResult, PanelConfig } from './cycle-types.ts';
export { terminalFail } from './cycle-types.ts';
