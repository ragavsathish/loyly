import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { specialistWorkers } from '../panel-vm-run.mjs';
import { treeDigest } from '../grading-room.ts';
import { fileURLToPath } from 'node:url';

const plan = JSON.parse(readFileSync(new URL('../booking-core.panel.json', import.meta.url)));
const runtimePlan = JSON.parse(
  readFileSync(new URL('../booking-core-runtime.panel.json', import.meta.url)),
);
const validate = new Ajv2020({ strict: false }).compile(
  JSON.parse(readFileSync(new URL('../panel-plan.schema.json', import.meta.url))),
);

test('existing booking panel retains its three pinned specialist workers', () => {
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    specialistWorkers(plan).map(({ id, item, feature }) => [id, item, feature]),
    [
      ['browser', '01-003', 'Booking core'],
      ['protocol', '01-010', 'Booking core'],
      ['telemetry', '01-003', 'Booking core'],
    ],
  );
});

test('a selected product slice can add a locally named VM probe', () => {
  const added = {
    ...plan,
    checks: [
      ...plan.checks,
      {
        id: 'release-race',
        source: 'specialist',
        role: 'corroborating',
        tool: 'Node.js',
        technique: 'acceptance',
        script: 'panel-protocol.mjs',
        feature: 'One-week occurrence release',
        items: ['02-005'],
        criterion: 'one taker',
        failure: 'two takers',
        target_runtime: 'gondolin-qemu-vm',
      },
    ],
  };
  assert.equal(validate(added), true, JSON.stringify(validate.errors));
  assert.deepEqual(specialistWorkers(added).at(-1), {
    id: 'release-race',
    script: 'panel-protocol.mjs',
    tool: 'Node.js',
    item: '02-005',
    technique: 'acceptance',
    feature: 'One-week occurrence release',
    probe: undefined,
  });
  assert.throws(
    () =>
      specialistWorkers({
        ...added,
        checks: [
          ...added.checks.slice(0, -1),
          { ...added.checks.at(-1), script: '../outside.mjs' },
        ],
      }),
    /specialist script/,
  );
  assert.throws(
    () => specialistWorkers({ ...added, checks: [...added.checks, added.checks.at(-1)] }),
    /unique specialist/,
  );
});

test('runtime profiling keeps the selected HTTP workload in the pinned plan', () => {
  const probe = {
    method: 'POST',
    path: '/api/bookings',
    expected_status: 201,
    json_body: { household: 'Profile-12', resource: 'ph8', weekday: 'Tuesday', start: '17:00' },
  };
  const runtime = {
    id: 'runtime-profile',
    source: 'specialist',
    role: 'diagnostic',
    tool: 'procfs/JFR',
    technique: 'profiling',
    script: 'panel-runtime.mjs',
    feature: 'Booking core',
    items: ['01-003'],
    probe,
    criterion: 'profile the booking request',
    failure: 'missing evidence',
    target_runtime: 'gondolin-qemu-vm',
  };
  const selected = { ...plan, checks: [...plan.checks, runtime] };
  assert.equal(validate(selected), true, JSON.stringify(validate.errors));
  assert.deepEqual(specialistWorkers(selected).at(-1).probe, probe);
  runtime.probe = { ...probe, path: '../candidate' };
  assert.equal(validate(selected), false);
});

test('the calibration panel adds one real booking profile without changing raw coverage', () => {
  assert.equal(validate(runtimePlan), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    specialistWorkers(runtimePlan).map((worker) => worker.id),
    ['browser', 'protocol', 'telemetry', 'runtime-profile'],
  );
  assert.deepEqual(runtimePlan.checks.find((check) => check.id === 'runtime-profile').probe, {
    method: 'POST',
    path: '/api/bookings',
    expected_status: 201,
    json_body: { household: 'Profile-12', resource: 'ph8', weekday: 'Tuesday', start: '17:00' },
  });
});

test('a second project supplies a pinned specialist bundle without a core worker ID', () => {
  const bundle = {
    path: 'test/fixtures/hello-panel',
    sha256: treeDigest(
      fileURLToPath(new URL('./fixtures/hello-panel/', import.meta.url)),
      'bundle',
    ),
  };
  const other = {
    schema: 'harness.grading-panel-plan.v2',
    project: 'hello',
    feature: 'Health',
    bundle,
    checks: [
      {
        id: 'health',
        source: 'specialist',
        role: 'corroborating',
        tool: 'Node.js',
        script: 'health.mjs',
        technique: 'acceptance',
        items: ['01-001'],
        criterion: 'Fresh app answers health',
        failure: 'No health response',
        target_runtime: 'gondolin-qemu-vm',
      },
    ],
  };
  assert.equal(validate(other), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    specialistWorkers(other).map((worker) => [worker.id, worker.script]),
    [['health', 'health.mjs']],
  );
  assert.throws(
    () => specialistWorkers({ ...other, bundle: { ...bundle, sha256: '0'.repeat(64) } }),
    /bundle differs/,
  );
  const missingScript = { ...other, checks: [{ ...other.checks[0], script: undefined }] };
  assert.equal(validate(missingScript), false);
});
