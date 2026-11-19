// Supported entrypoint for a pinned booking-core live cycle. The JSON file is
// the exact operator-selected contract; no digest is computed into approval.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path) => sha(readFileSync(path));
function git(path, ...args) {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw Error(`git ${args.join(' ')} failed at ${path}`);
  return result.stdout.trim();
}
function requireHash(path, expected) {
  const actual = fileSha(path);
  if (actual !== expected) throw Error(`digest changed: ${path} (${actual})`);
}
function verifyImage(image, expectedManifestSha256) {
  const manifestFile = join(image, 'manifest.json');
  requireHash(manifestFile, expectedManifestSha256);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  for (const [kind, name] of Object.entries(manifest.assets ?? {})) {
    const expected = manifest.checksums?.[kind];
    if (!/^[0-9a-f]{64}$/.test(expected ?? ''))
      throw Error(`image asset ${kind} has no checksum`);
    requireHash(join(image, name), expected);
  }
}
function pathInSource(repo, relative) {
  if (isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
    throw Error('spec_file must stay inside the pinned source cut');
  return join(repo, relative);
}
export function checkLiveRun(config, { makeChecklist = true } = {}) {
  const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(join(HERE, 'live-run.schema.json'))));
  if (!validate(config)) throw Error(`live run schema: ${JSON.stringify(validate.errors)}`);
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) throw Error('JAVA_HOME must point to Java 21');
  const java = spawnSync(join(javaHome, 'bin', 'java'), ['-version'], { encoding: 'utf8' });
  if (java.status !== 0 || !/version "21(?:\.|\")/.test(`${java.stdout}${java.stderr}`))
    throw Error('live run requires Java 21');
  const source = resolve(config.source.repo), scratch = resolve(config.scratch);
  if (source === ROOT || scratch === source || scratch.startsWith(`${source}/`))
    throw Error('source, controller and output must be separate');
  if (!existsSync(join(HERE, 'node_modules'))
      || !existsSync(join(ROOT, '.pi/harness/builder-host/node_modules')))
    throw Error('install Pi cycle and builder-host dependencies before the live run');
  if (git(ROOT, 'rev-parse', 'HEAD') !== config.controller_commit
      || git(source, 'rev-parse', 'HEAD') !== config.source.commit
      || git(ROOT, 'status', '--porcelain') || git(source, 'status', '--porcelain'))
    throw Error('controller or source is dirty or differs from the approved commit');
  requireHash(pathInSource(source, config.source.spec_file), config.source.spec_sha256);
  const agents = [
    [config.builder, 'builder-instruction.md'],
    [config.grader, 'grader-instruction-01.md'],
    [config.blind, 'blind-agent-instruction.md'],
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
    if (agent.settings) requireHash(agent.settings, agent.settings_sha256);
  }
  if (config.builder.model === config.grader.model)
    throw Error('builder and black-box grader must use different models');
  requireHash(join(HERE, 'allure-lifecycle-result.schema.json'), config.grader.schema_sha256);
  requireHash(join(HERE, 'booking-core.panel.json'), config.panel.plan_sha256);
  verifyImage(config.panel.image, config.panel.image_sha256);
  if (!makeChecklist) return { source, scratch };
  mkdirSync(scratch, { recursive: true });
  const checklist = join(scratch, 'approved-checklist.json');
  if (!existsSync(checklist)) {
    const result = spawnSync('bb', ['harness/gen_checklist.clj', '--out', checklist],
      { cwd: source, encoding: 'utf8' });
    if (result.status !== 0) throw Error(`checklist derivation failed: ${result.stderr}`);
  }
  requireHash(checklist, config.source.checklist_sha256);
  return { source, scratch };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || !['--check', '--run'].includes(process.argv[2]))
    throw Error('usage: node run-live.mjs --check|--run <pinned-config.json>');
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const { scratch } = checkLiveRun(config);
  console.log('pinned cycle contract verified');
  if (process.argv[2] === '--run') {
    const env = { ...process.env, PATH: `${process.env.JAVA_HOME}/bin:${process.env.PATH}`,
      LOYLY_RUN_ID: config.run_id,
      LOYLY_APPROVED_COMMIT: config.source.commit,
      LOYLY_APPROVED_CHECKLIST_SHA256: config.source.checklist_sha256,
      LOYLY_BUILDER_COMMAND: config.builder.command,
      LOYLY_BUILDER_COMMAND_SHA256: config.builder.command_sha256,
      LOYLY_BUILDER_IMAGE: config.builder.image,
      LOYLY_BUILDER_IMAGE_SHA256: config.builder.image_sha256,
      LOYLY_BUILDER_MODEL: config.builder.model,
      LOYLY_BUILDER_INSTRUCTION_SHA256: config.builder.instruction_sha256,
      LOYLY_GRADER_COMMAND: config.grader.command,
      LOYLY_GRADER_COMMAND_SHA256: config.grader.command_sha256,
      LOYLY_GRADER_IMAGE: config.grader.image,
      LOYLY_GRADER_IMAGE_SHA256: config.grader.image_sha256,
      LOYLY_GRADER_MODEL: config.grader.model,
      LOYLY_GRADER_SETTINGS: config.grader.settings,
      LOYLY_GRADER_SETTINGS_SHA256: config.grader.settings_sha256,
      LOYLY_GRADER_INSTRUCTION_SHA256: config.grader.instruction_sha256,
      LOYLY_GRADER_SCHEMA_SHA256: config.grader.schema_sha256,
      LOYLY_GRADER_SHARDS: String(config.grader.shards),
      LOYLY_BLIND_AGENT_COMMAND: config.blind.command,
      LOYLY_BLIND_AGENT_COMMAND_SHA256: config.blind.command_sha256,
      LOYLY_BLIND_AGENT_IMAGE: config.blind.image,
      LOYLY_BLIND_AGENT_IMAGE_SHA256: config.blind.image_sha256,
      LOYLY_BLIND_AGENT_MODEL: config.blind.model,
      LOYLY_BLIND_AGENT_SETTINGS: config.blind.settings,
      LOYLY_BLIND_AGENT_SETTINGS_SHA256: config.blind.settings_sha256,
      LOYLY_BLIND_AGENT_INSTRUCTION_SHA256: config.blind.instruction_sha256,
      LOYLY_PANEL_REQUIRED: '1', LOYLY_PANEL_IMAGE: config.panel.image,
      LOYLY_PANEL_IMAGE_SHA256: config.panel.image_sha256,
      LOYLY_PANEL_PLAN_SHA256: config.panel.plan_sha256,
    };
    const result = spawnSync(process.execPath, [join(HERE, 'worker.mjs'), scratch, 'live'],
      { cwd: HERE, env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
}
