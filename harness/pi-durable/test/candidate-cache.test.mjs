import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCycleEffects } from '../cycle-effects.ts';

test('builder cleanup removes package caches before the candidate is copied', () => {
  const root = mkdtempSync(join(tmpdir(), 'loyly-candidate-cache-'));
  try {
    const room = join(root, 'room');
    const impl = join(room, 'impl');
    mkdirSync(impl, { recursive: true });
    for (const name of ['.npm-cache', '.m2', '.cache', '.uv-cache', 'node_modules']) {
      mkdirSync(join(impl, name));
      writeFileSync(join(impl, name, 'package'), 'cached bytes');
    }
    writeFileSync(join(impl, 'start.sh'), '#!/bin/sh\n');
    const effects = createCycleEffects({
      root,
      scratch: root,
      room,
      cut: root,
      sourceRoot: root,
      approvedSourceRepo: root,
      digestCandidate: () => 'candidate',
    });
    effects.clearBuilderTestArtifacts();
    for (const name of ['.npm-cache', '.m2', '.cache', '.uv-cache', 'node_modules'])
      assert.equal(existsSync(join(impl, name)), false, `${name} leaked into candidate`);
    assert.equal(existsSync(join(impl, 'start.sh')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
