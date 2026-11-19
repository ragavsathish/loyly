// The grader writes Allure lifecycle results. The legacy scorer receives a derived view.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const RESULT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-result\.json$/;
const labelValues = (result, name) => result.labels.filter((label) => label.name === name).map((label) => label.value);

export function readAllureResults(room) {
  const schema = JSON.parse(readFileSync(join(room, "allure-lifecycle-result.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const checklist = JSON.parse(readFileSync(join(room, "checklist.json"), "utf8"));
  const items = checklist.items;
  if (!Array.isArray(items) || !items.length || new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("invalid grading checklist");
  const dir = join(room, "work", "allure-results");
  const files = readdirSync(dir).filter((name) => RESULT.test(name));
  if (files.length !== items.length) throw new Error("grader did not return one Allure result per selected item");
  const expectedFiles = new Set(files);
  const byId = new Map();
  for (const file of files) {
    const result = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (!validate(result)) throw new Error(`Allure schema rejected ${file}: ${JSON.stringify(validate.errors)}`);
    if (file !== `${result.uuid}-result.json`) throw new Error(`Allure UUID differs from filename: ${file}`);
    const tags = labelValues(result, "tag").filter((tag) => /^@item-\d\d-\d\d\d$/.test(tag));
    if (tags.length !== 1) throw new Error(`${file} needs one stamped item tag`);
    const id = tags[0].slice(6);
    const item = items.find((x) => x.id === id);
    if (!item || byId.has(id)) throw new Error(`unknown or duplicate Allure item ${id}`);
    if (result.name !== item.name || result.fullName !== `loyly.booking-core.${id}`
        || result.testCaseId !== result.fullName || result.historyId !== result.fullName
        || labelValues(result, "feature").join() !== "Booking core"
        || labelValues(result, "story").join() !== item.rule
        || labelValues(result, "lifecycle").join() !== "pre-production"
        || !labelValues(result, "tool").length || !labelValues(result, "technique").length)
      throw new Error(`Allure identity or Gherkin labels differ for ${id}`);
    if (typeof result.statusDetails?.message !== "string" || !result.statusDetails.message.trim()
        || !Number.isInteger(result.start) || !Number.isInteger(result.stop)
        || result.stop < result.start || !Array.isArray(result.steps) || !result.steps.length
        || result.steps.some((step) => !step.status || !step.stage))
      throw new Error(`Allure observation, timing or steps missing for ${id}`);
    if (!Array.isArray(result.attachments) || !result.attachments.length)
      throw new Error(`Allure evidence attachment missing for ${id}`);
    for (const attachment of result.attachments) {
      const path = join(dir, attachment.source);
      if (!existsSync(path) || !lstatSync(path).isFile())
        throw new Error(`Allure attachment bytes missing for ${id}: ${attachment.source}`);
      expectedFiles.add(attachment.source);
    }
    if (id === "01-011" && (result.status !== "skipped" || result.stage !== "pending"
        || !result.statusDetails.message.startsWith("not reached: blind human review required")))
      throw new Error("01-011 needs a separate blind human review");
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
