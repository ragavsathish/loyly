// Read-only Allure projection for the Pi audit page. These are evidence records,
// not Pi events; only committed grade/blind-review entries can reveal them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAllureResults } from "./allure-results.mjs";
import { readBlindAgentAllure } from "./blind-review.mjs";
import { verifyGradingRoom } from "./grading-room.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function summary(result, item, afterSeq, kind, sourceDigest, dir) {
  return { schema: "loyly.replay-evidence.v1", source: "Allure evidence projection",
    kind, after_seq: afterSeq, item, name: result.name, status: result.status,
    stage: result.stage, observation: result.statusDetails.message,
    steps: result.steps.map((step) => ({ name: step.name, status: step.status, stage: step.stage })),
    attachments: result.attachments.map((attachment) => ({ name: attachment.name,
      type: attachment.type, sha256: hash(readFileSync(join(dir, attachment.source))) })),
    source_digest: sourceDigest };
}

export function projectReplayEvidence(dir, rows) {
  const grade = rows.findLast((row) => row.stage === "grade" && row.outcome === "completed"
    && typeof row.allure_results_sha256 === "string");
  const blind = rows.findLast((row) => row.stage === "blind-review" && row.outcome === "completed");
  if (!grade && !blind) return [];
  if (blind && !grade) throw new Error("completed blind review has no committed Allure grade");
  const gradingRoom = join(dir, "grading-room");
  const prepared = rows.findLast((row) => row.stage === "grading-room"
    && row.outcome === "prepared" && typeof row.candidate_sha256 === "string");
  if (!prepared || !existsSync(gradingRoom)) throw new Error("committed grade has no bound grading room");
  const roomReceipt = JSON.parse(readFileSync(join(gradingRoom, ".grading-room.json"), "utf8"));
  verifyGradingRoom({ out: gradingRoom, candidateSha256: prepared.candidate_sha256,
    checklistSha256: prepared.checklist_sha256, schemaSha256: roomReceipt.schemaSha256 });
  const judged = readAllureResults(gradingRoom);
  if (judged.allureSha256 !== grade.allure_results_sha256)
    throw new Error("Allure evidence differs from the committed grade digest");
  const checklist = JSON.parse(readFileSync(join(gradingRoom, "checklist.json"), "utf8"));
  const raw = checklist.items.map((item) => {
    const result = judged.results.find((value) => value.labels.some((label) =>
      label.name === "tag" && label.value === `@item-${item.id}`));
    if (!result) throw new Error(`Allure result missing for ${item.id}`);
    return summary(result, item.id, grade.seq, "grader-item", judged.allureSha256,
      join(gradingRoom, "work", "allure-results"));
  });
  if (!blind) return raw;
  if (blind.raw_allure_sha256 !== judged.allureSha256)
    throw new Error("blind review audit differs from committed grade evidence");
  const reviewFile = join(dir, "blind-agent-review.json");
  const review = JSON.parse(readFileSync(reviewFile, "utf8"));
  const supplemental = readBlindAgentAllure({ packetDir: join(dir, "blind-agent-packet"),
    reviewFile, gradingRoom,
    verificationDir: review.verdict === "pass" ? join(dir, "blind-agent-verification") : undefined,
    out: join(dir, "blind-agent-allure") });
  if (supplemental.reviewSha256 !== blind.review_sha256)
    throw new Error("blind Allure evidence differs from the committed review digest");
  return [...raw, summary(supplemental.result, "01-011", blind.seq, "blind-review",
    supplemental.reviewSha256, join(dir, "blind-agent-allure"))];
}
