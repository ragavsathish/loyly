import { isSelectedChecklist, type Surprise, type Verdict } from "./types.ts";

function isVerdict(value: unknown): value is Verdict {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "verdict" in value &&
    (value.verdict === "pass" || value.verdict === "fail") &&
    "evidence" in value &&
    typeof value.evidence === "string"
  );
}

function isSurprise(value: unknown): value is Surprise {
  return (
    typeof value === "object" &&
    value !== null &&
    "item" in value &&
    typeof value.item === "string" &&
    "observation" in value &&
    typeof value.observation === "string" &&
    "evidence_file" in value &&
    typeof value.evidence_file === "string"
  );
}

export function validateVerdictData(
  checklist: unknown,
  rawVerdicts: unknown,
  rawSurprises: unknown,
): {
  verdicts: Verdict[];
  surprises: Surprise[];
  pass: number;
} {
  if (!isSelectedChecklist(checklist))
    throw new Error("invalid grading checklist");
  const ids = checklist.items.map((item) => item.id);
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error("invalid grading checklist");
  if (!Array.isArray(rawVerdicts) || rawVerdicts.length !== ids.length)
    throw new Error("grader did not return one verdict per selected item");
  if (!rawVerdicts.every(isVerdict))
    throw new Error("invalid grader verdict shape");
  const verdicts: Verdict[] = rawVerdicts;
  for (let i = 0; i < ids.length; i++) {
    const v = verdicts[i];
    if (!v || v.id !== ids[i] || !v.evidence.trim())
      throw new Error(`invalid verdict for ${ids[i]}`);
  }
  if (!Array.isArray(rawSurprises))
    throw new Error("surprises must be a JSON array");
  if (!rawSurprises.every(isSurprise))
    throw new Error("invalid surprise evidence");
  const surprises: Surprise[] = rawSurprises;
  for (const surprise of surprises) {
    if (
      !ids.includes(surprise.item) ||
      !/^work\/[A-Za-z0-9._/-]+$/.test(surprise.evidence_file) ||
      surprise.evidence_file.includes("..")
    )
      throw new Error("invalid surprise evidence");
  }
  return {
    verdicts,
    surprises,
    pass: verdicts.filter((v) => v.verdict === "pass").length,
  };
}
