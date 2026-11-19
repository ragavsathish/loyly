import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function validateVerdicts(room) {
  const checklist = JSON.parse(readFileSync(join(room, "checklist.json"), "utf8"));
  const ids = checklist.items.map((item) => item.id);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("invalid grading checklist");
  const verdicts = JSON.parse(readFileSync(join(room, "work", "verdicts.json"), "utf8"));
  const surprises = JSON.parse(readFileSync(join(room, "work", "surprises.json"), "utf8"));
  if (!Array.isArray(verdicts) || verdicts.length !== ids.length)
    throw new Error("grader did not return one verdict per selected item");
  for (let i = 0; i < ids.length; i++) {
    const v = verdicts[i];
    if (v?.id !== ids[i] || !["pass", "fail"].includes(v.verdict)
        || typeof v.evidence !== "string" || !v.evidence.trim())
      throw new Error(`invalid verdict for ${ids[i]}`);
  }
  const blind = verdicts.find((v) => v.id === "01-011");
  if (blind && (blind.verdict !== "fail"
      || !blind.evidence.startsWith("not reached: blind human review required")
      || !existsSync(join(room, "work", "blind-review-011.txt"))))
    throw new Error("01-011 needs a separate blind human review");
  if (!Array.isArray(surprises)) throw new Error("surprises must be a JSON array");
  for (const surprise of surprises) {
    if (!ids.includes(surprise?.item) || typeof surprise.observation !== "string"
        || typeof surprise.evidence_file !== "string"
        || !/^work\/[A-Za-z0-9._/-]+$/.test(surprise.evidence_file)
        || surprise.evidence_file.includes("..")
        || !existsSync(join(room, surprise.evidence_file)))
      throw new Error("invalid surprise evidence");
  }
  return { verdicts, surprises, pass: verdicts.filter((v) => v.verdict === "pass").length };
}
