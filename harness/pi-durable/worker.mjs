// Pi durable candidate cycle over the unchanged legacy harness reference.
// Fixture mode is explicit; live mode pins every model and VM instrument.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineEntry, defineExtension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runGate } from "./gate-adapter.ts";
import { Effect, Layer } from 'effect';
import { GateRunError, GateRunner, verifyCandidate } from './gate-effects.ts';
import { hasBuilderLaunch, runBuilder } from "./builder-adapter.mjs";
import { candidateDigest as digestCandidate, verifyGradingRoom } from "./grading-room.ts";
import { prepareShards, combineShards } from "./grader-shards.ts";
import { runDurablePanel } from "./panel-adapter.mjs";
import { createLifecycle } from "../cycle-core/lifecycle.ts";
import { createCycleEffects, hash } from './cycle-effects.ts';
import { parseWorkerConfig } from './worker-config.ts';
import { createGateTask } from './tasks/gate.ts';
import { createPanelTask } from './tasks/panel.ts';
import { createBuilderTask } from './tasks/builder.ts';
import { createGradeTask } from './tasks/grade.ts';
import { createCycleTask } from './tasks/cycle.ts';

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

const Cycle = createCycleTask({
  lifecycle, audit, command, proveCut, proofOfFence, gitAt, candidateDigest, builderReceipt,
  Builder, Gate, Grade, Panel,
  cut, sourceRoot, room, scratch, gradingRoom, instrument,
  here: HERE, root: ROOT, runId,
  approvedCommit, approvedSourceRepo, approvedChecklistSha256,
  live, builder, grader, blindAgent, blindRequired, project, panel, scoreCycle,
  schemaFile, attachedSchemaSha256,
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
