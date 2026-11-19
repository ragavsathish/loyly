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
  mkdirSync(join(sourceRoom, "docs", "plan", "01-booking-core"), { recursive: true });
  mkdirSync(join(sourceRoom, "docs", "plan", "02-private"), { recursive: true });
  mkdirSync(join(candidateRoom, "impl"), { recursive: true });
  mkdirSync(join(candidateRoom, ".builder"));
  writeFileSync(join(sourceRoom, "docs", "plan", "01-booking-core", "spec.feature"), "@item-01-001\n");
  writeFileSync(join(sourceRoom, "docs", "plan", "02-private", "secret"), "unselected\n");
  writeFileSync(join(candidateRoom, "impl", "start.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(candidateRoom, ".builder", "transcript"), "builder-only\n");
  writeFileSync(checklistFile, '{"items":[{"id":"01-001"}]}\n');
  const args = { sourceRoom, candidateRoom, checklistFile, out,
    candidateSha256: candidateDigest(candidateRoom), checklistSha256: sha(readFileSync(checklistFile)) };
  prepareGradingRoom(args);
  verifyGradingRoom(args);
  assert.deepEqual(readdirSync(out).sort(),
    [".grading-room.json", "checklist.json", "impl", "plan", "work"].sort());
  assert.ok(existsSync(join(out, "plan", "01-booking-core", "spec.feature")));
  assert.ok(!existsSync(join(out, "plan", "02-private")));
  assert.ok(!existsSync(join(out, ".builder")));
  assert.throws(() => prepareGradingRoom(args), /already exists/);
  writeFileSync(join(out, "impl", "start.sh"), "changed\n");
  assert.throws(() => verifyGradingRoom(args), /changed/);
});
