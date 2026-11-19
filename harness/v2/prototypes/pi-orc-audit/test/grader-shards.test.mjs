import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
    { id: "01-001", name: "Schedule", rule: "Availability" },
    { id: "01-002", name: "Closed day", rule: "Availability" },
    { id: "01-003", name: "Holder", rule: "Booking" },
    { id: "01-011", name: "Usable refusal", rule: "Blind review" },
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
  assert.throws(() => combineShards({ gradingRoom: full, shards: [shards[0], shards[0]],
    candidateSha256, schemaSha256 }), /exactly once/);
  const resultFile = readdirSync(join(shards[0].out, "work", "allure-results"))
    .find((name) => name.endsWith("-result.json"));
  rmSync(join(shards[0].out, "work", "allure-results", resultFile));
  assert.throws(() => combineShards({ gradingRoom: full, shards, candidateSha256, schemaSha256 }),
    /one Allure result/);
});
