import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { GateRunner, verifyCandidate } from '../gate-effects.ts';

test('gate Effect is lazy and keeps the candidate and receipt bound', async () => {
  const request = {
    room: '/room',
    out: '/out',
    candidateSha256: 'a'.repeat(64),
    timeoutMs: 900_000,
  };
  const seen = [];
  const layer = Layer.succeed(GateRunner, {
    run: (input) =>
      Effect.sync(() => {
        seen.push(input);
        return { exit: 0, logSha256: 'b'.repeat(64), reconciled: true };
      }),
  });
  const program = verifyCandidate(request).pipe(Effect.provide(layer));
  assert.deepEqual(seen, []);
  assert.deepEqual(await Effect.runPromise(program), {
    passed: true,
    exit: 0,
    log: '/out/gate.log',
    logSha256: 'b'.repeat(64),
    candidateSha256: request.candidateSha256,
    reconciled: true,
  });
  assert.deepEqual(seen, [request]);
});
