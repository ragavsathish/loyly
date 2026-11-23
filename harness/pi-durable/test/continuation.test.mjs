import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from 'effect';
import { readAuditRows } from "../audit-rows.ts";
import { continuationPrompt, selectedUncarried, selectedUncarriedEffect } from "../continuation.ts";
import { genChecklist } from "../measure/index.ts";
import { WorkspaceFiles } from '../workspace-effects.ts';

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(here, "../..");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("uncarried selection names only approved item lines", () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-uncarried-"));
  try {
    const room = join(scratch, "room");
    const made = spawnSync("mkdir", ["-p", join(room, "impl")]);
    assert.equal(made.status, 0);
    const checklist = join(scratch, "checklist.json");
    writeFileSync(checklist, JSON.stringify({ items: [{ id: "01-001" }, { id: "01-002" }] }));
    writeFileSync(join(room, "impl", "UNCARRIED.md"),
      "- @item-01-002: reason A\nProse @item-01-001\n- @item-01-999: other\n* `@item-01-001`: reason B\n");
    const ids = selectedUncarried(room, checklist);
    assert.deepEqual(ids, ["01-001", "01-002"]);
    assert.match(continuationPrompt(ids), /@item-01-001, @item-01-002/);
    assert.doesNotMatch(continuationPrompt(ids), /reason A|reason B/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("whole-product continuation carries selected items beyond booking core", () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-whole-uncarried-"));
  try {
    const room = join(scratch, "room");
    assert.equal(spawnSync("mkdir", ["-p", join(room, "impl")]).status, 0);
    const checklist = join(scratch, "checklist.json");
    writeFileSync(checklist, JSON.stringify({ items: [
      { id: "01-011" }, { id: "02-005" }, { id: "03-014" },
    ] }));
    writeFileSync(join(room, "impl", "UNCARRIED.md"),
      "- @item-02-005: resale\n* `@item-03-014`: notice\n- @item-04-001: unselected\n- @item-01-0110: malformed\n");
    const ids = selectedUncarried(room, checklist);
    assert.deepEqual(ids, ["02-005", "03-014"]);
    assert.match(continuationPrompt(ids), /@item-02-005, @item-03-014/);
    assert.throws(() => continuationPrompt(["06-1"]), /selected product item IDs/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('continuation file effects are lazy and injectable', () => {
  const reads = [];
  const layer = Layer.succeed(WorkspaceFiles, {
    exists: (path) => Effect.succeed(path === '/room/impl/UNCARRIED.md'),
    readText: (path) => Effect.sync(() => {
      reads.push(path);
      return path === '/checklist'
        ? JSON.stringify({ items: [{ id: '02-005' }] })
        : '- @item-02-005: pending\n- @item-02-999: unrelated\n';
    }),
  });
  const selection = selectedUncarriedEffect('/room', '/checklist').pipe(Effect.provide(layer));
  assert.deepEqual(reads, []);
  assert.deepEqual(Effect.runSync(selection), ['02-005']);
  assert.deepEqual(reads, ['/checklist', '/room/impl/UNCARRIED.md']);
  const invalid = Layer.succeed(WorkspaceFiles, {
    exists: () => Effect.succeed(true),
    readText: () => Effect.succeed('{broken'),
  });
  const error = Effect.runSync(Effect.flip(
    selectedUncarriedEffect('/room', '/checklist').pipe(Effect.provide(invalid))));
  assert.equal(error._tag, 'InvalidWorkspaceData');
  assert.equal(error.path, '/checklist');
});

function fixtureEnv(scratch, mode = "carry", builderCommand) {
    const checklist = join(scratch, "approved-checklist.json");
    genChecklist({ root, out: checklist });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    assert.equal(head.status, 0, head.stderr);
    const image = join(root, ".pi/harness/.state/assets/builder-clojure");
    const command = builderCommand ?? join(here, "test/stub-continuation-builder.sh");
    return { ...process.env,
      LOYLY_SOURCE_REPO: root,
      LOYLY_APPROVED_COMMIT: head.stdout.trim(), LOYLY_APPROVED_CHECKLIST_SHA256: sha(checklist),
      LOYLY_BUILDER_COMMAND: command, LOYLY_BUILDER_IMAGE: image,
      LOYLY_BUILDER_MODEL: "test/continuing-builder",
      LOYLY_BUILDER_COMMAND_SHA256: sha(command),
      LOYLY_BUILDER_IMAGE_SHA256: sha(join(image, "manifest.json")),
      LOYLY_BUILDER_INSTRUCTION_SHA256: sha(join(here, "builder-instruction.md")),
      LOYLY_TEST_CONTINUATION_MODE: mode,
      JAVA_HOME: "/opt/homebrew/opt/openjdk@21" };
}

function startWorker(scratch, env) {
    const child = spawn(process.execPath, [join(here, "worker.mjs"), scratch, "live"],
      { cwd: here, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (bytes) => { output += bytes; });
    child.stderr.on("data", (bytes) => { output += bytes; });
    const closed = new Promise((resolveDone, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolveDone(code));
      });
    return { child, closed, output: () => output };
}

async function finish(worker) {
    let timer;
    const done = await Promise.race([
      worker.closed,
      new Promise((_, reject) => { timer = setTimeout(() => {
        worker.child.kill("SIGTERM");
        reject(new Error(`continuation cycle timed out: ${worker.output()}`));
      }, 60_000); }),
    ]);
    clearTimeout(timer);
    assert.equal(done, 1, worker.output()); // no grader is attached to this controller test
}

async function runCycle(mode = "carry") {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-continuation-"));
  try {
    const env = fixtureEnv(scratch, mode);
    await finish(startWorker(scratch, env));
    return await readAuditRows(scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("live cycle continues one Pi session on its own uncarried list before gate", async () => {
  const rows = await runCycle();
  const turns = rows.filter((row) => row.stage === "builder-continuation" && row.outcome === "completed");
  assert.deepEqual(turns.map((row) => row.continued_ids),
    [["01-001", "01-002"], ["01-002"]]);
  assert.deepEqual(turns.map((row) => row.request_id),
    ["prototype-cycle-1-attempt-1-c1", "prototype-cycle-1-attempt-1-c2"]);
  assert.ok(turns.every((row) => row.session_id === "prototype-cycle-1-attempt-1" && row.changed));
  assert.deepEqual(rows.findLast((row) => row.stage === "builder-continuation").remaining_uncarried, []);
  assert.ok(rows.find((row) => row.stage === "gate" && row.outcome === "passed").seq > turns[1].seq);
});

test("pinned cut clones the approved source checkout instead of the controller checkout", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-external-source-"));
  try {
    const sourceRepo = join(scratch, "source");
    const cloned = spawnSync("git", ["clone", "-q", "--shared", root, sourceRepo], { encoding: "utf8" });
    assert.equal(cloned.status, 0, cloned.stderr);
    const env = { ...fixtureEnv(scratch, "unchanged"), LOYLY_SOURCE_REPO: sourceRepo };
    await finish(startWorker(scratch, env));
    const receipt = JSON.parse(readFileSync(join(scratch, "cut", "cut.json"), "utf8"));
    assert.equal(receipt.source_repo, sourceRepo);
    assert.equal(receipt.commit, env.LOYLY_APPROVED_COMMIT);
    const cutHead = spawnSync("git", ["rev-parse", "HEAD"],
      { cwd: join(scratch, "cut", "project"), encoding: "utf8" });
    assert.equal(cutHead.stdout.trim(), env.LOYLY_APPROVED_COMMIT);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("unchanged continuation stops before a second turn", async () => {
  const rows = await runCycle("unchanged");
  const turns = rows.filter((row) => row.stage === "builder-continuation" && row.outcome === "completed");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].changed, false);
  assert.ok(rows.find((row) => row.stage === "gate" && row.outcome === "passed").seq > turns[0].seq);
});

test("continuation stops at three turns with remaining IDs recorded", async () => {
  const rows = await runCycle("cap");
  const turns = rows.filter((row) => row.stage === "builder-continuation" && row.outcome === "completed");
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((row) => row.continuation), [1, 2, 3]);
  const stop = rows.findLast((row) => row.stage === "builder-continuation");
  assert.equal(stop.reason, "limit");
  assert.deepEqual(stop.remaining_uncarried, ["01-001", "01-002"]);
  assert.ok(rows.find((row) => row.stage === "gate" && row.outcome === "passed").seq > stop.seq);
});

test("failed builder turn forks its partial candidate and retries before grading", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-builder-fork-"));
  try {
    const command = join(here, "test/stub-fork-builder.sh");
    const env = fixtureEnv(scratch, "carry", command);
    await finish(startWorker(scratch, env));
    const rows = await readAuditRows(scratch);
    assert.deepEqual(rows.filter((row) => row.stage === "build" || row.stage === "repair")
      .map((row) => [row.attempt, row.outcome]),
      [[1, "started"], [1, "failed"], [2, "started"], [2, "completed"]]);
    assert.deepEqual(rows.filter((row) => row.stage === "retry").map((row) => row.attempt), [2]);
    assert.equal(rows.find((row) => row.stage === "gate")?.outcome, "passed");
    assert.ok(rows.find((row) => row.stage === "retry").seq
      < rows.find((row) => row.stage === "gate").seq);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("red gate forks the old build with its gate log before the second verify", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-gate-fork-"));
  try {
    const command = join(here, "test/stub-fork-builder.sh");
    const env = { ...fixtureEnv(scratch, "carry", command), LOYLY_TEST_FORK_MODE: "gate-red" };
    await finish(startWorker(scratch, env));
    const rows = await readAuditRows(scratch);
    assert.deepEqual(rows.filter((row) => row.stage === "gate")
      .map((row) => [row.attempt, row.outcome]), [[1, "failed"], [2, "passed"]]);
    assert.deepEqual(rows.filter((row) => row.stage === "retry").map((row) => row.attempt), [2]);
    const parent = JSON.parse(readFileSync(join(scratch, "builder-1-evidence", "session.json"), "utf8"));
    const fork = JSON.parse(readFileSync(join(scratch, "builder-2-evidence", "session.json"), "utf8"));
    assert.equal(fork.conversationId, parent.conversationId + 1);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("completed but incomplete builder forks before any gate", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-incomplete-fork-"));
  try {
    const command = join(here, "test/stub-fork-builder.sh");
    const env = { ...fixtureEnv(scratch, "carry", command), LOYLY_TEST_FORK_MODE: "incomplete" };
    await finish(startWorker(scratch, env));
    const rows = await readAuditRows(scratch);
    assert.deepEqual(rows.filter((row) => row.stage === "build" || row.stage === "repair")
      .filter((row) => row.outcome === "failed" || row.outcome === "completed")
      .map((row) => [row.attempt, row.outcome]), [[1, "failed"], [2, "completed"]]);
    assert.deepEqual(rows.filter((row) => row.stage === "gate")
      .map((row) => [row.attempt, row.outcome]), [[2, "passed"]]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("three failed forked builder turns stop without a gate or grader", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-builder-fork-red-"));
  try {
    const command = join(here, "test/stub-fork-builder.sh");
    const env = { ...fixtureEnv(scratch, "carry", command), LOYLY_TEST_FORK_MODE: "alwaysfail" };
    const worker = startWorker(scratch, env);
    assert.equal(await worker.closed, 1, worker.output());
    const rows = await readAuditRows(scratch);
    assert.deepEqual(rows.filter((row) => row.stage === "build" || row.stage === "repair")
      .filter((row) => row.outcome === "failed").map((row) => row.attempt), [1, 2, 3]);
    assert.equal(rows.findLast((row) => row.stage === "cycle").reason, "builder-attempts-exhausted");
    assert.ok(!rows.some((row) => row.stage === "gate" || row.stage === "grade"));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("controller restart rejoins an in-flight continuation without a duplicate request", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-continuation-restart-"));
  let first, resumed;
  try {
    const env = { ...fixtureEnv(scratch), LOYLY_TEST_CONTINUATION_DELAY_SECONDS: "3" };
    first = startWorker(scratch, env);
    const launch = join(scratch, "builder-1-evidence", "launch-2", "launch.txt");
    for (let n = 0; n < 600 && !existsSync(launch); n++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.ok(existsSync(launch), first.output());
    first.child.kill("SIGKILL");
    assert.equal(await first.closed, null);
    resumed = startWorker(scratch, env);
    await finish(resumed);
    const rows = await readAuditRows(scratch);
    const turns = rows.filter((row) => row.stage === "builder-continuation" && row.outcome === "completed");
    assert.deepEqual(turns.map((row) => row.continued_ids),
      [["01-001", "01-002"], ["01-002"]]);
    assert.equal(turns[0].reconciled, true);
    const launches = readdirSync(join(scratch, "builder-1-evidence"))
      .filter((name) => /^launch-\d+$/.test(name));
    assert.deepEqual(launches.sort(), ["launch-1", "launch-2", "launch-3"]);
    assert.ok(rows.find((row) => row.stage === "gate" && row.outcome === "passed").seq > turns[1].seq);
  } finally {
    if (first?.child.exitCode === null) first.child.kill("SIGTERM");
    if (resumed?.child.exitCode === null) resumed.child.kill("SIGTERM");
    rmSync(scratch, { recursive: true, force: true });
  }
});
