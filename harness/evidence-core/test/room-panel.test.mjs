import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assessRoomPanel } from "../assess-room-panel.ts";

function writeResult(dir, { item, tool, technique, status, name, rule }) {
  const uuid = randomUUID();
  const attachment = `${uuid}-attachment.txt`;
  writeFileSync(join(dir, attachment), "observation\n");
  const fullName = `loyly.booking-core.${item}`;
  writeFileSync(
    join(dir, `${uuid}-result.json`),
    JSON.stringify({
      uuid,
      name,
      fullName,
      testCaseId: fullName,
      historyId: fullName,
      status,
      stage: status === "skipped" ? "pending" : "finished",
      statusDetails: { message: "Observed over HTTP" },
      start: 1,
      stop: 2,
      labels: [
        { name: "lifecycle", value: "pre-production" },
        { name: "technique", value: technique },
        { name: "tool", value: tool },
        { name: "feature", value: "Booking core" },
        { name: "story", value: rule },
        { name: "tag", value: `@item-${item}` },
      ],
      steps: [{ name: "When", status, stage: "finished" }],
      attachments: [
        { name: "probe", source: attachment, type: "text/plain" },
      ],
    }),
  );
}

test("assessRoomPanel runs evaluatePanel for raw grader checks", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-room-panel-"));
  const raw = join(room, "work/allure-results");
  mkdirSync(raw, { recursive: true });
  const plan = join(room, "panel.json");
  const checklist = join(room, "checklist.json");
  const verdicts = join(room, "verdicts.json");
  const surprises = join(room, "work/surprises.json");
  writeFileSync(
    plan,
    JSON.stringify({
      checks: [
        {
          id: "black-box",
          source: "raw-grader",
          role: "scored",
          tool: "Cursor black-box grader",
          technique: "acceptance",
          items: ["01-001"],
          criterion: "observed",
          failure: "missing",
          target_runtime: "cursor-remote-session",
        },
      ],
    }),
  );
  writeFileSync(
    checklist,
    JSON.stringify({
      items: [{ id: "01-001", rule: "One holder", name: "The schedule" }],
    }),
  );
  writeFileSync(
    verdicts,
    JSON.stringify([
      { id: "01-001", verdict: "pass", evidence: "Observed over HTTP" },
    ]),
  );
  writeFileSync(surprises, "[]");
  writeResult(raw, {
    item: "01-001",
    tool: "Cursor black-box grader",
    technique: "acceptance",
    status: "passed",
    name: "The schedule",
    rule: "One holder",
  });
  const assessed = assessRoomPanel({
    plan,
    checklist,
    verdicts,
    surprises,
    rawAllureDirs: [raw],
    runtime: "cursor-remote-session",
  });
  assert.equal(assessed.panel_outcome, "ready-for-review");
  assert.equal(assessed.items[0].panel_status, "supported");
  rmSync(room, { recursive: true, force: true });
});
