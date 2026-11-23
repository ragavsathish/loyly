import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import type { TaskOutcome } from '@earendil-works/pi-durable';
import { hash } from '../cycle-effects.ts';

interface PanelRun {
  out: string;
  attempt: number;
  reconciled: boolean;
  manifest: {
    candidate_sha256: string;
    producers: { id: string; status: string }[];
  };
}
interface PanelDependencies {
  scratch: string;
  panel: { planSha256?: string; imageSha256?: string } | null;
  runPanel: () => Promise<PanelRun>;
  audit: (
    tx: unknown,
    task: unknown,
    stage: string,
    outcome: string,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
}

export function createPanelTask(deps: PanelDependencies) {
  return defineTask<{ candidateSha256: string }, { phase: 'run' }, { attempt: number }>({
    name: 'loyly.proto.panel',
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (task, runtime) => {
        let result: PanelRun | undefined;
        let reason: string | undefined;
        try {
          if (!deps.panel) throw new Error('grading panel not configured');
          result = await deps.runPanel();
          if (result.manifest.candidate_sha256 !== task.input.candidateSha256)
            throw new Error('panel VM candidate differs from gated candidate');
        } catch (error) {
          reason = String(error instanceof Error ? (error.stack ?? error) : error);
          writeFileSync(join(deps.scratch, 'panel-error.log'), `${reason}\n`);
        }
        await runtime.commit(async (tx) => {
          await deps.audit(tx, task, 'panel', result ? 'completed' : 'failed', {
            candidate_sha256: task.input.candidateSha256,
            plan_sha256: deps.panel?.planSha256 ?? null,
            image_sha256: deps.panel?.imageSha256 ?? null,
            manifest_sha256: result ? hash(readFileSync(join(result.out, 'manifest.json'))) : null,
            attempt: result?.attempt ?? null,
            workers:
              result?.manifest.producers.map((row) => ({ id: row.id, status: row.status })) ?? [],
            reconciled: result?.reconciled ?? false,
            reason_code: reason ? 'panel-vm-effect' : null,
          });
          const outcome = result
            ? { status: 'completed', result: { attempt: result.attempt } }
            : { status: 'failed', error: 'panel' };
          // Existing v1 Pi stores persist a string failure. Preserve it while extracting the task.
          return {
            status: 'terminal',
            outcome: outcome as unknown as TaskOutcome<{ attempt: number }>,
          };
        }, BACKGROUND_CONTEXT);
      },
    },
    abort: (_task, runtime) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
        BACKGROUND_CONTEXT,
      ),
  });
}
