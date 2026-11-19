import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditRows } from "../audit-rows.mjs";
import { continuationPrompt, selectedUncarried } from "../continuation.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(here, "../../../..");
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

function fixtureEnv(scratch, mode = "carry") {
    const checklist = join(scratch, "approved-checklist.json");
    const generated = spawnSync("bb", ["harness/gen_checklist.clj", "--out", checklist],
      { cwd: root, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    assert.equal(head.status, 0, head.stderr);
    const image = join(root, ".pi/harness/.state/assets/builder-clojure");
    const command = join(here, "test/stub-continuation-builder.sh");
    return { ...process.env,
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
