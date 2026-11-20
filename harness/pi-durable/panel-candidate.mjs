// The specialist sees the frozen source read-only. It runs a private copy
// through the same public start.sh seam used by the legacy gate and grader.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function launchCandidate({ candidate, out, port, env = {}, nodeOptions }) {
  const runtime = join(out, 'runtime');
  if (existsSync(runtime)) throw new Error('specialist runtime already exists');
  mkdirSync(runtime, { recursive: true });
  cpSync(candidate, runtime, { recursive: true, force: false });
  const start = join(runtime, 'start.sh');
  if (!existsSync(start)) throw new Error('candidate has no start.sh');
  return spawn(start, [String(port)], { cwd: runtime,
    env: { ...process.env, ...env, ...(nodeOptions ? {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, nodeOptions].filter(Boolean).join(' '),
    } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function readDerivedViews(base, fetcher = fetch) {
  const normalize = (body) => {
    const invoicingSignals = body.invoicingSignals ?? body.billingSignals;
    if (!Array.isArray(body.postedList) || !Array.isArray(body.heaterSchedule)
        || !Array.isArray(invoicingSignals))
      throw new Error('derived views have an unexpected shape');
    return { postedList: body.postedList, heaterSchedule: body.heaterSchedule,
      invoicingSignals };
  };
  const combined = await fetcher(`${base}/api/views`);
  if (combined.ok) {
    return normalize(await combined.json());
  }
  if (combined.status !== 404) throw new Error(`derived views HTTP ${combined.status}`);
  const routes = [
    ['postedList', '/api/posted-list'],
    ['heaterSchedule', '/api/heater-schedule'],
    ['invoicingSignals', '/api/invoicing-signals'],
  ];
  const pairs = await Promise.all(routes.map(async ([key, path]) => {
    let response = await fetcher(`${base}${path}`);
    if (key === 'invoicingSignals' && response.status === 404)
      response = await fetcher(`${base}/api/billing-signals`);
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    const body = await response.json();
    const entries = body.entries ?? body[key] ?? (key === 'invoicingSignals' ? body.billingSignals : undefined);
    if (!Array.isArray(entries)) throw new Error(`${path} has no entries`);
    return [key, entries];
  }));
  return Object.fromEntries(pairs);
}
