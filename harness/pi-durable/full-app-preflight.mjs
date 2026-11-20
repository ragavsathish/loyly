// Inventory the complete spec-v2 product cut before adapting the Pi cycle.
// The checklist is derived by the source repository's legacy parser, never
// reconstructed from a second interpretation of Gherkin here.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

export function inspectFullApp(source) {
  const repo = resolve(source);
  const commit = git(repo, 'rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw Error('source has no full commit ID');
  const selected = ['.pi/plan', '.pi/spec', 'harness/gen_checklist.clj',
    'harness/hjson.clj', 'harness/config.sh'];
  if (git(repo, 'status', '--porcelain', '--', ...selected))
    throw Error('selected spec or checklist instrument has uncommitted changes');
  const planRoot = join(repo, '.pi', 'plan');
  const names = readdirSync(planRoot).filter((name) => /^\d\d-[a-z][a-z-]*$/.test(name)).sort();
  if (names.length !== 6 || names.some((name, index) => name.slice(0, 2) !== String(index + 1).padStart(2, '0')))
    throw Error('full app requires exactly the six numbered context links');

  const temp = mkdtempSync(join(tmpdir(), 'loyly-full-app-preflight-'));
  try {
    const checklistFile = join(temp, 'checklist.json');
    const result = spawnSync('bb', ['harness/gen_checklist.clj', '--out', checklistFile],
      { cwd: repo, env: { ...process.env, SLICE: '06' }, encoding: 'utf8' });
    if (result.status !== 0) throw Error(`legacy checklist failed: ${result.stderr.trim()}`);
    const bytes = readFileSync(checklistFile);
    const checklist = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(checklist.items) || !checklist.items.length
        || checklist.counts?.total !== checklist.items.length)
      throw Error('legacy checklist is empty or has an inconsistent count');
    const contexts = names.map((name) => {
      const link = join(planRoot, name);
      const target = readlinkSync(link);
      if (target !== `../spec/${name.slice(3)}`)
        throw Error(`unexpected context link: ${name} -> ${target}`);
      const specFile = join(repo, '.pi', 'spec', name.slice(3), 'spec.feature');
      if (!existsSync(specFile)) throw Error(`missing context spec: ${name}`);
      const prefix = name.slice(0, 2);
      const items = checklist.items.filter((item) => item.id?.startsWith(`${prefix}-`));
      if (!items.length || items.some((item) => !item.source?.startsWith(`.pi/plan/${name}/spec.feature:`)))
        throw Error(`checklist does not cover the ${name} spec`);
      return { slice: prefix, context: basename(name), items: items.length,
        first_item: items[0].id, last_item: items.at(-1).id,
        spec_sha256: sha(readFileSync(specFile)) };
    });
    if (contexts.reduce((sum, row) => sum + row.items, 0) !== checklist.items.length
        || new Set(checklist.items.map((item) => item.id)).size !== checklist.items.length)
      throw Error('context inventory does not uniquely cover the checklist');
    return { schema: 'loyly.pi-full-app-preflight.v1', source_commit: commit,
      checklist_sha256: sha(bytes), ordered_item_ids_sha256: sha(`${checklist.items.map((item) => item.id).join('\n')}\n`),
      item_count: checklist.items.length, contexts };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('usage: node full-app-preflight.mjs <spec-v2-checkout>');
  process.stdout.write(`${JSON.stringify(inspectFullApp(process.argv[2]), null, 2)}\n`);
}
