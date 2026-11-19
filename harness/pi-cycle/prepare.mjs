// The first Pi durable production phase: pin an approved Löyly cut and prove
// the original legacy harness's clean room before launching any agent.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineEntry, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ctx = BACKGROUND_CONTEXT;
const Audit = defineEntry("loyly.pi.cycle.audit.v1");

function options(args) {
  const found = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1]) throw new Error("expected --name value pairs");
    found[args[i].slice(2)] = args[i + 1];
  }
  const state = resolve(found["state-dir"] ?? "");
  const commit = found.commit;
  const runId = found["run-id"];
  const checklistSha256 = found["checklist-sha256"];
  if (!found["state-dir"] || !/^[0-9a-f]{40}$/.test(commit ?? "")
      || !/^[A-Za-z0-9._-]+$/.test(runId ?? "")
      || !/^[0-9a-f]{64}$/.test(checklistSha256 ?? ""))
    throw new Error("usage: node prepare.mjs --state-dir DIR --commit 40-HEX --run-id ID --checklist-sha256 64-HEX");
  return { state, commit, runId, checklistSha256 };
}

const input = options(process.argv.slice(2));
const cutRoot = join(input.state, "cut");
const project = join(cutRoot, "project");
const room = join(input.state, "room");
const checklistFile = join(input.state, "checklist.json");
mkdirSync(input.state, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));

function command(stage, program, args, cwd = ROOT) {
  const r = spawnSync(program, args, { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 20 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(join(input.state, `${stage}.log`), output);
  return { code: r.status ?? 124, logSha256: hash(output), output };
}
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
function cutReceipt() {
  const path = join(cutRoot, "evidence", "cut.json");
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (receipt.base !== input.commit || receipt["run-id"] !== input.runId
      || receipt.project !== project || git(project, "rev-parse", "HEAD") !== receipt.cut)
    throw new Error("existing cut receipt differs from the approved input");
  return receipt;
}
function fenced() {
  if (!existsSync(room) || git(room, "rev-list", "--count", "--all") !== "1") return false;
  const fencedPaths = ["impl", ".pi", "archive/legacy-harness/cycles"];
  const objects = git(room, "rev-list", "--objects", "--all");
  if (objects === null) return false;
  const reachable = objects.split("\n").map((line) => line.slice(line.indexOf(" ") + 1));
  return fencedPaths.every((path) => !existsSync(join(room, path))
    && !reachable.some((name) => name === path || name.startsWith(`${path}/`)));
}
async function audit(tx, task, stage, outcome, detail = {}) {
  const data = { schema: "loyly.pi.cycle.audit.v1", run_id: task.input.runId,
    stage, outcome, at: new Date().toISOString(), task_id: String(task.id), ...detail };
  const entry = await tx.appendEntry(Audit, task.conversationId, { data });
  console.log(`${entry.id} ${stage} ${outcome}`);
}
const fail = (stage) => ({ status: "terminal", outcome: { status: "failed", error: stage } });

const Prepare = defineTask({
  name: "loyly.pi.cycle.prepare", version: 1,
  initial: () => ({ phase: "cut" }),
  phases: {
    cut: async (task, runtime) => {
      let receipt = cutReceipt();
      const r = receipt ? { code: 0, logSha256: hash("reconciled cut") }
        : existsSync(cutRoot) ? { code: 1, logSha256: hash("incomplete cut") }
        : command("cut", "bb", ["harness/loyly-run", "cut", "--commit", input.commit,
          "--state-dir", cutRoot, "--run-id", input.runId]);
      if (r.code === 0) receipt = cutReceipt();
      await runtime.commit(async (tx) => {
        await audit(tx, task, "cut", r.code === 0 ? "prepared" : "failed", {
          base_commit: input.commit, cut_commit: receipt?.cut ?? null, log_sha256: r.logSha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "self-check" } } : fail("cut");
      }, ctx);
    },
    "self-check": async (task, runtime) => {
      const r = command("self-check", "bash", ["harness/check.sh", "--local"], project);
      await runtime.commit(async (tx) => {
        await audit(tx, task, "self-check", r.code === 0 ? "passed" : "failed", { log_sha256: r.logSha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "fence" } } : fail("self-check");
      }, ctx);
    },
    fence: async (task, runtime) => {
      const r = fenced() ? { code: 0, logSha256: hash("reconciled fence") }
        : existsSync(room) ? { code: 1, logSha256: hash("incomplete fence") }
        : command("fence", "bash", ["harness/fence.sh", room], project);
      await runtime.commit(async (tx) => {
        await audit(tx, task, "fence", r.code === 0 && fenced() ? "passed" : "failed", { log_sha256: r.logSha256 });
        return r.code === 0 && fenced() ? { status: "running", checkpoint: { phase: "checklist" } } : fail("fence");
      }, ctx);
    },
    checklist: async (task, runtime) => {
      const r = command("checklist", "bb", ["harness/gen_checklist.clj", "--out", checklistFile], project);
      const actual = r.code === 0 ? fileHash(checklistFile) : null;
      const items = r.code === 0 ? JSON.parse(readFileSync(checklistFile, "utf8")).items.length : 0;
      const approved = actual === input.checklistSha256;
      await runtime.commit(async (tx) => {
        await audit(tx, task, "checklist", r.code === 0 && approved ? "approved" : "refused", {
          item_count: items, checklist_sha256: actual, approved_sha256: input.checklistSha256,
          log_sha256: r.logSha256 });
        if (r.code !== 0 || !approved) return fail("checklist");
        await audit(tx, task, "preparation", "completed", { item_count: items, cut_commit: cutReceipt().cut });
        return { status: "terminal", outcome: { status: "completed", result: {
          runId: input.runId, cut: cutReceipt().cut, itemCount: items,
          checklistSha256: actual, room,
        } } };
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const registry = createRegistry();
registry.install(defineExtension({ name: "loyly-pi-cycle", tasks: [Prepare] }));
const harness = await Harness.open(await openNodeSqliteStorage(join(input.state, "cycle.sqlite")),
  { models: createModels(), registry }, ctx);
try {
  const root = await harness.root(ctx);
  const existing = await harness.commit((tx) => tx.scanTasks({ kind: "loyly.pi.cycle.prepare" }, 10), ctx);
  let id = existing.items[0]?.id;
  if (id && JSON.stringify(existing.items[0].input) !== JSON.stringify(input))
    throw new Error("this state directory belongs to another approved run input");
  if (!id) id = await harness.commit((tx) => tx.createTask(Prepare, input,
    { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
  harness.resume();
  const final = await harness.waitForTask(id, ctx);
  console.log(JSON.stringify(final.state.outcome));
  if (final.state.outcome?.status !== "completed") process.exitCode = 1;
} finally {
  await harness.close(ctx);
}
