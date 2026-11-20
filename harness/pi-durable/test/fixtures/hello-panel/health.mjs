// A different project's panel adapter, used to exercise the generic VM lifecycle.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchCandidate } from '/harness/panel-candidate.mjs';
import { treeDigest } from '/harness/grading-room.mjs';

const out = '/out', config = JSON.parse(readFileSync(join(out, 'config.json')));
const uuid = randomUUID(), start = Date.now();
let server, status = 'passed', message = 'Fresh candidate returned its public health response.';
try {
  if (treeDigest('/candidate', 'impl') !== config.source_files_sha256)
    throw Error('candidate source digest changed');
  const port = 28000 + Math.floor(Math.random() * 20000);
  server = launchCandidate({ candidate: '/candidate', out, port });
  let response;
  for (let i = 0; i < 50; i++) {
    try { response = await fetch(`http://127.0.0.1:${port}/health`); break; }
    catch { await delay(100); }
  }
  if (!response?.ok || (await response.text()) !== 'hello')
    throw Error(`health response was ${response?.status ?? 'missing'}`);
} catch (error) {
  status = 'failed'; message = String(error);
  process.exitCode = 1;
} finally {
  server?.kill('SIGTERM');
}
const source = `${randomUUID()}-attachment.txt`;
writeFileSync(join(out, source), `${message}\n`);
const name = 'Public health responds from a fresh candidate';
const result = { uuid, name, fullName: 'hello.health.01-001', testCaseId: 'hello.health.01-001',
  historyId: 'hello.health.01-001', status, stage: 'finished',
  statusDetails: { message }, start, stop: Date.now(),
  labels: [{ name: 'lifecycle', value: 'pre-production' },
    { name: 'technique', value: config.technique }, { name: 'tool', value: config.tool },
    { name: 'feature', value: config.feature }, { name: 'story', value: 'Public health' },
    { name: 'tag', value: `@item-${config.item}` }],
  parameters: [{ name: 'candidate_sha256', value: config.candidate_sha256 }],
  steps: [{ name: 'GET /health', status, stage: 'finished', start, stop: Date.now() }],
  attachments: [{ name: 'HTTP observation', source, type: 'text/plain' }] };
writeFileSync(join(out, `${uuid}-result.json`), JSON.stringify(result));
