// THROWAWAY PROTOTYPE on scope-impact/master. Pi durable owns the original
// legacy harness cycle. Builder and grader are explicitly deterministic fixtures.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, chmodSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineEntry, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runGate } from "./gate-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const ctx = BACKGROUND_CONTEXT;
const Audit = defineEntry("loyly.proto.audit.v1");
const scratch = resolve(process.argv[2] ?? join(HERE, "scratch"));
const storePath = join(scratch, "cycle.PROTOTYPE.sqlite");
const room = join(scratch, "fenced-room");
const gradingRoom = join(scratch, "grading-room");
const instrument = join(scratch, "instrument");
const approvedCommit = process.env.LOYLY_APPROVED_COMMIT;
if (approvedCommit && !/^[0-9a-f]{40}$/.test(approvedCommit))
  throw new Error("LOYLY_APPROVED_COMMIT must be a full 40-character commit ID");
const approvedChecklistSha256 = process.env.LOYLY_APPROVED_CHECKLIST_SHA256 ?? null;
if (approvedCommit && !/^[0-9a-f]{64}$/.test(approvedChecklistSha256 ?? ""))
  throw new Error("a pinned cut needs LOYLY_APPROVED_CHECKLIST_SHA256");
const cut = join(scratch, "cut");
const sourceRoot = approvedCommit ? join(cut, "project") : ROOT;
const mode = process.argv[3] ?? "repair"; // repair: red first gate, green second; three-red: all red
mkdirSync(scratch, { recursive: true });

const hash = (value) => createHash("sha256").update(value).digest("hex");
const resultPath = (name) => join(scratch, `${name}.log`);
function command(name, program, args, options = {}) {
  const r = spawnSync(program, args, {
    cwd: options.cwd ?? sourceRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    timeout: options.timeout ?? 900_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(resultPath(name), output);
  return { code: r.status ?? 124, output, sha256: hash(output), log: resultPath(name) };
}
async function audit(tx, task, stage, outcome, extra = {}) {
  const data = {
    schema: "loyly.proto.audit.v1", run_id: "prototype-cycle-1", stage, outcome,
    at: new Date().toISOString(), task_id: String(task.id), ...extra,
  };
  const entry = await tx.appendEntry(Audit, task.conversationId, { data });
  console.log(`${entry.id} ${stage} ${outcome}${data.attempt ? ` attempt ${data.attempt}` : ""}`);
  return entry;
}
function proofOfFence() {
  if (!existsSync(room)) return false;
  const roots = spawnSync("git", ["-C", room, "rev-list", "--count", "--all"], { encoding: "utf8" });
  return roots.status === 0 && roots.stdout.trim() === "1"
    && !existsSync(join(room, "impl")) && !existsSync(join(room, "harness", "cycles"));
}
function gitAt(path, ...args) {
  const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
function proveCut() {
  if (!approvedCommit) return true;
  const receipt = join(cut, "cut.json");
  if (!existsSync(receipt) || !existsSync(sourceRoot)) return false;
  const recorded = JSON.parse(readFileSync(receipt, "utf8"));
  return recorded.commit === approvedCommit && recorded.project === sourceRoot
    && gitAt(sourceRoot, "rev-parse", "HEAD") === approvedCommit
    && gitAt(sourceRoot, "status", "--porcelain") === "";
}
function candidateDigest(candidateRoom = room) {
  const digest = createHash("sha256");
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = `${prefix}/${name}`, file = join(dir, name), stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, path);
      else if (stat.isFile()) {
        digest.update(path); digest.update("\0");
        digest.update(String(stat.mode & 0o777)); digest.update("\0");
        digest.update(readFileSync(file)); digest.update("\0");
      } else throw new Error(`candidate has a symlink or special file: ${path}`);
    }
  };
  walk(join(candidateRoom, "impl"), "impl");
  return digest.digest("hex");
}
function gateRoomFor(attempt, digest) {
  const base = join(scratch, `gate-${attempt}`), gateRoom = join(base, "room");
  const marker = join(base, "copy.json");
  if (existsSync(gateRoom) && !existsSync(marker))
    throw new Error("gate-room copy was interrupted; inspect its scratch directory");
  if (!existsSync(gateRoom)) {
    mkdirSync(base, { recursive: true });
    cpSync(room, gateRoom, { recursive: true });
    if (candidateDigest(gateRoom) !== digest) throw new Error("gate copy differs from candidate");
    writeFileSync(marker, JSON.stringify({ candidateSha256: digest }));
  } else if (JSON.parse(readFileSync(marker, "utf8")).candidateSha256 !== digest
      || (!existsSync(join(scratch, `gate-${attempt}-evidence`, "intent.json"))
        && candidateDigest(gateRoom) !== digest)) {
    throw new Error("gate-room copy receipt differs from candidate");
  }
  return gateRoom;
}

