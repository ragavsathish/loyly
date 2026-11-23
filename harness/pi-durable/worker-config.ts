import { join, resolve } from 'node:path';
import { DEFAULT_PANEL_PLAN, PROJECT_ID } from './project/loyly/index.ts';

const HASH64 = /^[0-9a-f]{64}$/;
const HASH40 = /^[0-9a-f]{40}$/;

function requireDigests(values: (string | undefined)[], message: string) {
  if (values.some((digest) => !HASH64.test(digest ?? ''))) throw new Error(message);
}

function parseBuilderAgent(ROOT: string, environment: NodeJS.ProcessEnv, live: boolean) {
  if (!live) return null;
  const builder = {
    command: resolve(
      environment.LOYLY_BUILDER_COMMAND ?? join(ROOT, '.pi/harness/bin/builder.sh'),
    ),
    image: resolve(environment.LOYLY_BUILDER_IMAGE ?? ''),
    model: environment.LOYLY_BUILDER_MODEL,
    commandSha256: environment.LOYLY_BUILDER_COMMAND_SHA256,
    imageSha256: environment.LOYLY_BUILDER_IMAGE_SHA256,
    instructionSha256: environment.LOYLY_BUILDER_INSTRUCTION_SHA256,
    instructionFile: environment.LOYLY_BUILDER_INSTRUCTION_FILE ?? 'builder-instruction.md',
  };
  if (
    !environment.LOYLY_APPROVED_COMMIT ||
    !environment.LOYLY_BUILDER_IMAGE ||
    !builder.model ||
    [builder.commandSha256, builder.imageSha256, builder.instructionSha256].some(
      (digest) => !HASH64.test(digest ?? ''),
    )
  )
    throw new Error(
      'live build needs approved cut/checklist, model, command, image, and three SHA-256 values',
    );
  return builder;
}

function parseGraderAgent(
  ROOT: string,
  environment: NodeJS.ProcessEnv,
  live: boolean,
  builder: ReturnType<typeof parseBuilderAgent>,
) {
  if (!live || !environment.LOYLY_GRADER_MODEL) return null;
  const grader = {
    command: resolve(environment.LOYLY_GRADER_COMMAND ?? builder!.command),
    image: resolve(environment.LOYLY_GRADER_IMAGE ?? builder!.image),
    settings: resolve(
      environment.LOYLY_GRADER_SETTINGS ??
        join(ROOT, '.pi/harness/config/pi.grader.settings.json'),
    ),
    model: environment.LOYLY_GRADER_MODEL,
    commandSha256: environment.LOYLY_GRADER_COMMAND_SHA256,
    imageSha256: environment.LOYLY_GRADER_IMAGE_SHA256,
    settingsSha256: environment.LOYLY_GRADER_SETTINGS_SHA256,
    instructionSha256: environment.LOYLY_GRADER_INSTRUCTION_SHA256,
    instructionFile: environment.LOYLY_GRADER_INSTRUCTION_FILE ?? 'grader-instruction-01.md',
    schemaSha256: environment.LOYLY_GRADER_SCHEMA_SHA256,
  };
  if (
    grader.model === builder!.model ||
    !/^[A-Za-z0-9._-]+\.md$/.test(grader.instructionFile) ||
    [
      grader.commandSha256,
      grader.imageSha256,
      grader.settingsSha256,
      grader.instructionSha256,
      grader.schemaSha256,
    ].some((digest) => !HASH64.test(digest ?? ''))
  )
    throw new Error(
      'independent grader needs another model and approved command, image, settings, schema and instruction digests',
    );
  return grader;
}

