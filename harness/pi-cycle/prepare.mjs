// The first Pi durable production phase: pin an approved Löyly cut and prove
// the original legacy harness's clean room before launching any agent.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBuilder } from "./builder-adapter.mjs";
import { runGate } from "./gate-adapter.mjs";
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
  const stage = found.stage ?? "prepare";
  if (!["prepare", "build", "gate"].includes(stage)) throw new Error("--stage must be prepare, build or gate");
  const build = stage === "build" || stage === "gate" ? {
    command: resolve(found["builder-command"] ?? join(ROOT, ".pi/harness/bin/builder.sh")),
    image: resolve(found["builder-image"] ?? ""),
    model: found["builder-model"],
    instructionSha256: found["builder-instruction-sha256"],
    commandSha256: found["builder-command-sha256"],
    imageSha256: found["builder-image-sha256"],
  } : null;
  if (build && (!found["builder-image"] || !build.model
      || [build.instructionSha256, build.commandSha256, build.imageSha256]
        .some((digest) => !/^[0-9a-f]{64}$/.test(digest ?? ""))))
    throw new Error("build needs image, model, instruction, command and image-manifest SHA-256 values");
  return { input: { state, commit, runId, checklistSha256 }, stage, build };
}

const cli = options(process.argv.slice(2));
const input = cli.input;
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

