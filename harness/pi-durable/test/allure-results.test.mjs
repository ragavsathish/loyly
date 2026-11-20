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
  mkdirSync(join(room, "plan", "01-booking-core"), { recursive: true });
  writeFileSync(join(room, "plan", "01-booking-core", "spec.feature"),
    "Feature: Booking core\nScenario: A fresh subagent judges the refusal\n");
  cpSync(schema, join(room, "allure-lifecycle-result.schema.json"));
  const items = [{ id: "01-001", name: "The schedule", rule: "Availability",
    source: "docs/plan/01-booking-core/spec.feature:2" },
  { id: "01-011", name: "Usable refusal", rule: "Actionable refusal",
    source: "docs/plan/01-booking-core/spec.feature:3" }];
  writeFileSync(join(room, "checklist.json"), JSON.stringify({ items }));
  writeFileSync(join(room, "work", "surprises.json"), "[]");
  const make = (item, status) => {
    const uuid = randomUUID(), attachment = `${randomUUID()}-attachment.txt`;
    writeFileSync(join(dir, attachment), "HTTP observation\n");
    const fullName = `loyly.booking-core.${item.id}`;
    const result = { uuid, historyId: fullName, testCaseId: fullName, fullName,
      name: item.name, status, stage: item.id === "01-011" ? "pending" : "finished",
      statusDetails: { message: item.id === "01-011"
        ? "not reached: blind subagent review required" : "Observed the weekly schedule over HTTP" },
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
  blind.result.statusDetails.message = "not reached: blind human review required";
  writeFileSync(blind.path, JSON.stringify(blind.result));
  assert.throws(() => readAllureResults(room), /blind subagent review/);
  blind.result.statusDetails.message = "not reached: blind subagent review required";
  writeFileSync(blind.path, JSON.stringify(blind.result));
  blind.result.status = "passed";
  writeFileSync(blind.path, JSON.stringify(blind.result));
  assert.throws(() => readAllureResults(room), /blind subagent review/);
  blind.result.status = "skipped";
  writeFileSync(blind.path, JSON.stringify(blind.result));
  first.result.labels = first.result.labels.filter((label) => label.name !== "lifecycle");
  writeFileSync(first.path, JSON.stringify(first.result));
  assert.throws(() => readAllureResults(room), /Allure schema rejected/);
});

test("Allure identity follows the selected product slice without a booking-core dependency", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-allure-second-slice-"));
  const dir = join(room, "work", "allure-results");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(room, "plan", "02-occurrence-release"), { recursive: true });
  writeFileSync(join(room, "plan", "02-occurrence-release", "spec.feature"),
    "Feature: Occurrence release\n");
  cpSync(schema, join(room, "allure-lifecycle-result.schema.json"));
  writeFileSync(join(room, "checklist.json"), JSON.stringify({ items: [{ id: "02-001",
    name: "Release one week", rule: "Standing holding survives",
    source: "docs/plan/02-occurrence-release/spec.feature:2" }] }));
  writeFileSync(join(room, "work", "surprises.json"), "[]");
  const uuid = randomUUID(), attachment = `${randomUUID()}-attachment.txt`;
  writeFileSync(join(dir, attachment), "Observed release over HTTP\n");
  const fullName = "loyly.occurrence-release.02-001";
  const result = { uuid, name: "Release one week", fullName, testCaseId: fullName,
    historyId: fullName, status: "passed", stage: "finished",
    statusDetails: { message: "A one-week release left the standing holding intact" },
    start: 1, stop: 2,
    labels: [{ name: "lifecycle", value: "pre-production" },
      { name: "technique", value: "acceptance" }, { name: "tool", value: "Pi grader" },
      { name: "feature", value: "Occurrence release" },
      { name: "story", value: "Standing holding survives" },
      { name: "tag", value: "@item-02-001" }],
    steps: [{ name: "Observe release", status: "passed", stage: "finished" }],
    attachments: [{ name: "HTTP observation", source: attachment, type: "text/plain" }] };
  const resultPath = join(dir, `${uuid}-result.json`);
  writeFileSync(resultPath, JSON.stringify(result));
  assert.deepEqual(readAllureResults(room).verdicts.map((item) => item.verdict), ["pass"]);
  result.labels.find((label) => label.name === "feature").value = "Booking core";
  writeFileSync(resultPath, JSON.stringify(result));
  assert.throws(() => readAllureResults(room), /Allure identity/);
});
test("surprise projection accepts only local evidence and selected item IDs", () => {
  const { room } = fixture();
  writeFileSync(join(room, "work", "probe.txt"), "HTTP observation\n");
  writeFileSync(join(room, "work", "surprises.json"), JSON.stringify([{
    item: "01-001, 01-011", observation: "Same missing interaction", evidence_file: "probe.txt" }]));
  assert.deepEqual(readAllureResults(room).surprises.map((s) => s.item), ["01-001", "01-011"]);
  assert.ok(readAllureResults(room).surprises.every((s) => s.evidence_file === "work/probe.txt"));
  writeFileSync(join(room, "work", "surprises.json"), JSON.stringify([{
    item: "01-001", observation: "Unsafe", evidence_file: "../outside.txt" }]));
  assert.throws(() => readAllureResults(room), /invalid surprise evidence/);
});
