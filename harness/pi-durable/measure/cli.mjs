#!/usr/bin/env node
// Easy Node entry for the TypeScript ports of gen_checklist / score / scoreboard.
import { resolve } from 'node:path';
import { genChecklist, MeasureRefuse, scoreCycle, scoreboard } from './index.ts';

function usage() {
  return `usage:
  node harness/pi-durable/measure/cli.mjs gen-checklist --root <repo> [--out <file>]
  node harness/pi-durable/measure/cli.mjs score --root <repo> <cycle> --verdicts <file>
  node harness/pi-durable/measure/cli.mjs scoreboard --root <repo> <cycle>`;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(usage());
    process.exit(cmd ? 0 : 2);
  }
  const root = resolve(flag(rest, '--root') ?? process.cwd());
  if (cmd === 'gen-checklist' || cmd === 'gen_checklist') {
    const out = flag(rest, '--out');
    const result = genChecklist({ root, out: out ? resolve(out) : undefined });
    if (!out) process.stdout.write(result.text);
    process.stderr.write(result.stderr);
    process.exit(0);
  }
  if (cmd === 'score') {
    const verdicts = flag(rest, '--verdicts');
    if (!verdicts) throw new MeasureRefuse('score: --verdicts <file> is required');
    const cycle = rest.find((arg, i) => {
      const prev = rest[i - 1];
      return arg !== '--root' && prev !== '--root' && arg !== '--verdicts' && prev !== '--verdicts';
    });
    const result = scoreCycle({ root, cycle, verdictsPath: resolve(verdicts) });
    process.stdout.write(result.stdout);
    process.exit(0);
  }
  if (cmd === 'scoreboard') {
    const cycle = rest.find((arg, i) => arg !== '--root' && rest[i - 1] !== '--root');
    const result = scoreboard({ root, cycle });
    process.stdout.write(result.text);
    process.exit(0);
  }
  console.error(usage());
  process.exit(2);
} catch (error) {
  const msg = error instanceof MeasureRefuse || error instanceof Error
    ? error.message
    : String(error);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}
