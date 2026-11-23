import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkRoomEvidence } from "../check-room-evidence.ts";

function roomWithResult(tool) {
  const room = mkdtempSync(join(tmpdir(), "loyly-room-evidence-"));
  const dir = join(room, "work/allure-results");
  mkdirSync(dir, { recursive: true });
  const checklist = join(room, "checklist.json");
  const verdicts = join(room, "verdicts.json");
  const surprises = join(room, "work/surprises.json");
  writeFileSync(checklist, JSON.stringify({ items: [{ id: "01-001" }] }));
  writeFileSync(
    verdicts,
    JSON.stringify([
      { id: "01-001", verdict: "pass", evidence: "HTTP observed" },
    ]),
  );
  writeFileSync(surprises, "[]");
  const uuid = randomUUID();
  writeFileSync(join(dir, `${uuid}-attachment.txt`), "HTTP 200");
  writeFileSync(
    join(dir, `${uuid}-result.json`),
    JSON.stringify({
      uuid,
      name: "One booking",
      status: "passed",
      stage: "finished",
      statusDetails: { message: "HTTP observed" },
      start: 1,
      stop: 2,
      labels: [
        { name: "lifecycle", value: "pre-production" },
        { name: "technique", value: "acceptance" },
        { name: "tool", value: tool },
        { name: "tag", value: "@item-01-001" },
      ],
      steps: [{ name: "Request", status: "passed", stage: "finished" }],
      attachments: [
        {
          name: "response",
          source: `${uuid}-attachment.txt`,
          type: "text/plain",
        },
      ],
    }),
  );
  return {
    room,
    files: { checklist, verdicts, surprises, room, rawAllureDirs: [dir] },
  };
}

test("checkRoomEvidence seals the grader tool string", () => {
  const { room, files } = roomWithResult("Shared grader");
  assert.equal(
    checkRoomEvidence(files, {
      graderTool: "Shared grader",
      blindTool: "fresh blind subagent",
    }).passed,
    1,
  );
  assert.throws(
    () =>
      checkRoomEvidence(files, {
        graderTool: "Other grader",
        blindTool: "fresh blind subagent",
      }),
    /sealed grader/,
  );
  rmSync(room, { recursive: true, force: true });
});
