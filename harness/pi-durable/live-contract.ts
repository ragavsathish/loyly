import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validatePanelSelection } from './panel-selection.ts';
import { specialistWorkers } from './panel-vm-run.mjs';

interface AgentConfig {
  command: string;
  command_sha256: string;
  image: string;
  image_sha256: string;
  model: string;
  instruction_sha256: string;
  instruction_file?: string;
  settings?: string;
  settings_sha256?: string;
}
interface GraderConfig extends AgentConfig {
  settings: string;
  settings_sha256: string;
  schema_sha256: string;
  shards: number;
}
interface SourceConfig {
  repo: string;
  commit: string;
  checklist_sha256: string;
  specs?: { file: string; sha256: string }[];
  spec_file?: string;
  spec_sha256?: string;
}
export interface LiveRunConfig {
  schema: 'loyly.pi-live-run.v1' | 'harness.pi-live-run.v2';
  project?: string;
  runtime?: { java21?: boolean };
  run_id: string;
  score_cycle?: string;
  controller_commit: string;
  source: SourceConfig;
  scratch: string;
  builder: AgentConfig;
  grader: GraderConfig;
  blind?: AgentConfig;
  panel?: { image: string; image_sha256: string; plan_sha256: string; plan_file?: string };
}
export interface ValidatedRun {
  source: string;
  scratch: string;
  config: LiveRunConfig;
}
interface Checklist {
  items: { id: string; source?: string }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path: string) => sha(readFileSync(path));
