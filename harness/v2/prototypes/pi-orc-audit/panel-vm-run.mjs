// Launch independent capability probes in parallel Gondolin QEMU VMs.
// Every VM sees the same read-only candidate and writes one Allure directory.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { candidateDigest } from './grading-room.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path) => sha(readFileSync(path));
const WORKERS = [
  { id: 'browser', script: 'panel-browser.mjs', tool: 'Playwright', item: '01-003' },
  { id: 'protocol', script: 'panel-protocol.mjs', tool: 'Node.js', item: '01-010' },
  { id: 'telemetry', script: 'panel-telemetry.mjs', tool: 'OpenTelemetry', item: '01-003' },
];
const label = (result, name) => result.labels?.find((entry) => entry.name === name)?.value;
function runBinding(original) {
  const input = join(original, 'score-input.json');
  if (existsSync(input)) return JSON.parse(readFileSync(input, 'utf8'));
  const cut = join(original, 'cut', 'project');
  const git = spawnSync('git', ['-C', cut, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim()))
    throw new Error('panel needs a pinned source cut');
  return { source_commit: git.stdout.trim(), candidate_sha256: candidateDigest(join(original, 'fenced-room')) };
}
function scoreDigest(original) {
  const score = join(original, 'instrument', 'harness', 'cycles', '02', 'scores.json');
  return existsSync(score) ? fileSha(score) : null;
}

async function runWorker(worker, image, candidate, out, candidateSha256, sourceFilesSha256,
  imageDigest, validate) {
  const dir = join(out, worker.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ candidate_sha256: candidateSha256,
    source_files_sha256: sourceFilesSha256 }));
  const args = ['exec', '--image', image,
    '--mount-hostfs', `${candidate}:/candidate:ro`,
    '--mount-hostfs', `${HERE}:/worker:ro`,
    '--mount-hostfs', `${dir}:/out`,
    '--allow-host', 'egress-blocked.invalid', '--', 'node', `/worker/${worker.script}`];
  const started = Date.now();
  const child = spawn('gondolin', args, { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000, killSignal: 'SIGTERM' });
  const stdout = [], stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((done, fail) => {
    child.on('error', fail); child.on('close', done);
  });
  const stopped = Date.now();
  writeFileSync(join(dir, 'vm-stdout.log'), Buffer.concat(stdout));
  writeFileSync(join(dir, 'vm-stderr.log'), Buffer.concat(stderr));
  const resultFiles = readdirSync(dir).filter((name) => /^[0-9a-f-]{36}-result\.json$/.test(name));
  if (resultFiles.length !== 1)
    throw new Error(`${worker.id}: VM exited ${exitCode} without one Allure result: ${Buffer.concat(stderr).toString()}`);
  const resultFile = resultFiles[0];
  const result = JSON.parse(readFileSync(join(dir, resultFile), 'utf8'));
  const receiptName = `${randomUUID()}-attachment.receipt.json`;
  const receipt = { schema: 'loyly.panel-vm-execution.v1',
    worker: worker.id, candidate_sha256: candidateSha256,
    imageDigest, image_manifest_sha256: imageDigest.slice(7),
    worker_script_sha256: fileSha(join(HERE, worker.script)),
    package_lock_sha256: fileSha(join(HERE, 'package-lock.json')),
    ...(worker.id === 'telemetry' ? {
      instrumentation_sha256: fileSha(join(HERE, 'panel-otel-instrumentation.mjs')),
    } : {}),
    vm_exit_code: exitCode, isolation: 'gondolin-qemu-vm',
    mounts: { candidate: 'read-only', worker: 'read-only', output: 'read-write' },
    egress: ['egress-blocked.invalid'], started, stopped,
    command: ['node', `/worker/${worker.script}`] };
  writeFileSync(join(dir, receiptName), JSON.stringify(receipt, null, 2));
  result.attachments ??= [];
  result.attachments.push({ name: 'Gondolin VM execution receipt',
    source: receiptName, type: 'application/json' });
  writeFileSync(join(dir, resultFile), JSON.stringify(result, null, 2));
  if (!validate(result) || resultFile !== `${result.uuid}-result.json`
      || label(result, 'tool') !== worker.tool || label(result, 'tag') !== `@item-${worker.item}`
      || result.parameters?.find((entry) => entry.name === 'candidate_sha256')?.value !== candidateSha256
      || result.stage !== 'finished' || (exitCode === 0) !== (result.status === 'passed'))
    throw new Error(`${worker.id}: VM result is invalid: ${JSON.stringify(validate.errors)}`);
  const files = [resultFile, ...result.attachments.map((attachment) => attachment.source)];
  const hashes = Object.fromEntries(files.map((name) => [name, fileSha(join(dir, name))]));
  return { id: worker.id, tool: worker.tool, item: `@item-${worker.item}`,
    status: result.status, result: resultFile, start: result.start, stop: result.stop,
    started, stopped, image_digest: imageDigest,
    execution_receipt_sha256: hashes[receiptName], files: hashes };
}

