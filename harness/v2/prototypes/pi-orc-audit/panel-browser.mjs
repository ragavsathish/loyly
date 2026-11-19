import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const root = '/out';
const candidate = '/candidate';
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const artifacts = join(root, 'artifacts');
const allure = root;
await mkdir(artifacts, { recursive: true });
await mkdir(allure, { recursive: true });
const hash = createHash('sha256');
for (const file of ['server.mjs', 'web.mjs', 'model.mjs', 'style.css', 'contract.json']) {
  hash.update(file);
  hash.update(await readFile(join(candidate, file)));
}
const sourceFilesSha256 = hash.digest('hex');
const expectedSourceFilesSha256 = config.source_files_sha256;
const candidateSha256 = config.candidate_sha256;
const uuid = randomUUID();
const now = () => Date.now();
const result = {
  uuid,
  name: 'Browser booking journey: standing slot appears in all three views',
  fullName: 'Löyly Pi supplemental browser probe / item-01-003',
  status: 'broken',
  statusDetails: { message: 'Probe did not complete.' },
  stage: 'running',
  start: now(),
  labels: [
    { name: 'lifecycle', value: 'pre-production' },
    { name: 'technique', value: 'ui-ux' },
    { name: 'tool', value: 'Playwright' },
    { name: 'feature', value: 'Booking core' },
    { name: 'story', value: 'Browser booking journey' },
    { name: 'tag', value: '@item-01-003' },
  ],
  parameters: [{ name: 'candidate_sha256', value: candidateSha256 }],
  steps: [],
  attachments: [],
};
const addAttachment = async (file, name, type) => {
  const extension = file.split('.').at(-1);
  const source = `${randomUUID()}-attachment.${extension}`;
  await copyFile(join(artifacts, file), join(allure, source));
  result.attachments.push({ name, source, type });
};
async function step(name, fn) {
  const s = { name, status: 'broken', stage: 'running', start: now(), steps: [], attachments: [] };
  result.steps.push(s);
  try {
    const value = await fn();
    s.status = 'passed';
    return value;
  } catch (error) {
    s.status = 'failed';
    s.statusDetails = { message: error.message };
    throw error;
  } finally {
    s.stage = 'finished';
    s.stop = now();
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let server, browser, context, page, traceStarted = false;
const observations = { candidateSha256, sourceFilesSha256, browser: 'Chromium via Playwright core', isolation: 'Gondolin QEMU VM; candidate and worker mounted read-only; isolated record under /out', checks: {} };
try {
  await step('Verify read-only mounted candidate source files', async () => {
    assert(sourceFilesSha256 === expectedSourceFilesSha256, `Candidate source digest mismatch: ${sourceFilesSha256}`);
    observations.sourceIntegrityVerified = true;
  });
  const port = 33000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: candidate,
    env: { ...process.env, LOYLY_DATA: join(artifacts, 'record.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', x => { serverOutput += x; });
  server.stderr.on('data', x => { serverOutput += x; });
  await step('Launch fresh candidate server with isolated record', async () => {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${serverOutput}`);
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok) return;
      } catch { /* waiting for listener */ }
      await delay(100);
    }
    throw new Error(`Server did not listen: ${serverOutput}`);
  });
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  observations.browserConnected = browser.isConnected();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  traceStarted = true;
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await step('Open the schedule and inspect free Tuesday room 8 slot', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    assert((await page.title()).includes('Löyly'), 'Unexpected page title');
    const free = page.getByRole('link', { name: 'Request Tuesday 17:00 in Pukuhuone 8' });
    assert(await free.count() === 1, 'Expected one free room 8 Tuesday 17:00 slot');
    observations.checks.initialFreeSlot = true;
    await page.screenshot({ path: join(artifacts, 'before.png'), fullPage: true });
  });
  await step('Submit the native booking form as apartment 12', async () => {
    await page.getByRole('link', { name: 'Request Tuesday 17:00 in Pukuhuone 8' }).click();
    assert(await page.locator('#resource').inputValue() === 'ph8', 'Room selection failed');
    assert(await page.locator('#weekday').inputValue() === 'Tuesday', 'Weekday selection failed');
    assert(await page.locator('#start').inputValue() === '17:00', 'Start selection failed');
    const navigation = page.waitForNavigation();
    await page.getByRole('button', { name: /Request standing slot/ }).click();
    const response = await navigation;
    assert(response?.status() === 200, `Booking form status ${response?.status()}`);
    assert(await page.getByRole('status').getByText('All set').count() === 1, 'Confirmation notice missing');
    observations.checks.formConfirmation = true;
  });
  await step('Inspect holding, schedule, posted list, heater and billing views', async () => {
    const holdings = page.locator('#holdings .holding-card');
    assert(await holdings.count() === 1, 'Expected one standing holding card');
    assert((await holdings.innerText()).includes('Tuesday'), 'Holding weekday missing');
    assert((await holdings.innerText()).includes('17:00'), 'Holding time missing');
    const schedule = await page.request.get(`${base}/api/schedule`).then(r => r.json());
    const slot = schedule.slots.find(s => s.resource === 'ph8' && s.weekday === 'Tuesday' && s.start === '17:00');
    assert(slot?.state === 'held' && slot.household === '12', `Schedule mismatch: ${JSON.stringify(slot)}`);
    const views = await page.request.get(`${base}/api/views`).then(r => r.json());
    assert(views.postedList.length === 1 && views.heaterSchedule.length === 1 && views.invoicingSignals.length === 1, `Derived view counts: ${JSON.stringify(views)}`);
    assert(views.postedList[0].household === '12', 'Posted list household mismatch');
    assert(views.invoicingSignals[0].payer === '12', 'Billing payer mismatch');
    const operations = page.locator('#operations');
    await operations.locator('details').nth(1).locator('summary').click();
    await operations.locator('details').nth(2).locator('summary').click();
    assert((await operations.innerText()).includes('Apartment 12'), 'Posted or billing view does not name apartment 12');
    assert((await operations.innerText()).includes('17:00–18:30'), 'Heater window missing from expanded UI');
    observations.checks.scheduleSlot = slot;
    observations.checks.derivedViewCounts = Object.fromEntries(Object.entries(views).map(([k,v]) => [k,v.length]));
    observations.checks.expandedDerivedViewsVisible = true;
    observations.checks.pageErrors = pageErrors;
    assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join('; ')}`);
    await page.screenshot({ path: join(artifacts, 'after.png'), fullPage: true });
  });
  result.status = 'passed';
  result.statusDetails.message = 'Fresh copied candidate passed the browser booking journey: free slot, native form confirmation, persisted holding, and all three derived views.';
} catch (error) {
  result.status = 'failed';
  result.statusDetails.message = error.stack ?? String(error);
  observations.error = error.stack ?? String(error);
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (traceStarted) {
    await context.tracing.stop({ path: join(artifacts, 'trace.zip') }).catch(e => { observations.traceError = e.message; });
  }
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  for (const [file, name, type] of [
    ['before.png', 'Before booking screenshot', 'image/png'],
    ['after.png', 'After booking screenshot', 'image/png'],
    ['failure.png', 'Failure screenshot', 'image/png'],
    ['trace.zip', 'Playwright trace', 'application/vnd.allure.playwright-trace'],
  ]) {
    try { await addAttachment(file, name, type); } catch { /* attachment was not produced */ }
  }
  result.stage = 'finished';
  result.stop = now();
  await writeFile(join(artifacts, 'observations.json'), JSON.stringify(observations, null, 2));
  await writeFile(join(allure, `${uuid}-result.json`), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ status: result.status, message: result.statusDetails.message, uuid, observations }, null, 2) + '\n');
  if (result.status !== 'passed') process.exitCode = 1;
}
