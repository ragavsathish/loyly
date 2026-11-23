import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyRuntimeProfileEvidence } from '../runtime-profile-evidence.mjs';

const candidateSha256 = 'a'.repeat(64), uuid = 'b'.repeat(8) + '-0000-0000-0000-' + 'c'.repeat(12);
const attribute = (key, value) => ({ key, value: typeof value === 'number'
  ? { intValue: value } : { stringValue: value } });
const metric = (name, value) => ({ name, gauge: { dataPoints: [{
  attributes: [attribute('http.request.method', 'GET'), attribute('url.path', '/')],
  timeUnixNano: '123000000', asDouble: value,
}] } });

test('the runtime profile binds real OTLP values to raw process and Allure evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loyly-runtime-profile-'));
  try {
    const evidence = { candidate_sha256: candidateSha256, probe_run_id: uuid,
      source: 'panel-vm-procfs', failure: null,
      request: { method: 'GET', path: '/', status: 200, expected_status: 200, elapsed_ms: 7 },
      after: { processes: [{ pid: 42 }], rss_bytes: 4096, threads: 3 },
      jfr: { kind: 'jvm', bytes: 4 } };
    const payload = { resourceMetrics: [{
      resource: { attributes: [attribute('candidate.sha256', candidateSha256),
        attribute('probe.run_id', uuid), attribute('measurement.source', 'panel-vm-procfs'),
        attribute('process.pid', 42)] },
      scopeMetrics: [{ scope: { name: 'loyly.panel.runtime' }, metrics: [
        metric('loyly.panel.process.rss', 4096),
        metric('loyly.panel.process.threads', 3),
        metric('loyly.panel.http.duration', 7),
        metric('loyly.panel.jvm.jfr.bytes', 4),
      ] }],
    }] };
    const result = { uuid, status: 'passed', attachments: [
      { name: 'VM process and HTTP observations', source: 'process.json' },
      { name: 'Panel-observed OTLP process metrics', source: 'metrics.json' },
      { name: 'Java Flight Recorder', source: 'profile.jfr' },
    ] };
    const write = () => {
      writeFileSync(join(dir, 'process.json'), JSON.stringify(evidence));
      writeFileSync(join(dir, 'metrics.json'), JSON.stringify(payload));
      writeFileSync(join(dir, 'profile.jfr'), 'JFR!');
    };
    const verify = () => verifyRuntimeProfileEvidence({ dir, result, candidateSha256 });
    write();
    assert.equal(verify().evidence.after.rss_bytes, 4096);
    payload.resourceMetrics[0].resource.attributes[0].value.stringValue = 'wrong';
    write();
    assert.throws(verify, /no unique candidate binding/);
    payload.resourceMetrics[0].resource.attributes[0].value.stringValue = candidateSha256;
    payload.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].asDouble = 8192;
    write();
    assert.throws(verify, /values differ/);
    payload.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].asDouble = 4096;
    evidence.request.path = '/other';
    write();
    assert.throws(verify, /differs from the candidate or HTTP observation/);
    evidence.request.path = '/';
    writeFileSync(join(dir, 'process.json'), JSON.stringify(evidence));
    writeFileSync(join(dir, 'profile.jfr'), 'x');
    assert.throws(verify, /no matching JFR attachment/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
