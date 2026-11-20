import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySelectedSpecs } from '../run-live.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('approved product specs exactly cover every selected checklist slice', () => {
  const repo = mkdtempSync(join(tmpdir(), 'loyly-selected-specs-'));
  try {
    const files = ['docs/plan/01-booking-core/spec.feature',
      'docs/plan/02-occurrence-release/spec.feature'];
    for (const file of files) {
      mkdirSync(join(repo, file, '..'), { recursive: true });
      writeFileSync(join(repo, file), `Feature: ${file}\n`);
    }
    const specs = files.map((file) => ({ file, sha256: sha(readFileSync(join(repo, file))) }));
    const checklist = { items: [
      { id: '01-001', source: `${files[0]}:2` },
      { id: '02-001', source: `${files[1]}:2` },
    ] };
    assert.deepEqual(verifySelectedSpecs(repo, { specs }, checklist), specs);
    assert.throws(() => verifySelectedSpecs(repo, { specs: specs.slice(0, 1) }, checklist),
      /exactly cover/);
    assert.throws(() => verifySelectedSpecs(repo, { specs: [...specs, specs[0]] }, checklist),
      /uniquely name/);
    writeFileSync(join(repo, files[1]), 'changed\n');
    assert.throws(() => verifySelectedSpecs(repo, { specs }, checklist), /digest changed/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
