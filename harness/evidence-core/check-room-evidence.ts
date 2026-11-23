// Shared room evidence check for subagent orchestrators (Codex, Cursor).
// Reads a grading room; pure schema/identity rules come from sibling modules.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSelectedChecklist } from "./types.ts";
import {
  allureFullName,
  assertAllureIdentity,
  featureTitleFromSpec,
  parsePlanSource,
  stampedItemId,
} from "./validate-identity.ts";
import {
  validateResultEvidence,
  type EvidenceResult,
} from "./validate-result.ts";
import { compileAllureSchema } from "./validate-schema.ts";
import { validateVerdictData } from "./validate-verdicts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = join(HERE, "allure-lifecycle-result.schema.json");

export interface RoomEvidenceFiles {
  checklist: string;
  verdicts: string;
  surprises: string;
  room: string;
  rawAllureDirs: string[];
  blindAllureDir?: string;
  /** Defaults to evidence-core's approved schema file. */
  schemaPath?: string;
}

/** Adapter-sealed producer names and optional blind handoff item id. */
export interface RoomEvidenceSeals {
  graderTool: string;
  blindTool: string;
  /** Grading project identity prefix (default `loyly`). */
  project?: string;
  /**
   * When this id is on the checklist, the raw result must stay pending and
   * exactly one blind Allure result must resolve it.
   */
  handoffItem?: string;
}

export interface RoomEvidenceReport {
  items: number;
  passed: number;
  rawAllureResults: number;
  blindAllureResults: number;
  /** Pass to cycle-core `createLifecycle({ assessments })`. */
  assessments: string[];
}

type SelectedChecklist = {
  items: Array<{ id: string; name?: string; rule?: string; source?: string }>;
};

type SchemaValidator = (raw: unknown, name: string) => void;

function readRoomResult(
  dir: string,
  name: string,
  files: RoomEvidenceFiles,
  selectedChecklist: SelectedChecklist,
  project: string,
  validateSchema: SchemaValidator,
  blind = false,
) {
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
        project,
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

function collectRawObservations(
  files: RoomEvidenceFiles,
  seals: RoomEvidenceSeals,
  selectedChecklist: SelectedChecklist,
  project: string,
  validateSchema: SchemaValidator,
) {
  const observed = new Map<string, string | undefined>();
  let rawCount = 0;
  for (const dir of files.rawAllureDirs) {
    for (const name of readdirSync(dir).filter((entry) =>
      entry.endsWith("-result.json"),
    )) {
      const { row, item } = readRoomResult(
        dir, name, files, selectedChecklist, project, validateSchema,
      );
      if (observed.has(item))
        throw new Error(`duplicate raw Allure item ${item}`);
      if (
        row.labels.find((label) => label.name === "tool")?.value !==
        seals.graderTool
      )
        throw new Error(
          `raw Allure tool differs from sealed grader for ${item}`,
        );
      observed.set(item, row.status);
      rawCount++;
    }
  }
  if (rawCount !== selectedChecklist.items.length)
    throw new Error("raw Allure coverage differs from checklist");
  return { observed, rawCount };
}

function resolveBlindAllure(
  files: RoomEvidenceFiles,
  seals: RoomEvidenceSeals,
  selectedChecklist: SelectedChecklist,
  project: string,
  validateSchema: SchemaValidator,
  observed: Map<string, string | undefined>,
  blindSelected: boolean,
) {
  const handoffItem = seals.handoffItem;
  if (
    blindSelected &&
    handoffItem &&
    observed.get(handoffItem) !== "skipped"
  )
    throw new Error(
      `${handoffItem} must remain pending for the blind reviewer`,
    );
  const blindResults = files.blindAllureDir
    ? readdirSync(files.blindAllureDir).filter((name) =>
        name.endsWith("-result.json"),
      )
    : [];
  if (blindResults.length > 1) throw new Error("multiple blind Allure results");
  if (blindSelected && blindResults.length !== 1)
    throw new Error("blind handoff needs exactly one blind Allure result");
  let blindStatus: string | undefined;
  if (blindResults[0] && files.blindAllureDir) {
    const { row, item } = readRoomResult(
      files.blindAllureDir,
      blindResults[0],
      files,
      selectedChecklist,
      project,
      validateSchema,
      true,
    );
    if (
      !handoffItem ||
      item !== handoffItem ||
      observed.get(item) !== "skipped" ||
      row.labels.find((label) => label.name === "tool")?.value !==
        seals.blindTool ||
      !row.status ||
      !["passed", "failed"].includes(row.status)
    )
      throw new Error(
        "blind Allure result does not resolve the pending handoff",
      );
    blindStatus = row.status;
  }
  return { blindResults, blindStatus };
}

function assertVerdictsMatchEvidence(
  judged: { verdicts: Array<{ id: string; verdict: string }> },
  observed: Map<string, string | undefined>,
  blindStatus: string | undefined,
) {
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
}

export function checkRoomEvidence(
  files: RoomEvidenceFiles,
  seals: RoomEvidenceSeals,
): RoomEvidenceReport {
  const project = seals.project ?? "loyly";
  const checklist: unknown = JSON.parse(readFileSync(files.checklist, "utf8"));
  const verdicts: unknown = JSON.parse(readFileSync(files.verdicts, "utf8"));
  const surprises: unknown = JSON.parse(readFileSync(files.surprises, "utf8"));
  const judged = validateVerdictData(checklist, verdicts, surprises);
  if (!isSelectedChecklist(checklist))
    throw new Error("invalid selected checklist");
  const selectedChecklist = checklist;
  const handoffItem = seals.handoffItem;
  const blindSelected = Boolean(
    handoffItem &&
      selectedChecklist.items.some((item) => item.id === handoffItem),
  );
  for (const surprise of judged.surprises) {
    const file = join(files.room, surprise.evidence_file);
    if (!existsSync(file) || !lstatSync(file).isFile())
      throw new Error(`missing surprise evidence: ${surprise.evidence_file}`);
  }
  const validateSchema = compileAllureSchema(
    JSON.parse(
      readFileSync(files.schemaPath ?? DEFAULT_SCHEMA, "utf8"),
    ) as object,
  );
  const { observed, rawCount } = collectRawObservations(
    files, seals, selectedChecklist, project, validateSchema,
  );
  const { blindResults, blindStatus } = resolveBlindAllure(
    files, seals, selectedChecklist, project, validateSchema, observed, blindSelected,
  );
  assertVerdictsMatchEvidence(judged, observed, blindStatus);
  return {
    items: selectedChecklist.items.length,
    passed: judged.pass,
    rawAllureResults: rawCount,
    blindAllureResults: blindResults.length,
    assessments: blindResults.length ? ["blind-review"] : [],
  };
}
