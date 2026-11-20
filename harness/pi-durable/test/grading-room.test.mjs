import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateDigest, prepareGradingRoom, verifyGradingRoom } from "../grading-room.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("grading room carries only the selected plan, candidate and checklist", () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-grading-room-"));
  const sourceRoom = join(root, "source"), candidateRoom = join(root, "candidate");
  const out = join(root, "grade"), checklistFile = join(root, "checklist.json");
  const schemaFile = join(root, "allure-lifecycle-result.schema.json");
  mkdirSync(join(sourceRoom, "docs", "plan", "01-booking-core"), { recursive: true });
  mkdirSync(join(sourceRoom, "docs", "plan", "02-private"), { recursive: true });
  mkdirSync(join(candidateRoom, "impl"), { recursive: true });
  mkdirSync(join(candidateRoom, ".builder"));
  writeFileSync(join(sourceRoom, "docs", "plan", "01-booking-core", "spec.feature"), "@item-01-001\n");
  writeFileSync(join(sourceRoom, "docs", "plan", "02-private", "secret"), "unselected\n");
  writeFileSync(join(candidateRoom, "impl", "start.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(candidateRoom, ".builder", "transcript"), "builder-only\n");
  writeFileSync(checklistFile, '{"items":[{"id":"01-001","source":"docs/plan/01-booking-core/spec.feature:1"}]}\n');
  writeFileSync(schemaFile, '{"type":"object"}\n');
  const args = { sourceRoom, candidateRoom, checklistFile, schemaFile, out,
    candidateSha256: candidateDigest(candidateRoom), checklistSha256: sha(readFileSync(checklistFile)),
    schemaSha256: sha(readFileSync(schemaFile)) };
  prepareGradingRoom(args);
  verifyGradingRoom(args);
  assert.deepEqual(readdirSync(out).sort(),
    [".grading-room.json", "checklist.json", "allure-lifecycle-result.schema.json",
      "impl", "plan", "work"].sort());
  assert.ok(existsSync(join(out, "plan", "01-booking-core", "spec.feature")));
  assert.ok(!existsSync(join(out, "plan", "02-private")));
  assert.ok(!existsSync(join(out, ".builder")));
  assert.throws(() => prepareGradingRoom(args), /already exists/);
  writeFileSync(join(out, "plan", "01-booking-core", "spec.feature"), "changed plan\n");
  assert.throws(() => verifyGradingRoom(args), /changed/);
  writeFileSync(join(out, "plan", "01-booking-core", "spec.feature"), "@item-01-001\n");
  writeFileSync(join(out, "impl", "start.sh"), "changed\n");
  assert.throws(() => verifyGradingRoom(args), /changed/);
});

test("grading room carries every selected product slice and excludes other plans", () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-multi-plan-room-"));
  const sourceRoom = join(root, "source"), candidateRoom = join(root, "candidate");
  const out = join(root, "grade"), checklistFile = join(root, "checklist.json");
  const schemaFile = join(root, "allure-lifecycle-result.schema.json");
  for (const name of ["01-booking-core", "02-occurrence-release", "03-private"]) {
    const dir = join(sourceRoom, "docs", "plan", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spec.feature"), `Feature: ${name}\n`);
  }
  mkdirSync(join(candidateRoom, "impl"), { recursive: true });
  writeFileSync(join(candidateRoom, "impl", "start.sh"), "#!/bin/sh\n");
  writeFileSync(checklistFile, JSON.stringify({ items: [
    { id: "01-001", source: "docs/plan/01-booking-core/spec.feature:2" },
    { id: "02-001", source: "docs/plan/02-occurrence-release/spec.feature:2" },
  ] }));
  writeFileSync(schemaFile, '{"type":"object"}\n');
  const args = { sourceRoom, candidateRoom, checklistFile, schemaFile, out,
    candidateSha256: candidateDigest(candidateRoom), checklistSha256: sha(readFileSync(checklistFile)),
    schemaSha256: sha(readFileSync(schemaFile)) };
  const receipt = prepareGradingRoom(args);
  assert.deepEqual(receipt.sourcePlans,
    ["plan/01-booking-core", "plan/02-occurrence-release"]);
  verifyGradingRoom(args);
  assert.ok(existsSync(join(out, "plan", "01-booking-core", "spec.feature")));
  assert.ok(existsSync(join(out, "plan", "02-occurrence-release", "spec.feature")));
  assert.ok(!existsSync(join(out, "plan", "03-private")));
  writeFileSync(join(out, "plan", "02-occurrence-release", "spec.feature"), "changed\n");
  assert.throws(() => verifyGradingRoom(args), /changed/);
});

test("grading room refuses a checklist source outside the numbered product plans", () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-bad-plan-room-"));
  const sourceRoom = join(root, "source"), candidateRoom = join(root, "candidate");
  const out = join(root, "grade"), checklistFile = join(root, "checklist.json");
  const schemaFile = join(root, "allure-lifecycle-result.schema.json");
  mkdirSync(join(candidateRoom, "impl"), { recursive: true });
  writeFileSync(join(candidateRoom, "impl", "start.sh"), "#!/bin/sh\n");
  writeFileSync(checklistFile, JSON.stringify({ items: [
    { id: "02-001", source: "docs/plan/../../private/spec.feature:2" },
  ] }));
  writeFileSync(schemaFile, '{"type":"object"}\n');
  assert.throws(() => prepareGradingRoom({ sourceRoom, candidateRoom, checklistFile,
    schemaFile, out, candidateSha256: candidateDigest(candidateRoom),
    checklistSha256: sha(readFileSync(checklistFile)),
    schemaSha256: sha(readFileSync(schemaFile)) }), /safe matching plan source/);
});

test('project identity and blind policy are bound in a reusable grading room', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-other-room-'));
  const sourceRoom = join(root, 'source'), candidateRoom = join(root, 'candidate');
  const out = join(root, 'grade'), checklistFile = join(root, 'checklist.json');
  const schemaFile = join(root, 'allure-lifecycle-result.schema.json');
  mkdirSync(join(sourceRoom, 'docs', 'plan', '01-health'), { recursive: true });
  mkdirSync(join(candidateRoom, 'impl'), { recursive: true });
  writeFileSync(join(sourceRoom, 'docs', 'plan', '01-health', 'spec.feature'), 'Feature: Health\n');
  writeFileSync(join(candidateRoom, 'impl', 'start.sh'), '#!/bin/sh\n');
  writeFileSync(checklistFile, JSON.stringify({ items: [{ id: '01-001',
    source: 'docs/plan/01-health/spec.feature:2' }] }));
  writeFileSync(schemaFile, '{"type":"object"}\n');
  const args = { sourceRoom, candidateRoom, checklistFile, schemaFile, out,
    candidateSha256: candidateDigest(candidateRoom), checklistSha256: sha(readFileSync(checklistFile)),
    schemaSha256: sha(readFileSync(schemaFile)), project: 'hello', blindReview: false };
  const receipt = prepareGradingRoom(args);
  assert.equal(receipt.project, 'hello');
  assert.equal(receipt.blindReview, false);
  verifyGradingRoom(args);
  assert.throws(() => verifyGradingRoom({ ...args, project: 'other' }), /changed/);
  assert.throws(() => verifyGradingRoom({ ...args, blindReview: true }), /changed/);
});
