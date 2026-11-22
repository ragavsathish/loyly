import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLifecycle } from "../cycle-core/lifecycle.ts";
import type {
  BuildResult,
  GateResult,
  TaskOutcome,
} from "../cycle-core/types.ts";
import {
  assessRoomPanel,
  type RoomPanelFiles,
} from "../evidence-core/assess-room-panel.ts";
import {
  checkRoomEvidence,
  type RoomEvidenceFiles,
} from "../evidence-core/check-room-evidence.ts";
import { isSelectedChecklist } from "../evidence-core/types.ts";
import { validatePanelCoverage } from "../evidence-core/panel-selection.ts";

export const CODEX_GRADER_TOOL = "Codex black-box grader";
export const CODEX_BLIND_TOOL = "fresh blind subagent";

const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const fileSha = (file: string) => sha(readFileSync(file));
const DISPOSABLE_CACHE_DIRS = new Set([
  ".npm-cache", ".npm", ".m2", ".uv-cache", ".cache", ".gradle", "node_modules",
]);
const CONTROLLER_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

interface PinnedFile {
  path: string;
  sha256: string;
}
interface AgentPin {
  model: string;
  instruction: PinnedFile;
  wrapper: PinnedFile;
}
export interface CycleContract {
  schema: "loyly.codex-subagent-cycle.v1";
  controllerCommit: string;
  runId: string;
  scoreCycle: string;
  scratch: string;
  source: {
    repo: string;
    commit: string;
    checklist: PinnedFile;
    itemIds: string[];
    specs: PinnedFile[];
  };
  agents: { builder: AgentPin; grader: AgentPin; blind?: AgentPin };
  execution: {
    builderEngine: "codex-subagent";
    builderRuntime: "host";
    graderEngine: "codex-subagent";
    graderRuntime: "gondolin-qemu-vm";
    blindEngine: "codex-subagent";
    blindProbeRuntime: "gondolin-qemu-vm";
    graderImageManifest: PinnedFile;
    allureSchema: PinnedFile;
    panelPlan: PinnedFile;
  };
}

/** Check the sealed candidate; post-gate permits installed dependencies in the gate-only copy. */
export function checkCandidateCaches(room: string, mode: "sealed" | "post-gate" = "sealed") {
  if (mode !== "sealed" && mode !== "post-gate") throw new Error(`invalid candidate cache mode: ${mode}`);
  const candidate = join(resolve(room), "impl");
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory())
    throw new Error(`candidate impl directory missing: ${candidate}`);
  const walk = (dir: string, relative: string): void => {
    for (const name of readdirSync(dir)) {
      const next = join(dir, name);
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(next);
      if (stat.isDirectory() && name === "node_modules" && mode === "post-gate") {
        walk(next, path);
        continue;
      }
      if (stat.isDirectory() && DISPOSABLE_CACHE_DIRS.has(name))
        throw new Error(`candidate contains disposable package cache impl/${path}`);
      if (stat.isDirectory()) walk(next, path);
      else if (!stat.isFile()) throw new Error(`candidate contains special file impl/${path}`);
    }
  };
  walk(candidate, "");
  return { room: resolve(room), mode, cacheFree: true };
}

