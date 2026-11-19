// THROWAWAY PROTOTYPE on scope-impact/master. Pi durable owns the original
// legacy harness cycle. Builder and grader are explicitly deterministic fixtures.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, chmodSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineEntry, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runGate } from "./gate-adapter.mjs";
import { runBuilder } from "./builder-adapter.mjs";
import { candidateDigest as digestCandidate, prepareGradingRoom, verifyGradingRoom } from "./grading-room.mjs";
import { prepareShards, combineShards } from "./grader-shards.mjs";
import { finalVerdictsFromBlindReview, prepareBlindReview, probeBlindAnswer,
  verifyBlindReviewPacket, writeBlindAgentAllure } from "./blind-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const schemaFile = join(HERE, "allure-lifecycle-result.schema.json");
const attachedSchemaSha256 = createHash("sha256").update(readFileSync(schemaFile)).digest("hex");
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
const live = mode === "live";
const builder = live ? {
  command: resolve(process.env.LOYLY_BUILDER_COMMAND ?? join(ROOT, ".pi/harness/bin/builder.sh")),
  image: resolve(process.env.LOYLY_BUILDER_IMAGE ?? ""),
  model: process.env.LOYLY_BUILDER_MODEL,
  commandSha256: process.env.LOYLY_BUILDER_COMMAND_SHA256,
  imageSha256: process.env.LOYLY_BUILDER_IMAGE_SHA256,
  instructionSha256: process.env.LOYLY_BUILDER_INSTRUCTION_SHA256,
} : null;
if (live && (!approvedCommit || !process.env.LOYLY_BUILDER_IMAGE || !builder.model
    || [builder.commandSha256, builder.imageSha256, builder.instructionSha256]
      .some((digest) => !/^[0-9a-f]{64}$/.test(digest ?? ""))))
  throw new Error("live build needs approved cut/checklist, model, command, image, and three SHA-256 values");
const grader = live && process.env.LOYLY_GRADER_MODEL ? {
  command: resolve(process.env.LOYLY_GRADER_COMMAND ?? builder.command),
  image: resolve(process.env.LOYLY_GRADER_IMAGE ?? builder.image),
  settings: resolve(process.env.LOYLY_GRADER_SETTINGS ?? join(ROOT, ".pi/harness/config/pi.grader.settings.json")),
  model: process.env.LOYLY_GRADER_MODEL,
  commandSha256: process.env.LOYLY_GRADER_COMMAND_SHA256,
  imageSha256: process.env.LOYLY_GRADER_IMAGE_SHA256,
  settingsSha256: process.env.LOYLY_GRADER_SETTINGS_SHA256,
  instructionSha256: process.env.LOYLY_GRADER_INSTRUCTION_SHA256,
  schemaSha256: process.env.LOYLY_GRADER_SCHEMA_SHA256,
} : null;
const graderShardCount = Number(process.env.LOYLY_GRADER_SHARDS ?? 3);
if (live && (!Number.isInteger(graderShardCount) || graderShardCount < 1 || graderShardCount > 16))
  throw new Error("LOYLY_GRADER_SHARDS must be an integer from 1 to 16");
