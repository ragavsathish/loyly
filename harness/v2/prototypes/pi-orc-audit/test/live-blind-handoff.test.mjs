import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(here, "../../../..");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function until(predicate, deadlineMs = 60_000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await pause(100);
  }
  throw new Error("timed out waiting for the durable blind-review handoff");
}
function worker(scratch, env) {
  const child = spawn(process.execPath, [join(here, "worker.mjs"), scratch, "live"],
    { cwd: here, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  const closed = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveClose({ code, signal, output }));
  });
  return { child, closed, output: () => output };
}

test("live stub cycle waits across a controller kill, then scores the separate blind result", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-live-blind-handoff-"));
  const checklist = join(scratch, "approved-checklist.json");
  const generated = spawnSync("bb", ["harness/gen_checklist.clj", "--out", checklist],
    { cwd: root, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
  const image = join(root, ".pi/harness/.state/assets/builder-clojure");
  const builderCommand = join(here, "test/stub-green-builder.sh");
  const graderCommand = join(here, "test/stub-grader.sh");
  const settings = join(root, ".pi/harness/config/pi.grader.settings.json");
  const env = { ...process.env,
    LOYLY_APPROVED_COMMIT: commit.stdout.trim(),
    LOYLY_APPROVED_CHECKLIST_SHA256: sha(checklist),
    LOYLY_BUILDER_COMMAND: builderCommand, LOYLY_BUILDER_IMAGE: image,
    LOYLY_BUILDER_MODEL: "test/green-builder",
    LOYLY_BUILDER_COMMAND_SHA256: sha(builderCommand),
    LOYLY_BUILDER_IMAGE_SHA256: sha(join(image, "manifest.json")),
    LOYLY_BUILDER_INSTRUCTION_SHA256: sha(join(here, "builder-instruction.md")),
    LOYLY_GRADER_COMMAND: graderCommand, LOYLY_GRADER_IMAGE: image,
    LOYLY_GRADER_MODEL: "test/black-box-grader",
    LOYLY_GRADER_COMMAND_SHA256: sha(graderCommand),
    LOYLY_GRADER_IMAGE_SHA256: sha(join(image, "manifest.json")),
    LOYLY_GRADER_SETTINGS: settings, LOYLY_GRADER_SETTINGS_SHA256: sha(settings),
    LOYLY_GRADER_INSTRUCTION_SHA256: sha(join(here, "grader-instruction-01.md")),
    LOYLY_GRADER_SCHEMA_SHA256: sha(join(here, "allure-lifecycle-result.schema.json")),
    LOYLY_GRADER_SHARDS: "3",
  };
  let first, resumed;
  try {
    first = worker(scratch, env);
    const packetDir = join(scratch, "blind-agent-packet");
    await until(() => existsSync(join(packetDir, "response-template.json"))
      || first.output().includes("FINAL"));
    assert.ok(existsSync(join(packetDir, "response-template.json")), first.output());
    assert.ok(!existsSync(join(scratch, "instrument", "harness", "cycles", "02", "scores.json")));
    first.child.kill("SIGKILL");
    assert.equal((await first.closed).signal, "SIGKILL");
    resumed = worker(scratch, env);
    const review = JSON.parse(readFileSync(join(packetDir, "response-template.json"), "utf8"));
    Object.assign(review, { reviewer: "test-only blind agent", had_not_read_configuration: true,
      saw_only_refusal: true, answer: "I cannot identify a request from this fixture refusal",
      verdict: "fail", reason: "Fixture reviewer could not act", reviewed_at: Date.now() });
    const reviewFile = join(scratch, "blind-agent-review.json");
    writeFileSync(`${reviewFile}.partial`, `${JSON.stringify(review)}\n`);
    renameSync(`${reviewFile}.partial`, reviewFile);
    const deadline = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `resumed worker did not finish: ${resumed.output()}`)), 35_000);
      timer.unref();
    });
    const done = await Promise.race([resumed.closed, deadline]);
    assert.equal(done.code, 1, done.output); // live measurement is not automatic acceptance
    assert.match(done.output, /blind-review completed/);
    assert.match(done.output, /score filed/);
    const scores = JSON.parse(readFileSync(join(scratch, "instrument", "harness", "cycles", "02", "scores.json")));
    assert.equal(scores.items.filter((item) => item.verdict === "pass").length, 10);
    assert.equal(scores.items.find((item) => item.id === "01-011").verdict, "fail");
    assert.equal(JSON.parse(readFileSync(join(scratch, "final-verdicts.json"))).length, 11);
  } finally {
    if (first?.child.exitCode === null) first.child.kill("SIGTERM");
    if (resumed?.child.exitCode === null) resumed.child.kill("SIGTERM");
    rmSync(scratch, { recursive: true, force: true });
  }
});
