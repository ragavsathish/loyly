import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const schemaFile = fileURLToPath(new URL('./panel-otel-metrics.schema.json', import.meta.url));
const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(schemaFile)));
const safeFile = (name) => typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name);
const attribute = (list, name) => list.find((row) => row.key === name)?.value;

export function verifyRuntimeProfileEvidence({ dir, result, candidateSha256, probe }) {
  if (result.status !== 'passed') return;
  const evidenceName = result.attachments?.find((row) =>
    row.name === 'VM process and HTTP observations')?.source;
  const otlpName = result.attachments?.find((row) =>
    row.name === 'Panel-observed OTLP process metrics')?.source;
  if (!safeFile(evidenceName) || !safeFile(otlpName))
    throw new Error('passed runtime profile needs safe process and OTLP attachments');
  const evidence = JSON.parse(readFileSync(join(dir, evidenceName)));
  const payload = JSON.parse(readFileSync(join(dir, otlpName)));
  if (!validate(payload)) throw new Error(`runtime OTLP schema: ${JSON.stringify(validate.errors)}`);
  if (evidence.candidate_sha256 !== candidateSha256
      || evidence.probe_run_id !== result.uuid || evidence.source !== 'panel-vm-procfs'
      || evidence.failure || !evidence.after?.processes?.length
      || evidence.request?.status !== evidence.request?.expected_status
      || evidence.request?.method !== (probe?.method ?? 'GET')
      || evidence.request?.path !== (probe?.path ?? '/')
      || evidence.request?.expected_status !== (probe?.expected_status ?? 200))
    throw new Error('runtime profile differs from the candidate or HTTP observation');
  const bound = payload.resourceMetrics.filter((row) => {
    const attrs = row.resource.attributes;
    return attribute(attrs, 'candidate.sha256')?.stringValue === candidateSha256
      && attribute(attrs, 'probe.run_id')?.stringValue === result.uuid
      && attribute(attrs, 'measurement.source')?.stringValue === 'panel-vm-procfs'
      && attribute(attrs, 'process.pid')?.intValue === evidence.after.processes[0].pid;
  });
  if (bound.length !== 1) throw new Error('runtime OTLP resource has no unique candidate binding');
  const metrics = bound[0].scopeMetrics.flatMap((scope) => scope.metrics);
  const value = (name) => metrics.find((row) => row.name === name)?.gauge?.dataPoints?.[0]?.asDouble;
  const required = ['loyly.panel.process.rss', 'loyly.panel.process.threads',
    'loyly.panel.http.duration', ...(evidence.jfr?.kind === 'jvm'
      ? ['loyly.panel.jvm.jfr.bytes'] : [])];
  if (required.some((name) => metrics.filter((row) => row.name === name).length !== 1))
    throw new Error('runtime OTLP metrics are missing or duplicated');
  if (value('loyly.panel.process.rss') !== evidence.after.rss_bytes
      || value('loyly.panel.process.threads') !== evidence.after.threads
      || value('loyly.panel.http.duration') !== evidence.request.elapsed_ms)
    throw new Error('runtime OTLP values differ from the raw process observation');
  if (evidence.jfr?.kind === 'jvm') {
    const jfrName = result.attachments.find((row) => row.name === 'Java Flight Recorder')?.source;
    if (!safeFile(jfrName) || statSync(join(dir, jfrName)).size !== evidence.jfr.bytes
        || value('loyly.panel.jvm.jfr.bytes') !== evidence.jfr.bytes)
      throw new Error('runtime JVM profile has no matching JFR attachment and metric');
  }
  return { evidence, payload };
}