function candidateDigest(candidateRoom = room) {
  const app = join(candidateRoom, "impl");
  const start = join(app, "start.sh"), test = join(app, "test.sh");
  if (!existsSync(start) || !existsSync(test)) throw new Error("builder did not leave both legacy app entrypoints");
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: candidateRoom, encoding: "buffer" });
  if (status.status !== 0) throw new Error("cannot check builder write scope");
  for (const line of status.stdout.toString("utf8").split("\0").filter(Boolean)) {
    if (line.slice(0, 2) !== "??") throw new Error("builder modified a tracked clean-room file");
    const path = line.slice(3);
    if (!path.startsWith("impl/") && !path.startsWith(".builder/"))
      throw new Error(`builder wrote outside declared scope: ${path}`);
  }
  const digest = createHash("sha256");
  let fileCount = 0;
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = `${prefix}/${name}`, file = join(dir, name), stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, path);
      else if (stat.isFile()) {
        digest.update(path); digest.update("\0");
        digest.update(String(stat.mode & 0o777)); digest.update("\0");
        digest.update(readFileSync(file)); digest.update("\0");
        fileCount++;
      } else throw new Error(`candidate has a symlink or special file: ${path}`);
    }
  };
  walk(app, "impl");
  return { sha256: digest.digest("hex"), fileCount };
}

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
          runId: input.runId, cut: cutReceipt().cut, fenceCommit: git(room, "rev-parse", "HEAD"), itemCount: items,
          checklistSha256: actual, room,
        } } };
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const Build = defineTask({
  name: "loyly.pi.cycle.build", version: 1,
  initial: () => ({ phase: "instruction" }),
  phases: {
    instruction: async (task, runtime) => {
      const source = join(ROOT, "harness", "loyly", "builder-instruction.md");
      const bytes = readFileSync(source);
      const actual = hash(bytes);
      const commandSha256 = existsSync(task.input.command) ? fileHash(task.input.command) : null;
      const manifest = join(task.input.image, "manifest.json");
      const imageSha256 = existsSync(manifest) ? fileHash(manifest) : null;
      const approved = actual === task.input.instructionSha256
        && commandSha256 === task.input.commandSha256
        && imageSha256 === task.input.imageSha256;
      if (approved)
        writeFileSync(join(input.state, "builder-instruction.md"), bytes);
      await runtime.commit(async (tx) => {
        await audit(tx, task, "builder-input", approved ? "approved" : "refused", {
          instruction_sha256: actual, approved_instruction_sha256: task.input.instructionSha256,
          command_sha256: commandSha256, approved_command_sha256: task.input.commandSha256,
          image_sha256: imageSha256, approved_image_sha256: task.input.imageSha256 });
        return approved
          ? { status: "running", checkpoint: { phase: "launch" } } : fail("builder-instruction");
      }, ctx);
    },
    launch: async (task, runtime) => {
      const clean = fenced() && git(room, "rev-parse", "HEAD") === task.input.fenceCommit
        && fileHash(checklistFile) === task.input.checklistSha256;
      await runtime.commit(async (tx) => {
        await audit(tx, task, "build", clean ? "started" : "refused", {
          attempt: 1, session_id: `${input.runId}-attempt-1`, model: task.input.model,
          instruction_sha256: task.input.instructionSha256 });
        return clean ? { status: "running", checkpoint: { phase: "run" } } : fail("builder-room");
      }, ctx);
    },
    run: async (task, runtime) => {
      const sessionId = `${input.runId}-attempt-1`;
      let r, candidate, reason;
      try {
        if (git(room, "rev-parse", "HEAD") !== task.input.fenceCommit
            || fileHash(checklistFile) !== task.input.checklistSha256
            || fileHash(join(input.state, "builder-instruction.md")) !== task.input.instructionSha256
            || fileHash(task.input.command) !== task.input.commandSha256
            || fileHash(join(task.input.image, "manifest.json")) !== task.input.imageSha256)
          throw new Error("approved cut, checklist, instruction, host or image changed after launch");
        r = await runBuilder({ command: task.input.command, room,
          instruction: join(input.state, "builder-instruction.md"), image: task.input.image,
          evidenceDir: join(input.state, "evidence", "builder"), sessionId,
          model: task.input.model, stateRoot: join(ROOT, ".pi", "harness", ".state") });
        if (r.exit === 0) candidate = candidateDigest();
        else reason = "builder-host-exit";
      } catch (error) {
        reason = "builder-effect-or-scope";
        writeFileSync(join(input.state, "build-error.log"), `${error.stack ?? error}\n`);
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "build", candidate ? "completed" : "failed", {
          attempt: 1, session_id: sessionId, model: task.input.model,
          candidate_sha256: candidate?.sha256 ?? null, candidate_files: candidate?.fileCount ?? 0,
          reconciled: r?.reconciled ?? false, exit: r?.exit ?? null, reason_code: reason ?? null });
        return candidate ? { status: "terminal", outcome: { status: "completed", result: candidate } }
          : fail("build");
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const Gate = defineTask({
  name: "loyly.pi.cycle.gate", version: 1,
  initial: () => ({ phase: "room" }),
  phases: {
    room: async (task, runtime) => {
      const gateRoom = join(input.state, "gate", "attempt-1", "room");
      const marker = join(input.state, "gate", "attempt-1", "copy.json");
      const source = candidateDigest();
      if (source.sha256 !== task.input.candidateSha256
          || git(room, "rev-parse", "HEAD") !== task.input.fenceCommit)
        throw new Error("candidate changed after the builder completed");
      if (existsSync(gateRoom) && !existsSync(marker))
        throw new Error("gate-room copy was interrupted; inspect and replace its scratch directory");
      if (!existsSync(gateRoom)) {
        mkdirSync(dirname(gateRoom), { recursive: true });
        cpSync(room, gateRoom, { recursive: true });
        if (candidateDigest(gateRoom).sha256 !== source.sha256)
          throw new Error("gate copy differs from the builder candidate");
        writeFileSync(marker, JSON.stringify({ candidateSha256: source.sha256,
          fenceCommit: task.input.fenceCommit }));
      } else {
        const copy = JSON.parse(readFileSync(marker, "utf8"));
        if (copy.candidateSha256 !== source.sha256 || copy.fenceCommit !== task.input.fenceCommit)
          throw new Error("gate-room copy receipt differs from the builder candidate");
        if (candidateDigest(gateRoom).sha256 !== source.sha256)
          throw new Error("gate-room copy changed before verification");
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "gate-room", "prepared", { attempt: 1,
          candidate_sha256: source.sha256, fence_commit: task.input.fenceCommit });
        return { status: "running", checkpoint: { phase: "verify" } };
      }, ctx);
    },
    verify: async (task, runtime) => {
      const base = join(input.state, "gate", "attempt-1");
      let result, reason;
      try {
        result = await runGate({ room: join(base, "room"), out: join(base, "evidence"),
          candidateSha256: task.input.candidateSha256 });
      } catch (error) {
        reason = "gate-effect-incomplete";
        writeFileSync(join(base, "error.log"), `${error.stack ?? error}\n`);
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "gate", result?.exit === 0 ? "passed" : "failed", {
          attempt: 1, candidate_sha256: task.input.candidateSha256,
          log_sha256: result?.logSha256 ?? null, exit: result?.exit ?? null,
          reconciled: result?.reconciled ?? false, reason_code: reason ?? null });
        return result ? { status: "terminal", outcome: { status: "completed", result: {
          passed: result.exit === 0, attempt: 1, logSha256: result.logSha256 } } }
          : fail("gate");
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const registry = createRegistry();
registry.install(defineExtension({ name: "loyly-pi-cycle", tasks: [Prepare, Build, Gate] }));
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
  if ((cli.stage === "build" || cli.stage === "gate") && final.state.outcome?.status === "completed") {
    const buildInput = { ...cli.build, runId: input.runId, cut: final.state.outcome.result.cut,
      fenceCommit: final.state.outcome.result.fenceCommit ?? git(room, "rev-parse", "HEAD"),
      checklistSha256: input.checklistSha256 };
    const builds = await harness.commit((tx) => tx.scanTasks({ kind: "loyly.pi.cycle.build" }, 10), ctx);
    let buildId = builds.items[0]?.id;
    if (buildId && JSON.stringify(builds.items[0].input) !== JSON.stringify(buildInput))
      throw new Error("this store belongs to another approved builder input");
    if (!buildId) buildId = await harness.commit((tx) => tx.createTask(Build, buildInput,
      { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
    harness.resume();
    const built = await harness.waitForTask(buildId, ctx);
    console.log(JSON.stringify(built.state.outcome));
    if (built.state.outcome?.status !== "completed") process.exitCode = 1;
    if (cli.stage === "gate" && built.state.outcome?.status === "completed") {
      const gateInput = { runId: input.runId,
        fenceCommit: buildInput.fenceCommit,
        candidateSha256: built.state.outcome.result.sha256 };
      const gates = await harness.commit((tx) => tx.scanTasks({ kind: "loyly.pi.cycle.gate" }, 10), ctx);
      let gateId = gates.items[0]?.id;
      if (gateId && JSON.stringify(gates.items[0].input) !== JSON.stringify(gateInput))
        throw new Error("this store belongs to another gated candidate");
      if (!gateId) gateId = await harness.commit((tx) => tx.createTask(Gate, gateInput,
        { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
      harness.resume();
      const gated = await harness.waitForTask(gateId, ctx);
      console.log(JSON.stringify(gated.state.outcome));
      if (gated.state.outcome?.status !== "completed" || !gated.state.outcome.result?.passed)
        process.exitCode = 1;
    }
  }
} finally {
  await harness.close(ctx);
}
