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
  checkRoomEvidence,
  type RoomEvidenceFiles,
} from "../evidence-core/check-room-evidence.ts";
import { isSelectedChecklist } from "../evidence-core/types.ts";
import { validatePanelCoverage } from "../evidence-core/panel-selection.ts";

const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const fileSha = (file: string) => sha(readFileSync(file));
const DISPOSABLE_CACHE_DIRS = new Set([
  ".npm-cache",
  ".npm",
  ".m2",
  ".uv-cache",
  ".cache",
  ".gradle",
  "node_modules",
]);
const CONTROLLER_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEFAULT_DOCKERFILE = resolve(
  CONTROLLER_ROOT,
  "harness/pi-durable/Dockerfile.panel-multistack",
);
export const CURSOR_GRADER_TOOL = "Cursor black-box grader";
export const CURSOR_BLIND_TOOL = "fresh blind subagent";

interface PinnedFile {
  path: string;
  sha256: string;
}
interface AgentPin {
  model: string;
  instruction: PinnedFile;
  wrapper: PinnedFile;
}

/** Candidate probes run in the Cursor remote session itself. */
export type RemoteRuntime = "cursor-remote-session";
/** Host orchestration isolates candidate probes in Docker. */
export type HostProbeRuntime = "docker";
export type BuilderRuntime = RemoteRuntime | "host";
export type ProbeRuntime = RemoteRuntime | HostProbeRuntime;

export interface CycleContract {
  schema: "loyly.cursor-subagent-cycle.v1";
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
    builderEngine: "cursor-cloud-agent";
    builderRuntime: BuilderRuntime;
    graderEngine: "cursor-cloud-agent";
    graderRuntime: ProbeRuntime;
    blindEngine: "cursor-cloud-agent";
    blindProbeRuntime: ProbeRuntime;
    /** Required when grader or blind probe runtime is docker. */
    dockerImage?: PinnedFile;
    /** Defaults to harness/pi-durable/Dockerfile.panel-multistack when docker is used. */
    dockerfile?: PinnedFile;
    allureSchema: PinnedFile;
    panelPlan: PinnedFile;
  };
}

