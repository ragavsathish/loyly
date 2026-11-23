// The grader writes Allure lifecycle results. The legacy scorer receives a derived view.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  allureFullName,
  assertAllureIdentity,
  featureTitleFromSpec,
  parsePlanSource,
  stampedItemId,
  type AllureIdentityResult,
} from '../evidence-core/validate-identity.ts';
import { validateResultEvidence } from '../evidence-core/validate-result.ts';
import { compileAllureSchema } from '../evidence-core/validate-schema.ts';
import {
  BLIND_ITEM_ID,
  BLIND_SPEC_RELATIVE,
  PROJECT_ID,
  isBlindPendingResult,
  pendingEvidencePrefix,
  requiresBlindHandoff,
} from './project/loyly/index.ts';

const RESULT =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-result\.json$/;

interface ChecklistItem {
  id: string;
  name: string;
  rule: string;
  source?: string;
}

interface AllureAttachment {
  name: string;
  type: string;
  source: string;
}

interface AllureStep {
  name: string;
  status: string;
  stage: string;
}

interface AllureLifecycleResult extends AllureIdentityResult {
  uuid: string;
  status: string;
  stage: string;
  statusDetails: { message: string };
  attachments: AllureAttachment[];
  steps: AllureStep[];
  start: number;
  stop: number;
}

interface AllureVerdict {
  id: string;
  verdict: string;
  evidence: string;
}

interface AllureSurprise {
  item: string;
  observation: string;
  evidence_file: string;
}

interface AllureJudgement {
  verdicts: AllureVerdict[];
  surprises: AllureSurprise[];
  results: AllureLifecycleResult[];
  pass: number;
  allureSha256: string;
}

function identity(
  room: string,
  item: ChecklistItem,
  project: string,
): { fullName: string; feature: string } {
  const { planDir, sliceKey } = parsePlanSource(item.source ?? '');
  if (planDir.slice(0, 2) !== item.id?.slice(0, 2))
    throw new Error(`Allure item has no matching numbered plan source: ${item.id ?? 'unknown'}`);
  const feature = featureTitleFromSpec(
    readFileSync(join(room, 'plan', planDir, 'spec.feature'), 'utf8'),
  );
  return {
    fullName: allureFullName({ project, sliceKey, itemId: item.id }),
    feature,
  };
}

