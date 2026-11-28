// Stack-independent runtime diagnostic. These are observations by the panel
// VM, not telemetry emitted by the candidate. Java candidates additionally
// produce a real JFR recording using JVM startup options around the request.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readlink, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { launchCandidate, treeDigest } from './panel-candidate.mjs';

const out = '/out';
const config = JSON.parse(await readFile(join(out, 'config.json'), 'utf8'));
const probe = config.probe ?? { method: 'GET', path: '/', expected_status: 200 };
const uuid = randomUUID(), started = Date.now(), steps = [];
const base = 'http://127.0.0.1:8903';
let server, failure, before, after, responseObservation, jfrObservation;
let output = '';

async function step(name, action) {
  const row = { name, stage: 'finished', status: 'passed', start: Date.now() };
  steps.push(row);
  try { return await action(); }
  catch (error) {
    row.status = 'failed'; row.statusDetails = { message: String(error) };
    throw error;
  } finally { row.stop = Date.now(); }
}

async function descendants(pid, seen = new Set()) {
  if (seen.has(pid) || !existsSync(`/proc/${pid}`)) return seen;
  seen.add(pid);
  const path = `/proc/${pid}/task/${pid}/children`;
  const children = (await readFile(path, 'utf8').catch(() => '')).trim();
  for (const child of children ? children.split(/\s+/).map(Number) : [])
    await descendants(child, seen);
  return seen;
}

async function snapshot(pid) {
  const rows = [];
  for (const child of await descendants(pid)) {
    const statusText = await readFile(`/proc/${child}/status`, 'utf8').catch(() => '');
    if (!statusText) continue;
    const field = (name) => new RegExp(`^${name}:\\s*(\\d+)`, 'm').exec(statusText)?.[1];
    rows.push({ pid: child,
      executable: await readlink(`/proc/${child}/exe`).catch(() => null),
      rss_bytes: Number(field('VmRSS') ?? 0) * 1024,
      threads: Number(field('Threads') ?? 0),
      voluntary_context_switches: Number(field('voluntary_ctxt_switches') ?? 0) });
  }
  if (!rows.length) throw new Error('candidate process has no readable procfs snapshot');
  return { at: Date.now(), processes: rows,
    rss_bytes: rows.reduce((n, row) => n + row.rss_bytes, 0),
    threads: rows.reduce((n, row) => n + row.threads, 0) };
}

