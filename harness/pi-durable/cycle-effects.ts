import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

interface CyclePaths {
  root: string;
  scratch: string;
  room: string;
  cut: string;
  sourceRoot: string;
  approvedSourceRepo: string;
  approvedCommit?: string;
  digestCandidate: (room: string) => string;
}

export function createCycleEffects(
  paths: CyclePaths,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const {
    root,
    scratch,
    room,
    cut,
    sourceRoot,
    approvedSourceRepo,
    approvedCommit,
    digestCandidate,
  } = paths;
  const resultPath = (name: string) => join(scratch, `${name}.log`);
  function command(
    name: string,
    program: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
    } = {},
  ) {
    const r = spawnSync(program, args, {
      cwd: options.cwd ?? sourceRoot,
      env: { ...environment, ...options.env },
      encoding: 'utf8',
      timeout: options.timeout ?? 900_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    writeFileSync(resultPath(name), output);
    return { code: r.status ?? 124, output, sha256: hash(output), log: resultPath(name) };
  }
  function proofOfFence() {
    if (!existsSync(room)) return false;
    const roots = spawnSync('git', ['-C', room, 'rev-list', '--count', '--all'], {
      encoding: 'utf8',
    });
    return (
      roots.status === 0 &&
      roots.stdout.trim() === '1' &&
      !existsSync(join(room, 'impl')) &&
      !existsSync(join(room, 'harness', 'cycles'))
    );
  }
  function gitAt(path: string, ...args: string[]) {
    const r = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  }
  function proveCut() {
    if (!approvedCommit) return true;
    const receipt = join(cut, 'cut.json');
    if (!existsSync(receipt) || !existsSync(sourceRoot)) return false;
    const recorded = JSON.parse(readFileSync(receipt, 'utf8')) as {
      commit?: string;
      project?: string;
      source_repo?: string;
    };
    return (
      recorded.commit === approvedCommit &&
      recorded.project === sourceRoot &&
      (recorded.source_repo ?? root) === approvedSourceRepo &&
      gitAt(sourceRoot, 'rev-parse', 'HEAD') === approvedCommit &&
      gitAt(sourceRoot, 'status', '--porcelain') === ''
    );
  }
  function candidateDigest(candidateRoom = room) {
    return digestCandidate(candidateRoom);
  }
  function clearBuilderTestArtifacts() {
    for (const name of ['node_modules', '.tmp'])
      rmSync(join(room, 'impl', name), { recursive: true, force: true });
  }
  function verifyBuilderScope(requireEntrypoints = true) {
    if (
      requireEntrypoints &&
      (!existsSync(join(room, 'impl', 'start.sh')) || !existsSync(join(room, 'impl', 'test.sh')))
    )
      throw new Error('builder did not leave both legacy app entrypoints');
    const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: room,
      encoding: 'buffer',
    });
    if (result.status !== 0) throw new Error('cannot check builder write scope');
    for (const line of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
      if (line.slice(0, 2) !== '??') throw new Error('builder modified a tracked clean-room file');
      const path = line.slice(3);
      if (!path.startsWith('impl/') && !path.startsWith('.builder/'))
        throw new Error(`builder wrote outside declared scope: ${path}`);
    }
  }
  function gateRoomFor(attempt: number, digest: string) {
    const base = join(scratch, `gate-${attempt}`),
      gateRoom = join(base, 'room');
    const marker = join(base, 'copy.json');
    if (existsSync(gateRoom) && !existsSync(marker))
      throw new Error('gate-room copy was interrupted; inspect its scratch directory');
    if (!existsSync(gateRoom)) {
      mkdirSync(base, { recursive: true });
      cpSync(room, gateRoom, { recursive: true });
      if (candidateDigest(gateRoom) !== digest) throw new Error('gate copy differs from candidate');
      writeFileSync(marker, JSON.stringify({ candidateSha256: digest }));
    } else if (
      (JSON.parse(readFileSync(marker, 'utf8')) as { candidateSha256?: string }).candidateSha256 !==
        digest ||
      (!existsSync(join(scratch, `gate-${attempt}-evidence`, 'intent.json')) &&
        candidateDigest(gateRoom) !== digest)
    ) {
      throw new Error('gate-room copy receipt differs from candidate');
    }
    return gateRoom;
  }
  return {
    command,
    proofOfFence,
    gitAt,
    proveCut,
    candidateDigest,
    clearBuilderTestArtifacts,
    verifyBuilderScope,
    gateRoomFor,
  };
}
