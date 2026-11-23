// TypeScript port of harness/gen_checklist.clj for direct Node invocation.
// Output matches the Babashka tool's 1-space JSON so approved digests stay valid.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const SCENARIO_LINE = /^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/;
const RULE_LINE = /^\s*Rule:\s*(.*?)\s*$/;
const ITEM_TAG = /@item-(\d+-\d+)/g;
const SKIPPED = new Set(['planned', 'backlog']);

export interface ChecklistItem {
  id: string;
  name: string;
  rule: string | null;
  source: string;
}

export interface ChecklistDocument {
  items: ChecklistItem[];
  counts: { total: number };
}

export class MeasureRefuse extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasureRefuse';
  }
}

function sliceStatus(dir: string): string | undefined {
  const plan = join(dir, 'plan.md');
  if (!existsSync(plan)) return undefined;
  const match = /^status:\s*(\S+)/m.exec(readFileSync(plan, 'utf8'));
  return match?.[1];
}

function relPosix(root: string, file: string): string {
  return relative(root, file).split(/[/\\]/).join('/');
}

function specFiles(root: string): string[] {
  const planRoot = join(root, 'docs', 'plan');
  if (!existsSync(planRoot)) return [];
  return readdirSync(planRoot)
    .filter((name) => /^[0-9]/.test(name))
    .map((name) => join(planRoot, name, 'spec.feature'))
    .filter((path) => existsSync(path))
    .sort((a, b) => relPosix(root, a).localeCompare(relPosix(root, b)));
}

function scan(root: string, file: string): { items: ChecklistItem[]; errors: string[] } {
  const path = relPosix(root, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  let rule: string | null = null;
  let pending: string | null = null;
  const items: ChecklistItem[] = [];
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    const stripped = line.trim();
    if (stripped.startsWith('@')) {
      const tags = [...line.matchAll(ITEM_TAG)].map((m) => m[1]!);
      if (tags.length) pending = tags[tags.length - 1]!;
      continue;
    }
    const ruleMatch = RULE_LINE.exec(line);
    if (ruleMatch) {
      rule = ruleMatch[1]!;
      continue;
    }
    const scenarioMatch = SCENARIO_LINE.exec(line);
    if (scenarioMatch) {
      const name = scenarioMatch[1]!;
      if (pending) {
        items.push({ id: pending, name, rule, source: `${path}:${n}` });
        pending = null;
      } else {
        errors.push(`  ${path}:${n}: UNSTAMPED: ${name}`);
      }
    }
  }
  return { items, errors };
}

export interface GenChecklistResult {
  checklist: ChecklistDocument;
  text: string;
  stderr: string;
}

/** Derive the scoring checklist from stamped specs under `root`. */
export function genChecklist({
  root,
  out,
}: {
  root: string;
  out?: string;
}): GenChecklistResult {
  const stderrParts: string[] = [];
  const files = specFiles(root).filter((file) => {
    const dir = dirname(file);
    const status = sliceStatus(dir);
    if (status && SKIPPED.has(status)) {
      stderrParts.push(
        `gen_checklist: skipping ${dir.split(/[/\\]/).pop()} (status: ${status})\n`,
      );
      return false;
    }
    return true;
  });
  if (!files.length) {
    throw new MeasureRefuse(
      `gen_checklist: no NN-slug/spec.feature under ${join(root, 'docs', 'plan')}. An empty checklist lets a scoring run report a flawless cycle in which nothing was ever checked, so none is written.`,
    );
  }
  const items: ChecklistItem[] = [];
  for (const file of files) {
    const scanned = scan(root, file);
    if (scanned.errors.length) {
      throw new MeasureRefuse(
        `gen_checklist: some scenarios carry no item id. A checklist built now would quietly score fewer items than the spec contains, so stamp them first with harness/stamp_item_ids.clj:\n${scanned.errors.join('\n')}`,
      );
    }
    items.push(...scanned.items);
  }
  const checklist: ChecklistDocument = {
    items,
    counts: { total: items.length },
  };
  const text = `${JSON.stringify(checklist, null, 1)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
  stderrParts.push(`checklist: {'total': ${items.length}}\n`);
  return { checklist, text, stderr: stderrParts.join('') };
}
