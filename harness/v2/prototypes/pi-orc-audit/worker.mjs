// THROWAWAY PROTOTYPE. Pi durable owns a full legacy-shaped cycle; the builder and
// grader are deterministic fixtures so this can run without a model account.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, chmodSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineEntry, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const ctx = BACKGROUND_CONTEXT;
const Audit = defineEntry("loyly.proto.audit.v1");
const scratch = resolve(process.argv[2] ?? join(HERE, "scratch"));
const storePath = join(scratch, "cycle.PROTOTYPE.sqlite");
const room = join(scratch, "fenced-room");
const gradingRoom = join(scratch, "grading-room");
const instrument = join(scratch, "instrument");
const mode = process.argv[3] ?? "repair"; // repair: red first gate, green second; three-red: all red
mkdirSync(scratch, { recursive: true });

const hash = (value) => createHash("sha256").update(value).digest("hex");
const resultPath = (name) => join(scratch, `${name}.log`);
function command(name, program, args, options = {}) {
  const r = spawnSync(program, args, {
    cwd: options.cwd ?? ROOT,
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
  return roots.status === 0 && roots.stdout.trim() === "1" && !existsSync(join(room, "harness-impl"));
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
      const target = join(room, "harness-impl", "06-cycle-runner");
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      // Frozen, gate-passing cycle-28 fixture: this is not a promoted build.
      cpSync(join(HERE, "fixture", "cycle28-candidate"), target, { recursive: true });
      const red = mode === "three-red" || task.input.attempt === 1;
      if (red) {
        writeFileSync(join(target, "test.sh"), "#!/bin/sh\necho 'fixture red suite'\nexit 1\n");
        chmodSync(join(target, "test.sh"), 0o755);
      }
      // Legacy continuation happens in this same child session before the gate.
      await runtime.commit(async (tx) => {
        await audit(tx, task, "builder-continuation", "completed", {
          attempt: task.input.attempt, session_id: `builder-${task.input.attempt}`,
          remaining_uncarried: 22, fixture: true,
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
      const name = `gate-${attempt}`;
      const log = resultPath(name);
      // A complete log is a reconciliation receipt if this process died after verify.sh.
      let r;
      if (existsSync(log) && /=== gate OK:|FATAL: the gate failed/.test(readFileSync(log, "utf8"))) {
        const output = readFileSync(log, "utf8");
        r = { code: output.includes("=== gate OK:") ? 0 : 1, output, sha256: hash(output), log };
      } else {
        r = command(name, "bash", ["harness/v2/gate.sh", "06", room], {
          env: { PI_HARNESS_STATE_ROOT: join(scratch, "gate-state") }, timeout: 900_000,
        });
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "gate", r.code === 0 ? "passed" : "failed", {
          attempt, gate_log: r.log, gate_log_sha256: r.sha256, exit: r.code,
        });
        return { status: "terminal", outcome: { status: "completed", result: {
          passed: r.code === 0, log: r.log,
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
      // Independent grader process is a deterministic fixture. The legacy score and
      // scoreboard below are real; no grader claim is treated as a gate verdict.
      const selected = readFileSync(join(gradingRoom, "checklist.txt"), "utf8").trim().split("\n")
        .map((id) => ({ id }));
      const verdicts = selected.map((item) => ({ id: item.id,
        verdict: item.id === "06-076" ? "fail" : "pass",
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
  initial: () => ({ phase: "preflight" }),
  phases: {
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
      else r = command("fence", "bash", ["harness/fence.sh", room], { env: { SLICE: "06" } });
      await runtime.commit(async (tx) => {
        await audit(tx, task, "fence", r.code === 0 ? "passed" : "failed", { room, log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "checklist" } }
          : { status: "terminal", outcome: { status: "failed", error: "fence" } };
      }, ctx);
    },
    checklist: async (task, runtime) => {
      const r = command("checklist", "bb", ["harness/gen_checklist.clj", "--out", join(scratch, "checklist.json")]);
      const n = r.code === 0 ? JSON.parse(readFileSync(join(scratch, "checklist.json"), "utf8")).items.filter((x) => x.id.startsWith("06-")).length : 0;
      await runtime.commit(async (tx) => {
        await audit(tx, task, "checklist", r.code === 0 ? "derived" : "failed", { item_count: n, log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "render" } }
          : { status: "terminal", outcome: { status: "failed", error: "checklist" } };
      }, ctx);
    },
    render: async (task, runtime) => {
      const r = command("render", "bb", ["harness/v2/prompt.clj", "06", join(scratch, "prompt")]);
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
        if (result.passed) return { status: "running", checkpoint: { phase: "grading-room" } };
        if (attempt < 3) {
          await audit(tx, task, "retry", "scheduled", { attempt: attempt + 1, previous_gate_log: result.log });
          return { status: "running", checkpoint: { phase: "build", attempt: attempt + 1, previousGateLog: result.log } };
        }
        await audit(tx, task, "cycle", "failed", { reason: "gate-attempts-exhausted", attempt });
        return { status: "terminal", outcome: { status: "completed", result: { passed: false, attempts: attempt } } };
      }, ctx);
    },
    "grading-room": async (task, runtime) => {
      const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
      let r;
      if (existsSync(join(gradingRoom, ".grading-room.txt"))) {
        r = { code: 0, sha256: hash(readFileSync(join(gradingRoom, ".grading-room.txt"))) };
      } else {
        r = command("grading-room", "bash", [".pi/harness/bin/grading-room.sh", gradingRoom,
          "06", join(room, "harness-impl", "06-cycle-runner"), commit.stdout.trim()]);
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "grading-room", r.code === 0 ? "prepared" : "failed", { log_sha256: r.sha256 });
        return r.code === 0 ? { status: "running", checkpoint: { phase: "grade" } }
          : { status: "terminal", outcome: { status: "failed", error: "grading-room" } };
      }, ctx);
    },
    grade: async (task, runtime) => runtime.commit(async (tx) => {
      const id = await tx.createTask(Grade, {}, { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-grade", grader: id }, on: [id], policy: "failFast" };
    }, ctx),
    "after-grade": async (task, runtime) => {
      await runtime.outcomes([task.state.checkpoint.grader], ctx);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "score" } }), ctx);
    },
    score: async (task, runtime) => {
      if (!existsSync(instrument)) command("instrument-clone", "git", ["clone", "-q", "--depth", "1", `file://${ROOT}`, instrument]);
      const existing = existsSync(join(instrument, "harness", "v2", "cycles", "06", "29", "scores.json"));
      const r = existing ? { code: 0, output: "score: reconciled cycle 29", sha256: hash("score: reconciled cycle 29") }
        : command("score", "bash", ["harness/v2/score.sh", "06", room, "--verdicts", join(scratch, "verdicts.json"), "--by", "prototype fixture grader"], { cwd: instrument });
      await runtime.commit(async (tx) => {
        await audit(tx, task, "score", r.code === 0 ? "filed" : "failed", { log_sha256: r.sha256, fixture_grader: true });
        if (r.code === 0) await audit(tx, task, "scoreboard", "reported", { cycle: 29 });
        await audit(tx, task, "cycle", r.code === 0 ? "completed" : "failed", { reason: r.code === 0 ? null : "score" });
        return { status: "terminal", outcome: { status: "completed", result: { passed: r.code === 0, attempts: 2, score: r.code === 0 ? "64/65" : null } } };
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
  if (!id) id = await harness.commit((tx) => tx.createTask(Cycle, {}, { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
  writeFileSync(join(scratch, "task-id"), String(id));
  console.log(`cycle task ${id}; mode ${mode}; store ${storePath}`);
  harness.resume();
  const final = await harness.waitForTask(id, ctx);
  console.log("FINAL", JSON.stringify(final));
  if (final.state.outcome?.status !== "completed") process.exitCode = 1;
} finally {
  await harness.close(ctx);
}
