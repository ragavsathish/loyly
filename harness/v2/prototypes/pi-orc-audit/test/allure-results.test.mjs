import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllureResults } from "../allure-results.mjs";

const schema = new URL("../allure-lifecycle-result.schema.json", import.meta.url).pathname;
function fixture() {
  const room = mkdtempSync(join(tmpdir(), "loyly-allure-result-"));
  const dir = join(room, "work", "allure-results");
  mkdirSync(dir, { recursive: true });
  cpSync(schema, join(room, "allure-lifecycle-result.schema.json"));
  const items = [{ id: "01-001", name: "The schedule", rule: "Availability" },
    { id: "01-011", name: "Usable refusal", rule: "Actionable refusal" }];
  writeFileSync(join(room, "checklist.json"), JSON.stringify({ items }));
  writeFileSync(join(room, "work", "surprises.json"), "[]");
  const make = (item, status) => {
    const uuid = randomUUID(), attachment = `${randomUUID()}-attachment.txt`;
    writeFileSync(join(dir, attachment), "HTTP observation\n");
    const fullName = `loyly.booking-core.${item.id}`;
    const result = { uuid, historyId: fullName, testCaseId: fullName, fullName,
      name: item.name, status, stage: item.id === "01-011" ? "pending" : "finished",
      statusDetails: { message: item.id === "01-011"
        ? "not reached: blind human review required" : "Observed the weekly schedule over HTTP" },
      start: 1000, stop: 1001,
      labels: [{ name: "lifecycle", value: "pre-production" },
        { name: "technique", value: "acceptance" }, { name: "tool", value: "Pi grader" },
        { name: "feature", value: "Booking core" }, { name: "story", value: item.rule },
        { name: "tag", value: `@item-${item.id}` }],
      steps: [{ name: "When the schedule is requested", status, stage: "finished" }],
      attachments: [{ name: "HTTP observation", source: attachment, type: "text/plain" }] };
    const path = join(dir, `${uuid}-result.json`);
    writeFileSync(path, JSON.stringify(result));
    return { path, result };
  };
  const first = make(items[0], "passed"), blind = make(items[1], "skipped");
  return { room, first, blind };
}
test("attached lifecycle schema is the grader contract and projects honest legacy verdicts", () => {
  const { room, first, blind } = fixture();
  assert.deepEqual(readAllureResults(room).verdicts.map((v) => v.verdict), ["pass", "fail"]);
  blind.result.status = "passed";
  writeFileSync(blind.path, JSON.stringify(blind.result));
  assert.throws(() => readAllureResults(room), /blind human review/);
  blind.result.status = "skipped";
  writeFileSync(blind.path, JSON.stringify(blind.result));
  first.result.labels = first.result.labels.filter((label) => label.name !== "lifecycle");
  writeFileSync(first.path, JSON.stringify(first.result));
  assert.throws(() => readAllureResults(room), /Allure schema rejected/);
});
