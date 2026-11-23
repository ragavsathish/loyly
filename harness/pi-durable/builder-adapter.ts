// A process boundary for the provided Pi builder host. The durable cycle gives
// each attempt a stable session ID; builder.sh writes its own launch receipt.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LaunchReceipt {
  session_id?: string;
  request_id?: string;
  instruction_sha256?: string;
  model?: string;
  wrapper_pid?: string;
  host_pid?: string;
  room?: string;
  builder_image?: string;
  store?: string;
  parent_conversation_receipt?: string;
  bash_timeout_floor?: string;
  bash_timeout_ceiling?: string;
  room_readonly_inputs?: string;
  exit?: string;
  [key: string]: string | undefined;
}

interface FoundLaunch {
  path: string;
  receipt: LaunchReceipt;
}

interface RunBuilderArgs {
  command: string;
  room: string;
  instruction: string;
  image: string;
  evidenceDir: string;
  sessionId: string;
  requestId?: string;
  model: string;
  stateRoot: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  prompt?: string;
  roomLabel?: string;
  piSettings?: string;
  imageAdditionsPath?: string;
  readonlyInputs?: boolean;
  bashTimeoutFloorSeconds?: number;
  bashTimeoutCeilingSeconds?: number;
  storePath?: string;
  parentConversationReceipt?: string;
}

interface BuilderRunResult {
  exit: number;
  reconciled: boolean;
  receipt: string;
}

function fields(path: string): LaunchReceipt {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  return Object.fromEntries(
    lines.map((line) => {
      const at = line.indexOf('=');
      return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
    }),
  );
}

