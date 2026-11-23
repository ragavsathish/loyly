import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { genChecklist } from '../measure/index.ts';
import { validatePanelSelection } from '../panel-selection.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const plan = JSON.parse(readFileSync(new URL('../whole-product.panel.json', import.meta.url)));

test('the approved whole-product panel covers the real five-slice checklist', () => {
  const { checklist } = genChecklist({ root });
  const selected = validatePanelSelection(plan, checklist);
  assert.equal(checklist.counts.total, 47);
  assert.equal(selected.selected.length, 47);
  assert.deepEqual(new Set(selected.selected.map((id) => id.slice(0, 2))),
    new Set(['01', '02', '03', '04', '05']));
  assert.deepEqual(selected.specialists,
    ['browser', 'protocol', 'runtime-profile']);
});
