import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { specialistWorkers } from '../panel-vm-run.mjs';

const plan = JSON.parse(readFileSync(new URL('../booking-core.panel.json', import.meta.url)));
const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(
  new URL('../panel-plan.schema.json', import.meta.url))));

test('existing booking panel retains its three pinned specialist workers', () => {
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  assert.deepEqual(specialistWorkers(plan).map(({ id, item, feature }) => [id, item, feature]), [
    ['browser', '01-003', 'Booking core'],
    ['protocol', '01-010', 'Booking core'],
    ['telemetry', '01-003', 'Booking core'],
  ]);
});

test('a selected product slice can add a locally named VM probe', () => {
  const added = { ...plan, checks: [...plan.checks, {
    id: 'release-race', source: 'specialist', role: 'corroborating',
    tool: 'Node.js', technique: 'acceptance', script: 'panel-protocol.mjs',
    feature: 'One-week occurrence release', items: ['02-005'],
    criterion: 'one taker', failure: 'two takers', target_runtime: 'gondolin-qemu-vm',
  }] };
  assert.equal(validate(added), true, JSON.stringify(validate.errors));
  assert.deepEqual(specialistWorkers(added).at(-1), {
    id: 'release-race', script: 'panel-protocol.mjs', tool: 'Node.js',
    item: '02-005', technique: 'acceptance', feature: 'One-week occurrence release',
  });
  assert.throws(() => specialistWorkers({ ...added, checks: [
    ...added.checks.slice(0, -1), { ...added.checks.at(-1), script: '../outside.mjs' },
  ] }), /specialist script/);
  assert.throws(() => specialistWorkers({ ...added, checks: [
    ...added.checks, added.checks.at(-1),
  ] }), /unique specialist/);
});