export async function runPanelVms({ original, image, out }) {
  original = resolve(original); image = resolve(image); out = resolve(out);
  if (existsSync(out)) throw new Error('panel VM output already exists');
  const scoreInput = runBinding(original);
  const candidateSha256 = candidateDigest(join(original, 'fenced-room'));
  if (candidateSha256 !== scoreInput.candidate_sha256)
    throw new Error('candidate differs from the scored cut');
  const scoreSha256 = scoreDigest(original);
  const candidate = join(original, 'fenced-room', 'impl');
  const sourceHash = createHash('sha256');
  for (const name of ['server.mjs', 'web.mjs', 'model.mjs', 'style.css', 'contract.json']) {
    sourceHash.update(name); sourceHash.update(readFileSync(join(candidate, name)));
  }
  const sourceFilesSha256 = sourceHash.digest('hex');
  const verify = spawnSync('gondolin', ['build', '--verify', image], { encoding: 'utf8' });
  if (verify.status !== 0) throw new Error(`Gondolin image verification failed: ${verify.stderr}`);
  const imageDigest = `sha256:${fileSha(join(image, 'manifest.json'))}`;
  const schemaFile = join(HERE, 'allure-lifecycle-result.schema.json');
  const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(schemaFile, 'utf8')));
  const planFile = join(HERE, 'booking-core.panel.json');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const validatePlan = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(join(HERE, 'panel-plan.schema.json'), 'utf8')));
  if (!validatePlan(plan) || WORKERS.some((worker) => !plan.checks.some((check) =>
    check.id === worker.id && check.source === 'specialist' && check.tool === worker.tool
    && check.items.join() === worker.item)))
    throw new Error('specialist workers differ from the panel plan');
  mkdirSync(out, { recursive: true });
  const settled = await Promise.allSettled(WORKERS.map((worker) => runWorker(worker, image,
    candidate, out, candidateSha256, sourceFilesSha256, imageDigest, validate)));
  const failures = settled.filter((row) => row.status === 'rejected').map((row) => String(row.reason));
  if (failures.length) throw new Error(`panel VM worker failed: ${failures.join('; ')}`);
  const producers = settled.map((row) => row.value);
  const overlap = Math.min(...producers.map((row) => row.stopped))
    - Math.max(...producers.map((row) => row.started));
  if (overlap <= 0) throw new Error('panel VMs did not overlap');
  if (scoreDigest(original) !== scoreSha256) throw new Error('score changed during VM grading');
  const manifest = { schema: 'loyly.panel-vm-run.v1', source_commit: scoreInput.source_commit,
    candidate_sha256: candidateSha256, original_score_sha256: scoreSha256,
    allure_schema_sha256: fileSha(schemaFile), plan_sha256: fileSha(planFile), image_digest: imageDigest,
    parallel_overlap_ms: overlap, original_score_unchanged: true,
    score_state: scoreSha256 ? 'filed' : 'pre-score', producers };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyPanelVmRun({ original, out, imageDigest });
}

