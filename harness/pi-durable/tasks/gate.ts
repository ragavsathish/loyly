import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import type { GateRequest } from '../gate-effects.ts';

interface VerifiedGate {
  passed: boolean;
  exit: number;
  log: string;
  logSha256: string;
  reconciled: boolean;
}
interface GateDependencies {
  scratch: string;
  candidateDigest: () => string;
  gateRoomFor: (attempt: number, digest: string) => string;
  verify: (request: GateRequest) => Promise<VerifiedGate>;
  audit: (
    tx: unknown,
    task: unknown,
    stage: string,
    outcome: string,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
}

export function createGateTask(deps: GateDependencies) {
  return defineTask<
    { attempt: number },
    { phase: 'verify' },
    { passed: boolean; log: string; logSha256: string; candidateSha256: string }
  >({
    name: 'loyly.proto.gate',
    version: 1,
    initial: () => ({ phase: 'verify' }),
    phases: {
      verify: async (task, runtime) => {
        const attempt = task.input.attempt;
        const out = join(deps.scratch, `gate-${attempt}-evidence`);
        const digest = deps.candidateDigest();
        const gateRoom = deps.gateRoomFor(attempt, digest);
        const r = await deps.verify({
          room: gateRoom,
          out,
          candidateSha256: digest,
          timeoutMs: 900_000,
        });
        await runtime.commit(async (tx) => {
          await deps.audit(tx, task, 'gate', r.passed ? 'passed' : 'failed', {
            attempt,
            gate_log: r.log,
            gate_log_sha256: r.logSha256,
            exit: r.exit,
            candidate_digest: digest,
            reconciled: r.reconciled,
          });
          return {
            status: 'terminal',
            outcome: {
              status: 'completed',
              result: {
                passed: r.passed,
                log: r.log,
                logSha256: r.logSha256,
                candidateSha256: digest,
              },
            },
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