function requirePin(pin: PinnedFile): void {
  if (
    !pin ||
    !/^[0-9a-f]{64}$/.test(pin.sha256) ||
    fileSha(pin.path) !== pin.sha256
  )
    throw new Error(`approved file differs: ${pin?.path ?? "missing"}`);
}

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export function checkContract(
  contract: CycleContract,
  controllerRoot = CONTROLLER_ROOT,
) {
  if (contract.schema !== "loyly.codex-subagent-cycle.v1")
    throw new Error("invalid cycle contract");
  if (
    !/^[A-Za-z0-9._-]+$/.test(contract.runId) ||
    !/^[0-9]{2}$/.test(contract.scoreCycle) ||
    !contract.scratch.startsWith("/") ||
    resolve(contract.scratch) !== contract.scratch
  )
    throw new Error(
      "run ID, score cycle and absolute scratch path must be pinned",
    );
  if (
    !/^[0-9a-f]{40}$/.test(contract.controllerCommit) ||
    git(controllerRoot, "rev-parse", "HEAD") !== contract.controllerCommit ||
    git(controllerRoot, "status", "--porcelain")
  )
    throw new Error(
      "controller checkout is dirty or differs from approved commit",
    );
  const source = contract.source;
  if (
    !/^[0-9a-f]{40}$/.test(source.commit) ||
    git(source.repo, "rev-parse", "HEAD") !== source.commit ||
    git(source.repo, "status", "--porcelain")
  )
    throw new Error("source checkout is dirty or differs from approved commit");
  requirePin(source.checklist);
  const derived = mkdtempSync(join(tmpdir(), "loyly-codex-checklist-"));
  try {
    const output = join(derived, "checklist.json");
    const generated = spawnSync(
      "bb",
      ["harness/gen_checklist.clj", "--out", output],
      { cwd: source.repo, encoding: "utf8" },
    );
    if (
      generated.status !== 0 ||
      !existsSync(output) ||
      !readFileSync(output).equals(readFileSync(source.checklist.path))
    )
      throw new Error(
        "pinned checklist differs from the source-derived checklist",
      );
  } finally {
    rmSync(derived, { recursive: true, force: true });
  }
  const checklist: unknown = JSON.parse(
    readFileSync(source.checklist.path, "utf8"),
  );
  if (!isSelectedChecklist(checklist))
    throw new Error("invalid selected checklist");
  const ids = checklist.items.map((item) => item.id);
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify(source.itemIds)
  )
    throw new Error("approved item list differs from checklist");
  const selectedSpecs = new Set<string>();
  for (const item of checklist.items) {
    const relative =
      /^((?:docs\/plan\/)[0-9]{2}-[a-z][a-z0-9-]*\/spec\.feature):[0-9]+$/.exec(
        (item as { source?: string }).source ?? "",
      )?.[1];
    if (!relative) throw new Error(`item ${item.id} has no source spec`);
    selectedSpecs.add(resolve(source.repo, relative));
  }
  if (
    new Set(source.specs.map((spec) => resolve(spec.path))).size !==
      source.specs.length ||
    JSON.stringify([...selectedSpecs].sort()) !==
      JSON.stringify(source.specs.map((spec) => resolve(spec.path)).sort())
  )
    throw new Error("approved specs differ from checklist sources");
  for (const spec of source.specs) requirePin(spec);
  if (contract.agents.builder.model === contract.agents.grader.model)
    throw new Error("builder and grader need different models");
  if (ids.includes("01-011") && !contract.agents.blind)
    throw new Error("booking refusal needs a fresh blind subagent");
  const execution = contract.execution;
  if (
    !execution ||
    execution.builderEngine !== "codex-subagent" ||
    execution.builderRuntime !== "host" ||
    execution.graderEngine !== "codex-subagent" ||
    execution.graderRuntime !== "gondolin-qemu-vm" ||
    execution.blindEngine !== "codex-subagent" ||
    execution.blindProbeRuntime !== "gondolin-qemu-vm"
  )
    throw new Error(
      "Codex agent and private Gondolin VM boundary is not pinned",
    );
  for (const agent of Object.values(contract.agents)) {
    requirePin(agent.instruction);
    requirePin(agent.wrapper);
  }
  for (const instrument of [
    execution.graderImageManifest,
    execution.allureSchema,
    execution.panelPlan,
  ])
    requirePin(instrument);
  const panel = JSON.parse(
    readFileSync(execution.panelPlan.path, "utf8"),
  ) as Parameters<typeof validatePanelCoverage>[0];
  validatePanelCoverage(
    panel,
    checklist,
    ids.includes("01-011") ? "01-011" : undefined,
  );
  if (
    panel.checks.some(
      (check) =>
        check.source === "raw-grader" &&
        (check as { tool?: string }).tool !== CODEX_GRADER_TOOL,
    ) ||
    panel.checks.some(
      (check) =>
        check.source === "blind-review" &&
        (check as { tool?: string }).tool !== CODEX_BLIND_TOOL,
    )
  )
    throw new Error("panel tool labels differ from Codex subagents");
  return {
    controllerCommit: contract.controllerCommit,
    runId: contract.runId,
    scoreCycle: contract.scoreCycle,
    sourceCommit: source.commit,
    itemIds: ids,
    checklistSha256: source.checklist.sha256,
    specSha256: source.specs.map((spec) => ({
      path: spec.path,
      sha256: spec.sha256,
    })),
  };
}

export function decideAttempt(
  attempt: number,
  build: TaskOutcome<BuildResult>,
  gate?: TaskOutcome<GateResult>,
) {
  const lifecycle = createLifecycle({ maxBuildAttempts: 3 });
  const afterBuild = lifecycle.afterBuild(attempt, build);
  if ("terminal" in afterBuild || afterBuild.phase !== "gate")
    return { afterBuild };
  return { afterBuild, afterGate: lifecycle.afterGate(attempt, gate) };
}

export type EvidenceFiles = RoomEvidenceFiles;

export function checkEvidence(files: EvidenceFiles) {
  const report = checkRoomEvidence(files, {
    graderTool: CODEX_GRADER_TOOL,
    blindTool: CODEX_BLIND_TOOL,
    handoffItem: "01-011",
  });
  return {
    ...report,
    nextPhase: createLifecycle({
      assessments: report.assessments,
    }).afterGrade({ status: "completed" }),
  };
}

export type PanelFiles = RoomPanelFiles;

/** Run evidence-core evaluatePanel over room Allure + filed verdicts. */
export function checkPanel(files: PanelFiles) {
  const panel = assessRoomPanel(files);
  return {
    ...panel,
    nextPhase: createLifecycle({
      assessments: ["panel"],
    }).afterAssessment("panel", panel.panel_outcome === "ready-for-review"),
  };
}
