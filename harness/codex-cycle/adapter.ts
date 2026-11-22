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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLifecycle } from "../cycle-core/lifecycle.ts";
import type {
  BuildResult,
  GateResult,
  TaskOutcome,
} from "../cycle-core/types.ts";
import { isSelectedChecklist } from "../evidence-core/types.ts";
import {
  allureFullName,
  assertAllureIdentity,
  featureTitleFromSpec,
  parsePlanSource,
  stampedItemId,
} from "../evidence-core/validate-identity.ts";
import {
  validateResultEvidence,
  type EvidenceResult,
} from "../evidence-core/validate-result.ts";
import { compileAllureSchema } from "../evidence-core/validate-schema.ts";
import { validateVerdictData } from "../evidence-core/validate-verdicts.ts";
import { validatePanelCoverage } from "../evidence-core/panel-selection.ts";

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
        (check as { tool?: string }).tool !== "Codex black-box grader",
    ) ||
    panel.checks.some(
      (check) =>
        check.source === "blind-review" &&
        (check as { tool?: string }).tool !== "fresh blind subagent",
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

export interface EvidenceFiles {
  checklist: string;
  verdicts: string;
  surprises: string;
  room: string;
  rawAllureDirs: string[];
  blindAllureDir?: string;
}

export function checkEvidence(files: EvidenceFiles) {
  const checklist: unknown = JSON.parse(readFileSync(files.checklist, "utf8"));
  const verdicts: unknown = JSON.parse(readFileSync(files.verdicts, "utf8"));
  const surprises: unknown = JSON.parse(readFileSync(files.surprises, "utf8"));
  const judged = validateVerdictData(checklist, verdicts, surprises);
  if (!isSelectedChecklist(checklist))
    throw new Error("invalid selected checklist");
  const selectedChecklist = checklist;
  const blindSelected = checklist.items.some((item) => item.id === "01-011");
  for (const surprise of judged.surprises) {
    const file = join(files.room, surprise.evidence_file);
    if (!existsSync(file) || !lstatSync(file).isFile())
      throw new Error(`missing surprise evidence: ${surprise.evidence_file}`);
  }
  const validateSchema = compileAllureSchema(
    JSON.parse(
      readFileSync(
        new URL(
          "../evidence-core/allure-lifecycle-result.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as object,
  );
  function readResult(dir: string, name: string, blind = false) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
    validateSchema(raw, name);
    const row = raw as EvidenceResult;
    const item = stampedItemId(row);
    if (!selectedChecklist.items.some((selected) => selected.id === item))
      throw new Error(`unselected Allure item ${item}`);
    const selected = selectedChecklist.items.find(
      (entry) => entry.id === item,
    ) as { id: string; name?: string; rule?: string; source?: string };
    if (selected.source) {
      if (
        typeof selected.name !== "string" ||
        typeof selected.rule !== "string"
      )
        throw new Error(`checklist item ${item} needs name and rule`);
      const { planDir, sliceKey } = parsePlanSource(selected.source);
      assertAllureIdentity(row, {
        itemId: item,
        name: selected.name,
        rule: selected.rule,
        feature: featureTitleFromSpec(
          readFileSync(
            join(files.room, "plan", planDir, "spec.feature"),
            "utf8",
          ),
        ),
        fullName: allureFullName({
          project: "loyly",
          sliceKey,
          itemId: item,
          blind,
        }),
      });
    }
    validateResultEvidence(row, item);
    for (const attachment of row.attachments ?? []) {
      if (
        basename(attachment.source) !== attachment.source ||
        !existsSync(join(dir, attachment.source)) ||
        !lstatSync(join(dir, attachment.source)).isFile()
      )
        throw new Error(`missing or unsafe attachment ${attachment.source}`);
    }
    return { row, item };
  }
  const observed = new Map<string, string>();
  let rawCount = 0;
  for (const dir of files.rawAllureDirs) {
    for (const name of readdirSync(dir).filter((entry) =>
      entry.endsWith("-result.json"),
    )) {
      const { row, item } = readResult(dir, name);
      if (observed.has(item))
        throw new Error(`duplicate raw Allure item ${item}`);
      if (
        row.labels.find((label) => label.name === "tool")?.value !==
        "Codex black-box grader"
      )
        throw new Error(
          `raw Allure tool differs from sealed Codex grader for ${item}`,
        );
      observed.set(item, row.status);
      rawCount++;
    }
  }
  if (rawCount !== checklist.items.length)
    throw new Error("raw Allure coverage differs from checklist");
  if (blindSelected && observed.get("01-011") !== "skipped")
    throw new Error("01-011 must remain pending for the blind reviewer");
  const blindResults = files.blindAllureDir
    ? readdirSync(files.blindAllureDir).filter((name) =>
        name.endsWith("-result.json"),
      )
    : [];
  if (blindResults.length > 1) throw new Error("multiple blind Allure results");
  if (blindSelected && blindResults.length !== 1)
    throw new Error("booking refusal needs exactly one blind Allure result");
  let blindStatus: string | undefined;
  if (blindResults[0] && files.blindAllureDir) {
    const { row, item } = readResult(
      files.blindAllureDir,
      blindResults[0],
      true,
    );
    if (
      item !== "01-011" ||
      observed.get(item) !== "skipped" ||
      row.labels.find((label) => label.name === "tool")?.value !==
        "fresh blind subagent" ||
      !["passed", "failed"].includes(row.status)
    )
      throw new Error(
        "blind Allure result does not resolve the pending refusal",
      );
    blindStatus = row.status;
  }
  for (const verdict of judged.verdicts) {
    const rawStatus = observed.get(verdict.id);
    const status = rawStatus === "skipped" ? blindStatus : rawStatus;
    if (
      !status ||
      (status !== "passed" && status !== "failed") ||
      verdict.verdict !== (status === "passed" ? "pass" : "fail")
    )
      throw new Error(
        `filed verdict differs from independent Allure evidence: ${verdict.id}`,
      );
  }
  const lifecycle = createLifecycle({
    assessments: blindResults.length ? ["blind-review"] : [],
  });
  return {
    items: checklist.items.length,
    passed: judged.pass,
    rawAllureResults: rawCount,
    blindAllureResults: blindResults.length,
    nextPhase: lifecycle.afterGrade({ status: "completed" }),
  };
}
