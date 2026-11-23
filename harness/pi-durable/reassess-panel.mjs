// Reassess only the project panel against a previously scored, frozen Pi cycle.
// The original score and Pi audit are inputs; this writes a separate receipt.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPanelAttempt } from './panel-adapter.mjs';
import { runPanelVms, verifyPanelVmRun } from './panel-vm-run.mjs';
import { compilePanel, verifyCompiledPanel } from './panel-compile.mjs';
import { candidateDigest } from './grading-room.ts';
import { scoreCycleFor, verifyScoredCycle } from './score-receipt.ts';
import { readAuditRows } from './audit-rows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path) => sha(readFileSync(path));
function git(...args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw Error(`git ${args.join(' ')} failed`);
  return r.stdout.trim();
}
export async function checkReassessment(config) {
  if (config?.schema !== 'loyly.pi-panel-reassessment.v1'
      || !/^[0-9a-f]{40}$/.test(config.controller_commit ?? '')
      || !/^[0-9a-f]{40}$/.test(config.source_commit ?? '')
      || [config.candidate_sha256, config.score_sha256,
        config.plan_sha256, config.image_sha256].some((x) => !/^[0-9a-f]{64}$/.test(x ?? ''))
      || typeof config.original !== 'string' || typeof config.out !== 'string'
      || typeof config.image !== 'string'
      || (config.plan_file !== undefined
        && !/^[a-z][a-z0-9-]*\.panel\.json$/.test(config.plan_file)))
    throw Error('panel reassessment needs a fully pinned contract');
  const original = resolve(config.original), out = resolve(config.out), image = resolve(config.image);
  if (out === original || out.startsWith(`${original}/`) === false)
    throw Error('reassessment output must be a private directory in the original scratch');
  if (git('rev-parse', 'HEAD') !== config.controller_commit || git('status', '--porcelain'))
    throw Error('controller differs from the pinned clean commit');
  const planFile = join(HERE, config.plan_file ?? 'booking-core.panel.json');
  if (fileSha(planFile) !== config.plan_sha256
      || fileSha(join(image, 'manifest.json')) !== config.image_sha256)
    throw Error('panel plan or VM image changed');
  const score = verifyScoredCycle({ scratch: original,
    instrument: join(original, 'instrument'), verdictsFile: join(original, 'final-verdicts.json'),
    cycle: scoreCycleFor(original) });
  const input = JSON.parse(readFileSync(join(original, 'score-input.json'), 'utf8'));
  const rows = await readAuditRows(original);
  const filed = rows.findLast((row) => row.stage === 'score' && row.outcome === 'filed');
  if (input.source_commit !== config.source_commit
      || input.candidate_sha256 !== config.candidate_sha256
      || candidateDigest(join(original, 'fenced-room')) !== config.candidate_sha256
      || score.scoreSha256 !== config.score_sha256
      || filed?.score_file_sha256 !== config.score_sha256
      || filed?.score_input_sha256 !== fileSha(join(original, 'score-input.json')))
    throw Error('frozen candidate or filed Pi score differs from reassessment contract');
  return { original, out, image, planFile, score, input };
}

export async function runReassessment(config) {
  const { original, out, image, planFile, score, input } = await checkReassessment(config);
  mkdirSync(out, { recursive: true });
  const receiptFile = join(out, 'reassessment.json');
  const vm = await selectPanelAttempt({ root: join(out, 'vm'),
    launch: (dir) => runPanelVms({ original, image, out: dir, planFile }),
    verify: (dir) => verifyPanelVmRun({ original, out: dir,
      imageDigest: `sha256:${config.image_sha256}`, planFile }) });
  const vmDir = join(out, 'vm', `attempt-${String(vm.attempt).padStart(2, '0')}`);
  const report = await selectPanelAttempt({ root: join(out, 'report'),
    manifestName: 'panel-manifest.json',
    launch: (dir) => compilePanel({ original, specialists: vmDir, out: dir, planFile }),
    verify: (dir) => verifyCompiledPanel({ original, out: dir, planFile }) });
  const reportDir = join(out, 'report', `attempt-${String(report.attempt).padStart(2, '0')}`);
  const receipt = { schema: 'loyly.pi-panel-reassessment-result.v1',
    controller_commit: config.controller_commit,
    source_commit: config.source_commit,
    candidate_sha256: config.candidate_sha256,
    filed_score_sha256: score.scoreSha256, filed_score: score.score,
    original_panel_manifest_sha256: input.panel_manifest_sha256 ?? null,
    revised_plan_sha256: config.plan_sha256,
    revised_vm_manifest_sha256: fileSha(join(vmDir, 'manifest.json')),
    revised_report_manifest_sha256: fileSha(join(reportDir, 'panel-manifest.json')),
    panel_outcome: report.summary.panel_outcome,
    allure_cases: report.stats.total,
    vm_attempt: vm.attempt, report_attempt: report.attempt,
    original_cycle_unchanged: true };
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(receiptFile) && readFileSync(receiptFile, 'utf8') !== bytes)
    throw Error('panel reassessment receipt changed');
  if (!existsSync(receiptFile)) {
    writeFileSync(`${receiptFile}.partial`, bytes);
    renameSync(`${receiptFile}.partial`, receiptFile);
  }
  return { ...receipt, out: reportDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || !['--check', '--run'].includes(process.argv[2]))
    throw Error('usage: node reassess-panel.mjs --check|--run <pinned-config.json>');
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  if (process.argv[2] === '--check') {
    const checked = await checkReassessment(config);
    console.log(`frozen ${checked.score.score} cycle verified`);
  } else {
    const result = await runReassessment(config);
    console.log(`${result.out}: filed ${result.filed_score}, ${result.allure_cases} Allure cases, ${result.panel_outcome}`);
  }
}
