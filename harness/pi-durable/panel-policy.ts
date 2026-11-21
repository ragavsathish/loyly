// The filed legacy score remains the authority. The panel adds independent
// observations and flags disagreement; it cannot retroactively change a score.
import type {
  PanelCheckResult,
  PanelEvaluation,
  PanelObservation,
  PanelPlan,
  ScoredItem,
} from './contracts.ts';

export function evaluatePanel(
  plan: PanelPlan,
  scoredItems: ScoredItem[],
  observations: PanelObservation[],
): PanelEvaluation {
  if (!Array.isArray(plan.checks) || !Array.isArray(scoredItems) || !scoredItems.length)
    throw new Error('panel needs a plan and scored items');
  const itemIds = new Set(scoredItems.map((item) => item.id));
  if (itemIds.size !== scoredItems.length) throw new Error('duplicate scored item');
  const checkIds = new Set();
  const expected = new Map<string, PanelPlan['checks'][number]>();
  for (const check of plan.checks) {
    if (checkIds.has(check.id)) throw new Error(`duplicate panel check ${check.id}`);
    checkIds.add(check.id);
    for (const item of check.items) {
      if (!itemIds.has(item)) throw new Error(`${check.id} names an unscored item ${item}`);
      const key = `${check.id}/${item}`;
      if (expected.has(key)) throw new Error(`duplicate panel assignment ${key}`);
      expected.set(key, check);
    }
  }
  const observed = new Map<string, PanelCheckResult>();
  for (const row of observations) {
    const key = `${row.id}/${row.item}`;
    if (!expected.has(key) || observed.has(key))
      throw new Error(`extra or duplicate panel result ${key}`);
    const check = expected.get(key);
    if (!check) throw new Error(`panel check missing for ${key}`);
    if (row.tool !== check.tool || row.technique !== check.technique)
      throw new Error(`${key} tool or technique differs from panel plan`);
    if (!row.message || !/^[0-9a-f]{64}$/.test(row.result_sha256))
      throw new Error(`${key} has no bound observation`);
    if (check.role === 'handoff' && row.status !== 'skipped')
      throw new Error(`${key} must leave the independent review pending`);
    if (check.role === 'scored' && !['passed', 'failed'].includes(row.status))
      throw new Error(`${key} cannot decide a score with ${row.status}`);
    observed.set(key, {
      id: check.id,
      item: row.item,
      role: check.role,
      tool: check.tool,
      technique: check.technique,
      status: row.status,
      runtime: row.runtime,
      target_runtime: check.target_runtime,
      result_sha256: row.result_sha256,
      criterion: check.criterion,
      failure: check.failure,
      message: row.message,
    });
  }
  const checks: PanelCheckResult[] = [];
  for (const key of expected.keys()) {
    const result = observed.get(key);
    if (!result) throw new Error(`missing panel result ${key}`);
    checks.push(result);
  }
  const gaps: string[] = [];
  const items: PanelEvaluation['items'] = scoredItems.map((item) => {
    const selected = checks.filter((check) => check.item === item.id);
    const decisive = selected.filter((check) => check.role === 'scored');
    if (decisive.length !== 1 || !decisive[0])
      throw new Error(`${item.id} needs exactly one scored panel check`);
    const expectedVerdict = decisive[0].status === 'passed' ? 'pass' : 'fail';
    if (item.verdict !== expectedVerdict)
      throw new Error(`${item.id} panel result disagrees with the filed score`);
    const contradiction = selected.some(
      (check) => check.role === 'corroborating' && check.status !== 'passed',
    );
    return {
      id: item.id,
      rule: item.rule,
      filed_verdict: item.verdict,
      check_ids: selected.map((check) => check.id),
      panel_status: contradiction ? 'conflicted' : item.verdict === 'pass' ? 'supported' : 'failed',
    };
  });
  for (const check of checks) {
    if (check.runtime !== check.target_runtime)
      gaps.push(
        `${check.id}/${check.item}: observed ${check.runtime}; target ${check.target_runtime}`,
      );
    if (check.role === 'diagnostic' && check.status !== 'passed')
      gaps.push(`${check.id}/${check.item}: diagnostic ${check.status}`);
  }
  for (const item of items.filter((value) => value.panel_status !== 'supported'))
    gaps.push(`${item.id}: filed ${item.filed_verdict}; panel ${item.panel_status}`);
  return { checks, items, gaps, panel_outcome: gaps.length ? 'not-ready' : 'ready-for-review' };
}
