// Independent grader room: gated candidate + selected plan only.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { GRADING_ROOM, PROJECT_ID, defaultsBlindReview } from './project/loyly/index.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

interface GradingRoomDigests {
  sourceRoom: string;
  candidateRoom: string;
  checklistFile: string;
  schemaFile: string;
  out: string;
  candidateSha256: string;
  checklistSha256: string;
  schemaSha256: string;
  project?: string;
  blindReview?: boolean;
}

interface GradingRoomVerifyInput {
  out: string;
  candidateSha256: string;
  checklistSha256: string;
  schemaSha256: string;
  project?: string;
  blindReview?: boolean;
}

interface GradingRoomReceipt {
  schema: typeof GRADING_ROOM;
  candidateSha256: string;
  checklistSha256: string;
  schemaSha256: string;
  planSha256: string;
  sourcePlan: string | null;
  sourcePlans: string[];
  project?: string;
  blindReview?: boolean;
}

function treeDigest(root: string, prefix: string): string {
  const digest = createHash('sha256');
  const walk = (dir: string, currentPrefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = `${currentPrefix}/${name}`;
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, path);
      else if (stat.isFile()) {
        digest.update(path);
        digest.update('\0');
        digest.update(String(stat.mode & 0o777));
        digest.update('\0');
        digest.update(readFileSync(file));
        digest.update('\0');
      } else throw new Error(`candidate has a symlink or special file: ${path}`);
    }
  };
  walk(root, prefix);
  return digest.digest('hex');
}

function candidateDigest(room: string): string {
  return treeDigest(join(room, 'impl'), 'impl');
}

function planDigest(room: string): string {
  return treeDigest(join(room, 'plan'), 'plan');
}

function selectedPlans(checklistFile: string): string[] {
  const checklist = JSON.parse(readFileSync(checklistFile, 'utf8')) as {
    items?: { id?: string; source?: string }[];
  };
  if (!Array.isArray(checklist.items) || !checklist.items.length)
    throw new Error('grading checklist has no selected items');
  const plans = new Set<string>();
  for (const item of checklist.items) {
    const match = /^docs\/plan\/(\d\d-[a-z][a-z0-9-]*)\/spec\.feature:\d+$/.exec(item.source ?? '');
    if (
      !match ||
      !/^\d\d-\d\d\d$/.test(item.id ?? '') ||
      match[1]!.slice(0, 2) !== item.id!.slice(0, 2)
    )
      throw new Error(`grading item has no safe matching plan source: ${item.id ?? 'unknown'}`);
    plans.add(match[1]!);
  }
  return [...plans];
}

function prepareGradingRoom({
  sourceRoom,
  candidateRoom,
  checklistFile,
  schemaFile,
  out,
  candidateSha256,
  checklistSha256,
  schemaSha256,
  project = PROJECT_ID,
  blindReview = defaultsBlindReview(project),
}: GradingRoomDigests): GradingRoomReceipt {
  if (!/^[a-z][a-z0-9-]*$/.test(project)) throw new Error('invalid grading project');
  for (const path of [sourceRoom, candidateRoom, checklistFile, schemaFile, out])
    if (!isAbsolute(path)) throw new Error(`grading path must be absolute: ${path}`);
  if (
    [candidateSha256, checklistSha256, schemaSha256].some(
      (digest) => !/^[0-9a-f]{64}$/.test(digest ?? ''),
    )
  )
    throw new Error('grading room needs approved digests');
  if (
    basename(checklistFile) !== 'checklist.json' ||
    basename(schemaFile) !== 'allure-lifecycle-result.schema.json' ||
    hash(readFileSync(checklistFile)) !== checklistSha256 ||
    hash(readFileSync(schemaFile)) !== schemaSha256 ||
    candidateDigest(candidateRoom) !== candidateSha256
  )
    throw new Error('grading inputs differ from the gated candidate, checklist or schema');
  if (existsSync(out))
    throw new Error('grading room already exists; reconcile its receipt or inspect it');
  const plans = selectedPlans(checklistFile);
  mkdirSync(join(out, 'plan'), { recursive: true });
  for (const plan of plans) {
    const from = join(sourceRoom, 'docs', 'plan', plan);
    if (!existsSync(join(from, 'spec.feature'))) throw new Error(`selected plan missing: ${plan}`);
    cpSync(from, join(out, 'plan', plan), { recursive: true });
  }
  cpSync(join(candidateRoom, 'impl'), join(out, 'impl'), { recursive: true });
  cpSync(checklistFile, join(out, 'checklist.json'));
  cpSync(schemaFile, join(out, 'allure-lifecycle-result.schema.json'));
  mkdirSync(join(out, 'work'));
  if (
    candidateDigest(out) !== candidateSha256 ||
    hash(readFileSync(join(out, 'checklist.json'))) !== checklistSha256 ||
    hash(readFileSync(join(out, 'allure-lifecycle-result.schema.json'))) !== schemaSha256
  )
    throw new Error('grading copy differs from the gated candidate, checklist or schema');
  const receipt: GradingRoomReceipt = {
    schema: GRADING_ROOM,
    candidateSha256,
    checklistSha256,
    schemaSha256,
    planSha256: planDigest(out),
    sourcePlan: plans.length === 1 ? `plan/${plans[0]}` : null,
    sourcePlans: plans.map((plan) => `plan/${plan}`),
    ...(project === PROJECT_ID && blindReview ? {} : { project, blindReview }),
  };
  writeFileSync(join(out, '.grading-room.json'), JSON.stringify(receipt));
  return receipt;
}

function verifyGradingRoom({
  out,
  candidateSha256,
  checklistSha256,
  schemaSha256,
  project = PROJECT_ID,
  blindReview = defaultsBlindReview(project),
}: GradingRoomVerifyInput): GradingRoomReceipt {
  const receipt = JSON.parse(
    readFileSync(join(out, '.grading-room.json'), 'utf8'),
  ) as GradingRoomReceipt;
  const expectedPlans = selectedPlans(join(out, 'checklist.json')).map((plan) => `plan/${plan}`);
  const recordedPlans = receipt.sourcePlans ?? (receipt.sourcePlan ? [receipt.sourcePlan] : []);
  if (
    receipt.schema !== GRADING_ROOM ||
    (receipt.project ?? PROJECT_ID) !== project ||
    (receipt.blindReview ?? true) !== blindReview ||
    receipt.candidateSha256 !== candidateSha256 ||
    receipt.checklistSha256 !== checklistSha256 ||
    receipt.schemaSha256 !== schemaSha256 ||
    JSON.stringify(recordedPlans) !== JSON.stringify(expectedPlans) ||
    receipt.planSha256 !== planDigest(out) ||
    candidateDigest(out) !== candidateSha256 ||
    hash(readFileSync(join(out, 'checklist.json'))) !== checklistSha256 ||
    hash(readFileSync(join(out, 'allure-lifecycle-result.schema.json'))) !== schemaSha256
  )
    throw new Error('grading room receipt or inputs changed');
  const allowed = new Set([
    '.grading-room.json',
    'plan',
    'impl',
    'checklist.json',
    'allure-lifecycle-result.schema.json',
    'work',
  ]);
  for (const name of readdirSync(out))
    if (!allowed.has(name)) throw new Error(`unexpected grading-room entry: ${name}`);
  return receipt;
}

export type { GradingRoomDigests, GradingRoomVerifyInput, GradingRoomReceipt };
export { treeDigest, candidateDigest, prepareGradingRoom, verifyGradingRoom };
