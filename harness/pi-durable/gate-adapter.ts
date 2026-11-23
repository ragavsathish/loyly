// Reconcile the legacy gate's external process from its own durable receipt.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = fileURLToPath(new URL('./gate-host.sh', import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

interface RunGateArgs {
  room: string;
  out: string;
  candidateSha256: string;
  timeoutMs?: number;
}

interface GateReceipt {
  exit: number;
  logSha256: string;
  receipt: string;
}

interface GateRunResult extends GateReceipt {
  reconciled: boolean;
}

function fields(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );
}

function live(pid: string | number | undefined): boolean {
  if (!/^\d+$/.test(String(pid ?? ''))) return false;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.includes('gate-host.sh');
}

function receipt(out: string, room: string, candidateSha256: string): GateReceipt | null {
  const path = join(out, 'receipt.txt');
  if (!existsSync(path)) return null;
  const result = fields(path);
  const logSha256 = result.log_sha256;
  const exit = result.exit;
  if (
    result.room !== room ||
    result.candidate_sha256 !== candidateSha256 ||
    exit === undefined ||
    !/^\d+$/.test(exit) ||
    logSha256 === undefined ||
    !/^[0-9a-f]{64}$/.test(logSha256) ||
    logSha256 !== hash(readFileSync(join(out, 'gate.log')))
  )
    throw new Error('gate receipt does not match room, candidate or log');
  return {
    exit: Number(exit),
    logSha256,
    receipt: path,
  };
}

async function runGate({
  room,
  out,
  candidateSha256,
  timeoutMs = 3_600_000,
}: RunGateArgs): Promise<GateRunResult> {
  if (!isAbsolute(room) || !isAbsolute(out) || !/^[0-9a-f]{64}$/.test(candidateSha256))
    throw new Error('gate needs absolute paths and a candidate SHA-256');
  if (!existsSync(join(room, 'harness', 'verify.sh'))) throw new Error('legacy gate missing');
  mkdirSync(out, { recursive: true });
  let done = receipt(out, room, candidateSha256);
  if (done) return { ...done, reconciled: true };
  const intent = join(out, 'intent.json');
  const running = join(out, 'running.txt');
  if (existsSync(intent)) {
    const recorded = JSON.parse(readFileSync(intent, 'utf8')) as {
      room: string;
      candidateSha256: string;
    };
    if (recorded.room !== room || recorded.candidateSha256 !== candidateSha256)
      throw new Error('gate intent differs from candidate');
    for (let n = 0; n < 100 && !existsSync(running); n++) await pause(50);
    if (!existsSync(running)) throw new Error('gate launch was interrupted before process receipt');
    const started = fields(running);
    if (started.room !== room || started.candidate_sha256 !== candidateSha256)
      throw new Error('gate running receipt differs from candidate');
    const began = Date.now();
    while (live(started.pid)) {
      done = receipt(out, room, candidateSha256);
      if (done) return { ...done, reconciled: true };
      if (Date.now() - began > timeoutMs) throw new Error('surviving gate exceeded deadline');
      await pause(250);
    }
    done = receipt(out, room, candidateSha256);
    if (done) return { ...done, reconciled: true };
    throw new Error(
      'gate process ended without a receipt; discard its gate room and retry separately',
    );
  }
  writeFileSync(intent, JSON.stringify({ room, candidateSha256 }), {
    flag: 'wx',
  });
  const child = spawn(HOST, [room, out, candidateSha256], {
    cwd: room,
    detached: true,
    stdio: 'ignore',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (live(child.pid)) {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        /* exited */
      }
      setTimeout(() => {
        if (live(child.pid))
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            /* exited */
          }
      }, 5000).unref();
    }
  }, timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    if (timedOut) throw new Error('gate exceeded deadline');
    done = receipt(out, room, candidateSha256);
    if (!done) throw new Error('gate exited without a receipt');
    return { ...done, reconciled: false };
  } finally {
    clearTimeout(timer);
  }
}

export type { RunGateArgs, GateReceipt, GateRunResult };
export { runGate };
