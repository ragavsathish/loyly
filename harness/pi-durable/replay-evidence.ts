// Read-only Allure projection for the Pi audit page. These are evidence records,
// not Pi events; only committed grade, review and panel entries can reveal them.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllureResults, type AllureLifecycleResult } from './allure-results.ts';
import { readBlindAgentAllure } from './blind-review.ts';
import { verifyGradingRoom } from './grading-room.ts';
import { verifyPanelVmRun } from './panel-vm-run.ts';
import { BLIND_ITEM_ID } from './project/loyly/index.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const here = fileURLToPath(new URL('.', import.meta.url));

interface AuditRow {
  stage?: string;
  outcome?: string;
  seq?: number;
  allure_results_sha256?: string;
  raw_allure_sha256?: string;
  review_sha256?: string;
  candidate_sha256?: string;
  checklist_sha256?: string;
  manifest_sha256?: string;
}

interface PanelManifest {
  plan_sha256?: string;
}

interface ReplayEvidence {
  schema: 'loyly.replay-evidence.v1';
  source: string;
  kind: string;
  after_seq: number | undefined;
  item: string;
  name: string;
  status: string;
  stage: string;
  observation: string;
  steps: { name: string; status: string; stage: string }[];
  attachments: { name: string; type: string; sha256: string }[];
  source_digest: string;
}

function panelPlanForManifest(manifest: PanelManifest): string {
  if (!/^[0-9a-f]{64}$/.test(manifest.plan_sha256 ?? ''))
    throw new Error('panel manifest has no plan digest');
  const matches = readdirSync(here).filter(
    (name) =>
      name.endsWith('.panel.json') && hash(readFileSync(join(here, name))) === manifest.plan_sha256,
  );
  if (matches.length !== 1)
    throw new Error('panel replay needs exactly one local plan matching the committed digest');
  return join(here, matches[0]!);
}

function summary(
  result:
    | AllureLifecycleResult
    | {
        name: string;
        status: string;
        stage: string;
        statusDetails: { message: string };
        steps: { name: string; status: string; stage: string }[];
        attachments: { name: string; type: string; source: string }[];
      },
  item: string,
  afterSeq: number | undefined,
  kind: string,
  sourceDigest: string,
  dir: string,
): ReplayEvidence {
  return {
    schema: 'loyly.replay-evidence.v1',
    source: 'Allure evidence projection',
    kind,
    after_seq: afterSeq,
    item,
    name: result.name ?? '',
    status: result.status,
    stage: result.stage,
    observation: result.statusDetails.message,
    steps: result.steps.map((step) => ({
      name: step.name,
      status: step.status,
      stage: step.stage,
    })),
    attachments: result.attachments.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      sha256: hash(readFileSync(join(dir, attachment.source))),
    })),
    source_digest: sourceDigest,
  };
}

