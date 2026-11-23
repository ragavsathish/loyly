import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from '../gate-adapter.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(exit, sleep = 0) {
  const root = mkdtempSync(join(tmpdir(), 'loyly-gate-adapter-'));
  const room = join(root, 'room'),
    out = join(root, 'evidence');
  mkdirSync(join(room, 'harness'), { recursive: true });
  writeFileSync(
    join(room, 'harness', 'verify.sh'),
    `#!/bin/sh\necho 'legacy gate ran'\nsleep ${sleep}\nexit ${exit}\n`,
  );
  return { room, out, candidateSha256: 'a'.repeat(64), timeoutMs: 10_000 };
}
test('passed and failed legacy gates retain their exact verdict and log', async () => {
  for (const code of [0, 1]) {
    const args = fixture(code);
    const first = await runGate(args);
    assert.equal(first.exit, code);
    assert.equal(first.reconciled, false);
    assert.match(readFileSync(join(args.out, 'gate.log'), 'utf8'), /legacy gate ran/);
    const second = await runGate(args);
    assert.deepEqual([second.exit, second.reconciled], [code, true]);
  }
});
test('a green suite cannot seal a candidate that recreates a local package cache', async () => {
  const args = fixture(0);
  mkdirSync(join(args.room, 'impl'));
  writeFileSync(
    join(args.room, 'harness', 'verify.sh'),
    '#!/bin/sh\nmkdir -p impl/.npm-cache\necho gate-green\nexit 0\n',
  );
  const result = await runGate(args);
  assert.equal(result.exit, 1);
  assert.match(readFileSync(join(args.out, 'gate.log'), 'utf8'), /package cache.*impl/);
});
test('a killed controller reads the surviving gate receipt', async () => {
  const args = fixture(1, 2);
  const controller = spawn(
    process.execPath,
    [new URL('./invoke-gate.mjs', import.meta.url).pathname, JSON.stringify(args)],
    { stdio: 'ignore' },
  );
  for (let n = 0; n < 100 && !existsSync(join(args.out, 'running.txt')); n++) await pause(20);
  assert.ok(existsSync(join(args.out, 'running.txt')), 'gate host started');
  controller.kill('SIGKILL');
  const result = await runGate(args);
  assert.deepEqual([result.exit, result.reconciled], [1, true]);
  assert.equal(readdirSync(args.out).filter((name) => name === 'receipt.txt').length, 1);
});
