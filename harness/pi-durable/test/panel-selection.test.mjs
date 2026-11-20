import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validatePanelSelection } from '../panel-selection.mjs';

const booking = JSON.parse(readFileSync(new URL('../booking-core.panel.json', import.meta.url)));
const ids = Array.from({ length: 11 }, (_, n) => `01-${String(n + 1).padStart(3, '0')}`);
const checklist = { items: ids.map((id) => ({ id })) };

test('the existing panel covers its whole scored booking cut', () => {
  assert.deepEqual(validatePanelSelection(booking, checklist), {
    selected: ids, specialists: ['browser', 'protocol', 'telemetry'],
  });
});

test('a future product cut needs a raw grade for every additional item', () => {
  const whole = { items: [...checklist.items, { id: '02-001' }] };
  assert.throws(() => validatePanelSelection(booking, whole), /exactly cover/);
  const plan = { ...booking, checks: [
    ...booking.checks,
    { ...booking.checks[0], id: 'release-black-box', items: ['02-001'] },
  ] };
  assert.equal(validatePanelSelection(plan, whole).selected.at(-1), '02-001');
  assert.throws(() => validatePanelSelection({ ...plan, checks: [
    ...plan.checks, { ...plan.checks.at(-1), id: 'duplicate-release' },
  ] }, whole), /exactly cover/);
});

test('preflight rejects blind and specialist coverage drift', () => {
  assert.throws(() => validatePanelSelection({ ...booking, checks: booking.checks.filter(
    (check) => check.id !== 'blind-review') }, checklist), /one scored blind review/);
  assert.throws(() => validatePanelSelection({ ...booking, checks: booking.checks.map(
    (check) => check.id === 'browser' ? { ...check, script: 'panel-browser.mjs', items: ['02-001'] } : check) }, checklist),
  /unselected item/);
  assert.throws(() => validatePanelSelection({ ...booking, checks: booking.checks.map(
    (check) => check.id === 'blind-handoff' ? { ...check, role: 'scored' } : check) }, checklist),
  /roles differ/);
  assert.throws(() => validatePanelSelection({ ...booking, checks: booking.checks.map(
    (check) => check.id === 'browser' ? { ...check, role: 'scored' } : check) }, checklist),
  /may corroborate or diagnose/);
});
