import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateVerdictData } from '../validate-verdicts.ts';
import { validatePanelCoverage } from '../panel-selection.ts';
import { validateResultEvidence } from '../validate-result.ts';

test('selected evidence keeps the full denominator and rejects path escapes', () => {
  const selected = { items: [{ id: '01-001' }, { id: '01-002' }] };
  const verdicts = [
    { id: '01-001', verdict: 'pass', evidence: 'Observed A' },
    { id: '01-002', verdict: 'fail', evidence: 'Observed B' },
  ];
  assert.equal(validateVerdictData(selected, verdicts, []).pass, 1);
  assert.throws(() => validateVerdictData(selected, verdicts.slice(0, 1), []), /one verdict per selected item/);
  assert.throws(() => validateVerdictData(selected, verdicts, [
    { item: '01-001', observation: 'note', evidence_file: 'work/../other' },
  ]), /invalid surprise evidence/);
});

test('generic panel coverage requires one raw decision per selected item', () => {
  const selected = { items: [{ id: '01-001' }, { id: '01-002' }] };
  const plan = { checks: [
    { id: 'raw', source: 'raw-grader', role: 'scored', items: ['01-001', '01-002'] },
    { id: 'probe', source: 'specialist', role: 'diagnostic', items: ['01-002'] },
  ] };
  assert.deepEqual(validatePanelCoverage(plan, selected), {
    selected: ['01-001', '01-002'], specialistIds: ['probe'],
  });
  assert.throws(() => validatePanelCoverage({ checks: [plan.checks[0]] },
    { items: [{ id: '01-001' }] }), /exactly cover/);
});

test('Allure evidence needs a timed observation, steps and attachments', () => {
  const result = { statusDetails: { message: 'Observed response' }, start: 1, stop: 2,
    steps: [{ status: 'passed', stage: 'finished' }], attachments: [{ source: 'probe.txt' }] };
  assert.doesNotThrow(() => validateResultEvidence(result, '01-001'));
  assert.throws(() => validateResultEvidence({ ...result, stop: 0 }, '01-001'), /timing or steps/);
  assert.throws(() => validateResultEvidence({ ...result, attachments: [] }, '01-001'), /attachment missing/);
});
