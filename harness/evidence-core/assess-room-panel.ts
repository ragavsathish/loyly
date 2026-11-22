// Build panel observations from a grading room and run evaluatePanel.
// Specialists are optional dirs keyed by check id; raw+blind cover booking-core.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePanel } from "./panel-policy.ts";
import {
  isSelectedChecklist,
  type PanelEvaluation,
  type PanelObservation,
  type PanelPlan,
  type PanelStatus,
  type ScoredItem,
} from "./types.ts";
import { stampedItemId, type AllureLabel } from "./validate-identity.ts";
import { compileAllureSchema } from "./validate-schema.ts";
import { validateVerdictData } from "./validate-verdicts.ts";

const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const fileSha = (file: string) => sha(readFileSync(file));

export interface RoomPanelFiles {
  plan: string;
  checklist: string;
  verdicts: string;
  surprises: string;
  rawAllureDirs: string[];
  blindAllureDir?: string;
  /** Specialist Allure dirs keyed by panel check id. */
  specialistDirs?: Record<string, string>;
  /** Observed runtime for every observation (must match plan target_runtime). */
  runtime: string;
  schemaPath?: string;
}

function labelValue(
  labels: AllureLabel[],
  name: string,
): string | undefined {
  return labels.find((label) => label.name === name)?.value;
}

function readAllureDir(
  dir: string,
  validateSchema: (result: unknown, hint?: string) => void,
): {
  item: string;
  tool: string;
  technique: string;
  status: PanelStatus;
  message: string;
  result_sha256: string;
}[] {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory())
    throw new Error(`panel Allure directory missing: ${dir}`);
  const rows = [];
  for (const name of readdirSync(dir).filter((entry) =>
    entry.endsWith("-result.json"),
  )) {
    const path = join(dir, name);
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    validateSchema(raw, name);
    const result = raw as {
      labels: AllureLabel[];
      status: string;
      statusDetails?: { message?: string };
    };
    const item = stampedItemId(result);
    const tool = labelValue(result.labels, "tool");
    const technique = labelValue(result.labels, "technique");
    const message = result.statusDetails?.message?.trim();
    if (
      !tool ||
      !technique ||
      !message ||
      !["passed", "failed", "broken", "skipped"].includes(result.status)
    )
      throw new Error(`panel Allure result incomplete: ${name}`);
    rows.push({
      item,
      tool,
      technique,
      status: result.status as PanelStatus,
      message,
      result_sha256: fileSha(path),
    });
  }
  return rows;
}

function matchCheck(
  plan: PanelPlan,
  source: string,
  item: string,
  tool: string,
  technique: string,
  checkId?: string,
) {
  const matches = plan.checks.filter(
    (check) =>
      check.source === source &&
      check.items.includes(item) &&
      check.tool === tool &&
      check.technique === technique &&
      (checkId === undefined || check.id === checkId),
  );
  if (matches.length !== 1 || !matches[0])
    throw new Error(
      `panel plan has no unique ${source} check for ${item} / ${tool}`,
    );
  return matches[0];
}

/** Scorecard rows for evaluatePanel from checklist + filed verdicts. */
export function scoredItemsFromVerdicts(
  checklistPath: string,
  verdictsPath: string,
  surprisesPath: string,
): ScoredItem[] {
  const checklist: unknown = JSON.parse(readFileSync(checklistPath, "utf8"));
  const verdicts: unknown = JSON.parse(readFileSync(verdictsPath, "utf8"));
  const surprises: unknown = JSON.parse(readFileSync(surprisesPath, "utf8"));
  const judged = validateVerdictData(checklist, verdicts, surprises);
  if (!isSelectedChecklist(checklist))
    throw new Error("invalid selected checklist");
  return judged.verdicts.map((verdict) => {
    const item = checklist.items.find((entry) => entry.id === verdict.id) as {
      id: string;
      rule?: string;
    };
    if (typeof item.rule !== "string" || !item.rule.trim())
      throw new Error(`checklist item ${verdict.id} needs a rule for the panel`);
    return { id: verdict.id, rule: item.rule, verdict: verdict.verdict };
  });
}

export function assessRoomPanel(files: RoomPanelFiles): PanelEvaluation {
  const plan = JSON.parse(readFileSync(files.plan, "utf8")) as PanelPlan;
  if (!Array.isArray(plan.checks) || !plan.checks.length)
    throw new Error("panel plan has no checks");
  const scoredItems = scoredItemsFromVerdicts(
    files.checklist,
    files.verdicts,
    files.surprises,
  );
  const schema = JSON.parse(
    readFileSync(
      files.schemaPath ??
        fileURLToPath(
          new URL("./allure-lifecycle-result.schema.json", import.meta.url),
        ),
      "utf8",
    ),
  ) as object;
  const validateSchema = compileAllureSchema(schema);
  const observations: PanelObservation[] = [];
  for (const dir of files.rawAllureDirs) {
    for (const row of readAllureDir(dir, validateSchema)) {
      const check = matchCheck(
        plan,
        "raw-grader",
        row.item,
        row.tool,
        row.technique,
      );
      observations.push({
        id: check.id,
        item: row.item,
        tool: row.tool,
        technique: row.technique,
        status: row.status,
        runtime: files.runtime,
        result_sha256: row.result_sha256,
        message: row.message,
      });
    }
  }
  if (files.blindAllureDir) {
    for (const row of readAllureDir(files.blindAllureDir, validateSchema)) {
      const check = matchCheck(
        plan,
        "blind-review",
        row.item,
        row.tool,
        row.technique,
      );
      observations.push({
        id: check.id,
        item: row.item,
        tool: row.tool,
        technique: row.technique,
        status: row.status,
        runtime: files.runtime,
        result_sha256: row.result_sha256,
        message: row.message,
      });
    }
  }
  for (const [checkId, dir] of Object.entries(files.specialistDirs ?? {})) {
    for (const row of readAllureDir(dir, validateSchema)) {
      const check = matchCheck(
        plan,
        "specialist",
        row.item,
        row.tool,
        row.technique,
        checkId,
      );
      observations.push({
        id: check.id,
        item: row.item,
        tool: row.tool,
        technique: row.technique,
        status: row.status,
        runtime: files.runtime,
        result_sha256: row.result_sha256,
        message: row.message,
      });
    }
  }
  return evaluatePanel(plan, scoredItems, observations);
}