function git(path: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw Error(`git ${args.join(' ')} failed at ${path}`);
  return result.stdout.trim();
}
function requireHash(path: string, expected: string) {
  const actual = fileSha(path);
  if (actual !== expected) throw Error(`digest changed: ${path} (${actual})`);
}
function verifyImage(image: string, expectedManifestSha256: string) {
  const manifestFile = join(image, 'manifest.json');
  requireHash(manifestFile, expectedManifestSha256);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    assets?: Record<string, string>;
    checksums?: Record<string, string>;
  };
  for (const [kind, name] of Object.entries(manifest.assets ?? {})) {
    const expected = manifest.checksums?.[kind];
    if (!/^[0-9a-f]{64}$/.test(expected ?? '')) throw Error(`image asset ${kind} has no checksum`);
    requireHash(join(image, name), expected!);
  }
}
function pathInSource(repo: string, relative: string) {
  if (isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
    throw Error('spec_file must stay inside the pinned source cut');
  return join(repo, relative);
}
export function verifySelectedSpecs(repo: string, source: SourceConfig, checklist?: Checklist) {
  const selected = source.specs ?? [{ file: source.spec_file!, sha256: source.spec_sha256! }];
  const paths = selected.map(({ file }) => file);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((file) => !/^docs\/plan\/\d\d-[a-z][a-z0-9-]*\/spec\.feature$/.test(file))
  )
    throw Error('approved specs must uniquely name numbered product plans');
  for (const spec of selected) requireHash(pathInSource(repo, spec.file), spec.sha256);
  if (checklist) {
    const actual = [
      ...new Set(
        checklist.items.map((item) => {
          const match = /^(docs\/plan\/\d\d-[a-z][a-z0-9-]*\/spec\.feature):\d+$/.exec(
            item.source ?? '',
          );
          if (!match) throw Error(`checklist item has no numbered product spec source: ${item.id}`);
          return match[1];
        }),
      ),
    ].sort();
    if (JSON.stringify([...paths].sort()) !== JSON.stringify(actual))
      throw Error('approved spec files do not exactly cover the derived checklist');
  }
  return selected;
}
export function checkLiveRun(
  input: unknown,
  { makeChecklist = true }: { makeChecklist?: boolean } = {},
): ValidatedRun {
  const validate = new Ajv2020({ strict: false }).compile(
    JSON.parse(readFileSync(join(HERE, 'live-run.schema.json'), 'utf8')),
  );
  if (!validate(input)) throw Error(`live run schema: ${JSON.stringify(validate.errors)}`);
  const config = input as LiveRunConfig;
  const javaHome = process.env.JAVA_HOME;
  if (config.schema === 'loyly.pi-live-run.v1' || config.runtime?.java21) {
    if (!javaHome) throw Error('JAVA_HOME must point to Java 21');
    const java = spawnSync(join(javaHome, 'bin', 'java'), ['-version'], { encoding: 'utf8' });
    if (java.status !== 0 || !/version "21(?:[.]|")/.test(`${java.stdout}${java.stderr}`))
      throw Error('live run requires Java 21');
  }
  const source = resolve(config.source.repo),
    scratch = resolve(config.scratch);
  if (source === ROOT || scratch === source || scratch.startsWith(`${source}/`))
    throw Error('source, controller and output must be separate');
  if (
    !existsSync(join(HERE, 'node_modules')) ||
    !existsSync(join(ROOT, '.pi/harness/builder-host/node_modules'))
  )
    throw Error('install Pi cycle and builder-host dependencies before the live run');
  if (
    git(ROOT, 'rev-parse', 'HEAD') !== config.controller_commit ||
    git(source, 'rev-parse', 'HEAD') !== config.source.commit ||
    git(ROOT, 'status', '--porcelain') ||
    git(source, 'status', '--porcelain')
  )
    throw Error('controller or source is dirty or differs from the approved commit');
  verifySelectedSpecs(source, config.source);
  if (
    config.schema === 'loyly.pi-live-run.v1' &&
    (config.builder.instruction_file || config.blind?.instruction_file)
  )
    throw Error('only the grader selects a separate instruction file in v1');
  const agents: [AgentConfig, string][] = [
    [config.builder, config.builder.instruction_file ?? 'builder-instruction.md'],
    [config.grader, config.grader.instruction_file ?? 'grader-instruction-01.md'],
    ...(config.blind
      ? [
          [config.blind, config.blind.instruction_file ?? 'blind-agent-instruction.md'] as [
            AgentConfig,
            string,
          ],
        ]
      : []),
  ];
  const checkedImages = new Set();
  for (const [agent, instruction] of agents) {
    requireHash(agent.command, agent.command_sha256);
    const imageKey = `${resolve(agent.image)}:${agent.image_sha256}`;
    if (!checkedImages.has(imageKey)) {
      verifyImage(agent.image, agent.image_sha256);
      checkedImages.add(imageKey);
    }
    requireHash(join(HERE, instruction), agent.instruction_sha256);
    if (agent.settings) requireHash(agent.settings, agent.settings_sha256!);
  }
  if (config.builder.model === config.grader.model)
    throw Error('builder and black-box grader must use different models');
  requireHash(
    join(HERE, '../evidence-core/allure-lifecycle-result.schema.json'),
    config.grader.schema_sha256,
  );
  if (config.panel) {
    requireHash(
      join(HERE, config.panel.plan_file ?? 'booking-core.panel.json'),
      config.panel.plan_sha256,
    );
    verifyImage(config.panel.image, config.panel.image_sha256);
  }
  if (!makeChecklist) return { source, scratch, config };
  mkdirSync(scratch, { recursive: true });
  const checklist = join(scratch, 'approved-checklist.json');
  if (!existsSync(checklist)) {
    const result = spawnSync('bb', ['harness/gen_checklist.clj', '--out', checklist], {
      cwd: source,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw Error(`checklist derivation failed: ${result.stderr}`);
  }
  requireHash(checklist, config.source.checklist_sha256);
  const selectedChecklist = JSON.parse(readFileSync(checklist, 'utf8')) as Checklist;
  if (
    config.schema === 'harness.pi-live-run.v2' &&
    config.project === 'loyly' &&
    selectedChecklist.items.some((item) => item.id === '01-011')
  )
    throw Error('selected Löyly refusal item requires the v1 blind-review contract');
  verifySelectedSpecs(source, config.source, selectedChecklist);
  if (config.panel) {
    const panelPlan = JSON.parse(
      readFileSync(join(HERE, config.panel.plan_file ?? 'booking-core.panel.json'), 'utf8'),
    ) as { schema: string; project?: string };
    if (
      config.schema === 'harness.pi-live-run.v2' &&
      (panelPlan.schema !== 'harness.grading-panel-plan.v2' || panelPlan.project !== config.project)
    )
      throw Error('panel plan project differs from the live contract');
    validatePanelSelection(panelPlan, selectedChecklist);
    specialistWorkers(panelPlan); // Verify the approved project's worker bundle before building.
  }
  return { source, scratch, config };
}