/** Check the sealed candidate; post-gate permits installed dependencies in the gate-only copy. */
export function checkCandidateCaches(
  room: string,
  mode: "sealed" | "post-gate" = "sealed",
) {
  if (mode !== "sealed" && mode !== "post-gate")
    throw new Error(`invalid candidate cache mode: ${mode}`);
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
        throw new Error(
          `candidate contains disposable package cache impl/${path}`,
        );
      if (stat.isDirectory()) walk(next, path);
      else if (!stat.isFile())
        throw new Error(`candidate contains special file impl/${path}`);
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

function assertProbeBoundary(execution: CycleContract["execution"]): void {
  const { graderRuntime, blindProbeRuntime, builderRuntime } = execution;
  const dockerUsed =
    graderRuntime === "docker" || blindProbeRuntime === "docker";
  const remoteUsed =
    graderRuntime === "cursor-remote-session" ||
    blindProbeRuntime === "cursor-remote-session";
  if (dockerUsed && remoteUsed)
    throw new Error(
      "grader and blind probe must share one isolation mode: cursor-remote-session or docker",
    );
  if (
    graderRuntime === "cursor-remote-session" &&
    blindProbeRuntime === "cursor-remote-session"
  ) {
    if (builderRuntime !== "cursor-remote-session" && builderRuntime !== "host")
      throw new Error("invalid builder runtime for Cursor remote grading");
    if (execution.dockerImage || execution.dockerfile)
      throw new Error(
        "Cursor remote-session grading does not pin a Docker image",
      );
    return;
  }
  if (graderRuntime !== "docker" || blindProbeRuntime !== "docker")
    throw new Error(
      "host Cursor grading isolates candidate probes in Docker from Dockerfile.panel-multistack",
    );
  if (builderRuntime !== "host" && builderRuntime !== "cursor-remote-session")
    throw new Error("invalid builder runtime for host Docker grading");
  const dockerfile = execution.dockerfile ?? {
    path: DEFAULT_DOCKERFILE,
    sha256: fileSha(DEFAULT_DOCKERFILE),
  };
  requirePin(dockerfile);
  if (resolve(dockerfile.path) !== DEFAULT_DOCKERFILE)
    throw new Error(
      "host Docker grading must pin harness/pi-durable/Dockerfile.panel-multistack",
    );
  if (!execution.dockerImage) throw new Error("docker image digest is not pinned");
  requirePin(execution.dockerImage);
  execution.dockerfile = dockerfile;
}

export function checkContract(
  contract: CycleContract,
  controllerRoot = CONTROLLER_ROOT,
) {
  if (contract.schema !== "loyly.cursor-subagent-cycle.v1")
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
  const derived = mkdtempSync(join(tmpdir(), "loyly-cursor-checklist-"));
  let fullItems: { id: string; source?: string }[] = [];
  try {
    const output = join(derived, "checklist.json");
    const generated = spawnSync(
      "bb",
      ["harness/gen_checklist.clj", "--out", output],
      { cwd: source.repo, encoding: "utf8" },
    );
    if (generated.status !== 0 || !existsSync(output))
      throw new Error(
        "pinned checklist differs from the source-derived checklist",
      );
    const full = JSON.parse(readFileSync(output, "utf8")) as {
      items: { id: string; source?: string }[];
    };
    if (!isSelectedChecklist(full))
      throw new Error("source-derived checklist is invalid");
    fullItems = full.items;
  } finally {
    rmSync(derived, { recursive: true, force: true });
  }
  const fullIds = fullItems.map((item) => item.id);
  if (
    !source.itemIds.length ||
    new Set(source.itemIds).size !== source.itemIds.length
  )
    throw new Error("approved item list differs from checklist");
  let cursor = 0;
  for (const id of source.itemIds) {
    const next = fullIds.indexOf(id, cursor);
    if (next < 0)
      throw new Error(`selected item ${id} is absent from the derived checklist`);
    cursor = next + 1;
  }
  const selectedItems = source.itemIds.map(
    (id) => fullItems.find((item) => item.id === id)!,
  );
  const checklist: unknown = JSON.parse(
    readFileSync(source.checklist.path, "utf8"),
  );
  if (!isSelectedChecklist(checklist))
    throw new Error("invalid selected checklist");
  const ids = checklist.items.map((item) => item.id);
  if (
    JSON.stringify(ids) !== JSON.stringify(source.itemIds) ||
    JSON.stringify(checklist.items) !== JSON.stringify(selectedItems)
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
    execution.builderEngine !== "cursor-cloud-agent" ||
    execution.graderEngine !== "cursor-cloud-agent" ||
    execution.blindEngine !== "cursor-cloud-agent"
  )
    throw new Error("Cursor cloud-agent engine boundary is not pinned");
  assertProbeBoundary(execution);
  for (const agent of Object.values(contract.agents)) {
    requirePin(agent.instruction);
    requirePin(agent.wrapper);
  }
  for (const instrument of [execution.allureSchema, execution.panelPlan])
    requirePin(instrument);
  const panel = JSON.parse(readFileSync(execution.panelPlan.path, "utf8")) as {
    checks: {
      id: string;
      source: string;
      role: string;
      items: string[];
      tool?: string;
      target_runtime?: string;
    }[];
  };
  validatePanelCoverage(
    panel,
    checklist,
    ids.includes("01-011") ? "01-011" : undefined,
  );
  const expectedRuntime = execution.graderRuntime;
  if (
    panel.checks.some(
      (check) =>
        check.source === "raw-grader" && check.tool !== CURSOR_GRADER_TOOL,
    ) ||
    panel.checks.some(
      (check) =>
        check.source === "blind-review" && check.tool !== CURSOR_BLIND_TOOL,
    )
  )
    throw new Error("panel tool labels differ from Cursor cloud agents");
  if (
    panel.checks.some(
      (check) =>
        (check.source === "raw-grader" || check.source === "blind-review") &&
        check.target_runtime !== expectedRuntime,
    )
  )
    throw new Error(
      `panel target_runtime must match pinned probe runtime ${expectedRuntime}`,
    );
  return {
    controllerCommit: contract.controllerCommit,
    runId: contract.runId,
    scoreCycle: contract.scoreCycle,
    sourceCommit: source.commit,
    itemIds: ids,
    checklistSha256: source.checklist.sha256,
    probeRuntime: expectedRuntime,
    dockerfile:
      expectedRuntime === "docker"
        ? (execution.dockerfile ?? {
            path: DEFAULT_DOCKERFILE,
            sha256: fileSha(DEFAULT_DOCKERFILE),
          })
        : undefined,
    dockerImage: execution.dockerImage,
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
    graderTool: CURSOR_GRADER_TOOL,
    blindTool: CURSOR_BLIND_TOOL,
    handoffItem: "01-011",
  });
  return {
    ...report,
    nextPhase: createLifecycle({
      assessments: report.assessments,
    }).afterGrade({ status: "completed" }),
  };
}
