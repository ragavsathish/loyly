// Pi durable candidate cycle over the unchanged legacy harness reference.
// Fixture mode is explicit; live mode pins every model and VM instrument.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineEntry, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runGate } from "./gate-adapter.ts";
import { Effect, Layer } from 'effect';
import { GateRunError, GateRunner, verifyCandidate } from './gate-effects.ts';
import { hasBuilderLaunch, runBuilder } from "./builder-adapter.mjs";
import { candidateDigest as digestCandidate, prepareGradingRoom, verifyGradingRoom } from "./grading-room.ts";
import { prepareShards, combineShards } from "./grader-shards.ts";
import { finalVerdictsFromBlindReview, prepareBlindReview, probeBlindAnswer,
  verifyBlindReviewPacket, writeBlindAgentAllure } from "./blind-review.mjs";
import { runBlindAgent } from "./blind-agent-adapter.mjs";
import { bindScoreInput, verifyScoredCycle } from "./score-receipt.ts";
import { runDurablePanel, runDurablePanelReport } from "./panel-adapter.mjs";
import { createLifecycle } from "../cycle-core/lifecycle.ts";
import { createCycleEffects, hash } from './cycle-effects.ts';
import { parseWorkerConfig } from './worker-config.ts';
import { createGateTask } from './tasks/gate.ts';
import { createPanelTask } from './tasks/panel.ts';
import { createBuilderTask } from './tasks/builder.ts';
import { createGradeTask } from './tasks/grade.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const schemaFile = join(HERE, "../evidence-core/allure-lifecycle-result.schema.json");
const attachedSchemaSha256 = createHash("sha256").update(readFileSync(schemaFile)).digest("hex");
const ctx = BACKGROUND_CONTEXT;
const Audit = defineEntry("loyly.proto.audit.v1");
const scratch = resolve(process.argv[2] ?? join(HERE, "scratch"));
const runId = process.env.LOYLY_RUN_ID ?? "prototype-cycle-1";
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("LOYLY_RUN_ID contains unsafe characters");
const scoreCycle = process.env.LOYLY_SCORE_CYCLE ?? "02";
if (!/^\d\d$/.test(scoreCycle)) throw new Error("LOYLY_SCORE_CYCLE must be two digits");
const storePath = join(scratch, "cycle.PROTOTYPE.sqlite");
const room = join(scratch, "fenced-room");
const gradingRoom = join(scratch, "grading-room");
const instrument = join(scratch, "instrument");
const builderStore = join(scratch, "builder-lineage", "session.sqlite");
const builderReceipt = (attempt) => join(scratch, `builder-${attempt}-evidence`, "session.json");
function builderLineage(attempt) {
  const path = builderReceipt(attempt);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path);
    const receipt = JSON.parse(raw.toString("utf8"));
    return { conversation_id: receipt.conversationId,
      parent_conversation_id: receipt.parentConversationId,
      fork_entry_id: receipt.forkEntryId,
      session_receipt_sha256: hash(raw) };
  } catch { return {}; }
}
function canForkBuilderAttempt(attempt) {
  const path = builderReceipt(attempt);
  if (!existsSync(path)) return false;
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  return receipt.store === builderStore && Number.isSafeInteger(receipt.conversationId)
    && receipt.conversationId > 0 && Number.isSafeInteger(receipt.lastEntryId)
    && receipt.lastEntryId > 0;
}
const { approvedCommit, approvedChecklistSha256, cut, sourceRoot, approvedSourceRepo,
  mode, live, builder, grader, graderShardCount, blindAgent, blindRequired, project, panel } =
  parseWorkerConfig(ROOT, scratch, process.argv[3]);
const lifecycle = createLifecycle({ assessments: live
  ? [...(blindRequired ? ["blind-review"] : []), ...(panel ? ["panel"] : [])] : [] });
mkdirSync(scratch, { recursive: true });

const { command, proofOfFence, gitAt, proveCut, candidateDigest,
  clearBuilderTestArtifacts, verifyBuilderScope, gateRoomFor } = createCycleEffects({
  root: ROOT, scratch, room, cut, sourceRoot, approvedSourceRepo,
  approvedCommit, digestCandidate,
});
async function audit(tx, task, stage, outcome, extra = {}) {
  const data = {
    schema: "loyly.proto.audit.v1", run_id: runId, stage, outcome,
    at: new Date().toISOString(), task_id: String(task.id), ...extra,
  };
  const entry = await tx.appendEntry(Audit, task.conversationId, { data });
  console.log(`${entry.id} ${stage} ${outcome}${data.attempt ? ` attempt ${data.attempt}` : ""}`);
  return entry;
}
const Builder = createBuilderTask({
  live, builder, scratch, room, here: HERE, root: ROOT, runId, mode,
  builderStore, builderReceipt, builderLineage, canForkBuilderAttempt,
  verifyBuilderScope, clearBuilderTestArtifacts, candidateDigest,
  hasBuilderLaunch, runBuilder, audit,
});

