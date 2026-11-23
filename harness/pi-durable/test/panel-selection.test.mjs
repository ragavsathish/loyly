import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validatePanelSelection } from '../panel-selection.mjs';
import { treeDigest } from '../grading-room.ts';
import { fileURLToPath } from 'node:url';

const booking = JSON.parse(readFileSync(new URL('../booking-core.panel.json', import.meta.url)));
const runtime = JSON.parse(
  readFileSync(new URL('../booking-core-runtime.panel.json', import.meta.url)),
);
const ids = Array.from({ length: 11 }, (_, n) => `01-${String(n + 1).padStart(3, '0')}`);
const checklist = { items: ids.map((id) => ({ id })) };

test('the existing panel covers its whole scored booking cut', () => {
  assert.deepEqual(validatePanelSelection(booking, checklist), {
    selected: ids,
    specialists: ['browser', 'protocol', 'telemetry'],
  });
});

test('the four-worker calibration panel retains the same scored denominator', () => {
  assert.deepEqual(validatePanelSelection(runtime, checklist), {
    selected: ids,
    specialists: ['browser', 'protocol', 'telemetry', 'runtime-profile'],
  });
});

test('a future product cut needs a raw grade for every additional item', () => {
  const whole = { items: [...checklist.items, { id: '02-001' }] };
  assert.throws(() => validatePanelSelection(booking, whole), /exactly cover/);
  const plan = {
    ...booking,
    checks: [
      ...booking.checks,
      { ...booking.checks[0], id: 'release-black-box', items: ['02-001'] },
    ],
  };
  assert.equal(validatePanelSelection(plan, whole).selected.at(-1), '02-001');
  assert.throws(
    () =>
      validatePanelSelection(
        { ...plan, checks: [...plan.checks, { ...plan.checks.at(-1), id: 'duplicate-release' }] },
        whole,
      ),
    /exactly cover/,
  );
});

test('preflight rejects blind and specialist coverage drift', () => {
  assert.throws(
    () =>
      validatePanelSelection(
        { ...booking, checks: booking.checks.filter((check) => check.id !== 'blind-review') },
        checklist,
      ),
    /one scored blind review/,
  );
  assert.throws(
    () =>
      validatePanelSelection(
        {
          ...booking,
          checks: booking.checks.map((check) =>
            check.id === 'browser'
              ? { ...check, script: 'panel-browser.mjs', items: ['02-001'] }
              : check,
          ),
        },
        checklist,
      ),
    /unselected item/,
  );
  assert.throws(
    () =>
      validatePanelSelection(
        {
          ...booking,
          checks: booking.checks.map((check) =>
            check.id === 'blind-handoff' ? { ...check, role: 'scored' } : check,
          ),
        },
        checklist,
      ),
    /roles differ/,
  );
  assert.throws(
    () =>
      validatePanelSelection(
        {
          ...booking,
          checks: booking.checks.map((check) =>
            check.id === 'browser' ? { ...check, role: 'scored' } : check,
          ),
        },
        checklist,
      ),
    /may corroborate or diagnose/,
  );
});

test('another project scores its selected items directly and may add one VM specialist', () => {
  const plan = {
    schema: 'harness.grading-panel-plan.v2',
    project: 'hello',
    feature: 'Health',
    bundle: { path: 'test/fixtures/hello-panel', sha256: '0'.repeat(64) },
    checks: [
      {
        id: 'direct',
        source: 'raw-grader',
        role: 'scored',
        tool: 'Pi grader',
        technique: 'acceptance',
        items: ['01-001'],
        criterion: 'health responds',
        failure: 'health fails',
        target_runtime: 'gondolin-qemu-vm',
      },
      {
        id: 'health',
        source: 'specialist',
        role: 'corroborating',
        tool: 'Node.js',
        script: 'health.mjs',
        technique: 'acceptance',
        items: ['01-001'],
        criterion: 'fresh health responds',
        failure: 'health fails',
        target_runtime: 'gondolin-qemu-vm',
      },
    ],
  };
  // The bundle hash is filled from the actual project-owned files.
  plan.bundle.sha256 = treeDigest(
    fileURLToPath(new URL('./fixtures/hello-panel/', import.meta.url)),
    'bundle',
  );
  const selected = { items: [{ id: '01-001' }] };
  assert.deepEqual(validatePanelSelection(plan, selected), {
    selected: ['01-001'],
    specialists: ['health'],
  });
  assert.throws(
    () =>
      validatePanelSelection(
        {
          ...plan,
          checks: [...plan.checks, { ...plan.checks[0], id: 'blind', source: 'blind-review' }],
        },
        selected,
      ),
    /blind review/,
  );
});
