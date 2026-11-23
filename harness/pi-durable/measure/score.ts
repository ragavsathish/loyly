// TypeScript port of harness/score.clj for direct Node invocation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeasureRefuse } from './gen-checklist.ts';

const UNREACHED = 'not scored: the grader never reached this item';

export interface ScoreResult {
  cycle: string;
  passes: number;
  total: number;
  unreached: number;
  scoresPath: string;
  stdout: string;
}

function typeName(v: unknown): string {
  if (v === null) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'number') return 'int';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'dict';
  return 'list';
}

/** File one cycle's verdicts against that cycle's checklist under `root`. */
export function scoreCycle({
  root,
  cycle,
  verdictsPath,
}: {
  root: string;
  cycle: string;
  verdictsPath: string;
}): ScoreResult {
  if (!cycle) throw new MeasureRefuse('score: usage: score <cycle> --verdicts <file>');
  if (!verdictsPath) throw new MeasureRefuse('score: --verdicts <file> is required');
  const checklistRel = `harness/cycles/${cycle}/checklist.json`;
  const checklistFile = join(root, checklistRel);
  const scoresRel = `harness/cycles/${cycle}/scores.json`;
  if (!existsSync(checklistFile)) {
    throw new MeasureRefuse(
      `score: no ${checklistRel}: generate it first:\n  node harness/pi-durable/measure/cli.mjs gen-checklist --root <repo> --out ${checklistRel}`,
    );
  }
  const items = (
    JSON.parse(readFileSync(checklistFile, 'utf8')) as {
      items: Record<string, unknown>[];
    }
  ).items;
  if (!existsSync(verdictsPath)) {
    throw new MeasureRefuse(
      `score: no verdicts at ${verdictsPath}. A measurement that is not there is not a measurement: nothing was written.`,
    );
  }
  const raw = readFileSync(verdictsPath, 'utf8');
  if (!raw.trim()) {
    throw new MeasureRefuse(
      'score: 0 items scored. A run that graded nothing tells you the grading did not happen, not that every item failed. Nothing recorded.',
    );
  }
  let verdicts: unknown;
  try {
    verdicts = JSON.parse(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MeasureRefuse(
      `score: ${verdictsPath} is not valid JSON (${detail}). A measurement that cannot be read is not a measurement: nothing was written.`,
    );
  }
  if (!Array.isArray(verdicts)) {
    throw new MeasureRefuse(
      `score: ${verdictsPath} should hold a list of verdicts, found ${typeName(verdicts)}. Nothing was written.`,
    );
  }
  if (!verdicts.length) {
    throw new MeasureRefuse(
      'score: 0 items scored. A run that graded nothing tells you the grading did not happen, not that every item failed. Nothing recorded.',
    );
  }
  const known = new Set(items.map((item) => String(item.id)));
  const unknown = verdicts
    .map((v) => (v as { id?: string }).id)
    .filter((id): id is string => typeof id === 'string' && !known.has(id));
  if (unknown.length) {
    throw new MeasureRefuse(
      `score: verdicts for items not on the checklist (the spec is the only author of the item list): ${unknown.join(', ')}`,
    );
  }
  const bad = verdicts
    .filter((v) => !['pass', 'fail'].includes(String((v as { verdict?: string }).verdict)))
    .map((v) => String((v as { id?: string }).id));
  if (bad.length) {
    throw new MeasureRefuse(`score: verdict must be 'pass' or 'fail' for: ${bad.join(', ')}`);
  }
  const byId = new Map<string, { verdict: string; evidence?: string }>();
  for (const v of verdicts as { id: string; verdict: string; evidence?: string }[]) {
    byId.set(v.id, v);
  }
  const scored = items.map((item) => {
    const id = String(item.id);
    const v = byId.get(id);
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) row[key] = value;
    row.verdict = v ? v.verdict : 'fail';
    row.evidence = v ? (v.evidence ?? '') : UNREACHED;
    return row;
  });
  const passes = scored.filter((item) => item.verdict === 'pass').length;
  const unreached = items.length - [...items].filter((item) => byId.has(String(item.id))).length;
  const scoresPath = join(root, scoresRel);
  mkdirSync(dirname(scoresPath), { recursive: true });
  writeFileSync(scoresPath, `${JSON.stringify({ items: scored }, null, 1)}\n`);
  const stdout =
    `scored cycle ${cycle}: ${passes}/${items.length} pass` +
    (unreached > 0 ? ` (${unreached} unreached, recorded as fail)` : '') +
    `\nfiled: ${scoresRel}\n`;
  return { cycle, passes, total: items.length, unreached, scoresPath, stdout };
}
