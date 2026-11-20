import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateDigest, prepareGradingRoom } from "../grading-room.mjs";
import { combineShards, partitionByRule, prepareShards } from "../grader-shards.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const schema = new URL("../allure-lifecycle-result.schema.json", import.meta.url).pathname;
const instruction = new URL("../grader-instruction-01.md", import.meta.url).pathname;
const stub = new URL("./stub-grader.sh", import.meta.url).pathname;

test("rule scopes merge exactly once into the attached Allure contract", () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-shards-"));
  const source = join(root, "source"), candidate = join(root, "candidate"), full = join(root, "full");
  const checklistFile = join(root, "checklist.json");
  mkdirSync(join(source, "docs", "plan", "01-booking-core"), { recursive: true });
  mkdirSync(join(candidate, "impl"), { recursive: true });
  writeFileSync(join(source, "docs", "plan", "01-booking-core", "spec.feature"), "Feature: Booking core\n");
  writeFileSync(join(candidate, "impl", "start.sh"), "#!/bin/sh\n");
  const items = [
    { id: "01-001", name: "Schedule", rule: "Availability", source: "docs/plan/01-booking-core/spec.feature:2" },
    { id: "01-002", name: "Closed day", rule: "Availability", source: "docs/plan/01-booking-core/spec.feature:3" },
    { id: "01-003", name: "Holder", rule: "Booking", source: "docs/plan/01-booking-core/spec.feature:4" },
    { id: "01-011", name: "Usable refusal", rule: "Blind review", source: "docs/plan/01-booking-core/spec.feature:5" },
  ];
  writeFileSync(checklistFile, JSON.stringify({ items }));
  const candidateSha256 = candidateDigest(candidate), checklistSha256 = sha(readFileSync(checklistFile));
  const schemaSha256 = sha(readFileSync(schema));
  prepareGradingRoom({ sourceRoom: source, candidateRoom: candidate, checklistFile, schemaFile: schema,
    out: full, candidateSha256, checklistSha256, schemaSha256 });
  const groups = partitionByRule(items, 2);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((s) => s.items.some((i) => i.id === "01-001")).items.length, 2);
  const shards = prepareShards({ gradingRoom: full, sourceRoom: source, scratch: root,
    schemaFile: schema, candidateSha256, schemaSha256, count: 2 });
  for (const shard of shards) {
    mkdirSync(join(shard.out, "work", "runtime-01-001"));
    writeFileSync(join(shard.out, "work", "runtime-01-001", "bookings.json"), "{}\n");
    const evidence = join(root, "evidence", shard.id);
    const result = spawnSync("sh", [stub, shard.out, instruction, root], {
      env: { ...process.env, BUILDER_EVIDENCE_DIR: evidence,
        LOYLY_BUILDER_SESSION_ID: shard.id, LOYLY_PI_MODEL: "test/grader" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const merged = combineShards({ gradingRoom: full, shards, candidateSha256, schemaSha256 });
  assert.equal(merged.verdicts.length, 4);
  assert.deepEqual(merged.verdicts.map((v) => v.verdict), ["pass", "pass", "pass", "fail"]);
  assert.equal(readdirSync(join(full, "work", "allure-results")).length, 8);
  assert.ok(!readdirSync(join(full, "work", "shards", shards[0].id)).includes("runtime-01-001"));
  assert.throws(() => combineShards({ gradingRoom: full, shards: [shards[0], shards[0]],
    candidateSha256, schemaSha256 }), /exactly once/);
  const resultFile = readdirSync(join(shards[0].out, "work", "allure-results"))
    .find((name) => name.endsWith("-result.json"));
  rmSync(join(shards[0].out, "work", "allure-results", resultFile));
  assert.throws(() => combineShards({ gradingRoom: full, shards, candidateSha256, schemaSha256 }),
    /one Allure result/);
});

test("identical rule names in different product slices stay separate scopes", () => {
  const groups = partitionByRule([
    { id: "01-001", rule: "Availability", source: "docs/plan/01-booking-core/spec.feature:2" },
    { id: "02-001", rule: "Availability", source: "docs/plan/02-release/spec.feature:2" },
  ], 2);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.items.length === 1));
});

test("parallel result directories combine across two product slices", () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-multi-slice-shards-"));
  try {
    const source = join(root, "source"), candidate = join(root, "candidate");
    const full = join(root, "full"), checklistFile = join(root, "checklist.json");
    const plans = [["01-booking-core", "Booking core"],
      ["02-occurrence-release", "Occurrence release"]];
    for (const [name, feature] of plans) {
      const dir = join(source, "docs", "plan", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "spec.feature"), `Feature: ${feature}\n`);
    }
    mkdirSync(join(candidate, "impl"), { recursive: true });
    writeFileSync(join(candidate, "impl", "start.sh"), "#!/bin/sh\n");
    const items = [
      { id: "01-001", name: "Book", rule: "Availability",
        source: "docs/plan/01-booking-core/spec.feature:2" },
      { id: "02-001", name: "Release", rule: "Availability",
        source: "docs/plan/02-occurrence-release/spec.feature:2" },
    ];
    writeFileSync(checklistFile, JSON.stringify({ items }));
    const candidateSha256 = candidateDigest(candidate), schemaSha256 = sha(readFileSync(schema));
    prepareGradingRoom({ sourceRoom: source, candidateRoom: candidate, checklistFile,
      schemaFile: schema, out: full, candidateSha256,
      checklistSha256: sha(readFileSync(checklistFile)), schemaSha256 });
    const shards = prepareShards({ gradingRoom: full, sourceRoom: source, scratch: root,
      schemaFile: schema, candidateSha256, schemaSha256, count: 2 });
    for (const shard of shards) {
      const item = items.find((selected) => selected.id === shard.items[0]);
      const feature = item.id.startsWith("01-") ? "Booking core" : "Occurrence release";
      const slug = item.id.startsWith("01-") ? "booking-core" : "occurrence-release";
      const dir = join(shard.out, "work", "allure-results");
      mkdirSync(dir);
      writeFileSync(join(shard.out, "work", "surprises.json"), "[]");
      const uuid = randomUUID(), attachment = `${randomUUID()}-attachment.txt`;
      writeFileSync(join(dir, attachment), `${item.name} observed over HTTP\n`);
      const fullName = `loyly.${slug}.${item.id}`;
      writeFileSync(join(dir, `${uuid}-result.json`), JSON.stringify({
        uuid, name: item.name, fullName, testCaseId: fullName, historyId: fullName,
        status: "passed", stage: "finished", start: 1, stop: 2,
        statusDetails: { message: `${item.name} observed over HTTP` },
        labels: [{ name: "lifecycle", value: "pre-production" },
          { name: "technique", value: "acceptance" }, { name: "tool", value: "Pi grader" },
          { name: "feature", value: feature }, { name: "story", value: item.rule },
          { name: "tag", value: `@item-${item.id}` }],
        steps: [{ name: "Observe public behavior", status: "passed", stage: "finished" }],
        attachments: [{ name: "HTTP observation", source: attachment, type: "text/plain" }],
      }));
    }
    const merged = combineShards({ gradingRoom: full, shards, candidateSha256, schemaSha256 });
    assert.deepEqual(merged.verdicts.map((item) => [item.id, item.verdict]),
      [["01-001", "pass"], ["02-001", "pass"]]);
    assert.equal(readdirSync(join(full, "work", "allure-results")).length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
