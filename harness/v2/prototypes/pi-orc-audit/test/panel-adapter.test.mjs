import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectPanelAttempt } from '../panel-adapter.mjs';

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const verify = (out) => {
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  if (manifest.candidate !== 'frozen') throw Error('candidate changed');
  return { out, manifest };
};
const launch = async (out) => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ candidate: 'frozen' }));
  return verify(out);
};

test('a completed panel reopens without another VM launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loyly-panel-adapter-'));
  try {
    let launches = 0;
    const first = await selectPanelAttempt({ root, verify, launch: async (out) => {
      launches++; return launch(out);
    } });
    assert.equal(first.attempt, 1);
    assert.equal(first.reconciled, false);
    const reopened = await selectPanelAttempt({ root, verify, launch: async () => {
      throw Error('duplicate launch');
    } });
    assert.equal(reopened.reconciled, true);
    assert.equal(launches, 1);
    assert.equal(sha(join(root, 'attempt-01', 'manifest.json')),
      JSON.parse(readFileSync(join(root, 'selected.json'))).manifest_sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a partial first attempt is preserved and one fresh attempt is selected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loyly-panel-interrupted-'));
  try {
    mkdirSync(join(root, 'attempt-01'));
    writeFileSync(join(root, 'attempt-01', 'partial.txt'), 'interrupted');
    const result = await selectPanelAttempt({ root, verify, launch });
    assert.equal(result.attempt, 2);
    assert.equal(existsSync(join(root, 'attempt-01', 'partial.txt')), true);
    assert.equal(existsSync(join(root, 'attempt-02', 'manifest.json')), true);
    writeFileSync(join(root, 'attempt-02', 'manifest.json'), '{}');
    await assert.rejects(() => selectPanelAttempt({ root, verify, launch }),
      /candidate changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