function latestLaunch(
  evidenceDir: string,
  sessionId: string,
  requestId: string,
): FoundLaunch | null {
  if (!existsSync(evidenceDir)) return null;
  const names = readdirSync(evidenceDir)
    .filter((name) => /^launch-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
  for (const name of names) {
    const path = join(evidenceDir, name, 'launch.txt');
    if (!existsSync(path)) continue;
    const receipt = fields(path);
    // A concurrent writer may have created launch.txt but not yet written its
    // session_id line. Treat that as pending, never as permission to relaunch.
    if (
      !receipt.session_id ||
      !receipt.request_id ||
      (receipt.session_id === sessionId && receipt.request_id === requestId)
    )
      return { path, receipt };
  }
  return null;
}

function hasBuilderLaunch(evidenceDir: string, sessionId: string, requestId: string): boolean {
  return latestLaunch(evidenceDir, sessionId, requestId) !== null;
}

async function readyLaunch(
  evidenceDir: string,
  sessionId: string,
  requestId: string,
): Promise<FoundLaunch | null> {
  let found = latestLaunch(evidenceDir, sessionId, requestId);
  for (let n = 0; found && n < 100; n++) {
    if (found.receipt.instruction_sha256 && found.receipt.model && found.receipt.wrapper_pid)
      return found;
    await pause(50);
    found = latestLaunch(evidenceDir, sessionId, requestId);
  }
  if (found) throw new Error('builder launch receipt stayed incomplete');
  return null;
}

function livePid(pid: string | number | undefined, expectedCommand: string): boolean {
  if (!/^\d+$/.test(String(pid ?? ''))) return false;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes(expectedCommand);
}

function validateReceipt(
  found: FoundLaunch | null | undefined,
  instructionSha256: string,
  model: string,
  room: string,
  image: string,
  readonlyInputs: boolean,
  sessionId: string,
  requestId: string,
  bashTimeoutFloorSeconds: number | undefined,
  bashTimeoutCeilingSeconds: number | undefined,
  storePath: string | undefined,
  parentConversationReceipt: string | undefined,
): void {
  if (!found) return;
  const { receipt } = found;
  if (
    receipt.session_id !== sessionId ||
    receipt.request_id !== requestId ||
    receipt.instruction_sha256 !== instructionSha256 ||
    receipt.model !== model ||
    receipt.room !== room ||
    receipt.builder_image !== image ||
    (storePath !== undefined && receipt.store !== storePath) ||
    (parentConversationReceipt !== undefined &&
      receipt.parent_conversation_receipt !== parentConversationReceipt) ||
    (bashTimeoutFloorSeconds !== undefined &&
      receipt.bash_timeout_floor !== String(bashTimeoutFloorSeconds)) ||
    (bashTimeoutCeilingSeconds !== undefined &&
      receipt.bash_timeout_ceiling !== String(bashTimeoutCeilingSeconds)) ||
    (readonlyInputs
      ? receipt.room_readonly_inputs !== '1'
      : receipt.room_readonly_inputs !== undefined && receipt.room_readonly_inputs !== '0')
  )
    throw new Error(
      'builder launch receipt differs from approved room, instruction, image or model',
    );
}

function stopGroup(pid: number | undefined, expectedCommand: string): void {
  if (!pid || !livePid(pid, expectedCommand)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (livePid(pid, expectedCommand)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 5000).unref();
}

async function runBuilder({
  command,
  room,
  instruction,
  image,
  evidenceDir,
  sessionId,
  requestId = sessionId,
  model,
  stateRoot,
  timeoutMs = 14_400_000,
  signal,
  prompt,
  roomLabel,
  piSettings,
  imageAdditionsPath,
  readonlyInputs = false,
  bashTimeoutFloorSeconds,
  bashTimeoutCeilingSeconds,
  storePath,
  parentConversationReceipt,
}: RunBuilderArgs): Promise<BuilderRunResult> {
  for (const path of [command, room, instruction, image, evidenceDir, stateRoot])
    if (!isAbsolute(path)) throw new Error(`builder path must be absolute: ${path}`);
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error('unsafe builder session ID');
  if (!/^[A-Za-z0-9._-]+$/.test(requestId)) throw new Error('unsafe builder request ID');
  if (
    bashTimeoutFloorSeconds !== undefined &&
    (!Number.isInteger(bashTimeoutFloorSeconds) ||
      bashTimeoutFloorSeconds < 1 ||
      bashTimeoutFloorSeconds > 1800)
  )
    throw new Error('invalid bash timeout floor');
  if (
    bashTimeoutCeilingSeconds !== undefined &&
    (!Number.isInteger(bashTimeoutCeilingSeconds) ||
      bashTimeoutCeilingSeconds < (bashTimeoutFloorSeconds ?? 1800))
  )
    throw new Error('invalid bash timeout ceiling');
  if (!existsSync(room) || !existsSync(instruction) || !existsSync(image))
    throw new Error('builder room, instruction, or image missing');
  if (storePath && !isAbsolute(storePath)) throw new Error('Pi store path must be absolute');
  if (
    parentConversationReceipt &&
    (!isAbsolute(parentConversationReceipt) || !existsSync(parentConversationReceipt))
  )
    throw new Error('prior Pi conversation receipt missing');
  if (signal?.aborted) throw new Error('builder launch already aborted');
  const instructionSha256 = sha256(readFileSync(instruction));
  mkdirSync(evidenceDir, { recursive: true });
  let found = await readyLaunch(evidenceDir, sessionId, requestId);
  validateReceipt(
    found,
    instructionSha256,
    model,
    room,
    image,
    readonlyInputs,
    sessionId,
    requestId,
    bashTimeoutFloorSeconds,
    bashTimeoutCeilingSeconds,
    storePath,
    parentConversationReceipt,
  );
  if (found?.receipt.exit !== undefined)
    return { exit: Number(found.receipt.exit), reconciled: true, receipt: found.path };

  // If the controller died, builder.sh can still be running in its own process
  // group. Wait for its receipt; never start a second writer on that Pi store.
  const started = Date.now();
  while (
    found &&
    (livePid(found.receipt.wrapper_pid, basename(command)) ||
      livePid(found.receipt.host_pid, 'host.ts'))
  ) {
    if (Date.now() - started > timeoutMs) {
      stopGroup(Number(found.receipt.wrapper_pid), basename(command));
      if (livePid(found.receipt.host_pid, 'host.ts'))
        try {
          process.kill(Number(found.receipt.host_pid), 'SIGTERM');
        } catch {
          /* already gone */
        }
      throw new Error('existing builder host exceeded deadline');
    }
    await pause(1000);
    found = await readyLaunch(evidenceDir, sessionId, requestId);
    validateReceipt(
      found,
      instructionSha256,
      model,
      room,
      image,
      readonlyInputs,
      sessionId,
      requestId,
      bashTimeoutFloorSeconds,
      bashTimeoutCeilingSeconds,
      storePath,
      parentConversationReceipt,
    );
    if (found?.receipt.exit !== undefined)
      return { exit: Number(found.receipt.exit), reconciled: true, receipt: found.path };
  }
  // A dead wrapper with no exit receipt can be relaunched with the same session
  // and request ID; pi-durable resumes that submission instead of duplicating it.
  const out = openSync(join(evidenceDir, 'controller.stdout'), 'a');
  const err = openSync(join(evidenceDir, 'controller.stderr'), 'a');
  const child = spawn(command, [room, instruction, image], {
    cwd: room,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      BUILDER_EVIDENCE_DIR: evidenceDir,
      LOYLY_BUILDER_SESSION_ID: sessionId,
      LOYLY_BUILDER_REQUEST_ID: requestId,
      ...(storePath ? { LOYLY_BUILDER_STORE: storePath } : {}),
      ...(parentConversationReceipt ? { LOYLY_PI_PARENT_RECEIPT: parentConversationReceipt } : {}),
      LOYLY_PI_MODEL: model,
      PI_HARNESS_STATE_ROOT: stateRoot,
      ...(prompt ? { LOYLY_PI_PROMPT: prompt } : {}),
      ...(roomLabel ? { LOYLY_ROOM_LABEL: roomLabel } : {}),
      ...(piSettings ? { LOYLY_BUILDER_PI_SETTINGS: piSettings } : {}),
      LOYLY_ROOM_READONLY_INPUTS: readonlyInputs ? '1' : '0',
      ...(bashTimeoutFloorSeconds !== undefined
        ? { LOYLY_BASH_TIMEOUT_FLOOR_SECONDS: String(bashTimeoutFloorSeconds) }
        : {}),
      ...(bashTimeoutCeilingSeconds !== undefined
        ? { LOYLY_BASH_TIMEOUT_CEILING_SECONDS: String(bashTimeoutCeilingSeconds) }
        : {}),
      ...(imageAdditionsPath ? { LOYLY_IMAGE_ADDITIONS_PATH: imageAdditionsPath } : {}),
    },
  });
  closeSync(out);
  closeSync(err);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopGroup(child.pid, basename(command));
  }, timeoutMs);
  const onAbort = () => stopGroup(child.pid, basename(command));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const exit = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
    });
    found = await readyLaunch(evidenceDir, sessionId, requestId);
    validateReceipt(
      found,
      instructionSha256,
      model,
      room,
      image,
      readonlyInputs,
      sessionId,
      requestId,
      bashTimeoutFloorSeconds,
      bashTimeoutCeilingSeconds,
      storePath,
      parentConversationReceipt,
    );
    if (timedOut) throw new Error('builder host exceeded deadline');
    if (!found || found.receipt.exit === undefined)
      throw new Error('builder host exited without a completed launch receipt');
    if (Number(found.receipt.exit) !== exit)
      throw new Error('builder process exit differs from its launch receipt');
    return { exit, reconciled: false, receipt: found.path };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export type { RunBuilderArgs, BuilderRunResult, LaunchReceipt };
export { hasBuilderLaunch, runBuilder };
