import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateDigest, prepareGradingRoom } from "../grading-room.mjs";
import { readAllureResults } from "../allure-results.mjs";
import { prepareBlindReview, writeBlindAgentAllure } from "../blind-review.mjs";
import { projectReplayEvidence } from "../replay-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const schemaFile = new URL("../allure-lifecycle-result.schema.json", import.meta.url).pathname;

test("playback projects bound grader and blind Allure evidence without inventing Pi entries", () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-replay-evidence-"));
  const sourceRoom = join(scratch, "source"), candidateRoom = join(scratch, "candidate");
  const gradingRoom = join(scratch, "grading-room");
  const checklistFile = join(scratch, "checklist.json");
  try {
    mkdirSync(join(sourceRoom, "docs", "plan", "01-booking-core"), { recursive: true });
    mkdirSync(join(candidateRoom, "impl"), { recursive: true });
    writeFileSync(join(sourceRoom, "docs", "plan", "01-booking-core", "spec.feature"),
      "Feature: Booking core\nScenario: Fresh blind subagent judges refusal\n");
    writeFileSync(join(candidateRoom, "impl", "app.txt"), "candidate");
    const items = [{ id: "01-001", name: "The schedule", rule: "Availability",
      source: "docs/plan/01-booking-core/spec.feature:2" },
    { id: "01-011", name: "The refusal", rule: "Actionable refusal",
      source: "docs/plan/01-booking-core/spec.feature:3" }];
    writeFileSync(checklistFile, JSON.stringify({ items }));
    const candidateSha256 = candidateDigest(candidateRoom);
    const checklistSha256 = hash(readFileSync(checklistFile));
    prepareGradingRoom({ sourceRoom, candidateRoom, checklistFile, schemaFile,
      out: gradingRoom, candidateSha256, checklistSha256,
      schemaSha256: hash(readFileSync(schemaFile)) });
    const work = join(gradingRoom, "work"), results = join(work, "allure-results");
    mkdirSync(results); mkdirSync(join(work, "shards", "shard-01"), { recursive: true });
    writeFileSync(join(work, "surprises.json"), "[]");
    const refusal = "Try Thursday at 17:00 in pukuhuone 9.\n";
    writeFileSync(join(work, "shards", "shard-01", "blind-review-011.txt"), refusal);
    for (const item of items) {
      const pending = item.id === "01-011", uuid = randomUUID();
      const attachment = `${randomUUID()}-attachment.txt`;
      writeFileSync(join(results, attachment), pending ? refusal : "Observed schedule over HTTP\n");
      const fullName = `loyly.booking-core.${item.id}`;
      writeFileSync(join(results, `${uuid}-result.json`), JSON.stringify({
        uuid, name: item.name, fullName, testCaseId: fullName, historyId: fullName,
        status: pending ? "skipped" : "passed", stage: pending ? "pending" : "finished",
        statusDetails: { message: pending ? "not reached: blind subagent review required"
          : "Observed schedule over HTTP" }, start: 1, stop: 1,
        labels: [{ name: "lifecycle", value: "pre-production" },
          { name: "technique", value: "acceptance" }, { name: "tool", value: "test grader" },
          { name: "feature", value: "Booking core" }, { name: "story", value: item.rule },
          { name: "tag", value: `@item-${item.id}` }],
        steps: [{ name: "Observe behavior", status: pending ? "skipped" : "passed",
          stage: pending ? "pending" : "finished" }],
        attachments: [{ name: "Observation", source: attachment, type: "text/plain" }],
      }));
    }
    const judged = readAllureResults(gradingRoom);
    const rows = [{ seq: 1, stage: "grading-room", outcome: "prepared",
      candidate_sha256: candidateSha256, checklist_sha256: checklistSha256 },
    { seq: 2, stage: "grade", outcome: "completed", allure_results_sha256: judged.allureSha256 }];
    const raw = projectReplayEvidence(scratch, rows);
    assert.deepEqual(raw.map((item) => [item.item, item.status, item.after_seq]),
      [["01-001", "passed", 2], ["01-011", "skipped", 2]]);
    assert.ok(raw.every((item) => item.source === "Allure evidence projection"));
    const packetDir = join(scratch, "blind-agent-packet");
    prepareBlindReview({ gradingRoom, out: packetDir });
    const review = JSON.parse(readFileSync(join(packetDir, "response-template.json")));
    Object.assign(review, { reviewer: "test agent", had_not_read_configuration: true,
      saw_only_refusal: true, answer: "I cannot act on it", verdict: "fail",
      reason: "Unusable refusal", reviewed_at: 1000 });
    const reviewFile = join(scratch, "blind-agent-review.json");
    writeFileSync(reviewFile, JSON.stringify(review));
    const supplemental = writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom,
      out: join(scratch, "blind-agent-allure") });
    rows.push({ seq: 3, stage: "blind-review", outcome: "completed",
      raw_allure_sha256: judged.allureSha256, review_sha256: supplemental.reviewSha256 });
    const combined = projectReplayEvidence(scratch, rows);
    assert.equal(combined.length, 3);
    assert.deepEqual([combined[2].kind, combined[2].status, combined[2].after_seq],
      ["blind-review", "failed", 3]);
    rows[1].allure_results_sha256 = "0".repeat(64);
    assert.throws(() => projectReplayEvidence(scratch, rows), /committed grade digest/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
