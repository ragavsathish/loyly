import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { genChecklist, pct, scoreCycle, scoreboard } from '../measure/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('genChecklist matches bb harness/gen_checklist.clj byte for byte', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'loyly-measure-'));
  try {
    const tsOut = join(scratch, 'ts.json');
    const bbOut = join(scratch, 'bb.json');
    const ts = genChecklist({ root, out: tsOut });
    const bb = spawnSync('bb', ['harness/gen_checklist.clj', '--out', bbOut], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(bb.status, 0, bb.stderr);
    assert.equal(readFileSync(tsOut, 'utf8'), readFileSync(bbOut, 'utf8'));
    assert.equal(ts.stderr, bb.stderr);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('scoreCycle matches bb harness/score.clj byte for byte', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'loyly-score-'));
  try {
    mkdirSync(join(scratch, 'harness', 'cycles', '02'), { recursive: true });
    cpSync(join(root, 'docs/plan'), join(scratch, 'docs/plan'), { recursive: true });
    for (const name of ['score.clj', 'hjson.clj', 'gen_checklist.clj']) {
      cpSync(join(root, 'harness', name), join(scratch, 'harness', name));
    }
    const checklist = join(scratch, 'harness/cycles/02/checklist.json');
    genChecklist({ root: scratch, out: checklist });
    const verdicts = join(scratch, 'verdicts.json');
    writeFileSync(
      verdicts,
      JSON.stringify(
        JSON.parse(readFileSync(checklist, 'utf8')).items.map((item) => ({
          id: item.id,
          verdict: 'pass',
          evidence: 'ok',
        })),
      ),
    );
    scoreCycle({ root: scratch, cycle: '02', verdictsPath: verdicts });
    const tsScores = readFileSync(join(scratch, 'harness/cycles/02/scores.json'));
    rmSync(join(scratch, 'harness/cycles/02/scores.json'));
    const bb = spawnSync('bb', ['harness/score.clj', '02', '--verdicts', verdicts], {
      cwd: scratch,
      encoding: 'utf8',
    });
    assert.equal(bb.status, 0, bb.stderr);
    assert.equal(
      tsScores.toString('utf8'),
      readFileSync(join(scratch, 'harness/cycles/02/scores.json'), 'utf8'),
    );
    const board = scoreboard({ root: scratch, cycle: '02' });
    assert.match(board.text, /cycle 02: \d+\/\d+ checklist items pass/);
    assert.equal(pct(1, 16), '6.2');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
