import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { launchCandidate, readDerivedViews } from '../panel-candidate.mjs';

test('specialist launches a writable copy through start.sh, regardless of server filename', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loyly-panel-candidate-'));
  const source = join(dir, 'source'), out = join(dir, 'out');
  mkdirSync(source); mkdirSync(out);
  writeFileSync(join(source, 'start.sh'), '#!/bin/sh\ncd "$(dirname "$0")"\nexec node app.js "$1"\n');
  chmodSync(join(source, 'start.sh'), 0o755);
  writeFileSync(join(source, 'app.js'), `const http=require('node:http'),fs=require('node:fs');
http.createServer((req,res)=>{fs.writeFileSync('started.txt','yes');res.setHeader('content-type','application/json');
if(req.url==='/api/views')res.end(JSON.stringify({postedList:[],heaterSchedule:[],invoicingSignals:[]}));
else res.end('{}')}).listen(Number(process.argv[2]),'127.0.0.1');`);
  const reserved = createServer();
  await new Promise((resolve) => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const server = launchCandidate({ candidate: source, out, port });
  try {
    let response;
    for (let i = 0; i < 30; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/`); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.equal(response?.status, 200);
    assert.equal(readFileSync(join(out, 'runtime', 'start.sh'), 'utf8'), readFileSync(join(source, 'start.sh'), 'utf8'));
    assert.equal(readFileSync(join(out, 'runtime', 'started.txt'), 'utf8'), 'yes');
    assert.equal(readFileSync(join(source, 'app.js'), 'utf8').includes('started.txt'), true);
  } finally { server.kill('SIGTERM'); }
});

test('specialist reads either combined or split public derived views', async () => {
  const combined = { postedList: [], heaterSchedule: [], invoicingSignals: [] };
  assert.deepEqual(await readDerivedViews('http://example.invalid', async () => ({
    ok: true, json: async () => combined,
  })), combined);
  const split = async (url) => url.endsWith('/api/views')
    ? { ok: false, status: 404 }
    : { ok: true, json: async () => ({ entries: [{ route: url }] }) };
  const views = await readDerivedViews('http://example.invalid', split);
  assert.deepEqual(Object.keys(views), ['postedList', 'heaterSchedule', 'invoicingSignals']);
  assert.equal(views.postedList[0].route, 'http://example.invalid/api/posted-list');
});
