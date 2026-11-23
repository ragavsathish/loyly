// A rule is the smallest grading scope. Each shard gets a private candidate copy,
// checklist, VM session, and result directory; the collector alone writes the score view.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { prepareGradingRoom, verifyGradingRoom } from './grading-room.ts';
import { readAllureResults } from './allure-results.mjs';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function copySafeTree(from: string, to: string): void {
  const stat = lstatSync(from);
  if (stat.isFile()) {
    cpSync(from, to);
    return;
  }
  if (!stat.isDirectory())
    throw new Error(`grader evidence contains a symlink or special file: ${from}`);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) copySafeTree(join(from, name), join(to, name));
}

export function partitionByRule(
  items: { id?: string; rule?: string; source?: string }[],
  count: number,
): { id: string; items: { id?: string; rule?: string; source?: string }[] }[] {
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw new Error('grader shards must be 1..16');
  if (!Array.isArray(items) || !items.length) throw new Error('empty grader checklist');
  const groups = new Map<string, { id?: string; rule?: string; source?: string }[]>();
  for (const item of items) {
    const source = /^docs\/plan\/(\d\d-[a-z][a-z0-9-]*)\/spec\.feature:\d+$/.exec(
      item.source ?? '',
    );
    if (!item.id || !item.rule || !source || source[1]!.slice(0, 2) !== item.id.slice(0, 2))
      throw new Error('grading scope needs item ID, numbered plan source and rule');
    const key = `${source[1]}\0${item.rule}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const shards = Array.from(
    { length: Math.min(count, groups.size) },
    () => [] as { id?: string; rule?: string; source?: string }[],
  );
  for (const group of groups.values()) {
    const smallest = shards.reduce(
      (best, shard) => (shard.length < best.length ? shard : best),
      shards[0]!,
    );
    smallest.push(...group);
  }
  return shards.map((shardItems, i) => ({
    id: `shard-${String(i + 1).padStart(2, '0')}`,
    items: shardItems,
  }));
}

export function prepareShards({
  gradingRoom,
  sourceRoom,
  scratch,
  schemaFile,
  candidateSha256,
  schemaSha256,
  count,
  project = 'loyly',
  blindReview = project === 'loyly',
}: {
  gradingRoom: string;
  sourceRoom: string;
  scratch: string;
  schemaFile: string;
  candidateSha256: string;
  schemaSha256: string;
  count: number;
  project?: string;
  blindReview?: boolean;
}) {
  const full = JSON.parse(readFileSync(join(gradingRoom, 'checklist.json'), 'utf8')) as {
    items: { id: string; rule?: string; source?: string }[];
  };
  const partitions = partitionByRule(full.items, count);
  return partitions.map(({ id, items }) => {
    const base = join(scratch, 'grader-shards', id);
    const checklistFile = join(base, 'inputs', 'checklist.json');
    const out = join(base, `grading-${id}`);
    mkdirSync(join(base, 'inputs'), { recursive: true });
    const bytes = `${JSON.stringify({ items, counts: { total: items.length } })}\n`;
    if (existsSync(checklistFile) && readFileSync(checklistFile, 'utf8') !== bytes)
      throw new Error(`grader shard selection changed: ${id}`);
    writeFileSync(checklistFile, bytes);
    const checklistSha256 = hash(bytes);
    const args = {
      sourceRoom,
      candidateRoom: gradingRoom,
      checklistFile,
      schemaFile,
      out,
      candidateSha256,
      checklistSha256,
      schemaSha256,
      project,
      blindReview,
    };
    if (existsSync(out)) verifyGradingRoom(args);
    else prepareGradingRoom(args);
    return {
      id,
      items: items.map((item) => item.id!),
      out,
      checklistSha256,
      args,
    };
  });
}

export function combineShards({
  gradingRoom,
  shards,
  candidateSha256,
  schemaSha256,
}: {
  gradingRoom: string;
  shards: {
    id: string;
    items: string[];
    out: string;
    checklistSha256: string;
  }[];
  candidateSha256: string;
  schemaSha256: string;
}) {
  const full = JSON.parse(readFileSync(join(gradingRoom, 'checklist.json'), 'utf8')) as {
    items: { id: string }[];
  };
  const selected = full.items.map((item) => item.id);
  const seen = shards.flatMap((shard) => shard.items);
  if (
    seen.length !== selected.length ||
    new Set(seen).size !== selected.length ||
    selected.some((id) => !seen.includes(id))
  )
    throw new Error('grader shards do not cover the approved checklist exactly once');
  const work = join(gradingRoom, 'work');
  const combined = join(work, 'allure-results');
  rmSync(combined, { recursive: true, force: true });
  rmSync(join(work, 'shards'), { recursive: true, force: true });
  mkdirSync(combined, { recursive: true });
  mkdirSync(join(work, 'shards'), { recursive: true });
  const surprises: {
    item: string;
    observation: string;
    evidence_file: string;
  }[] = [];
  for (const shard of shards) {
    const roomMeta = JSON.parse(readFileSync(join(gradingRoom, '.grading-room.json'), 'utf8')) as {
      project?: string;
      blindReview?: boolean;
    };
    verifyGradingRoom({
      out: shard.out,
      candidateSha256,
      checklistSha256: shard.checklistSha256,
      schemaSha256,
      project: roomMeta.project ?? 'loyly',
      blindReview: roomMeta.blindReview ?? true,
    });
    const judged = readAllureResults(shard.out) as {
      verdicts: unknown[];
      surprises: {
        item: string;
        observation: string;
        evidence_file: string;
      }[];
    };
    if (judged.verdicts.length !== shard.items.length) throw new Error(`incomplete ${shard.id}`);
    const source = join(shard.out, 'work', 'allure-results');
    for (const name of readdirSync(source)) {
      if (existsSync(join(combined, name))) throw new Error(`Allure filename collision: ${name}`);
      cpSync(join(source, name), join(combined, name));
    }
    const evidence = join(work, 'shards', shard.id);
    mkdirSync(evidence, { recursive: true });
    for (const name of readdirSync(join(shard.out, 'work'))) {
      const sourcePath = join(shard.out, 'work', name);
      if (
        name !== 'allure-results' &&
        name !== 'surprises.json' &&
        !(name.startsWith('runtime-') && lstatSync(sourcePath).isDirectory())
      )
        copySafeTree(sourcePath, join(evidence, name));
    }
    for (const surprise of judged.surprises)
      surprises.push({
        ...surprise,
        evidence_file: `work/shards/${shard.id}/${surprise.evidence_file.slice(5)}`,
      });
  }
  writeFileSync(join(work, 'surprises.json'), JSON.stringify(surprises));
  return readAllureResults(gradingRoom);
}
