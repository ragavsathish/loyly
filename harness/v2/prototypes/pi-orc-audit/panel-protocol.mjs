import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { treeDigest } from './grading-room.mjs';

const out = '/out';
const config = JSON.parse(await readFile(join(out, 'config.json'), 'utf8'));
const modern = JSON.parse(await readFile('/candidate/contract.json', 'utf8')).request?.path === '/api/bookings';
const uuid = randomUUID();
const start = Date.now();
const base = 'http://127.0.0.1:8901';
const slot = { resource: 'ph8', weekday: 'Tuesday', start: '17:00' };
const cases = [];
const steps = [];
const record = join(out, 'record.json');
let server;
let failure;

async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ...(await response.json()), status: response.status };
}
async function step(name, action) {
  const row = { name, status: 'passed', stage: 'finished', start: Date.now() };
  steps.push(row);
  try { return await action(); }
  catch (error) { row.status = 'failed'; row.statusDetails = { message: String(error) }; throw error; }
  finally { row.stop = Date.now(); }
}
async function oneRace(index) {
  let firstAnswered = false;
  const first = request('/api/bookings', 'POST', { household: '12', ...slot })
    .then((response) => { firstAnswered = true; return response; });
  const second = request('/api/bookings', 'POST', { household: '3', ...slot });
  const overlapped = !firstAnswered;
  const [a, b] = await Promise.all([first, second]);
  const booking = await request('/api/bookings');
  const views = await request('/api/views');
  const schedule = await request('/api/schedule');
  const selected = schedule.slots.find((value) => value.resource === 'ph8'
    && value.weekday === 'Tuesday' && value.start === '17:00');
  const row = { index, overlapped, responses: [a.status, b.status],
    codes: [a.code ?? a.reason ?? null, b.code ?? b.reason ?? null], holder: selected?.household,
    bookingCount: booking.bookings?.length,
    viewCounts: Object.fromEntries(['postedList', 'heaterSchedule', 'invoicingSignals']
      .map((name) => [name, views[name]?.length])) };
  cases.push(row);
  assert.equal(overlapped, true, `race ${index} requests did not overlap`);
  assert.deepEqual(row.responses.sort(), [201, 409], `race ${index} responses`);
  const winner = [a, b].find((value) => value.status === 201).booking;
  assert.equal([a, b].find((value) => value.status === 409).code
    ?? [a, b].find((value) => value.status === 409).reason, 'held');
  assert.equal(booking.bookings?.length, 1);
  assert.equal(booking.bookings[0].id, winner.id);
  assert.equal(selected?.state ?? selected?.status, 'held');
  assert.equal(selected.household, winner.household);
  for (const name of ['postedList', 'heaterSchedule', 'invoicingSignals'])
    assert.equal(views[name]?.length, 1, name);
  assert.equal(views.postedList[0].household, winner.household);
  assert.equal(views.invoicingSignals[0].payer, winner.household);
  const released = await request(`/api/bookings/${winner.id}`, 'DELETE', { household: winner.household });
  assert.equal(released.status, 200);
  const after = await request('/api/schedule');
  assert.equal(after.slots.find((value) => value.resource === 'ph8'
    && value.weekday === 'Tuesday' && value.start === '17:00')?.state
    ?? after.slots.find((value) => value.resource === 'ph8'
      && value.weekday === 'Tuesday' && value.start === '17:00')?.status, 'free');
}

try {
  if (treeDigest('/candidate', 'impl') !== config.candidate_sha256)
    throw Error('Mounted candidate differs from the bound source digest');
  server = spawn(process.execPath, ['/candidate/server.mjs', '8901'], {
    cwd: '/candidate', env: { ...process.env, LOYLY_DATA: record }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  await step('Start fresh candidate in the Gondolin VM', async () => {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw Error(`candidate exited: ${stderr}`);
      try { if ((await request(modern ? '/api/state' : '/health')).status === 200) return; } catch { /* wait */ }
      await delay(100);
    }
    throw Error(`candidate did not start: ${stderr}`);
  });
  await step('Run 100 overlapping two-household races with a fresh slot each time', async () => {
    for (let i = 0; i < 100; i++) await oneRace(i);
  });
  await step('Check the durable record and derived views after release', async () => {
    const stored = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(stored.bookings.length, 0);
    const views = await request('/api/views');
    for (const name of ['postedList', 'heaterSchedule', 'invoicingSignals'])
      assert.equal(views[name].length, 0);
  });
} catch (error) { failure = error.stack ?? String(error); }
finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((done) => server.once('exit', done)), delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
const attachment = `${randomUUID()}-attachment.json`;
await writeFile(join(out, attachment), JSON.stringify({ candidate_sha256: config.candidate_sha256,
  runs: cases, total: cases.length, failure }, null, 2));
const result = { uuid, name: 'One hundred overlapping races leave one holder',
  fullName: 'loyly.booking-core.01-010.protocol-panel',
  historyId: 'loyly.booking-core.01-010.protocol-panel',
  testCaseId: 'loyly.booking-core.01-010.protocol-panel',
  status: failure ? 'failed' : 'passed', stage: 'finished', start, stop: Date.now(),
  statusDetails: { message: failure ?? '100/100 overlapping races confirmed one household, refused the other, and preserved all derived views.' },
  labels: [{ name: 'lifecycle', value: 'pre-production' }, { name: 'technique', value: 'acceptance' },
    { name: 'tool', value: 'Node.js' }, { name: 'feature', value: 'Booking core' },
    { name: 'story', value: 'Two households requesting one free slot leave exactly one holder' },
    { name: 'tag', value: '@item-01-010' }],
  parameters: [{ name: 'candidate_sha256', value: config.candidate_sha256 }],
  steps, attachments: [{ name: 'Hundred race observations', source: attachment, type: 'application/json' }],
};
await writeFile(join(out, `${uuid}-result.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, races: cases.length, uuid }));
if (failure) process.exitCode = 1;