// Reopen a completed panel after a controller restart without launching VMs
// again. A partial output is not a receipt and must be kept as failed evidence.
export function verifyPanelVmRun({ original, out, imageDigest }) {
  original = resolve(original); out = resolve(out);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const scoreInput = runBinding(original);
  const candidateSha256 = candidateDigest(join(original, 'fenced-room'));
  const scoreSha256 = scoreDigest(original);
  const planSha256 = fileSha(join(HERE, 'booking-core.panel.json'));
  const schemaFile = join(HERE, 'allure-lifecycle-result.schema.json');
  const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(schemaFile, 'utf8')));
  if (manifest.schema !== 'loyly.panel-vm-run.v1'
      || manifest.source_commit !== scoreInput.source_commit
      || manifest.candidate_sha256 !== candidateSha256
      || ((manifest.score_state ?? 'filed') === 'filed' && manifest.original_score_sha256 !== scoreSha256)
      || (manifest.score_state === 'pre-score' && manifest.original_score_sha256 !== null)
      || manifest.plan_sha256 !== planSha256
      || manifest.allure_schema_sha256 !== fileSha(schemaFile)
      || manifest.original_score_unchanged !== true
      || (imageDigest && manifest.image_digest !== imageDigest)
      || manifest.producers?.length !== WORKERS.length)
    throw new Error('panel VM manifest differs from the scored cut, plan, schema or image');
  for (const worker of WORKERS) {
    const producer = manifest.producers.find((row) => row.id === worker.id);
    if (!producer || producer.tool !== worker.tool || producer.item !== `@item-${worker.item}`
        || producer.image_digest !== manifest.image_digest
        || !Number.isInteger(producer.started) || !Number.isInteger(producer.stopped)
        || producer.stopped < producer.started)
      throw new Error(`${worker.id}: panel producer receipt differs`);
    const dir = join(out, worker.id);
    const results = readdirSync(dir).filter((name) => /^[0-9a-f-]{36}-result\.json$/.test(name));
    if (results.length !== 1 || results[0] !== producer.result)
      throw new Error(`${worker.id}: expected one result`);
    const result = JSON.parse(readFileSync(join(dir, producer.result), 'utf8'));
    const receiptFile = result.attachments?.find((attachment) =>
      attachment.name === 'Gondolin VM execution receipt')?.source;
    const files = [producer.result, ...(result.attachments ?? []).map((attachment) => attachment.source)];
    if (!validate(result) || result.uuid + '-result.json' !== producer.result
        || result.status !== producer.status || result.stage !== 'finished'
        || label(result, 'tool') !== worker.tool || label(result, 'tag') !== producer.item
        || result.parameters?.find((entry) => entry.name === 'candidate_sha256')?.value !== candidateSha256
        || !receiptFile || new Set(files).size !== files.length
        || files.length !== Object.keys(producer.files).length
        || files.some((name) => !existsSync(join(dir, name))
          || producer.files[name] !== fileSha(join(dir, name)))
        || producer.execution_receipt_sha256 !== fileSha(join(dir, receiptFile)))
      throw new Error(`${worker.id}: Allure result or attachment changed`);
    const receipt = JSON.parse(readFileSync(join(dir, receiptFile), 'utf8'));
    if (receipt.worker !== worker.id || receipt.candidate_sha256 !== candidateSha256
        || receipt.imageDigest !== manifest.image_digest
        || receipt.isolation !== 'gondolin-qemu-vm'
        || receipt.mounts?.candidate !== 'read-only'
        || receipt.mounts?.worker !== 'read-only'
        || (receipt.vm_exit_code === 0) !== (result.status === 'passed'))
      throw new Error(`${worker.id}: Gondolin execution receipt changed`);
  }
  const overlap = Math.min(...manifest.producers.map((row) => row.stopped))
    - Math.max(...manifest.producers.map((row) => row.started));
  if (overlap <= 0 || overlap !== manifest.parallel_overlap_ms)
    throw new Error('panel VM overlap receipt changed');
  return { out, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error('usage: node panel-vm-run.mjs <scored-cycle-scratch> <Gondolin-image-assets> <output-dir>');
  const result = await runPanelVms({ original: process.argv[2], image: process.argv[3], out: process.argv[4] });
  console.log(`${result.out}: ${result.manifest.producers.length} parallel Gondolin VMs; overlap ${result.manifest.parallel_overlap_ms} ms; ${result.manifest.producers.map((row) => `${row.id}=${row.status}`).join(', ')}`);
}