function loadAllureRoom(room: string) {
  const validateSchema = compileAllureSchema(
    JSON.parse(readFileSync(join(room, 'allure-lifecycle-result.schema.json'), 'utf8')) as object,
  );
  const checklist = JSON.parse(readFileSync(join(room, 'checklist.json'), 'utf8')) as {
    items: ChecklistItem[];
  };
  const items = checklist.items;
  const receipt = JSON.parse(readFileSync(join(room, '.grading-room.json'), 'utf8')) as {
    project?: string;
    blindReview?: boolean;
  };
  const project = receipt.project ?? PROJECT_ID;
  const blindReview = receipt.blindReview ?? true;
  if (!/^[a-z][a-z0-9-]*$/.test(project)) throw new Error('invalid grading project');
  if (
    !Array.isArray(items) ||
    !items.length ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new Error('invalid grading checklist');
  return { validateSchema, items, project, blindReview };
}

function readOneAllureResult(
  room: string,
  dir: string,
  file: string,
  items: ChecklistItem[],
  identities: Map<string, { fullName: string; feature: string }>,
  byId: Map<string, AllureLifecycleResult>,
  expectedFiles: Set<string>,
  validateSchema: (raw: unknown, name: string) => void,
  project: string,
  blindReview: boolean,
  pendingPrefix: string,
) {
  const result = JSON.parse(readFileSync(join(dir, file), 'utf8')) as AllureLifecycleResult;
  validateSchema(result, file);
  if (file !== `${result.uuid}-result.json`)
    throw new Error(`Allure UUID differs from filename: ${file}`);
  const id = stampedItemId(result);
  const item = items.find((x) => x.id === id);
  if (!item || byId.has(id)) throw new Error(`unknown or duplicate Allure item ${id}`);
  const expected = identities.get(id);
  if (!expected) throw new Error(`Allure identity missing for ${id}`);
  assertAllureIdentity(result, {
    itemId: id,
    name: item.name,
    rule: item.rule,
    feature: expected.feature,
    fullName: expected.fullName,
  });
  validateResultEvidence(result, id);
  for (const attachment of result.attachments) {
    const path = join(dir, attachment.source);
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw new Error(`Allure attachment bytes missing for ${id}: ${attachment.source}`);
    expectedFiles.add(attachment.source);
  }
  if (
    blindReview &&
    requiresBlindHandoff(project, items) &&
    id === BLIND_ITEM_ID &&
    !isBlindPendingResult(result, pendingPrefix)
  )
    throw new Error(`${BLIND_ITEM_ID} needs a separate blind subagent review`);
  byId.set(id, result);
}

function readSurprises(room: string, byId: Map<string, AllureLifecycleResult>): AllureSurprise[] {
  const rawSurprises = JSON.parse(
    readFileSync(join(room, 'work', 'surprises.json'), 'utf8'),
  ) as unknown;
  if (!Array.isArray(rawSurprises)) throw new Error('surprises must be a JSON array');
  const surprises: AllureSurprise[] = [];
  for (const surprise of rawSurprises as {
    item?: string;
    observation?: string;
    evidence_file?: string;
  }[]) {
    const ids = typeof surprise?.item === 'string' ? surprise.item.split(/,\s*/) : [];
    const rawPath = surprise?.evidence_file;
    const evidenceFile =
      typeof rawPath === 'string' && !rawPath.startsWith('work/') ? `work/${rawPath}` : rawPath;
    if (
      !ids.length ||
      ids.some((id) => !byId.has(id)) ||
      typeof surprise.observation !== 'string' ||
      typeof evidenceFile !== 'string' ||
      !/^work\/[A-Za-z0-9._/-]+$/.test(evidenceFile) ||
      evidenceFile.includes('..') ||
      /^work\/runtime-[^/]+\//.test(evidenceFile) ||
      !existsSync(join(room, evidenceFile)) ||
      !lstatSync(join(room, evidenceFile)).isFile()
    )
      throw new Error('invalid surprise evidence');
    for (const id of ids)
      surprises.push({
        item: id,
        observation: surprise.observation,
        evidence_file: evidenceFile,
      });
  }
  return surprises;
}

function digestAllureDir(dir: string, expectedFiles: Set<string>): string {
  const digest = createHash('sha256');
  for (const name of readdirSync(dir).sort()) {
    if (!expectedFiles.has(name) || !lstatSync(join(dir, name)).isFile())
      throw new Error(`unexpected Allure result entry: ${name}`);
    digest.update(name);
    digest.update('\0');
    digest.update(readFileSync(join(dir, name)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function readAllureResults(room: string): AllureJudgement {
  const { validateSchema, items, project, blindReview } = loadAllureRoom(room);
  const identities = new Map(items.map((item) => [item.id, identity(room, item, project)]));
  const specSha256 =
    blindReview && requiresBlindHandoff(project, items)
      ? createHash('sha256')
          .update(readFileSync(join(room, BLIND_SPEC_RELATIVE)))
          .digest('hex')
      : null;
  const pendingPrefix = pendingEvidencePrefix(specSha256);
  const dir = join(room, 'work', 'allure-results');
  const files = readdirSync(dir).filter((name) => RESULT.test(name));
  if (files.length !== items.length)
    throw new Error('grader did not return one Allure result per selected item');
  const expectedFiles = new Set(files);
  const byId = new Map<string, AllureLifecycleResult>();
  for (const file of files) {
    readOneAllureResult(
      room,
      dir,
      file,
      items,
      identities,
      byId,
      expectedFiles,
      validateSchema,
      project,
      blindReview,
      pendingPrefix,
    );
  }
  const verdicts = items.map((item) => {
    const result = byId.get(item.id);
    if (!result) throw new Error(`Allure result missing for ${item.id}`);
    return {
      id: item.id,
      verdict: result.status === 'passed' ? 'pass' : 'fail',
      evidence: result.statusDetails.message,
    };
  });
  const surprises = readSurprises(room, byId);
  return {
    verdicts,
    surprises,
    results: [...byId.values()],
    pass: verdicts.filter((v) => v.verdict === 'pass').length,
    allureSha256: digestAllureDir(dir, expectedFiles),
  };
}

export type {
  ChecklistItem,
  AllureLifecycleResult,
  AllureVerdict,
  AllureSurprise,
  AllureJudgement,
};
export { readAllureResults };
