import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const out = '/out';
const config = JSON.parse(await readFile(join(out, 'config.json'), 'utf8'));
const uuid = randomUUID(), start = Date.now();
const events = [], steps = [];
let server, failure, observed;
const receiver = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || !['/v1/traces', '/v1/metrics'].includes(request.url)) {
    response.writeHead(404).end(); return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  events.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
  response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
});
await new Promise((done) => receiver.listen(0, '127.0.0.1', done));
const receiverPort = receiver.address().port;
async function step(name, action) {
  const row = { name, status: 'passed', stage: 'finished', start: Date.now() };
  steps.push(row);
  try { return await action(); }
  catch (error) { row.status = 'failed'; row.statusDetails = { message: String(error) }; throw error; }
  finally { row.stop = Date.now(); }
}
const base = 'http://127.0.0.1:8902';
async function request(path, init) {
  const response = await fetch(base + path, init);
  return { status: response.status, body: await response.json() };
}
const attributes = (resource) => Object.fromEntries((resource?.attributes ?? [])
  .map((entry) => [entry.key, entry.value.stringValue ?? entry.value.intValue]));
try {
  server = spawn(process.execPath, [
    '--experimental-loader=/worker/node_modules/@opentelemetry/instrumentation/hook.mjs',
    '--import=/worker/panel-otel-instrumentation.mjs', '/candidate/server.mjs', '8902',
  ], { cwd: '/candidate', env: { ...process.env,
    LOYLY_DATA: join(out, 'record.json'), CANDIDATE_SHA256: config.candidate_sha256,
    PROBE_RUN_ID: uuid, OTLP_RECEIVER: `http://127.0.0.1:${receiverPort}` },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  await step('Start instrumented candidate and local OTLP receiver in Gondolin VM', async () => {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw Error(`candidate exited: ${stderr}`);
      try { if ((await request('/health')).status === 200) return; } catch { /* wait */ }
      await delay(100);
    }
    throw Error(`candidate did not start: ${stderr}`);
  });
  await step('Confirm one durable booking and all three derived views', async () => {
    const booked = await request('/api/bookings', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ household: 'Probe-17', resource: 'ph8', weekday: 'Tuesday', start: '17:00' }) });
    const views = await request('/api/views');
    const stored = JSON.parse(await readFile(join(out, 'record.json'), 'utf8'));
    observed = { status: booked.status, recurrence: booked.body.booking?.recurrence,
      bookingId: booked.body.booking?.id, storedCount: stored.bookings.length,
      viewCounts: Object.fromEntries(['postedList', 'heaterSchedule', 'invoicingSignals']
        .map((name) => [name, views.body[name]?.length])), processPid: server.pid };
    if (booked.status !== 201 || observed.recurrence !== 'weekly'
        || observed.storedCount !== 1
        || Object.values(observed.viewCounts).some((count) => count !== 1))
      throw Error(`booking observation failed: ${JSON.stringify(observed)}`);
  });
  await step('Receive candidate-bound OTLP booking span and metric', async () => {
    // The SDK's default batch span processor exports on a five-second timer.
    await delay(6000);
    const spans = events.filter((event) => event.path === '/v1/traces')
      .flatMap((event) => (event.body.resourceSpans ?? []).flatMap((resource) =>
        (resource.scopeSpans ?? []).flatMap((scope) =>
          (scope.spans ?? []).map((span) => ({ span, resource: attributes(resource.resource) })) )));
    const metrics = events.filter((event) => event.path === '/v1/metrics')
      .flatMap((event) => (event.body.resourceMetrics ?? []).flatMap((resource) =>
        (resource.scopeMetrics ?? []).flatMap((scope) =>
          (scope.metrics ?? []).map((metric) => ({ metric, resource: attributes(resource.resource) })) )));
    const bound = (entry) => entry.resource['candidate.sha256'] === config.candidate_sha256
      && entry.resource['probe.run_id'] === uuid
      && Number(entry.resource['process.pid']) === server.pid;
    const bookingSpan = spans.find((entry) => bound(entry)
      && entry.span.name === 'POST'
      && (entry.span.attributes ?? []).some((attribute) =>
        attribute.key === 'url.path' && attribute.value.stringValue === '/api/bookings'));
    const bookingMetric = metrics.find((entry) => bound(entry)
      && entry.metric.name === 'loyly.booking.request'
      && (entry.metric.sum?.dataPoints ?? []).some((point) => Number(point.asInt ?? point.asDouble) >= 1));
    observed.spans = spans.length;
    observed.metricRows = metrics.length;
    observed.traceExports = events.filter((event) => event.path === '/v1/traces').length;
    observed.metricExports = events.filter((event) => event.path === '/v1/metrics').length;
    if (!bookingSpan || !bookingMetric)
      throw Error(`candidate-bound booking span or metric missing: ${JSON.stringify(observed)}`);
  });
} catch (error) { failure = error.stack ?? String(error); }
finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((done) => server.once('exit', done)), delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  receiver.close();
}
const evidenceFile = `${randomUUID()}-attachment.json`;
await writeFile(join(out, evidenceFile), JSON.stringify({ candidate_sha256: config.candidate_sha256,
  observation: observed, events, failure }, null, 2));
const result = { uuid, name: 'Instrumented booking emits bound OpenTelemetry span and metric',
  fullName: 'loyly.booking-core.01-003.otel-panel',
  historyId: 'loyly.booking-core.01-003.otel-panel',
  testCaseId: 'loyly.booking-core.01-003.otel-panel',
  status: failure ? 'failed' : 'passed', stage: 'finished', start, stop: Date.now(),
  statusDetails: { message: failure ?? `HTTP 201, durable holding, three views, ${observed.spans} candidate-bound spans and ${observed.metricRows} metric rows.` },
  labels: [{ name: 'lifecycle', value: 'pre-production' }, { name: 'technique', value: 'tracing' },
    { name: 'tool', value: 'OpenTelemetry' }, { name: 'feature', value: 'Booking core' },
    { name: 'story', value: 'Instrumented booking request' }, { name: 'tag', value: '@item-01-003' }],
  parameters: [{ name: 'candidate_sha256', value: config.candidate_sha256 }],
  steps, attachments: [{ name: 'Bounded OTLP and booking evidence', source: evidenceFile, type: 'application/json' }],
};
await writeFile(join(out, `${uuid}-result.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, uuid, observation: observed }));
if (failure) process.exitCode = 1;
