// Read-only preflight for a separately pinned grader-only reassessment.
// The original score stays immutable; a reassessment writes under `output`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSelectedChecklist } from "../evidence-core/types.ts";
import { validatePanelCoverage } from "../evidence-core/panel-selection.ts";
import { CODEX_GRADER_TOOL } from "./adapter.ts";

interface PinnedFile {
  path: string;
  sha256: string;
}

export interface ReassessmentContract {
  schema: "loyly.codex-grader-reassessment.v1";
  controllerCommit: string;
  reassessmentId: string;
  output: string;
  original: {
    cycleDir: string;
    sourceCommit: string;
    builderModel: string;
    candidateSha256: string;
    scoreSha256: string;
    checklistSha256: string;
    runContractSha256: string;
  };
  selection: {
    itemIds: string[];
    checklist: PinnedFile;
    specs: PinnedFile[];
  };
  grader: {
    model: string;
    instruction: PinnedFile;
    wrapper: PinnedFile;
  };
  execution: {
    engine: "codex-subagent";
    runtime: "gondolin-qemu-vm";
    graderImageManifest: PinnedFile;
    allureSchema: PinnedFile;
    panelPlan: PinnedFile;
  };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const fileSha = (file: string) => sha(readFileSync(file));
const digestPattern = /^[0-9a-f]{64}$/;

function pin(file: PinnedFile): void {
  if (
    !file ||
    !isAbsolute(file.path) ||
    resolve(file.path) !== file.path ||
    !digestPattern.test(file.sha256) ||
    !existsSync(file.path) ||
    !lstatSync(file.path).isFile() ||
    fileSha(file.path) !== file.sha256
  )
    throw new Error(`reassessment pin differs: ${file?.path ?? "missing"}`);
}

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

// Same path/mode/bytes framing as the frozen grading-room candidate receipt.
export function candidateDigest(impl: string): string {
  const digest = createHash("sha256");
  function walk(dir: string, prefix: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relative = `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, relative);
      else if (stat.isFile()) {
        digest.update(relative);
        digest.update("\0");
        digest.update(String(stat.mode & 0o777));
        digest.update("\0");
        digest.update(readFileSync(path));
        digest.update("\0");
      } else
        throw new Error(`candidate has a symlink or special file: ${relative}`);
    }
  }
  walk(impl, "impl");
  return digest.digest("hex");
}

export function checkReassessment(
  contract: ReassessmentContract,
  controllerRoot = ROOT,
) {
  if (
    contract?.schema !== "loyly.codex-grader-reassessment.v1" ||
    !/^[A-Za-z0-9._-]+$/.test(contract.reassessmentId) ||
    !/^[0-9a-f]{40}$/.test(contract.controllerCommit) ||
    git(controllerRoot, "rev-parse", "HEAD") !== contract.controllerCommit ||
    git(controllerRoot, "status", "--porcelain")
  )
    throw new Error(
      "reassessment controller differs from approved clean commit",
    );
  if (
    !isAbsolute(contract.output) ||
    resolve(contract.output) !== contract.output ||
    existsSync(contract.output)
  )
    throw new Error("reassessment output must be a fresh absolute path");
  const original = contract.original;
  if (
    !original ||
    !isAbsolute(original.cycleDir) ||
    resolve(original.cycleDir) !== original.cycleDir ||
    contract.output.startsWith(`${original.cycleDir}/`) ||
    !/^[0-9a-f]{40}$/.test(original.sourceCommit) ||
    !original.builderModel ||
    ![
      original.candidateSha256,
      original.scoreSha256,
      original.checklistSha256,
      original.runContractSha256,
    ].every((x) => digestPattern.test(x ?? ""))
  )
    throw new Error("reassessment original must be fully pinned and separate");
  const originalFile = (name: string) => join(original.cycleDir, name);
  for (const [name, expected] of [
    ["scores.json", original.scoreSha256],
    ["checklist.json", original.checklistSha256],
    ["run-contract.json", original.runContractSha256],
  ]) {
    if (fileSha(originalFile(name!)) !== expected)
      throw new Error(
        `original ${name} differs from pinned score/checklist/contract`,
      );
  }
  if (
    candidateDigest(originalFile("candidate/impl")) !== original.candidateSha256
  )
    throw new Error("original candidate differs from pinned gated digest");
  const originalRun: unknown = JSON.parse(
    readFileSync(originalFile("run-contract.json"), "utf8"),
  );
  const run = originalRun as {
    source?: { commit?: string };
    agents?: { builder?: { model?: string } };
  };
  if (
    run.source?.commit !== original.sourceCommit ||
    run.agents?.builder?.model !== original.builderModel
  )
    throw new Error("original source or builder model differs from filed run");
  const full: unknown = JSON.parse(
    readFileSync(originalFile("checklist.json"), "utf8"),
  );
  const scores: unknown = JSON.parse(
    readFileSync(originalFile("scores.json"), "utf8"),
  );
  if (!isSelectedChecklist(full) || !isSelectedChecklist(scores))
    throw new Error("invalid original checklist or score");
  const scored = scores.items as { id: string; verdict?: string }[];
  const fullIds = full.items.map((item) => item.id);
  if (
    JSON.stringify(scored.map((item) => item.id)) !== JSON.stringify(fullIds) ||
    scored.some((item) => !["pass", "fail"].includes(item.verdict ?? ""))
  )
    throw new Error("original score differs from its full checklist");
  const failed = scored
    .filter((item) => item.verdict === "fail")
    .map((item) => item.id);
  const selected = contract.selection;
  if (
    !selected ||
    !failed.length ||
    JSON.stringify(selected.itemIds) !== JSON.stringify(failed)
  )
    throw new Error(
      "reassessment must select exactly the original failed items",
    );
  pin(selected.checklist);
  const subset: unknown = JSON.parse(
    readFileSync(selected.checklist.path, "utf8"),
  );
  if (!isSelectedChecklist(subset))
    throw new Error("invalid reassessment checklist");
  const expectedItems = full.items.filter((item) => failed.includes(item.id));
  if (JSON.stringify(subset.items) !== JSON.stringify(expectedItems))
    throw new Error(
      "reassessment checklist differs from selected original items",
    );
  const specPaths = new Set(
    expectedItems.map((item) => {
      const source = (item as { source?: string }).source;
      const match =
        /^docs\/plan\/(\d\d-[a-z][a-z0-9-]*)\/spec\.feature:\d+$/.exec(
          source ?? "",
        );
      if (!match)
        throw new Error(`selected item has invalid source: ${item.id}`);
      return originalFile(`grading-room/plan/${match[1]}/spec.feature`);
    }),
  );
  if (
    new Set(selected.specs.map((spec) => spec.path)).size !==
      selected.specs.length ||
    JSON.stringify(selected.specs.map((spec) => spec.path).sort()) !==
      JSON.stringify([...specPaths].sort())
  )
    throw new Error("reassessment specs differ from selected source slices");
  for (const spec of selected.specs) pin(spec);
  if (
    !contract.grader ||
    !contract.grader.model ||
    contract.grader.model === original.builderModel
  )
    throw new Error("reassessment grader must use an independent model");
  pin(contract.grader.instruction);
  pin(contract.grader.wrapper);
  const execution = contract.execution;
  if (
    !execution ||
    execution.engine !== "codex-subagent" ||
    execution.runtime !== "gondolin-qemu-vm"
  )
    throw new Error(
      "reassessment must use a Codex agent and private Gondolin VMs",
    );
  for (const file of [
    execution.graderImageManifest,
    execution.allureSchema,
    execution.panelPlan,
  ])
    pin(file);
  if (basename(execution.graderImageManifest.path) !== "manifest.json")
    throw new Error("grader VM pin must name its manifest");
  const panel = JSON.parse(
    readFileSync(execution.panelPlan.path, "utf8"),
  ) as Parameters<typeof validatePanelCoverage>[0];
  validatePanelCoverage(panel, subset);
  if (
    panel.checks.some(
      (check) =>
        check.source !== "raw-grader" ||
        check.role !== "scored" ||
        (check as { tool?: string }).tool !== CODEX_GRADER_TOOL,
    )
  )
    throw new Error(
      "reassessment panel must be a raw independent Codex grader",
    );
  return {
    reassessmentId: contract.reassessmentId,
    controllerCommit: contract.controllerCommit,
    sourceCommit: original.sourceCommit,
    candidateSha256: original.candidateSha256,
    originalScoreSha256: original.scoreSha256,
    originalChecklistSha256: original.checklistSha256,
    selectedItemIds: failed,
    selectedChecklistSha256: selected.checklist.sha256,
    graderModel: contract.grader.model,
    graderInstructionSha256: contract.grader.instruction.sha256,
    graderWrapperSha256: contract.grader.wrapper.sha256,
    panelSha256: execution.panelPlan.sha256,
    imageManifestSha256: execution.graderImageManifest.sha256,
    allureSchemaSha256: execution.allureSchema.sha256,
    output: contract.output,
  };
}
