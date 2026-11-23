// TypeScript port of harness/scoreboard.clj for direct Node invocation.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeasureRefuse } from './gen-checklist.ts';

function ralign(s: string, w: number): string {
  return s.padStart(w, ' ');
}

/** One decimal, ties rounded to EVEN (HALF_EVEN), matching @harness-046. */
export function pct(n: number, d: number): string {
  // Match Clojure BigDecimal HALF_EVEN on (* 100.0 n / d).
  const value = (100 * n) / d;
  const scaled = Math.round(value * 10);
  // Manual half-even for .x5 cases: Math.round is half-away-from-zero for positives.
  const floored = Math.floor(value * 10);
  const frac = value * 10 - floored;
  let rounded: number;
  if (Math.abs(frac - 0.5) < 1e-12) {
    rounded = floored % 2 === 0 ? floored : floored + 1;
  } else {
    rounded = scaled;
  }
  return (rounded / 10).toFixed(1);
}

function rate(n: number, d: number): string {
  return (
    ralign(`${n}/${d}`, 7) +
    (d === 0 ? ' =   n/a' : ` = ${ralign(pct(n, d), 5)}%`)
  );
}

function verdictsOf(path: string): Map<string, string> | null {
  if (!existsSync(path)) return null;
  const items = (
    JSON.parse(readFileSync(path, 'utf8')) as {
      items: { id: string; verdict: string }[];
    }
  ).items;
  const map = new Map<string, string>();
  for (const item of items) map.set(item.id, item.verdict);
  return map;
}

export interface ScoreboardResult {
  text: string;
}

/** Report the cycle pass rate and shared-item comparison with the previous cycle. */
export function scoreboard({
  root,
  cycle,
}: {
  root: string;
  cycle: string;
}): ScoreboardResult {
  if (!cycle) throw new MeasureRefuse('scoreboard: usage: scoreboard <cycle>');
  const scoresRel = `harness/cycles/${cycle}/scores.json`;
  const thisMap = verdictsOf(join(root, scoresRel));
  if (!thisMap || thisMap.size === 0) {
    throw new MeasureRefuse(`scoreboard: nothing recorded at ${scoresRel}`);
  }
  const total = thisMap.size;
  const passes = [...thisMap.values()].filter((v) => v === 'pass').length;
  const lines = [`cycle ${cycle}: ${passes}/${total} checklist items pass`, ''];
  const prevCycle = /^\d+$/.test(cycle)
    ? String(Number(cycle) - 1).padStart(cycle.length, '0')
    : null;
  const prev = prevCycle
    ? verdictsOf(join(root, `harness/cycles/${prevCycle}/scores.json`))
    : null;
  if (!prev) {
    lines.push('  no previous cycle to diff against: baseline cycle.');
  } else {
    const thisKeys = [...thisMap.keys()];
    const prevKeys = new Set(prev.keys());
    const thisKeySet = new Set(thisKeys);
    const shared = thisKeys.filter((id) => prevKeys.has(id));
    const added = thisKeys.filter((id) => !prevKeys.has(id));
    const dropped = [...prev.keys()].filter((id) => !thisKeySet.has(id));
    const sharedN = shared.length;
    const prevPass = shared.filter((id) => prev.get(id) === 'pass').length;
    const thisPass = shared.filter((id) => thisMap.get(id) === 'pass').length;
    const better = shared.filter(
      (id) => prev.get(id) === 'fail' && thisMap.get(id) === 'pass',
    ).length;
    const worse = shared.filter(
      (id) => prev.get(id) === 'pass' && thisMap.get(id) === 'fail',
    ).length;
    lines.push(
      `  against cycle ${prevCycle}, counting only the ${sharedN} items both cycles carried:`,
      `    cycle ${prevCycle}  ${rate(prevPass, sharedN)}`,
      `    cycle ${cycle}  ${rate(thisPass, sharedN)}   <- these two are the fair comparison`,
      `    now passing   ${ralign(String(better), 3)}   <- repaired since then`,
      `    now failing   ${ralign(String(worse), 3)}   <- broken since then`,
    );
    if (added.length || dropped.length) {
      lines.push(
        '',
        `  THE ITEM SET MOVED: ${prev.size} items -> ${total} (${added.length} added, ${dropped.length} dropped), so the two headline`,
        '  rates count different things and must not be read against each other.',
        "  The added items cover work last cycle's spec never asked for.",
      );
    }
  }
  lines.push('');
  return { text: `${lines.join('\n')}` };
}