const Builder = defineTask({
  name: "loyly.proto.builder", version: 1,
  initial: () => ({ phase: "announce" }),
  phases: {
    announce: async (task, runtime) => runtime.commit(async (tx) => {
      await audit(tx, task, task.input.attempt === 1 ? "build" : "repair", "started", {
        attempt: task.input.attempt, session_id: `builder-${task.input.attempt}`,
        fixture: true, previous_gate_log: task.input.previousGateLog ?? null,
      });
      return { status: "sleeping", until: Date.now() + 1200, checkpoint: { phase: "materialize" } };
    }, ctx),
    materialize: async (task, runtime) => {
      const target = join(room, "impl");
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      // Tiny sauna fixture. The upstream repository has no built app to copy.
      cpSync(join(HERE, "fixture", "legacy-app"), target, { recursive: true });
      const red = mode === "three-red" || task.input.attempt === 1;
      if (red) {
        writeFileSync(join(target, "test.sh"), "#!/bin/sh\necho 'fixture red suite'\nexit 1\n");
        chmodSync(join(target, "test.sh"), 0o755);
      }
      // An explicit fixture continuation in the same child session before the gate.
      await runtime.commit(async (tx) => {
        await audit(tx, task, "builder-continuation", "completed", {
          attempt: task.input.attempt, session_id: `builder-${task.input.attempt}`,
          remaining_uncarried: 0, fixture: true,
        });
        await audit(tx, task, task.input.attempt === 1 ? "build" : "repair", "completed", {
          attempt: task.input.attempt, candidate_digest: hash(readFileSync(join(target, "test.sh"))),
          fixture: true,
        });
        return { status: "terminal", outcome: { status: "completed", result: { red } } };
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const Gate = defineTask({
  name: "loyly.proto.gate", version: 1,
  initial: () => ({ phase: "verify" }),
  phases: {
    verify: async (task, runtime) => {
      const attempt = task.input.attempt;
      const out = join(scratch, `gate-${attempt}-evidence`);
      const digest = candidateDigest();
      const gateRoom = gateRoomFor(attempt, digest);
      const r = await runGate({ room: gateRoom, out, candidateSha256: digest, timeoutMs: 900_000 });
      const log = join(out, "gate.log");
      await runtime.commit(async (tx) => {
        await audit(tx, task, "gate", r.exit === 0 ? "passed" : "failed", {
          attempt, gate_log: log, gate_log_sha256: r.logSha256, exit: r.exit,
          candidate_digest: digest, reconciled: r.reconciled,
        });
        return { status: "terminal", outcome: { status: "completed", result: {
          passed: r.exit === 0, log,
        } } };
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const Grade = defineTask({
  name: "loyly.proto.grade", version: 1,
  initial: () => ({ phase: "file" }),
  phases: {
    file: async (task, runtime) => {
      // Independent grader task is a deterministic fixture. The legacy score and
      // scoreboard below are real; no grader claim is treated as a gate verdict.
      const selected = readFileSync(join(gradingRoom, "checklist.txt"), "utf8").trim().split("\n")
        .map((id) => ({ id }));
      const verdicts = selected.map((item) => ({ id: item.id,
        verdict: item.id === "01-010" ? "fail" : "pass",
        evidence: `prototype fixture grader observed ${item.id}` }));
      writeFileSync(join(scratch, "verdicts.json"), JSON.stringify(verdicts));
      await runtime.commit(async (tx) => {
        await audit(tx, task, "grade", "completed", {
          fixture: true, item_count: verdicts.length, fail_count: verdicts.filter((v) => v.verdict === "fail").length,
          verdicts_sha256: hash(readFileSync(join(scratch, "verdicts.json"))),
        });
        return { status: "terminal", outcome: { status: "completed", result: { count: verdicts.length } } };
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const Cycle = defineTask({
  name: "loyly.proto.cycle", version: 1,
  initial: () => ({ phase: "cut" }),
  phases: {
    cut: async (task, runtime) => {
      let r = { code: 0, sha256: hash("original source: no cut requested") };
      if (approvedCommit && !proveCut()) {
        if (existsSync(cut)) throw new Error("incomplete or changed original-source cut");
        mkdirSync(cut, { recursive: true });
        r = command("cut-clone", "git", ["clone", "-q", "--no-local", "--no-checkout", ROOT, sourceRoot], { cwd: ROOT });
        if (r.code === 0) r = command("cut-checkout", "git", ["checkout", "-q", "--detach", approvedCommit], { cwd: sourceRoot });
        if (r.code === 0 && gitAt(sourceRoot, "rev-parse", "HEAD") === approvedCommit
            && gitAt(sourceRoot, "status", "--porcelain") === "")
          writeFileSync(join(cut, "cut.json"), JSON.stringify({ commit: approvedCommit, project: sourceRoot }));
        if (!proveCut()) r = { ...r, code: 1 };
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "cut", r.code === 0 ? "pinned" : "failed", {
          approved_commit: approvedCommit ?? null, source_root: sourceRoot, log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "preflight" } }
          : { status: "terminal", outcome: { status: "failed", error: "cut" } };
      }, ctx);
    },
    preflight: async (task, runtime) => {
      const r = command("preflight", "bash", ["harness/check.sh", "--local"]);
      await runtime.commit(async (tx) => {
        await audit(tx, task, "self-check", r.code === 0 ? "passed" : "failed", { log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "fence" } }
          : { status: "terminal", outcome: { status: "failed", error: "self-check" } };
      }, ctx);
    },
    fence: async (task, runtime) => {
      let r;
      if (proofOfFence()) r = { code: 0, output: "fence OK: reconciled", sha256: hash("fence OK: reconciled") };
      else r = command("fence", "bash", ["harness/fence.sh", room]);
      await runtime.commit(async (tx) => {
        await audit(tx, task, "fence", r.code === 0 ? "passed" : "failed", { room, log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "checklist" } }
          : { status: "terminal", outcome: { status: "failed", error: "fence" } };
      }, ctx);
    },
    checklist: async (task, runtime) => {
      const r = command("checklist", "bb", ["harness/gen_checklist.clj", "--out", join(scratch, "checklist.json")]);
      const n = r.code === 0 ? JSON.parse(readFileSync(join(scratch, "checklist.json"), "utf8")).items.length : 0;
      const actual = r.code === 0 ? hash(readFileSync(join(scratch, "checklist.json"))) : null;
      const approved = !approvedCommit || actual === approvedChecklistSha256;
      await runtime.commit(async (tx) => {
        await audit(tx, task, "checklist", r.code === 0 && approved ? "derived" : "refused", {
          item_count: n, checklist_sha256: actual, approved_sha256: approvedChecklistSha256,
          log_sha256: r.sha256 });
        return r.code === 0 && approved ? { status: "running", checkpoint: { phase: "render" } }
          : { status: "terminal", outcome: { status: "failed", error: "checklist" } };
      }, ctx);
    },
    render: async (task, runtime) => {
      // The original harness has no prompt renderer. Record the exact legacy
      // README and plan the fixture builder would receive, without inventing a v2 tool.
      const plan = readFileSync(join(sourceRoot, "docs", "plan", "01-booking-core", "spec.feature"), "utf8");
      const instruction = `${readFileSync(join(sourceRoot, "harness", "README.md"), "utf8")}\n\n${plan}`;
      writeFileSync(join(scratch, "prompt.txt"), instruction);
      const r = { code: 0, sha256: hash(instruction) };
      await runtime.commit(async (tx) => {
        await audit(tx, task, "render", r.code === 0 ? "completed" : "failed", { log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "build", attempt: 1, previousGateLog: null } }
          : { status: "terminal", outcome: { status: "failed", error: "render" } };
      }, ctx);
    },
    build: async (task, runtime) => runtime.commit(async (tx) => {
      const { attempt, previousGateLog } = task.state.checkpoint;
      const id = await tx.createTask(Builder, { attempt, previousGateLog }, { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-build", attempt, builder: id }, on: [id], policy: "failFast" };
    }, ctx),
    "after-build": async (task, runtime) => {
      const { attempt, builder } = task.state.checkpoint;
      await runtime.outcomes([builder], ctx);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "gate", attempt } }), ctx);
    },
    gate: async (task, runtime) => runtime.commit(async (tx) => {
      const { attempt } = task.state.checkpoint;
      const id = await tx.createTask(Gate, { attempt }, { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-gate", attempt, gate: id }, on: [id], policy: "failFast" };
    }, ctx),
    "after-gate": async (task, runtime) => {
      const { attempt, gate } = task.state.checkpoint;
      const [outcome] = await runtime.outcomes([gate], ctx);
      const result = outcome.result;
      await runtime.commit(async (tx) => {
        if (result.passed) return { status: "running", checkpoint: { phase: "grading-room", attempt } };
        if (attempt < 3) {
          await audit(tx, task, "retry", "scheduled", { attempt: attempt + 1, previous_gate_log: result.log });
          return { status: "running", checkpoint: { phase: "build", attempt: attempt + 1, previousGateLog: result.log } };
        }
        await audit(tx, task, "cycle", "failed", { reason: "gate-attempts-exhausted", attempt });
        return { status: "terminal", outcome: { status: "completed", result: { passed: false, attempts: attempt } } };
      }, ctx);
    },
    "grading-room": async (task, runtime) => {
      let r;
      if (existsSync(join(gradingRoom, ".grading-room.txt"))) {
        r = { code: 0, sha256: hash(readFileSync(join(gradingRoom, ".grading-room.txt"))) };
      } else {
        mkdirSync(gradingRoom, { recursive: true });
        cpSync(join(room, "impl"), join(gradingRoom, "impl"), { recursive: true });
        cpSync(join(room, "docs", "plan"), join(gradingRoom, "plan"), { recursive: true });
        const ids = JSON.parse(readFileSync(join(scratch, "checklist.json"), "utf8")).items.map((item) => item.id);
        writeFileSync(join(gradingRoom, "checklist.txt"), `${ids.join("\n")}\n`);
        const receipt = `legacy fixture grader view; items=${ids.length}\n`;
        writeFileSync(join(gradingRoom, ".grading-room.txt"), receipt);
        r = { code: 0, sha256: hash(receipt) };
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "grading-room", r.code === 0 ? "prepared" : "failed", { log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "grade", attempt: task.state.checkpoint.attempt } }
          : { status: "terminal", outcome: { status: "failed", error: "grading-room" } };
      }, ctx);
    },
    grade: async (task, runtime) => runtime.commit(async (tx) => {
      const id = await tx.createTask(Grade, {}, { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-grade", grader: id, attempt: task.state.checkpoint.attempt }, on: [id], policy: "failFast" };
    }, ctx),
    "after-grade": async (task, runtime) => {
      await runtime.outcomes([task.state.checkpoint.grader], ctx);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "score", attempt: task.state.checkpoint.attempt } }), ctx);
    },
    score: async (task, runtime) => {
      if (!existsSync(instrument)) command("instrument-clone", "git", ["clone", "-q", "--depth", "1", `file://${sourceRoot}`, instrument]);
      const cycleDir = join(instrument, "harness", "cycles", "02");
      mkdirSync(cycleDir, { recursive: true });
      const checklist = existsSync(join(cycleDir, "checklist.json"))
        ? { code: 0 } : command("score-checklist", "bb", ["harness/gen_checklist.clj", "--out", join(cycleDir, "checklist.json")], { cwd: instrument });
      const existing = existsSync(join(cycleDir, "scores.json"));
      const r = checklist.code !== 0 ? checklist
        : existing ? { code: 0, sha256: hash("score: reconciled cycle 02") }
        : command("score", "bb", ["harness/score.clj", "02", "--verdicts", join(scratch, "verdicts.json")], { cwd: instrument });
      const board = r.code === 0 ? command("scoreboard", "bb", ["harness/scoreboard.clj", "02"], { cwd: instrument }) : r;
      const scored = board.code === 0 ? JSON.parse(readFileSync(join(cycleDir, "scores.json"), "utf8")).items : [];
      const score = `${scored.filter((item) => item.verdict === "pass").length}/${scored.length}`;
      const attempt = task.state.checkpoint.attempt ?? 2;
      await runtime.commit(async (tx) => {
        await audit(tx, task, "score", r.code === 0 ? "filed" : "failed", { log_sha256: r.sha256, fixture_grader: true });
        if (board.code === 0) await audit(tx, task, "scoreboard", "reported", { cycle: "02", log_sha256: board.sha256 });
        await audit(tx, task, "cycle", board.code === 0 ? "completed" : "failed", { reason: board.code === 0 ? null : "score" });
        return { status: "terminal", outcome: { status: "completed", result: { passed: board.code === 0, attempts: attempt, score: board.code === 0 ? score : null } } };
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const registry = createRegistry();
registry.install(defineExtension({ name: "loyly-prototype", tasks: [Builder, Gate, Grade, Cycle] }));
const harness = await Harness.open(await openNodeSqliteStorage(storePath), { models: createModels(), registry }, ctx);
try {
  const root = await harness.root(ctx);
  const existing = await harness.commit((tx) => tx.scanTasks({ kind: "loyly.proto.cycle" }, 10), ctx);
  let id = existing.items[0]?.id;
  const cycleInput = { approvedCommit: approvedCommit ?? null, approvedChecklistSha256, mode };
  if (id && JSON.stringify(existing.items[0].input) !== JSON.stringify(cycleInput))
    throw new Error("this Pi store belongs to a different approved cut, checklist or mode");
  if (!id) id = await harness.commit((tx) => tx.createTask(Cycle, cycleInput,
    { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
  writeFileSync(join(scratch, "task-id"), String(id));
  console.log(`cycle task ${id}; mode ${mode}; store ${storePath}`);
  harness.resume();
  const final = await harness.waitForTask(id, ctx);
  console.log("FINAL", JSON.stringify(final));
  if (final.state.outcome?.status !== "completed") process.exitCode = 1;
} finally {
  await harness.close(ctx);
}