if (grader && (grader.model === builder.model
    || [grader.commandSha256, grader.imageSha256, grader.settingsSha256,
      grader.instructionSha256, grader.schemaSha256]
      .some((digest) => !/^[0-9a-f]{64}$/.test(digest ?? ""))))
  throw new Error("independent grader needs another model and approved command, image, settings, schema and instruction digests");
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
  return digestCandidate(candidateRoom);
}
function verifyBuilderScope() {
  if (!existsSync(join(room, "impl", "start.sh")) || !existsSync(join(room, "impl", "test.sh")))
    throw new Error("builder did not leave both legacy app entrypoints");
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: room, encoding: "buffer" });
  if (result.status !== 0) throw new Error("cannot check builder write scope");
  for (const line of result.stdout.toString("utf8").split("\0").filter(Boolean)) {
    if (line.slice(0, 2) !== "??") throw new Error("builder modified a tracked clean-room file");
    const path = line.slice(3);
    if (!path.startsWith("impl/") && !path.startsWith(".builder/"))
      throw new Error(`builder wrote outside declared scope: ${path}`);
  }
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
        fixture: !live || builder?.model.startsWith("test/"), model: builder?.model ?? null,
        previous_gate_log_sha256: task.input.previousGateSha256 ?? null,
      });
      return live ? { status: "running", checkpoint: { phase: "materialize" } }
        : { status: "sleeping", until: Date.now() + 1200, checkpoint: { phase: "materialize" } };
    }, ctx),
    materialize: async (task, runtime) => {
      if (live) {
        const attempt = task.input.attempt;
        const sessionId = `prototype-cycle-1-attempt-${attempt}`;
        let instruction = join(scratch, "prompt.txt"), r, digest, reason;
        try {
          if (hash(readFileSync(instruction)) !== builder.instructionSha256
              || hash(readFileSync(builder.command)) !== builder.commandSha256
              || hash(readFileSync(join(builder.image, "manifest.json"))) !== builder.imageSha256)
            throw new Error("builder inputs changed after render");
          if (attempt > 1) {
            const log = task.input.previousGateLog;
            if (!log?.startsWith(`${scratch}/`) || !existsSync(log)
                || hash(readFileSync(log)) !== task.input.previousGateSha256)
              throw new Error("repair gate evidence differs from committed receipt");
            instruction = join(scratch, `repair-${attempt}.md`);
            writeFileSync(instruction, `${readFileSync(join(scratch, "prompt.txt"), "utf8")}\n\n# Previous gate failure\n\n${readFileSync(log, "utf8")}\n`);
          }
          r = await runBuilder({ command: builder.command, room, instruction,
            image: builder.image, evidenceDir: join(scratch, `builder-${attempt}-evidence`),
            sessionId, model: builder.model, stateRoot: join(ROOT, ".pi/harness/.state") });
          if (r.exit !== 0) throw new Error(`builder host exited ${r.exit}`);
          verifyBuilderScope();
          digest = candidateDigest();
        } catch (error) {
          reason = String(error.stack ?? error);
          writeFileSync(join(scratch, `builder-${attempt}-error.log`), `${reason}\n`);
        }
        await runtime.commit(async (tx) => {
          await audit(tx, task, attempt === 1 ? "build" : "repair", digest ? "completed" : "failed", {
            attempt, session_id: sessionId, candidate_digest: digest ?? null,
            instruction_sha256: existsSync(instruction) ? hash(readFileSync(instruction)) : null,
            reconciled: r?.reconciled ?? false, reason_code: reason ? "builder-effect-or-scope" : null,
            fixture: builder.model.startsWith("test/"),
          });
          return { status: "terminal", outcome: digest
            ? { status: "completed", result: { candidateDigest: digest } }
            : { status: "failed", error: "build" } };
        }, ctx);
        return;
      }
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
          passed: r.exit === 0, log, logSha256: r.logSha256, candidateSha256: digest,
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
      if (live) {
        const instruction = join(HERE, "grader-instruction-01.md");
        let r, judged, reason, shardReceipts;
        try {
          if (!grader) throw new Error("independent grader not configured");
          if (hash(readFileSync(instruction)) !== grader.instructionSha256
              || hash(readFileSync(grader.command)) !== grader.commandSha256
              || hash(readFileSync(join(grader.image, "manifest.json"))) !== grader.imageSha256
              || hash(readFileSync(grader.settings)) !== grader.settingsSha256
              || attachedSchemaSha256 !== grader.schemaSha256)
            throw new Error("grader instruction, command, image, settings or schema differs from approved digest");
          verifyGradingRoom({ out: gradingRoom, candidateSha256: task.input.candidateSha256,
            checklistSha256: approvedChecklistSha256, schemaSha256: grader.schemaSha256 });
          const shards = prepareShards({ gradingRoom, sourceRoom: room, scratch, schemaFile,
            candidateSha256: task.input.candidateSha256, schemaSha256: grader.schemaSha256,
            count: graderShardCount });
          const launches = await Promise.allSettled(shards.map((shard) => runBuilder({
            command: grader.command, room: shard.out, instruction,
            image: grader.image, evidenceDir: join(scratch, "grader-evidence", shard.id),
            sessionId: `prototype-cycle-1-grade-${shard.id}`, model: grader.model,
            stateRoot: join(ROOT, ".pi/harness/.state"),
            piSettings: grader.settings, prompt: "Grade your selected checklist scope now, as the attached instruction says.",
            roomLabel: `the ${shard.id} grading room`,
            imageAdditionsPath: "/workspace/work/image-additions.txt",
            readonlyInputs: true })));
          const failures = launches.flatMap((launch, i) => launch.status === "rejected"
            ? [`${shards[i].id}: ${launch.reason}`]
            : launch.value.exit !== 0 ? [`${shards[i].id}: exit ${launch.value.exit}`] : []);
          if (failures.length) throw new Error(`grader shards failed: ${failures.join("; ")}`);
          verifyGradingRoom({ out: gradingRoom, candidateSha256: task.input.candidateSha256,
            checklistSha256: approvedChecklistSha256, schemaSha256: grader.schemaSha256 });
          judged = combineShards({ gradingRoom, shards, candidateSha256: task.input.candidateSha256,
            schemaSha256: grader.schemaSha256 });
          shardReceipts = shards.map((shard, i) => ({ id: shard.id, items: shard.items,
            checklist_sha256: shard.checklistSha256,
            reconciled: launches[i].value.reconciled }));
          r = { reconciled: launches.some((launch) => launch.value.reconciled), shardCount: shards.length };
          writeFileSync(join(scratch, "verdicts.json"), JSON.stringify(judged.verdicts));
          cpSync(join(gradingRoom, "work", "surprises.json"), join(scratch, "surprises.json"));
        } catch (error) {
          reason = String(error.stack ?? error);
          writeFileSync(join(scratch, "grade-error.log"), `${reason}\n`);
        }
        await runtime.commit(async (tx) => {
          await audit(tx, task, "grade", judged ? "completed" : "failed", {
            model: grader?.model ?? null, fixture: grader?.model.startsWith("test/") ?? false,
            item_count: judged?.verdicts.length ?? 0, pass_count: judged?.pass ?? 0,
            shard_count: r?.shardCount ?? 0,
            shards: shardReceipts ?? [],
            allure_results_sha256: judged?.allureSha256 ?? null,
            schema_sha256: grader?.schemaSha256 ?? null,
            verdicts_sha256: judged ? hash(readFileSync(join(scratch, "verdicts.json"))) : null,
            surprises_sha256: judged ? hash(readFileSync(join(scratch, "surprises.json"))) : null,
            reconciled: r?.reconciled ?? false,
            reason_code: reason ? "grader-effect-or-verdict" : null });
          return { status: "terminal", outcome: judged
            ? { status: "completed", result: { count: judged.verdicts.length, pass: judged.pass } }
            : { status: "failed", error: "grade" } };
        }, ctx);
        return;
      }
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
      const instruction = live ? readFileSync(join(HERE, "builder-instruction.md"), "utf8")
        : `${readFileSync(join(sourceRoot, "harness", "README.md"), "utf8")}\n\n${plan}`;
      const commandSha256 = live && existsSync(builder.command) ? hash(readFileSync(builder.command)) : null;
      const manifest = live ? join(builder.image, "manifest.json") : null;
      const imageSha256 = manifest && existsSync(manifest) ? hash(readFileSync(manifest)) : null;
      const instructionSha256 = hash(instruction);
      const approved = !live || (instructionSha256 === builder.instructionSha256
        && commandSha256 === builder.commandSha256 && imageSha256 === builder.imageSha256);
      if (approved) writeFileSync(join(scratch, "prompt.txt"), instruction);
      await runtime.commit(async (tx) => {
        await audit(tx, task, "render", approved ? "completed" : "refused", {
          instruction_sha256: instructionSha256, approved_instruction_sha256: builder?.instructionSha256 ?? null,
          builder_command_sha256: commandSha256, approved_command_sha256: builder?.commandSha256 ?? null,
          builder_image_sha256: imageSha256, approved_image_sha256: builder?.imageSha256 ?? null,
          model: builder?.model ?? null });
        return approved ? { status: "running", checkpoint: { phase: "build", attempt: 1, previousGateLog: null } }
          : { status: "terminal", outcome: { status: "failed", error: "render" } };
      }, ctx);
    },
    build: async (task, runtime) => runtime.commit(async (tx) => {
      const { attempt, previousGateLog, previousGateSha256 } = task.state.checkpoint;
      const id = await tx.createTask(Builder, { attempt, previousGateLog, previousGateSha256 },
        { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-build", attempt, builder: id }, on: [id], policy: "failFast" };
    }, ctx),
    "after-build": async (task, runtime) => {
      const { attempt, builder } = task.state.checkpoint;
      const [outcome] = await runtime.outcomes([builder], ctx);
      await runtime.commit(async (tx) => {
        if (outcome?.status !== "completed") {
          await audit(tx, task, "cycle", "failed", { reason: "builder-attempt-failed", attempt });
          return { status: "terminal", outcome: { status: "failed", error: "build" } };
        }
        return { status: "running", checkpoint: { phase: "gate", attempt } };
      }, ctx);
    },
    gate: async (task, runtime) => runtime.commit(async (tx) => {
      const { attempt } = task.state.checkpoint;
      const id = await tx.createTask(Gate, { attempt }, { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-gate", attempt, gate: id }, on: [id], policy: "failFast" };
    }, ctx),
    "after-gate": async (task, runtime) => {
      const { attempt, gate } = task.state.checkpoint;
      const [outcome] = await runtime.outcomes([gate], ctx);
      await runtime.commit(async (tx) => {
        if (outcome?.status !== "completed") {
          await audit(tx, task, "cycle", "failed", { reason: "gate-effect-failed", attempt });
          return { status: "terminal", outcome: { status: "failed", error: "gate" } };
        }
        const result = outcome.result;
        if (result.passed) {
          return { status: "running", checkpoint: { phase: "grading-room", attempt,
            candidateSha256: result.candidateSha256 } };
        }
        if (attempt < 3) {
          await audit(tx, task, "retry", "scheduled", { attempt: attempt + 1, previous_gate_log: result.log });
          return { status: "running", checkpoint: { phase: "build", attempt: attempt + 1,
            previousGateLog: result.log, previousGateSha256: result.logSha256 } };
        }
        await audit(tx, task, "cycle", "failed", { reason: "gate-attempts-exhausted", attempt });
        return { status: "terminal", outcome: { status: "completed", result: { passed: false, attempts: attempt } } };
      }, ctx);
    },
    "grading-room": async (task, runtime) => {
      if (live) {
        const candidateSha256 = task.state.checkpoint.candidateSha256;
        const checklistFile = join(scratch, "checklist.json");
        const args = { sourceRoom: room, candidateRoom: room, checklistFile, schemaFile,
          out: gradingRoom, candidateSha256, checklistSha256: approvedChecklistSha256,
          schemaSha256: grader?.schemaSha256 ?? attachedSchemaSha256 };
        let reason;
        try {
          if (existsSync(gradingRoom)) verifyGradingRoom(args);
          else prepareGradingRoom(args);
        } catch (error) {
          reason = String(error.stack ?? error);
          writeFileSync(join(scratch, "grading-room-error.log"), `${reason}\n`);
        }
        await runtime.commit(async (tx) => {
          await audit(tx, task, "grading-room", reason ? "failed" : "prepared", {
            candidate_sha256: candidateSha256, checklist_sha256: approvedChecklistSha256,
            reason_code: reason ? "grading-room-copy" : null });
          if (!reason && !grader) await audit(tx, task, "grade", "blocked", {
            reason: "independent-live-grader-not-connected" });
          if (reason || !grader) return { status: "terminal", outcome: { status: "failed",
            error: reason ? "grading-room" : "grader-not-connected" } };
          return { status: "running", checkpoint: { phase: "grade",
            attempt: task.state.checkpoint.attempt,
            candidateSha256 } };
        }, ctx);
        return;
      }
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
      const id = await tx.createTask(Grade,
        { candidateSha256: task.state.checkpoint.candidateSha256 ?? null },
        { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-grade", grader: id, attempt: task.state.checkpoint.attempt }, on: [id], policy: "failFast" };
    }, ctx),
    "after-grade": async (task, runtime) => {
      const [outcome] = await runtime.outcomes([task.state.checkpoint.grader], ctx);
      await runtime.commit(async (tx) => {
        if (outcome?.status !== "completed") {
          await audit(tx, task, "cycle", "failed", { reason: "grader-effect-or-verdict" });
          return { status: "terminal", outcome: { status: "failed", error: "grade" } };
        }
        return { status: "running", checkpoint: { phase: live ? "blind-review" : "score",
          attempt: task.state.checkpoint.attempt } };
      }, ctx);
    },
    "blind-review": async (task, runtime) => {
      const packetDir = join(scratch, "blind-agent-packet");
      const reviewFile = join(scratch, "blind-agent-review.json");
      const requestFile = join(scratch, "blind-agent-request.json");
      const verificationDir = join(scratch, "blind-agent-verification");
      const allureDir = join(scratch, "blind-agent-allure");
      let packetSha256, projected, reason;
      try {
        if (!existsSync(packetDir)) prepareBlindReview({ gradingRoom, out: packetDir });
        packetSha256 = verifyBlindReviewPacket({ packetDir, gradingRoom }).packetSha256;
        if (!existsSync(reviewFile) || (existsSync(reviewFile)
            && JSON.parse(readFileSync(reviewFile, "utf8")).verdict === "pass"
            && !existsSync(requestFile))) {
          await runtime.commit(async (tx) => {
            if (task.state.checkpoint.packetSha256 !== packetSha256)
              await audit(tx, task, "blind-review", "awaiting", {
                packet_sha256: packetSha256, candidate_sha256: candidateDigest(gradingRoom),
                spec_sha256: hash(readFileSync(join(gradingRoom, "plan", "01-booking-core", "spec.feature"))) });
            return { status: "sleeping", until: Date.now() + 5000,
              checkpoint: { ...task.state.checkpoint, packetSha256 } };
          }, ctx);
          return;
        }
        const review = JSON.parse(readFileSync(reviewFile, "utf8"));
        if (review.verdict === "pass" && !existsSync(verificationDir))
          await probeBlindAnswer({ packetDir, reviewFile, gradingRoom,
            request: JSON.parse(readFileSync(requestFile, "utf8")), out: verificationDir });
        writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom,
          verificationDir: review.verdict === "pass" ? verificationDir : undefined, out: allureDir });
        projected = finalVerdictsFromBlindReview({ packetDir, reviewFile, gradingRoom,
          verificationDir: review.verdict === "pass" ? verificationDir : undefined, out: allureDir });
        const finalFile = join(scratch, "final-verdicts.json");
        const bytes = JSON.stringify(projected.verdicts);
        if (existsSync(finalFile) && readFileSync(finalFile, "utf8") !== bytes)
          throw new Error("final verdicts differ from the previously projected review");
        if (!existsSync(finalFile)) writeFileSync(finalFile, bytes);
      } catch (error) {
        reason = String(error.stack ?? error);
        writeFileSync(join(scratch, "blind-review-error.log"), `${reason}\n`);
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "blind-review", projected ? "completed" : "failed", {
          packet_sha256: packetSha256 ?? null,
          raw_allure_sha256: projected?.rawAllureSha256 ?? null,
          review_sha256: projected?.reviewSha256 ?? null,
          final_verdicts_sha256: projected ? hash(readFileSync(join(scratch, "final-verdicts.json"))) : null,
          reason_code: reason ? "blind-agent-evidence" : null });
        return projected ? { status: "running", checkpoint: { phase: "score",
          attempt: task.state.checkpoint.attempt } }
          : { status: "terminal", outcome: { status: "failed", error: "blind-review" } };
      }, ctx);
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
        : command("score", "bb", ["harness/score.clj", "02", "--verdicts",
          join(scratch, live ? "final-verdicts.json" : "verdicts.json")], { cwd: instrument });
      const board = r.code === 0 ? command("scoreboard", "bb", ["harness/scoreboard.clj", "02"], { cwd: instrument }) : r;
      const scored = board.code === 0 ? JSON.parse(readFileSync(join(cycleDir, "scores.json"), "utf8")).items : [];
      const score = `${scored.filter((item) => item.verdict === "pass").length}/${scored.length}`;
      const blindAgentReviewFailed = live && scored.some((item) => item.id === "01-011" && item.verdict === "fail");
      const attempt = task.state.checkpoint.attempt ?? 2;
      await runtime.commit(async (tx) => {
        await audit(tx, task, "score", r.code === 0 ? "filed" : "failed", {
          log_sha256: r.sha256, fixture_grader: !live || grader?.model.startsWith("test/") });
        if (board.code === 0) await audit(tx, task, "scoreboard", "reported", { cycle: "02", log_sha256: board.sha256 });
        await audit(tx, task, "cycle", board.code === 0 ? (live ? "measured" : "completed") : "failed", {
          reason: board.code === 0 ? (blindAgentReviewFailed ? "blind-agent-review-failed" : null) : "score" });
        return { status: "terminal", outcome: { status: "completed", result: {
          passed: board.code === 0 && !live, scored: board.code === 0,
          blindAgentReviewFailed, attempts: attempt, score: board.code === 0 ? score : null } } };
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
  const cycleInput = { approvedCommit: approvedCommit ?? null, approvedChecklistSha256, mode, builder,
    grader, graderShardCount: live ? graderShardCount : null };
  if (id && JSON.stringify(existing.items[0].input) !== JSON.stringify(cycleInput))
    throw new Error("this Pi store belongs to a different approved cut, checklist or mode");
  if (!id) id = await harness.commit((tx) => tx.createTask(Cycle, cycleInput,
    { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
  writeFileSync(join(scratch, "task-id"), String(id));
  console.log(`cycle task ${id}; mode ${mode}; store ${storePath}`);
  harness.resume();
  const final = await harness.waitForTask(id, ctx);
  console.log("FINAL", JSON.stringify(final));
  if (final.state.outcome?.status !== "completed"
      || (live && final.state.outcome.result?.passed !== true)) process.exitCode = 1;
} finally {
  await harness.close(ctx);
}
