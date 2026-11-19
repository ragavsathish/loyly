import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuilder } from "../builder-adapter.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(sleep = 0) {
  const root = mkdtempSync(join(tmpdir(), "loyly-builder-adapter-"));
  const room = join(root, "room"), image = join(root, "image"), evidenceDir = join(root, "evidence");
  mkdirSync(room); mkdirSync(image);
  const instruction = join(root, "instruction.md");
  writeFileSync(instruction, "Build the fixture.\n");
  const command = join(root, "builder-stub.sh");
  writeFileSync(command, `#!/bin/sh
set -eu
mkdir -p "$BUILDER_EVIDENCE_DIR/launch-1"
l="$BUILDER_EVIDENCE_DIR/launch-1/launch.txt"
{
  echo "session_id=$LOYLY_BUILDER_SESSION_ID"
  echo "room=$1"
  echo "builder_image=$3"
  echo "instruction_sha256=$(shasum -a 256 "$2" | cut -d' ' -f1)"
  echo "model=$LOYLY_PI_MODEL"
  echo "room_readonly_inputs=$LOYLY_ROOM_READONLY_INPUTS"
  echo "wrapper_pid=$$"
} > "$l"
sleep ${sleep}
mkdir -p "$1/impl"
echo built > "$1/impl/built.txt"
echo exit=0 >> "$l"
`);
  chmodSync(command, 0o755);
  return { command, room, instruction, image, evidenceDir, sessionId: "run-1-attempt-1",
    model: "test/model", stateRoot: root, timeoutMs: 10_000 };
}
const launches = (dir) => readdirSync(dir).filter((name) => /^launch-\d+$/.test(name));

test("completed builder launch is reconciled without a second process", async () => {
  const args = fixture();
  const first = await runBuilder(args);
  assert.equal(first.exit, 0);
  assert.equal(first.reconciled, false);
  assert.equal(readFileSync(join(args.room, "impl", "built.txt"), "utf8"), "built\n");
  const second = await runBuilder(args);
  assert.deepEqual([second.exit, second.reconciled], [0, true]);
  assert.equal(launches(args.evidenceDir).length, 1);
  await assert.rejects(() => runBuilder({ ...args, readonlyInputs: true }), /approved room/);
});

test("grader receipt pins its read-only VM policy on reopening", async () => {
  const args = { ...fixture(), readonlyInputs: true };
  assert.equal((await runBuilder(args)).exit, 0);
  assert.equal((await runBuilder(args)).reconciled, true);
  await assert.rejects(() => runBuilder({ ...args, readonlyInputs: false }), /approved room/);
});

test("a killed controller waits for the original builder, then reads its receipt", async () => {
  const args = fixture(2);
  const controller = spawn(process.execPath, [new URL("./invoke-builder.mjs", import.meta.url).pathname,
    JSON.stringify(args)], { stdio: "ignore" });
  for (let n = 0; n < 100 && !existsSync(join(args.evidenceDir, "launch-1", "launch.txt")); n++)
    await pause(20);
  assert.ok(existsSync(join(args.evidenceDir, "launch-1", "launch.txt")), "stub launched");
  controller.kill("SIGKILL");
  const result = await runBuilder(args);
  assert.deepEqual([result.exit, result.reconciled], [0, true]);
  assert.equal(launches(args.evidenceDir).length, 1);
});