function projectReplayEvidence(dir: string, rows: AuditRow[]): ReplayEvidence[] {
  const grade = rows.findLast(
    (row) =>
      row.stage === 'grade' &&
      row.outcome === 'completed' &&
      typeof row.allure_results_sha256 === 'string',
  );
  const blind = rows.findLast((row) => row.stage === 'blind-review' && row.outcome === 'completed');
  if (!grade && !blind) return [];
  if (blind && !grade) throw new Error('completed blind review has no committed Allure grade');
  const gradingRoom = join(dir, 'grading-room');
  const prepared = rows.findLast(
    (row) =>
      row.stage === 'grading-room' &&
      row.outcome === 'prepared' &&
      typeof row.candidate_sha256 === 'string',
  );
  if (!prepared || !existsSync(gradingRoom))
    throw new Error('committed grade has no bound grading room');
  const roomReceipt = JSON.parse(readFileSync(join(gradingRoom, '.grading-room.json'), 'utf8')) as {
    schemaSha256: string;
    project?: string;
    blindReview?: boolean;
  };
  verifyGradingRoom({
    out: gradingRoom,
    candidateSha256: prepared.candidate_sha256!,
    checklistSha256: prepared.checklist_sha256!,
    schemaSha256: roomReceipt.schemaSha256,
    project: roomReceipt.project ?? 'loyly',
    blindReview: roomReceipt.blindReview ?? true,
  });
  const judged = readAllureResults(gradingRoom);
  if (judged.allureSha256 !== grade!.allure_results_sha256)
    throw new Error('Allure evidence differs from the committed grade digest');
  const checklist = JSON.parse(readFileSync(join(gradingRoom, 'checklist.json'), 'utf8')) as {
    items: { id: string }[];
  };
  const raw = checklist.items.map((item) => {
    const result = judged.results.find((value) =>
      value.labels.some((label) => label.name === 'tag' && label.value === `@item-${item.id}`),
    );
    if (!result) throw new Error(`Allure result missing for ${item.id}`);
    return summary(
      result,
      item.id,
      grade!.seq,
      'grader-item',
      judged.allureSha256,
      join(gradingRoom, 'work', 'allure-results'),
    );
  });
  const projected = [...raw];
  if (blind) {
    if (blind.raw_allure_sha256 !== judged.allureSha256)
      throw new Error('blind review audit differs from committed grade evidence');
    const reviewFile = join(dir, 'blind-agent-review.json');
    const review = JSON.parse(readFileSync(reviewFile, 'utf8')) as { verdict?: string };
    const supplemental = readBlindAgentAllure({
      packetDir: join(dir, 'blind-agent-packet'),
      reviewFile,
      gradingRoom,
      verificationDir:
        review.verdict === 'pass' ? join(dir, 'blind-agent-verification') : undefined,
      out: join(dir, 'blind-agent-allure'),
    }) as {
      result: AllureLifecycleResult;
      reviewSha256: string;
    };
    if (supplemental.reviewSha256 !== blind.review_sha256)
      throw new Error('blind Allure evidence differs from the committed review digest');
    projected.push(
      summary(
        supplemental.result,
        BLIND_ITEM_ID,
        blind.seq,
        'blind-review',
        supplemental.reviewSha256,
        join(dir, 'blind-agent-allure'),
      ),
    );
  } else if (roomReceipt.blindReview ?? true) {
    return projected;
  }
  const panel = rows.findLast((row) => row.stage === 'panel' && row.outcome === 'completed');
  if (!panel) return projected;
  const selected = JSON.parse(readFileSync(join(dir, 'panel-vm', 'selected.json'), 'utf8')) as {
    attempt: number;
    manifest_sha256: string;
  };
  const out = join(dir, 'panel-vm', `attempt-${String(selected.attempt).padStart(2, '0')}`);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as PanelManifest;
  const verified = verifyPanelVmRun({
    original: dir,
    out,
    planFile: panelPlanForManifest(manifest),
  }) as {
    manifest: {
      producers: { id: string; item: string; result: string }[];
    };
  };
  const panelManifestSha256 = panel.manifest_sha256;
  if (
    !panelManifestSha256 ||
    selected.manifest_sha256 !== panelManifestSha256 ||
    hash(readFileSync(join(out, 'manifest.json'))) !== panelManifestSha256
  )
    throw new Error('panel Allure evidence differs from committed Pi audit');
  for (const worker of verified.manifest.producers) {
    const evidenceDir = join(out, worker.id);
    const result = JSON.parse(
      readFileSync(join(evidenceDir, worker.result), 'utf8'),
    ) as AllureLifecycleResult;
    projected.push(
      summary(
        result,
        worker.item.slice(6),
        panel.seq,
        'panel-specialist',
        panelManifestSha256,
        evidenceDir,
      ),
    );
  }
  return projected;
}

export type { AuditRow, PanelManifest, ReplayEvidence };
export { panelPlanForManifest, projectReplayEvidence };