function parseBlindAgent(
  ROOT: string,
  environment: NodeJS.ProcessEnv,
  live: boolean,
  builder: ReturnType<typeof parseBuilderAgent>,
) {
  if (!live || !environment.LOYLY_BLIND_AGENT_MODEL) return null;
  const blindAgent = {
    command: resolve(environment.LOYLY_BLIND_AGENT_COMMAND ?? builder!.command),
    image: resolve(environment.LOYLY_BLIND_AGENT_IMAGE ?? builder!.image),
    settings: resolve(
      environment.LOYLY_BLIND_AGENT_SETTINGS ??
        join(ROOT, '.pi/harness/config/pi.blind-review.settings.json'),
    ),
    model: environment.LOYLY_BLIND_AGENT_MODEL,
    commandSha256: environment.LOYLY_BLIND_AGENT_COMMAND_SHA256,
    imageSha256: environment.LOYLY_BLIND_AGENT_IMAGE_SHA256,
    settingsSha256: environment.LOYLY_BLIND_AGENT_SETTINGS_SHA256,
    instructionSha256: environment.LOYLY_BLIND_AGENT_INSTRUCTION_SHA256,
    instructionFile:
      environment.LOYLY_BLIND_AGENT_INSTRUCTION_FILE ?? 'blind-agent-instruction.md',
  };
  requireDigests(
    [
      blindAgent.commandSha256,
      blindAgent.imageSha256,
      blindAgent.settingsSha256,
      blindAgent.instructionSha256,
    ],
    'blind agent needs approved command, image, settings and instruction digests',
  );
  return blindAgent;
}

function parsePanelConfig(environment: NodeJS.ProcessEnv, live: boolean) {
  const panel =
    live && environment.LOYLY_PANEL_IMAGE
      ? {
          image: resolve(environment.LOYLY_PANEL_IMAGE),
          planFile: environment.LOYLY_PANEL_PLAN_FILE ?? DEFAULT_PANEL_PLAN,
          planSha256: environment.LOYLY_PANEL_PLAN_SHA256,
          imageSha256: environment.LOYLY_PANEL_IMAGE_SHA256,
        }
      : null;
  if (live && environment.LOYLY_PANEL_REQUIRED === '1' && !panel)
    throw new Error('production live cycle requires the approved grading panel');
  if (panel) {
    requireDigests(
      [panel.planSha256, panel.imageSha256],
      'grading panel needs approved plan and image manifest digests',
    );
    if (!/^[a-z][a-z0-9-]*\.panel\.json$/.test(panel.planFile))
      throw new Error('grading panel plan file must be a local named plan');
  }
  return panel;
}

export function parseWorkerConfig(
  ROOT: string,
  scratch: string,
  modeArg: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const approvedCommit = environment.LOYLY_APPROVED_COMMIT;
  if (approvedCommit && !HASH40.test(approvedCommit))
    throw new Error('LOYLY_APPROVED_COMMIT must be a full 40-character commit ID');
  const approvedChecklistSha256 = environment.LOYLY_APPROVED_CHECKLIST_SHA256 ?? null;
  if (approvedCommit && !HASH64.test(approvedChecklistSha256 ?? ''))
    throw new Error('a pinned cut needs LOYLY_APPROVED_CHECKLIST_SHA256');
  const cut = join(scratch, 'cut');
  const sourceRoot = approvedCommit ? join(cut, 'project') : ROOT;
  const approvedSourceRepo = environment.LOYLY_SOURCE_REPO
    ? resolve(environment.LOYLY_SOURCE_REPO)
    : ROOT;
  const mode = modeArg ?? 'repair'; // repair: red first gate, green second; three-red: all red
  const live = mode === 'live';
  const builder = parseBuilderAgent(ROOT, environment, live);
  const grader = parseGraderAgent(ROOT, environment, live, builder);
  const graderShardCount = Number(environment.LOYLY_GRADER_SHARDS ?? 3);
  if (
    live &&
    (!Number.isInteger(graderShardCount) || graderShardCount < 1 || graderShardCount > 16)
  )
    throw new Error('LOYLY_GRADER_SHARDS must be an integer from 1 to 16');
  const blindAgent = parseBlindAgent(ROOT, environment, live, builder);
  const blindRequired = live && environment.LOYLY_BLIND_REQUIRED !== '0';
  const project = environment.HARNESS_PROJECT_ID ?? PROJECT_ID;
  if (!/^[a-z][a-z0-9-]*$/.test(project)) throw new Error('invalid harness project');
  const panel = parsePanelConfig(environment, live);
  return {
    approvedCommit,
    approvedChecklistSha256,
    cut,
    sourceRoot,
    approvedSourceRepo,
    mode,
    live,
    builder,
    grader,
    graderShardCount,
    blindAgent,
    blindRequired,
    project,
    panel,
  };
}
