import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
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

test('live contract accepts the old single-spec cut and a pinned multi-slice cut', () => {
  const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(
    new URL('../live-run.schema.json', import.meta.url))));
  const digest = 'a'.repeat(64), commit = 'b'.repeat(40);
  const agent = { command: '/agent', command_sha256: digest, image: '/image',
    image_sha256: digest, model: 'test/model', instruction_sha256: digest };
  const config = { schema: 'loyly.pi-live-run.v1', run_id: 'whole-app', controller_commit: commit,
    source: { repo: '/source', commit, checklist_sha256: digest,
      spec_file: 'docs/plan/01-booking-core/spec.feature', spec_sha256: digest },
    scratch: '/scratch', builder: agent,
    grader: { ...agent, settings: '/settings', settings_sha256: digest,
      schema_sha256: digest, shards: 3 },
    blind: { ...agent, settings: '/settings', settings_sha256: digest },
    panel: { image: '/image', image_sha256: digest, plan_sha256: digest } };
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  delete config.source.spec_file;
  delete config.source.spec_sha256;
  config.source.specs = [{ file: 'docs/plan/01-booking-core/spec.feature', sha256: digest },
    { file: 'docs/plan/02-occurrence-release/spec.feature', sha256: digest }];
  config.grader.instruction_file = 'grader-instruction-product.md';
  config.panel.plan_file = 'whole-product.panel.json';
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  config.panel.plan_file = '../outside.panel.json';
  assert.equal(validate(config), false);
  config.panel.plan_file = 'whole-product.panel.json';
  config.source.spec_file = 'docs/plan/01-booking-core/spec.feature';
  assert.equal(validate(config), false);
});