const gateRunner = Layer.succeed(GateRunner, {
  run: (request) => Effect.tryPromise({
    try: () => runGate(request),
    catch: (cause) => new GateRunError({ reason: String(cause) }),
  }),
});

const Gate = createGateTask({ scratch, candidateDigest, gateRoomFor, audit,
  verify: (request) => Effect.runPromise(verifyCandidate(request).pipe(Effect.provide(gateRunner))) });

const Grade = createGradeTask({
  live, grader, here: HERE, root: ROOT, scratch, gradingRoom, room, runId,
  schemaFile, approvedChecklistSha256, graderShardCount, project, blindRequired,
  attachedSchemaSha256, verifyGradingRoom, prepareShards, combineShards,
  runBuilder, audit,
});

const Panel = createPanelTask({ scratch, panel, audit, runPanel: () =>
  runDurablePanel({ scratch, image: panel.image, planFile: join(HERE, panel.planFile),
    approvedPlanSha256: panel.planSha256, approvedImageSha256: panel.imageSha256 }) });

const Cycle = defineTask({
  name: "loyly.proto.cycle", version: 1,
  initial: () => ({ phase: "cut" }),
  phases: {
    cut: async (task, runtime) => {
      let r = { code: 0, sha256: hash("original source: no cut requested") };
      if (approvedCommit && !proveCut()) {
        if (existsSync(cut)) throw new Error("incomplete or changed original-source cut");
        mkdirSync(cut, { recursive: true });
        r = command("cut-clone", "git", ["clone", "-q", "--no-local", "--no-checkout", approvedSourceRepo, sourceRoot], { cwd: ROOT });
        if (r.code === 0) r = command("cut-checkout", "git", ["checkout", "-q", "--detach", approvedCommit], { cwd: sourceRoot });
        if (r.code === 0 && gitAt(sourceRoot, "rev-parse", "HEAD") === approvedCommit
            && gitAt(sourceRoot, "status", "--porcelain") === "")
          writeFileSync(join(cut, "cut.json"), JSON.stringify({ commit: approvedCommit,
            project: sourceRoot, source_repo: approvedSourceRepo }));
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
      const plan = live ? null : readFileSync(join(sourceRoot, "docs", "plan", "01-booking-core", "spec.feature"), "utf8");
      const instruction = live ? readFileSync(join(HERE, builder.instructionFile), "utf8")
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
      const { attempt, previousFailureLog, previousFailureSha256, previousFailureKind } = task.state.checkpoint;
      const id = await tx.createTask(Builder,
        { attempt, previousFailureLog, previousFailureSha256, previousFailureKind },
        { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-build", attempt, builder: id }, on: [id], policy: "failFast" };
    }, ctx),
    "after-build": async (task, runtime) => {
      const { attempt, builder } = task.state.checkpoint;
      const [outcome] = await runtime.outcomes([builder], ctx);
      await runtime.commit(async (tx) => {
        const decision = lifecycle.afterBuild(attempt, outcome);
        if (decision.retry === "builder") {
            await audit(tx, task, "retry", "scheduled", { attempt: decision.attempt,
              previous_builder_log: decision.failureLog,
              previous_builder_log_sha256: decision.failureSha256,
              fork_from: builderReceipt(attempt) });
            return { status: "running", checkpoint: { phase: "build", attempt: decision.attempt,
              previousFailureLog: decision.failureLog,
              previousFailureSha256: decision.failureSha256,
              previousFailureKind: "builder" } };
        }
        if (decision.terminal) {
          await audit(tx, task, "cycle", "failed", { reason: decision.reason, attempt });
          if (decision.exhausted)
            return { status: "terminal", outcome: { status: "completed", result: { passed: false, attempts: attempt } } };
          return { status: "terminal", outcome: { status: "failed", error: "build" } };
        }
        return { status: "running", checkpoint: { phase: decision.phase, attempt } };
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
        const decision = lifecycle.afterGate(attempt, outcome);
        if (decision.reason === "gate-effect-failed") {
          await audit(tx, task, "cycle", "failed", { reason: decision.reason, attempt });
          return { status: "terminal", outcome: { status: "failed", error: "gate" } };
        }
        if (decision.phase === "grading-room") {
          return { status: "running", checkpoint: { phase: decision.phase, attempt,
            candidateSha256: decision.candidateSha256 } };
        }
        if (decision.retry === "gate") {
          await audit(tx, task, "retry", "scheduled", { attempt: decision.attempt,
            previous_gate_log: decision.failureLog });
          return { status: "running", checkpoint: { phase: "build", attempt: decision.attempt,
            previousFailureLog: decision.failureLog, previousFailureSha256: decision.failureSha256,
            previousFailureKind: "gate" } };
        }
        await audit(tx, task, "cycle", "failed", { reason: decision.reason, attempt });
        return { status: "terminal", outcome: { status: "completed", result: { passed: false, attempts: attempt } } };
      }, ctx);
    },
    "grading-room": async (task, runtime) => {
      if (live) {
        const candidateSha256 = task.state.checkpoint.candidateSha256;
        const checklistFile = join(scratch, "checklist.json");
        const args = { sourceRoom: room, candidateRoom: room, checklistFile, schemaFile,
          out: gradingRoom, candidateSha256, checklistSha256: approvedChecklistSha256,
          schemaSha256: grader?.schemaSha256 ?? attachedSchemaSha256,
          project, blindReview: blindRequired };
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
        const decision = lifecycle.afterGrade(outcome);
        if (decision.terminal) {
          await audit(tx, task, "cycle", "failed", { reason: decision.reason });
          return { status: "terminal", outcome: { status: "failed", error: "grade" } };
        }
        return { status: "running", checkpoint: { phase: decision.phase,
          attempt: task.state.checkpoint.attempt } };
      }, ctx);
    },
    "blind-review": async (task, runtime) => {
      const packetDir = join(scratch, "blind-agent-packet");
      const reviewFile = join(scratch, "blind-agent-review.json");
      const requestFile = join(scratch, "blind-agent-request.json");
      const verificationDir = join(scratch, "blind-agent-verification");
      const allureDir = join(scratch, "blind-agent-allure");
      let packetSha256, projected, reason, agentLaunch;
      try {
        if (!existsSync(packetDir)) prepareBlindReview({ gradingRoom, out: packetDir });
        packetSha256 = verifyBlindReviewPacket({ packetDir, gradingRoom }).packetSha256;
        if (blindAgent) {
          agentLaunch = await runBlindAgent({ packetDir, gradingRoom,
            room: join(scratch, "blind-agent-room"),
            instruction: join(HERE, blindAgent.instructionFile),
            command: blindAgent.command, image: blindAgent.image,
            settings: blindAgent.settings, model: blindAgent.model,
            evidenceDir: join(scratch, "blind-agent-evidence"),
            stateRoot: join(ROOT, ".pi/harness/.state"),
            sessionId: `${runId}-blind-011`,
            instructionSha256: blindAgent.instructionSha256,
            commandSha256: blindAgent.commandSha256,
            imageSha256: blindAgent.imageSha256,
            settingsSha256: blindAgent.settingsSha256 });
          const expected = agentLaunch.review;
          if (existsSync(reviewFile)) {
            const existing = JSON.parse(readFileSync(reviewFile, "utf8"));
            for (const key of Object.keys(expected)) if (key !== "reviewed_at"
                && JSON.stringify(existing[key]) !== JSON.stringify(expected[key]))
              throw new Error(`blind agent response changed after launch: ${key}`);
          } else {
            if (agentLaunch.request) {
              writeFileSync(`${requestFile}.partial`, `${JSON.stringify(agentLaunch.request)}\n`);
              renameSync(`${requestFile}.partial`, requestFile);
            }
            writeFileSync(`${reviewFile}.partial`, `${JSON.stringify(expected)}\n`);
            renameSync(`${reviewFile}.partial`, reviewFile);
          }
          if (agentLaunch.request && JSON.stringify(JSON.parse(readFileSync(requestFile, "utf8")))
              !== JSON.stringify(agentLaunch.request))
            throw new Error("blind agent request changed after launch");
          if (!agentLaunch.request && existsSync(requestFile))
            throw new Error("unusable blind answer must not supply an HTTP request");
        }
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
          agent_launch_receipt_sha256: agentLaunch?.review.launch_receipt_sha256 ?? null,
          agent_reconciled: agentLaunch?.reconciled ?? false,
          final_verdicts_sha256: projected ? hash(readFileSync(join(scratch, "final-verdicts.json"))) : null,
          reason_code: reason ? "blind-agent-evidence" : null });
        return projected ? { status: "running", checkpoint: { phase: lifecycle.afterAssessment("blind-review", true).phase,
          attempt: task.state.checkpoint.attempt } }
          : { status: "terminal", outcome: { status: "failed", error: "blind-review" } };
      }, ctx);
    },
    panel: async (task, runtime) => runtime.commit(async (tx) => {
      const id = await tx.createTask(Panel,
        { candidateSha256: candidateDigest(room) },
        { ownership: { kind: "task", taskId: task.id } });
      return { status: "waiting", checkpoint: { phase: "after-panel", panel: id,
        attempt: task.state.checkpoint.attempt }, on: [id], policy: "failFast" };
    }, ctx),
    "after-panel": async (task, runtime) => {
      const [outcome] = await runtime.outcomes([task.state.checkpoint.panel], ctx);
      await runtime.commit(async (tx) => {
        if (outcome?.status !== "completed") {
          await audit(tx, task, "cycle", "failed", { reason: "panel-vm-effect" });
          return { status: "terminal", outcome: { status: "failed", error: "panel" } };
        }
        return { status: "running", checkpoint: { phase: lifecycle.afterAssessment("panel", true).phase,
          attempt: task.state.checkpoint.attempt } };
      }, ctx);
    },
    score: async (task, runtime) => {
      const verdictsFile = join(scratch, blindRequired ? "final-verdicts.json" : "verdicts.json");
      let r, board, scoreReceipt, scoreInput, reason, reconciled = false;
      try {
        const candidateSha256 = candidateDigest(room);
        if (live && blindRequired) {
          verifyGradingRoom({ out: gradingRoom, candidateSha256,
            checklistSha256: approvedChecklistSha256, schemaSha256: grader.schemaSha256,
            project, blindReview: blindRequired });
          const reviewFile = join(scratch, "blind-agent-review.json");
          const review = JSON.parse(readFileSync(reviewFile, "utf8"));
          const projected = finalVerdictsFromBlindReview({ packetDir: join(scratch, "blind-agent-packet"),
            reviewFile, gradingRoom,
            verificationDir: review.verdict === "pass" ? join(scratch, "blind-agent-verification") : undefined,
            out: join(scratch, "blind-agent-allure") });
          if (JSON.stringify(projected.verdicts) !== readFileSync(verdictsFile, "utf8"))
            throw new Error("final verdicts changed after blind review");
        }
        if (!existsSync(instrument)) {
          const cloned = command("instrument-clone", "git", ["clone", "-q", "--depth", "1",
            `file://${sourceRoot}`, instrument]);
          if (cloned.code !== 0) throw new Error("instrument clone failed");
        }
        scoreInput = bindScoreInput({ scratch, sourceRoot, instrument,
          candidateSha256, verdictsFile, scoreCycle });
        const cycleDir = join(instrument, "harness", "cycles", scoreCycle);
        mkdirSync(cycleDir, { recursive: true });
        if (!existsSync(join(cycleDir, "checklist.json"))) {
          const checklist = command("score-checklist", "bb", ["harness/gen_checklist.clj",
            "--out", join(cycleDir, "checklist.json")], { cwd: instrument });
          if (checklist.code !== 0) throw new Error("score checklist derivation failed");
        }
        if (existsSync(join(cycleDir, "scores.json"))) {
          scoreReceipt = verifyScoredCycle({ scratch, instrument, verdictsFile, cycle: scoreCycle });
          r = { code: 0, sha256: scoreReceipt.scoreSha256 };
          reconciled = true;
        } else {
          r = command("score", "bb", ["harness/score.clj", scoreCycle, "--verdicts", verdictsFile],
            { cwd: instrument });
          if (r.code !== 0) throw new Error("legacy scorer failed");
          scoreReceipt = verifyScoredCycle({ scratch, instrument, verdictsFile, cycle: scoreCycle });
        }
        board = command("scoreboard", "bb", ["harness/scoreboard.clj", scoreCycle], { cwd: instrument });
        if (board.code !== 0) throw new Error("legacy scoreboard failed");
      } catch (error) {
        reason = String(error.stack ?? error);
        writeFileSync(join(scratch, "score-error.log"), `${reason}\n`);
      }
      const scored = scoreReceipt?.items ?? [];
      const score = scoreReceipt?.score ?? null;
      const blindAgentReviewFailed = blindRequired && scored.some((item) => item.id === "01-011" && item.verdict === "fail");
      const attempt = task.state.checkpoint.attempt ?? 2;
      await runtime.commit(async (tx) => {
        await audit(tx, task, "score", reason ? "failed" : "filed", {
          log_sha256: r?.sha256 ?? null, score_input_sha256: scoreInput
            ? hash(readFileSync(join(scratch, "score-input.json"))) : null,
          score_file_sha256: scoreReceipt?.scoreSha256 ?? null, reconciled,
          fixture_grader: !live || grader?.model.startsWith("test/") });
        if (!reason) await audit(tx, task, "scoreboard", "reported", {
          cycle: scoreCycle, log_sha256: board.sha256 });
        if (reason) {
          await audit(tx, task, "cycle", "failed", { reason: "score" });
          return { status: "terminal", outcome: { status: "failed", error: "score" } };
        }
        if (panel) return { status: "running", checkpoint: { phase: "panel-report",
          attempt, score, blindAgentReviewFailed } };
        await audit(tx, task, "cycle", live ? "measured" : "completed", {
          reason: blindAgentReviewFailed ? "blind-agent-review-failed" : null });
        return { status: "terminal", outcome: { status: "completed", result: {
          passed: !live, scored: true, blindAgentReviewFailed, attempts: attempt, score } } };
      }, ctx);
    },
    "panel-report": async (task, runtime) => {
      let report, reason;
      try {
        const selected = JSON.parse(readFileSync(join(scratch, "panel-vm", "selected.json"), "utf8"));
        const specialists = join(scratch, "panel-vm", `attempt-${String(selected.attempt).padStart(2, "0")}`);
        report = await runDurablePanelReport({ scratch, specialists,
          planFile: join(HERE, panel.planFile) });
      } catch (error) {
        reason = String(error.stack ?? error);
        writeFileSync(join(scratch, "panel-report-error.log"), `${reason}\n`);
      }
      await runtime.commit(async (tx) => {
        await audit(tx, task, "panel-report", report ? "completed" : "failed", {
          manifest_sha256: report ? hash(readFileSync(join(report.out, "panel-manifest.json"))) : null,
          plan_sha256: panel.planSha256,
          score: task.state.checkpoint.score,
          panel_outcome: report?.summary.panel_outcome ?? null,
          reconciled: report?.reconciled ?? false,
          reason_code: reason ? "panel-report-effect" : null });
        if (!report) {
          await audit(tx, task, "cycle", "failed", { reason: "panel-report-effect" });
          return { status: "terminal", outcome: { status: "failed", error: "panel-report" } };
        }
        const { attempt, score, blindAgentReviewFailed } = task.state.checkpoint;
        await audit(tx, task, "cycle", "measured", {
          reason: blindAgentReviewFailed ? "blind-agent-review-failed" : null,
          panel_outcome: report.summary.panel_outcome });
        return { status: "terminal", outcome: { status: "completed", result: {
          passed: false, scored: true, blindAgentReviewFailed, attempts: attempt, score,
          panelOutcome: report.summary.panel_outcome } } };
      }, ctx);
    },
  },
  abort: (_task, runtime) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const registry = createRegistry();
registry.install(defineExtension({ name: "loyly-prototype", tasks: [Builder, Gate, Grade, Panel, Cycle] }));
const harness = await Harness.open(await openNodeSqliteStorage(storePath), { models: createModels(), registry }, ctx);
try {
  const root = await harness.root(ctx);
  const existing = await harness.commit((tx) => tx.scanTasks({ kind: "loyly.proto.cycle" }, 10), ctx);
  let id = existing.items[0]?.id;
  const cycleInput = { runId, approvedCommit: approvedCommit ?? null, approvedChecklistSha256, mode, builder,
    ...(process.env.LOYLY_SOURCE_REPO ? { approvedSourceRepo } : {}),
    ...(scoreCycle !== "02" ? { scoreCycle } : {}),
    grader, blindAgent, ...(process.env.HARNESS_PROJECT_ID ? { project } : {}),
    ...(live && !blindRequired ? { blindRequired: false } : {}),
    panel, graderShardCount: live ? graderShardCount : null };
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