async function exportPanelMetrics() {
  const exports = [];
  const receiver = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/metrics') {
      response.writeHead(404).end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    exports.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((done) => receiver.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${receiver.address().port}/v1/metrics`;
  const provider = new MeterProvider({ resource: resourceFromAttributes({
    'service.name': 'loyly-panel-runtime-probe',
    'candidate.sha256': config.candidate_sha256,
    'probe.run_id': uuid,
    'measurement.source': 'panel-vm-procfs',
    'process.pid': after.processes[0].pid,
  }), readers: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url }), exportIntervalMillis: 60_000,
  })] });
  try {
    const meter = provider.getMeter('loyly.panel.runtime');
    const attributes = { 'http.request.method': probe.method, 'url.path': probe.path,
      'runtime.kind': jfrObservation ? 'jvm' : 'native-or-other' };
    meter.createGauge('loyly.panel.process.rss', { unit: 'By' })
      .record(after.rss_bytes, attributes);
    meter.createGauge('loyly.panel.process.threads', { unit: '{thread}' })
      .record(after.threads, attributes);
    meter.createGauge('loyly.panel.http.duration', { unit: 'ms' })
      .record(responseObservation.elapsed_ms, attributes);
    if (jfrObservation?.bytes) meter.createGauge('loyly.panel.jvm.jfr.bytes', { unit: 'By' })
      .record(jfrObservation.bytes, attributes);
    await provider.forceFlush();
  } finally {
    await provider.shutdown();
    await new Promise((done) => receiver.close(done));
  }
  const payload = exports.find((entry) => (entry.resourceMetrics ?? []).some((resource) =>
    (resource.scopeMetrics ?? []).some((scope) => (scope.metrics ?? []).length >= 3)));
  if (!payload) throw new Error('OTLP exporter produced no process metrics');
  const file = `${randomUUID()}-attachment.otlp.json`;
  await writeFile(join(out, file), JSON.stringify(payload, null, 2));
  return file;
}

try {
  await step('Verify the read-only candidate digest', async () => {
    if (treeDigest('/candidate', 'impl') !== config.candidate_sha256)
      throw new Error('mounted candidate differs from the pinned digest');
  });
  const jfrFile = join(out, `${uuid}-attachment.jfr`);
  const jfrOption = `-XX:StartFlightRecording=name=loyly-${uuid},settings=profile,filename=${jfrFile},dumponexit=true,disk=true`;
  server = launchCandidate({ candidate: '/candidate', out, port: 8903,
    env: { LOYLY_DATA: join(out, 'record.json'), LOYLY_DATA_FILE: join(out, 'record.json'),
      JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, jfrOption].filter(Boolean).join(' ') } });
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await step('Start a private candidate copy and observe HTTP readiness', async () => {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`candidate exited: ${output}`);
      try { if ((await fetch(base + '/')).ok) return; }
      catch { /* wait for listener */ }
      await delay(100);
    }
    throw new Error(`candidate did not become ready: ${output}`);
  });
  before = await step('Capture candidate process tree before workload', () => snapshot(server.pid));
  const java = before.processes.find((row) => /\/java$/.test(row.executable ?? ''));
  if (java) jfrObservation = { pid: java.pid, kind: 'jvm', capture: 'startup-options',
    file: jfrFile };
  responseObservation = await step('Issue the pinned public HTTP request', async () => {
    const began = Date.now();
    const response = await fetch(base + probe.path, { method: probe.method,
      headers: probe.json_body ? { 'content-type': 'application/json' } : {},
      body: probe.json_body ? JSON.stringify(probe.json_body) : undefined });
    const body = (await response.text()).slice(0, 1024);
    const observed = { method: probe.method, path: probe.path, status: response.status,
      expected_status: probe.expected_status, elapsed_ms: Date.now() - began, body_prefix: body };
    if (response.status !== probe.expected_status)
      throw new Error(`HTTP ${response.status}, expected ${probe.expected_status}: ${body}`);
    return observed;
  });
  after = await step('Capture candidate process tree after workload', () => snapshot(server.pid));
} catch (error) { failure = String(error.stack ?? error); }
finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((done) => server.once('exit', done)), delay(10_000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (jfrObservation) {
    try {
      await step('Verify the JVM dumped a nonempty JFR recording', async () => {
        jfrObservation.bytes = (await stat(jfrObservation.file)).size;
        if (jfrObservation.bytes <= 0) throw new Error('JFR recording is empty');
      });
    } catch (error) { failure ??= String(error.stack ?? error); }
  }
}

let otlpFile;
if (after && responseObservation) {
  try { otlpFile = await step('Export panel-observed process metrics as OTLP JSON',
    exportPanelMetrics); }
  catch (error) { failure ??= String(error.stack ?? error); }
}

const observed = { candidate_sha256: config.candidate_sha256, probe_run_id: uuid,
  source: 'panel-vm-procfs', request: responseObservation, before, after,
  jfr: jfrObservation, output: output.slice(-4096), failure };
const evidence = `${randomUUID()}-attachment.json`;
await writeFile(join(out, evidence), JSON.stringify(observed, null, 2));
const attachments = [{ name: 'VM process and HTTP observations', source: evidence,
  type: 'application/json' }];
if (otlpFile) attachments.push({ name: 'Panel-observed OTLP process metrics',
  source: otlpFile, type: 'application/json' });
if (jfrObservation?.bytes) attachments.push({ name: 'Java Flight Recorder',
  source: `${uuid}-attachment.jfr`, type: 'application/octet-stream' });
const result = { uuid, name: 'Candidate runtime profile around a public request',
  fullName: `loyly.panel.runtime.${config.item}`,
  historyId: `loyly.panel.runtime.${config.item}`,
  testCaseId: `loyly.panel.runtime.${config.item}`,
  status: failure ? 'failed' : 'passed', stage: 'finished', start: started, stop: Date.now(),
  statusDetails: { message: failure ?? `HTTP ${responseObservation.status}; observed ${after.processes.length} candidate process(es), ${after.rss_bytes} RSS bytes${jfrObservation ? ', JFR captured' : ''}.` },
  labels: [{ name: 'lifecycle', value: 'pre-production' },
    { name: 'technique', value: config.technique }, { name: 'tool', value: config.tool },
    { name: 'feature', value: config.feature },
    { name: 'story', value: 'Runtime profile for one public request' },
    { name: 'tag', value: `@item-${config.item}` }],
  parameters: [{ name: 'candidate_sha256', value: config.candidate_sha256 }],
  steps, attachments };
await writeFile(join(out, `${uuid}-result.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, candidate_sha256: config.candidate_sha256,
  request: responseObservation, runtime: jfrObservation ? 'jvm' : 'native-or-other' }));
if (failure) process.exitCode = 1;
