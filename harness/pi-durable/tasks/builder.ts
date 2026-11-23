import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import { createBuilderPhases } from './builder-phases.ts';
import {
  type BuilderDependencies,
  type BuilderInput,
  type BuilderCheckpoint,
  type BuilderResult,
} from './builder-types.ts';

export type {
  BuilderConfig,
  BuilderCall,
  BuilderDependencies,
  BuilderInput,
  BuilderCheckpoint,
  BuilderResult,
} from './builder-types.ts';
export { legacyFailure } from './builder-types.ts';

export function createBuilderTask(deps: BuilderDependencies) {
  const ctx = BACKGROUND_CONTEXT;
  return defineTask<BuilderInput, BuilderCheckpoint, BuilderResult>({
    name: 'loyly.proto.builder',
    version: 1,
    initial: () => ({ phase: 'announce' }),
    phases: createBuilderPhases(deps, ctx),
    abort: (_task, runtime) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });
}
