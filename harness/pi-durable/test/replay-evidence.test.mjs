import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateDigest, prepareGradingRoom } from '../grading-room.ts';
import { readAllureResults } from '../allure-results.mjs';
import { prepareBlindReview, writeBlindAgentAllure } from '../blind-review.mjs';
import { panelPlanForManifest, projectReplayEvidence } from '../replay-evidence.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const schemaFile = new URL('../allure-lifecycle-result.schema.json', import.meta.url).pathname;

test('replay selects the whole-product panel by its committed digest', () => {
  const plan = new URL('../whole-product.panel.json', import.meta.url).pathname;
  assert.equal(panelPlanForManifest({ plan_sha256: hash(readFileSync(plan)) }), plan);
  assert.throws(
    () => panelPlanForManifest({ plan_sha256: '0'.repeat(64) }),
    /exactly one local plan/,
  );
});

test('playback projects bound grader and blind Allure evidence without inventing Pi entries', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'loyly-replay-evidence-'));
  const sourceRoom = join(scratch, 'source'),
    candidateRoom = join(scratch, 'candidate');
  const gradingRoom = join(scratch, 'grading-room');
  const checklistFile = join(scratch, 'checklist.json');
  try {
    mkdirSync(join(sourceRoom, 'docs', 'plan', '01-booking-core'), { recursive: true });
    mkdirSync(join(candidateRoom, 'impl'), { recursive: true });
    writeFileSync(
      join(sourceRoom, 'docs', 'plan', '01-booking-core', 'spec.feature'),
      'Feature: Booking core\nScenario: Fresh blind subagent judges refusal\n',
    );
    writeFileSync(join(candidateRoom, 'impl', 'app.txt'), 'candidate');
    const items = [
      {
        id: '01-001',
        name: 'The schedule',
        rule: 'Availability',
        source: 'docs/plan/01-booking-core/spec.feature:2',
      },
      {
        id: '01-011',
        name: 'The refusal',
        rule: 'Actionable refusal',
        source: 'docs/plan/01-booking-core/spec.feature:3',
      },
    ];
    writeFileSync(checklistFile, JSON.stringify({ items }));
    const candidateSha256 = candidateDigest(candidateRoom);
    const checklistSha256 = hash(readFileSync(checklistFile));
    prepareGradingRoom({
      sourceRoom,
      candidateRoom,
      checklistFile,
      schemaFile,
      out: gradingRoom,
      candidateSha256,
      checklistSha256,
      schemaSha256: hash(readFileSync(schemaFile)),
    });
    const work = join(gradingRoom, 'work'),
      results = join(work, 'allure-results');
    mkdirSync(results);
    mkdirSync(join(work, 'shards', 'shard-01'), { recursive: true });
    writeFileSync(join(work, 'surprises.json'), '[]');
    const refusal = 'Try Thursday at 17:00 in pukuhuone 9.\n';
    writeFileSync(join(work, 'shards', 'shard-01', 'blind-review-011.txt'), refusal);
    for (const item of items) {
      const pending = item.id === '01-011',
        uuid = randomUUID();
      const attachment = `${randomUUID()}-attachment.txt`;
      writeFileSync(join(results, attachment), pending ? refusal : 'Observed schedule over HTTP\n');
      const fullName = `loyly.booking-core.${item.id}`;
      writeFileSync(
        join(results, `${uuid}-result.json`),
        JSON.stringify({
          uuid,
          name: item.name,
          fullName,
          testCaseId: fullName,
          historyId: fullName,
          status: pending ? 'skipped' : 'passed',
          stage: pending ? 'pending' : 'finished',
          statusDetails: {
            message: pending
              ? 'not reached: blind subagent review required'
              : 'Observed schedule over HTTP',
          },
          start: 1,
          stop: 1,
          labels: [
            { name: 'lifecycle', value: 'pre-production' },
            { name: 'technique', value: 'acceptance' },
            { name: 'tool', value: 'test grader' },
            { name: 'feature', value: 'Booking core' },
            { name: 'story', value: item.rule },
            { name: 'tag', value: `@item-${item.id}` },
          ],
          steps: [
            {
              name: 'Observe behavior',
              status: pending ? 'skipped' : 'passed',
              stage: pending ? 'pending' : 'finished',
            },
          ],
          attachments: [{ name: 'Observation', source: attachment, type: 'text/plain' }],
        }),
      );
    }
    const judged = readAllureResults(gradingRoom);
    const rows = [
      {
        seq: 1,
        stage: 'grading-room',
        outcome: 'prepared',
        candidate_sha256: candidateSha256,
        checklist_sha256: checklistSha256,
      },
      { seq: 2, stage: 'grade', outcome: 'completed', allure_results_sha256: judged.allureSha256 },
    ];
    const raw = projectReplayEvidence(scratch, rows);
    assert.deepEqual(
      raw.map((item) => [item.item, item.status, item.after_seq]),
      [
        ['01-001', 'passed', 2],
        ['01-011', 'skipped', 2],
      ],
    );
    assert.ok(raw.every((item) => item.source === 'Allure evidence projection'));
    const packetDir = join(scratch, 'blind-agent-packet');
    prepareBlindReview({ gradingRoom, out: packetDir });
    const review = JSON.parse(readFileSync(join(packetDir, 'response-template.json')));
    Object.assign(review, {
      reviewer: 'test agent',
      had_not_read_configuration: true,
      saw_only_refusal: true,
      answer: 'I cannot act on it',
      verdict: 'fail',
      reason: 'Unusable refusal',
      reviewed_at: 1000,
    });
    const reviewFile = join(scratch, 'blind-agent-review.json');
    writeFileSync(reviewFile, JSON.stringify(review));
    const supplemental = writeBlindAgentAllure({
      packetDir,
      reviewFile,
      gradingRoom,
      out: join(scratch, 'blind-agent-allure'),
    });
    rows.push({
      seq: 3,
      stage: 'blind-review',
      outcome: 'completed',
      raw_allure_sha256: judged.allureSha256,
      review_sha256: supplemental.reviewSha256,
    });
    const combined = projectReplayEvidence(scratch, rows);
    assert.equal(combined.length, 3);
    assert.deepEqual(
      [combined[2].kind, combined[2].status, combined[2].after_seq],
      ['blind-review', 'failed', 3],
    );
    rows[1].allure_results_sha256 = '0'.repeat(64);
    assert.throws(() => projectReplayEvidence(scratch, rows), /committed grade digest/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('another project replays direct grader evidence without a blind event', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'harness-replay-evidence-'));
  const sourceRoom = join(scratch, 'source'),
    candidateRoom = join(scratch, 'candidate');
  const gradingRoom = join(scratch, 'grading-room'),
    checklistFile = join(scratch, 'checklist.json');
  try {
    mkdirSync(join(sourceRoom, 'docs', 'plan', '01-health'), { recursive: true });
    mkdirSync(join(candidateRoom, 'impl'), { recursive: true });
    writeFileSync(
      join(sourceRoom, 'docs', 'plan', '01-health', 'spec.feature'),
      'Feature: Health\n',
    );
    writeFileSync(join(candidateRoom, 'impl', 'app.txt'), 'candidate');
    writeFileSync(
      checklistFile,
      JSON.stringify({
        items: [
          {
            id: '01-001',
            name: 'Health',
            rule: 'Responds',
            source: 'docs/plan/01-health/spec.feature:2',
          },
        ],
      }),
    );
    const candidateSha256 = candidateDigest(candidateRoom);
    const checklistSha256 = hash(readFileSync(checklistFile));
    prepareGradingRoom({
      sourceRoom,
      candidateRoom,
      checklistFile,
      schemaFile,
      out: gradingRoom,
      candidateSha256,
      checklistSha256,
      schemaSha256: hash(readFileSync(schemaFile)),
      project: 'hello',
      blindReview: false,
    });
    const dir = join(gradingRoom, 'work', 'allure-results');
    mkdirSync(dir);
    writeFileSync(join(gradingRoom, 'work', 'surprises.json'), '[]');
    const uuid = randomUUID(),
      attachment = `${randomUUID()}-attachment.txt`;
    writeFileSync(join(dir, attachment), 'HTTP 200\n');
    const fullName = 'hello.health.01-001';
    writeFileSync(
      join(dir, `${uuid}-result.json`),
      JSON.stringify({
        uuid,
        fullName,
        testCaseId: fullName,
        historyId: fullName,
        name: 'Health',
        status: 'passed',
        stage: 'finished',
        statusDetails: { message: 'HTTP 200' },
        start: 1,
        stop: 2,
        labels: [
          { name: 'lifecycle', value: 'pre-production' },
          { name: 'tool', value: 'Pi grader' },
          { name: 'technique', value: 'acceptance' },
          { name: 'feature', value: 'Health' },
          { name: 'story', value: 'Responds' },
          { name: 'tag', value: '@item-01-001' },
        ],
        steps: [{ name: 'GET /health', status: 'passed', stage: 'finished' }],
        attachments: [{ name: 'HTTP response', source: attachment, type: 'text/plain' }],
      }),
    );
    const judged = readAllureResults(gradingRoom);
    const rows = [
      {
        seq: 1,
        stage: 'grading-room',
        outcome: 'prepared',
        candidate_sha256: candidateSha256,
        checklist_sha256: checklistSha256,
      },
      { seq: 2, stage: 'grade', outcome: 'completed', allure_results_sha256: judged.allureSha256 },
    ];
    assert.deepEqual(
      projectReplayEvidence(scratch, rows).map((row) => [row.item, row.kind, row.after_seq]),
      [['01-001', 'grader-item', 2]],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
