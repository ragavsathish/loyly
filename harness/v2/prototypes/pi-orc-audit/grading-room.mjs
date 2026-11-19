// The independent grader receives the gated candidate and selected plan only.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function treeDigest(root, prefix) {
  const digest = createHash("sha256");
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = `${prefix}/${name}`, file = join(dir, name), stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, path);
      else if (stat.isFile()) {
        digest.update(path); digest.update("\0");
        digest.update(String(stat.mode & 0o777)); digest.update("\0");
        digest.update(readFileSync(file)); digest.update("\0");
      } else throw new Error(`candidate has a symlink or special file: ${path}`);
    }
  };
  walk(root, prefix);
  return digest.digest("hex");
}
export const candidateDigest = (room) => treeDigest(join(room, "impl"), "impl");
const planDigest = (room) => treeDigest(join(room, "plan"), "plan");
export function prepareGradingRoom({ sourceRoom, candidateRoom, checklistFile, schemaFile, out,
  candidateSha256, checklistSha256, schemaSha256 }) {
  for (const path of [sourceRoom, candidateRoom, checklistFile, schemaFile, out])
    if (!isAbsolute(path)) throw new Error(`grading path must be absolute: ${path}`);
  if ([candidateSha256, checklistSha256, schemaSha256]
    .some((digest) => !/^[0-9a-f]{64}$/.test(digest ?? "")))
    throw new Error("grading room needs approved digests");
  if (basename(checklistFile) !== "checklist.json" || basename(schemaFile) !== "allure-lifecycle-result.schema.json"
      || hash(readFileSync(checklistFile)) !== checklistSha256
      || hash(readFileSync(schemaFile)) !== schemaSha256
      || candidateDigest(candidateRoom) !== candidateSha256)
    throw new Error("grading inputs differ from the gated candidate, checklist or schema");
  if (existsSync(out)) throw new Error("grading room already exists; reconcile its receipt or inspect it");
  mkdirSync(join(out, "plan"), { recursive: true });
  cpSync(join(sourceRoom, "docs", "plan", "01-booking-core"), join(out, "plan", "01-booking-core"),
    { recursive: true });
  cpSync(join(candidateRoom, "impl"), join(out, "impl"), { recursive: true });
  cpSync(checklistFile, join(out, "checklist.json"));
  cpSync(schemaFile, join(out, "allure-lifecycle-result.schema.json"));
  mkdirSync(join(out, "work"));
  if (candidateDigest(out) !== candidateSha256
      || hash(readFileSync(join(out, "checklist.json"))) !== checklistSha256
      || hash(readFileSync(join(out, "allure-lifecycle-result.schema.json"))) !== schemaSha256)
    throw new Error("grading copy differs from the gated candidate, checklist or schema");
  const receipt = { schema: "loyly.grading-room.v1", candidateSha256, checklistSha256,
    schemaSha256, planSha256: planDigest(out),
    sourcePlan: "plan/01-booking-core" };
  writeFileSync(join(out, ".grading-room.json"), JSON.stringify(receipt));
  return receipt;
}
export function verifyGradingRoom({ out, candidateSha256, checklistSha256, schemaSha256 }) {
  const receipt = JSON.parse(readFileSync(join(out, ".grading-room.json"), "utf8"));
  if (receipt.schema !== "loyly.grading-room.v1" || receipt.candidateSha256 !== candidateSha256
      || receipt.checklistSha256 !== checklistSha256
      || receipt.schemaSha256 !== schemaSha256
      || receipt.planSha256 !== planDigest(out)
      || candidateDigest(out) !== candidateSha256
      || hash(readFileSync(join(out, "checklist.json"))) !== checklistSha256
      || hash(readFileSync(join(out, "allure-lifecycle-result.schema.json"))) !== schemaSha256)
    throw new Error("grading room receipt or inputs changed");
  const allowed = new Set([".grading-room.json", "plan", "impl", "checklist.json",
    "allure-lifecycle-result.schema.json", "work"]);
  for (const name of readdirSync(out)) if (!allowed.has(name))
    throw new Error(`unexpected grading-room entry: ${name}`);
  return receipt;
}
