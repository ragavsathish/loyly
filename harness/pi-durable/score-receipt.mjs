// Reconcile a legacy score only when its cut, checklist, candidate and verdicts
// are the same inputs that produced it. The legacy scorer remains unchanged.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
function head(path) {
  const result = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot read instrument cut at ${path}`);
  return result.stdout.trim();
}
function panelManifestHash(scratch) {
  const selection = join(scratch, "panel-vm", "selected.json");
  if (!existsSync(selection)) return null;
  const selected = JSON.parse(readFileSync(selection, "utf8"));
  if (!Number.isInteger(selected.attempt) || selected.attempt < 1 || selected.attempt > 2)
    throw new Error("invalid panel VM selection");
  const manifest = join(scratch, "panel-vm", `attempt-${String(selected.attempt).padStart(2, "0")}`, "manifest.json");
  const digest = fileHash(manifest);
  if (selected.manifest_sha256 !== digest) throw new Error("selected panel manifest changed");
  return digest;
}

export function bindScoreInput({ scratch, sourceRoot, instrument, candidateSha256, verdictsFile,
  scoreCycle = "02" }) {
  if (head(instrument) !== head(sourceRoot)) throw new Error("instrument clone is from another source cut");
  if (!/^\d\d$/.test(scoreCycle)) throw new Error("score cycle must be two digits");
  const checklistFile = join(scratch, "checklist.json");
  const panelSha256 = panelManifestHash(scratch);
  const input = { schema: "loyly.score-input.v1", source_commit: head(sourceRoot),
    candidate_sha256: candidateSha256, checklist_sha256: fileHash(checklistFile),
    verdicts_sha256: fileHash(verdictsFile),
    ...(scoreCycle !== "02" ? { score_cycle: scoreCycle } : {}),
    ...(panelSha256 ? { panel_manifest_sha256: panelSha256 } : {}) };
  const receipt = join(scratch, "score-input.json");
  const bytes = `${JSON.stringify(input)}\n`;
  if (existsSync(receipt) && readFileSync(receipt, "utf8") !== bytes)
    throw new Error("score input changed after its first attempt");
  if (!existsSync(receipt)) writeFileSync(receipt, bytes, { flag: "wx" });
  return input;
}

export function verifyScoredCycle({ scratch, instrument, verdictsFile, cycle = "02" }) {
  const input = JSON.parse(readFileSync(join(scratch, "score-input.json"), "utf8"));
  const checklistFile = join(scratch, "checklist.json");
  const cycleDir = join(instrument, "harness", "cycles", cycle);
  const instrumentChecklist = join(cycleDir, "checklist.json");
  if (input.schema !== "loyly.score-input.v1" || head(instrument) !== input.source_commit
      || (input.score_cycle ?? "02") !== cycle
      || fileHash(checklistFile) !== input.checklist_sha256
      || fileHash(instrumentChecklist) !== input.checklist_sha256
      || fileHash(verdictsFile) !== input.verdicts_sha256
      || (input.panel_manifest_sha256 !== undefined
        && panelManifestHash(scratch) !== input.panel_manifest_sha256))
    throw new Error("scored cycle inputs differ from the bound cut, checklist or verdicts");
  const items = JSON.parse(readFileSync(checklistFile, "utf8")).items;
  const verdicts = JSON.parse(readFileSync(verdictsFile, "utf8"));
  if (!Array.isArray(items) || !items.length || !Array.isArray(verdicts)
      || verdicts.length !== items.length
      || items.some((item, i) => verdicts[i]?.id !== item.id
        || !["pass", "fail"].includes(verdicts[i].verdict)
        || typeof verdicts[i].evidence !== "string"))
    throw new Error("score input does not cover the exact checklist in order");
  const expected = items.map((item, i) => ({ ...item,
    verdict: verdicts[i].verdict, evidence: verdicts[i].evidence }));
  const scoreFile = join(cycleDir, "scores.json");
  const recorded = JSON.parse(readFileSync(scoreFile, "utf8"));
  if (!Array.isArray(recorded.items)
      || JSON.stringify(recorded.items) !== JSON.stringify(expected))
    throw new Error("existing legacy score differs from bound verdicts");
  return { items: recorded.items, scoreSha256: fileHash(scoreFile),
    score: `${recorded.items.filter((item) => item.verdict === "pass").length}/${items.length}` };
}
