// The grader writes Allure lifecycle results. The legacy scorer receives a derived view.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  allureFullName,
  assertAllureIdentity,
  featureTitleFromSpec,
  parsePlanSource,
  stampedItemId,
} from "../evidence-core/validate-identity.ts";
import { validateResultEvidence } from "../evidence-core/validate-result.ts";
import { compileAllureSchema } from "../evidence-core/validate-schema.ts";

const RESULT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-result\.json$/;
// Preserve the old calibration room, while requiring the revised handoff in every new cut.
const PERSON_SPEC_SHA256 = "b28ee83dfaada8df0ed99b90121a50f3c55885ade4db323b68e03c4d5f15005e";

function identity(room, item, project) {
  const { planDir, sliceKey } = parsePlanSource(item.source ?? "");
  if (planDir.slice(0, 2) !== item.id?.slice(0, 2))
    throw new Error(`Allure item has no matching numbered plan source: ${item.id ?? "unknown"}`);
  const feature = featureTitleFromSpec(
    readFileSync(join(room, "plan", planDir, "spec.feature"), "utf8"),
  );
  return {
    fullName: allureFullName({ project, sliceKey, itemId: item.id }),
    feature,
  };
}

export function readAllureResults(room) {
  const validateSchema = compileAllureSchema(
    JSON.parse(readFileSync(join(room, "allure-lifecycle-result.schema.json"), "utf8")),
  );
  const checklist = JSON.parse(readFileSync(join(room, "checklist.json"), "utf8"));
  const items = checklist.items;
  const receipt = JSON.parse(readFileSync(join(room, '.grading-room.json'), 'utf8'));
  const project = receipt.project ?? 'loyly';
  const blindReview = receipt.blindReview ?? true;
  if (!/^[a-z][a-z0-9-]*$/.test(project)) throw new Error('invalid grading project');
  if (!Array.isArray(items) || !items.length || new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("invalid grading checklist");
  const identities = new Map(items.map((item) => [item.id, identity(room, item, project)]));
  const specSha256 = blindReview && project === 'loyly' && items.some((item) => item.id === "01-011")
    ? createHash("sha256").update(readFileSync(join(room, "plan", "01-booking-core", "spec.feature"))).digest("hex")
    : null;
  const pendingPrefix = specSha256 === PERSON_SPEC_SHA256
    ? "not reached: blind human review required" : "not reached: blind subagent review required";
  const dir = join(room, "work", "allure-results");
  const files = readdirSync(dir).filter((name) => RESULT.test(name));
  if (files.length !== items.length) throw new Error("grader did not return one Allure result per selected item");
  const expectedFiles = new Set(files);
  const byId = new Map();
  for (const file of files) {
    const result = JSON.parse(readFileSync(join(dir, file), "utf8"));
    validateSchema(result, file);
    if (file !== `${result.uuid}-result.json`) throw new Error(`Allure UUID differs from filename: ${file}`);
    const id = stampedItemId(result);
    const item = items.find((x) => x.id === id);
    if (!item || byId.has(id)) throw new Error(`unknown or duplicate Allure item ${id}`);
    const expected = identities.get(id);
    assertAllureIdentity(result, {
      itemId: id,
      name: item.name,
      rule: item.rule,
      feature: expected.feature,
      fullName: expected.fullName,
    });
    validateResultEvidence(result, id);
    for (const attachment of result.attachments) {
      const path = join(dir, attachment.source);
      if (!existsSync(path) || !lstatSync(path).isFile())
        throw new Error(`Allure attachment bytes missing for ${id}: ${attachment.source}`);
      expectedFiles.add(attachment.source);
    }
    if (blindReview && project === 'loyly' && id === "01-011" && (result.status !== "skipped" || result.stage !== "pending"
        || !result.statusDetails.message.startsWith(pendingPrefix)))
      throw new Error("01-011 needs a separate blind subagent review");
    byId.set(id, result);
  }
  const verdicts = items.map((item) => {
    const result = byId.get(item.id);
    if (!result) throw new Error(`Allure result missing for ${item.id}`);
    return { id: item.id, verdict: result.status === "passed" ? "pass" : "fail",
      evidence: result.statusDetails.message };
  });
  const rawSurprises = JSON.parse(readFileSync(join(room, "work", "surprises.json"), "utf8"));
  if (!Array.isArray(rawSurprises)) throw new Error("surprises must be a JSON array");
  const surprises = [];
  for (const surprise of rawSurprises) {
    const ids = typeof surprise?.item === "string" ? surprise.item.split(/,\s*/) : [];
    const rawPath = surprise?.evidence_file;
    const evidenceFile = typeof rawPath === "string" && !rawPath.startsWith("work/")
      ? `work/${rawPath}` : rawPath;
    if (!ids.length || ids.some((id) => !byId.has(id))
        || typeof surprise.observation !== "string"
        || typeof evidenceFile !== "string" || !/^work\/[A-Za-z0-9._/-]+$/.test(evidenceFile)
        || evidenceFile.includes("..") || /^work\/runtime-[^/]+\//.test(evidenceFile)
        || !existsSync(join(room, evidenceFile))
        || !lstatSync(join(room, evidenceFile)).isFile())
      throw new Error("invalid surprise evidence");
    for (const id of ids) surprises.push({ item: id, observation: surprise.observation,
      evidence_file: evidenceFile });
  }
  const digest = createHash("sha256");
  for (const name of readdirSync(dir).sort()) {
    if (!expectedFiles.has(name) || !lstatSync(join(dir, name)).isFile())
      throw new Error(`unexpected Allure result entry: ${name}`);
    digest.update(name); digest.update("\0"); digest.update(readFileSync(join(dir, name))); digest.update("\0");
  }
  return { verdicts, surprises, results: [...byId.values()],
    pass: verdicts.filter((v) => v.verdict === "pass").length,
    allureSha256: digest.digest("hex") };
}
