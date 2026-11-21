import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePanel } from '../panel-policy.ts';

const hash = 'a'.repeat(64);
const plan = { checks: [
  { id: 'black-box', source: 'raw-grader', role: 'scored', tool: 'agent',
    technique: 'acceptance', items: ['01-001'], target_runtime: 'gondolin-qemu-vm',
    criterion: 'one holder', failure: 'two holders' },
  { id: 'browser', source: 'specialist', role: 'corroborating', tool: 'Playwright',
    technique: 'ui-ux', items: ['01-001'], target_runtime: 'gondolin-qemu-vm',
    criterion: 'public form works', failure: 'form fails' },
] };
const items = [{ id: '01-001', rule: 'One holder', verdict: 'pass' }];
const observations = [
  { id: 'black-box', item: '01-001', tool: 'agent', technique: 'acceptance',
    status: 'passed', runtime: 'gondolin-qemu-vm', result_sha256: hash, message: 'observed' },
  { id: 'browser', item: '01-001', tool: 'Playwright', technique: 'ui-ux',
    status: 'passed', runtime: 'gondolin-qemu-vm', result_sha256: hash, message: 'observed' },
];

test('panel keeps the filed score and marks complete independent checks ready for review', () => {
  const result = evaluatePanel(plan, items, observations);
  assert.equal(result.panel_outcome, 'ready-for-review');
  assert.equal(result.items[0].filed_verdict, 'pass');
  assert.equal(result.items[0].panel_status, 'supported');
});

test('panel rejects missing, duplicate, and conflicting evidence', () => {
  assert.throws(() => evaluatePanel(plan, items, observations.slice(0, 1)), /missing panel result/);
  assert.throws(() => evaluatePanel(plan, items, [...observations, observations[1]]), /duplicate panel result/);
  assert.throws(() => evaluatePanel(plan, items, [
    { ...observations[0], status: 'failed' }, observations[1],
  ]), /disagrees with the filed score/);
  const conflict = evaluatePanel(plan, items, [observations[0], { ...observations[1], status: 'failed' }]);
  assert.equal(conflict.items[0].panel_status, 'conflicted');
  assert.equal(conflict.panel_outcome, 'not-ready');
});

test('a probe outside Gondolin is reported as a runtime gap', () => {
  const result = evaluatePanel(plan, items, [observations[0],
    { ...observations[1], runtime: 'docker-shared-linux-vm' }]);
  assert.match(result.gaps[0], /observed docker-shared-linux-vm/);
  assert.equal(result.panel_outcome, 'not-ready');
});
