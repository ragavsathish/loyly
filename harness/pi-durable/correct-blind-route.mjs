// One-item, same-candidate score correction. The original Pi cycle and score remain immutable.
// This is a supplementary measurement, not a new builder run or a Pi cycle acceptance decision.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAuditRows } from "./audit-rows.ts";
import { parseBlindAgentAnswer } from "./blind-agent-adapter.mjs";
import { finalVerdictsFromBlindReview, probeBlindAnswer, writeBlindAgentAllure } from "./blind-review.mjs";
import { candidateDigest } from "./grading-room.ts";
import { bindScoreInput, verifyScoredCycle } from "./score-receipt.ts";

const [priorArg, outArg] = process.argv.slice(2);
if (!priorArg || !outArg || process.argv.length !== 4)
  throw new Error("usage: node correct-blind-route.mjs <prior-live-cycle> <new-output-dir>");
const prior = resolve(priorArg), out = resolve(outArg);
if (existsSync(out)) throw new Error("correction output already exists; preserve its evidence");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
const command = (program, args, cwd, log) => {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(join(out, log), output);
  if (result.error || result.status !== 0)
    throw new Error(`${program} failed: ${result.error ?? output.slice(-2000)}`);
  return output;
};
const head = (path) => {
  const result = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot read source cut: ${path}`);
  return result.stdout.trim();
};
const rows = await readAuditRows(prior);
const stage = (name, outcome) => rows.findLast((row) => row.stage === name && row.outcome === outcome);
const cut = stage("cut", "pinned"), gate = stage("gate", "passed"), grade = stage("grade", "completed");
const blind = stage("blind-review", "completed"), filed = stage("score", "filed");
if (!cut || !gate || !grade || !blind || !filed || stage("cycle", "measured") === undefined
    || rows.some((row) => row.fixture === true || row.fixture_grader === true)
    || grade.model !== "openai-codex/gpt-6.1-terra" || grade.shards?.length !== 3
    || !blind.agent_launch_receipt_sha256)
  throw new Error("prior cycle is not a completed live build, gate, grade and blind score");
const source = join(prior, "cut", "project"), gradingRoom = join(prior, "grading-room");
const packetDir = join(prior, "blind-agent-packet"), reviewFile = join(prior, "blind-agent-review.json");
const priorScore = verifyScoredCycle({ scratch: prior, instrument: join(prior, "instrument"),
  verdictsFile: join(prior, "final-verdicts.json") });
const candidate = candidateDigest(join(prior, "fenced-room"));
if (head(source) !== cut.approved_commit || candidate !== gate.candidate_digest
    || candidateDigest(gradingRoom) !== candidate || priorScore.score !== "10/11"
    || filed.score_file_sha256 !== priorScore.scoreSha256
    || JSON.parse(readFileSync(join(prior, "score-input.json"), "utf8")).candidate_sha256 !== candidate
    || fileHash(join(prior, `gate-${gate.attempt}-evidence`, "gate.log")) !== gate.gate_log_sha256
    || priorScore.items.filter((item) => item.verdict === "fail").map((item) => item.id).join() !== "01-011")
  throw new Error("prior source, gate, candidate or sole failed item differs from the correction scope");
const review = JSON.parse(readFileSync(reviewFile, "utf8"));
if (review.verdict !== "pass" || review.launch_receipt_sha256 !== blind.agent_launch_receipt_sha256
    || fileHash(reviewFile) !== blind.review_sha256
    || fileHash(join(prior, "blind-agent-evidence", "launch-1", "launch.txt"))
      !== review.launch_receipt_sha256
    || fileHash(join(prior, "blind-agent-evidence", "launch-1", "pi.stdout"))
      !== review.agent_output_sha256
    || readdirSync(join(prior, "blind-agent-room")).sort().join() !== "question.txt,refusal.txt"
    || !["question.txt", "refusal.txt"].every((name) =>
      fileHash(join(prior, "blind-agent-room", name)) === fileHash(join(packetDir, name))))
  throw new Error("blind answer differs from the committed Pi audit");
const parsed = parseBlindAgentAnswer(review.answer, readFileSync(join(packetDir, "refusal.txt"), "utf8"));
if (parsed.verdict !== "pass" || parsed.request.path !== "@booking-form")
  throw new Error("blind answer did not yield a public booking-form request");

mkdirSync(out, { recursive: false });
const verification = await probeBlindAnswer({ packetDir, reviewFile, gradingRoom,
  request: parsed.request, out: join(out, "probe") });
const confirmation = readFileSync(join(out, "probe", "response.txt"), "utf8");
if (!verification.accepted || !confirmation.includes("Standing slot confirmed")
    || !confirmation.includes("apartment 12") || !confirmation.includes("pukuhuone 9")
    || !confirmation.includes("Thursday") || !confirmation.includes("17:00"))
  throw new Error("corrected public form did not confirm the blind agent's exact request");
writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom,
  verificationDir: join(out, "probe"), out: join(out, "blind-agent-allure") });
const projected = finalVerdictsFromBlindReview({ packetDir, reviewFile, gradingRoom,
  verificationDir: join(out, "probe"), out: join(out, "blind-agent-allure") });
if (projected.rawAllureSha256 !== grade.allure_results_sha256
    || projected.reviewSha256 !== blind.review_sha256
    || projected.verdicts.length !== 11
    || projected.verdicts.some((item) => item.verdict !== "pass"))
  throw new Error("corrected verdicts do not match the original independent grade and blind review");
const verdictsFile = join(out, "final-verdicts.json");
writeFileSync(verdictsFile, JSON.stringify(projected.verdicts));
cpSync(join(prior, "checklist.json"), join(out, "checklist.json"));
const instrument = join(out, "instrument");
command("git", ["clone", "-q", "--depth", "1", `file://${source}`, instrument], out, "clone.log");
const previousDir = join(instrument, "harness", "cycles", "02");
mkdirSync(previousDir, { recursive: true });
cpSync(join(prior, "instrument", "harness", "cycles", "02", "checklist.json"),
  join(previousDir, "checklist.json"));
cpSync(join(prior, "instrument", "harness", "cycles", "02", "scores.json"),
  join(previousDir, "scores.json"));
if (fileHash(join(previousDir, "scores.json")) !== priorScore.scoreSha256)
  throw new Error("prior score changed while copying its baseline");
const newDir = join(instrument, "harness", "cycles", "03");
mkdirSync(newDir, { recursive: true });
command("bb", ["harness/gen_checklist.clj", "--out", join(newDir, "checklist.json")],
  instrument, "checklist.log");
if (fileHash(join(newDir, "checklist.json")) !== fileHash(join(out, "checklist.json")))
  throw new Error("correction checklist differs from the original selection");
bindScoreInput({ scratch: out, sourceRoot: source, instrument, candidateSha256: candidate,
  verdictsFile });
command("bb", ["harness/score.clj", "03", "--verdicts", verdictsFile], instrument, "score.log");
const score = verifyScoredCycle({ scratch: out, instrument, verdictsFile, cycle: "03" });
if (score.score !== "11/11") throw new Error("correction score is not 11/11");
command("bb", ["harness/scoreboard.clj", "03"], instrument, "scoreboard.log");
const controller = head(resolve(import.meta.dirname, "../.."));
const allureDir = join(out, "blind-agent-allure");
const correctedAllureSha256 = hash(readdirSync(allureDir).sort()
  .map((name) => `${name}\0${fileHash(join(allureDir, name))}`).join("\0"));
const manifest = { schema: "loyly.blind-route-correction.v1", kind: "supplemental-same-candidate-score",
  controller_commit: controller, source_commit: cut.approved_commit, candidate_sha256: candidate,
  correction_script_sha256: fileHash(join(import.meta.dirname, "correct-blind-route.mjs")),
  blind_agent_adapter_sha256: fileHash(join(import.meta.dirname, "blind-agent-adapter.mjs")),
  blind_probe_sha256: fileHash(join(import.meta.dirname, "blind-review.mjs")),
  checklist_sha256: fileHash(join(out, "checklist.json")),
  original_score: priorScore.score, original_score_sha256: priorScore.scoreSha256,
  raw_allure_sha256: projected.rawAllureSha256, blind_review_sha256: projected.reviewSha256,
  blind_launch_receipt_sha256: blind.agent_launch_receipt_sha256,
  corrected_probe_sha256: fileHash(join(out, "probe", "verification.json")),
  resolved_path: verification.request.resolved_path, corrected_allure_sha256: correctedAllureSha256,
  corrected_verdicts_sha256: fileHash(verdictsFile), correction_score: score.score,
  correction_score_sha256: score.scoreSha256,
  pi_cycle_record_rewritten: false, acceptance_authorized: false };
writeFileSync(join(out, "correction-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ original: priorScore.score, corrected: score.score,
  candidate_sha256: candidate, resolved_path: verification.request.resolved_path,
  acceptance_authorized: false }));
