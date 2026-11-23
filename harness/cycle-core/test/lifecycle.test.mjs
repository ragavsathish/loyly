import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from '../lifecycle.ts';

test('a small project builds, verifies, grades and scores without extra assessments', () => {
  const cycle = createLifecycle({ maxBuildAttempts: 2 });
  assert.deepEqual(cycle.afterBuild(1, { status: 'completed' }), { phase: 'gate', attempt: 1 });
  assert.deepEqual(
    cycle.afterGate(1, {
      status: 'completed',
      result: {
        passed: false,
        log: '/gate.log',
        logSha256: 'abc',
      },
    }),
    { phase: 'build', attempt: 2, retry: 'gate', failureLog: '/gate.log', failureSha256: 'abc' },
  );
  assert.deepEqual(
    cycle.afterGate(2, {
      status: 'completed',
      result: {
        passed: true,
        candidateSha256: 'candidate',
      },
    }),
    { phase: 'grading-room', attempt: 2, candidateSha256: 'candidate' },
  );
  assert.deepEqual(cycle.afterGrade({ status: 'completed' }), { phase: 'score' });
});

test('a project with independent review and specialists retains the bounded loop', () => {
  const cycle = createLifecycle({ assessments: ['blind-review', 'panel'] });
  assert.deepEqual(
    cycle.afterBuild(1, {
      status: 'failed',
      result: {
        retryable: true,
        failureLog: '/build.log',
        failureSha256: 'def',
      },
    }),
    {
      phase: 'build',
      attempt: 2,
      retry: 'builder',
      failureLog: '/build.log',
      failureSha256: 'def',
    },
  );
  assert.deepEqual(cycle.afterBuild(3, { status: 'failed', result: { retryable: true } }), {
    terminal: true,
    reason: 'builder-attempts-exhausted',
    exhausted: true,
    attempt: 3,
  });
  assert.deepEqual(cycle.afterGate(3, { status: 'completed', result: { passed: false } }), {
    terminal: true,
    reason: 'gate-attempts-exhausted',
    exhausted: true,
    attempt: 3,
  });
  assert.deepEqual(cycle.afterGrade({ status: 'completed' }), { phase: 'blind-review' });
  assert.deepEqual(cycle.afterAssessment('blind-review', true), { phase: 'panel' });
  assert.deepEqual(cycle.afterAssessment('panel', true), { phase: 'score' });
  assert.deepEqual(cycle.afterAssessment('panel', false), {
    terminal: true,
    reason: 'panel-effect',
  });
  assert.throws(() => cycle.afterAssessment('other', true), /unknown assessment/);
});
