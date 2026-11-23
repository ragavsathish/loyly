import { join } from 'node:path';
import { Context, Data, Effect } from 'effect';

export interface GateRequest {
  readonly room: string;
  readonly out: string;
  readonly candidateSha256: string;
  readonly timeoutMs: number;
}

export interface GateReceipt {
  readonly exit: number;
  readonly logSha256: string;
  readonly reconciled: boolean;
}

export class GateRunError extends Data.TaggedError('GateRunError')<{
  readonly reason: string;
}> {}

export class GateRunner extends Context.Service<
  GateRunner,
  { readonly run: (request: GateRequest) => Effect.Effect<GateReceipt, GateRunError> }
>()('HarnessGateRunner') {}

export function verifyCandidate(request: GateRequest) {
  return Effect.gen(function* () {
    const runner = yield* GateRunner;
    const receipt = yield* runner.run(request);
    return {
      passed: receipt.exit === 0,
      exit: receipt.exit,
      log: join(request.out, 'gate.log'),
      logSha256: receipt.logSha256,
      candidateSha256: request.candidateSha256,
      reconciled: receipt.reconciled,
    };
  });
}
