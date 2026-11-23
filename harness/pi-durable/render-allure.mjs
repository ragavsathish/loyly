// Render a scored cycle with the official Allure CLI. Historical Löyly runs
// add a separate blind-review case; direct-grade projects use raw results.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditRows } from "./audit-rows.mjs";
import { readAllureResults } from "./allure-results.mjs";
import { finalVerdictsFromBlindReview, readBlindAgentAllure } from "./blind-review.mjs";
import { candidateDigest } from "./grading-room.ts";
import { scoreCycleFor, verifyScoredCycle } from "./score-receipt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));

export async function renderScoredAllure(scratch) {
  scratch = resolve(scratch);
  const instrument = join(scratch, "instrument");
  const gradingRoom = join(scratch, "grading-room");
  const receipt = JSON.parse(readFileSync(join(gradingRoom, '.grading-room.json'), 'utf8'));
  const blindRequired = receipt.blindReview ?? true;
  const verdictsFile = join(scratch, blindRequired ? "final-verdicts.json" : "verdicts.json");
  const scoreInput = JSON.parse(readFileSync(join(scratch, "score-input.json"), "utf8"));
  if (candidateDigest(join(scratch, "fenced-room")) !== scoreInput.candidate_sha256)
    throw new Error("current candidate differs from the scored candidate");
  const score = verifyScoredCycle({ scratch, instrument, verdictsFile,
    cycle: scoreCycleFor(scratch) });
  const raw = readAllureResults(gradingRoom);
  let projected = { verdicts: raw.verdicts, rawAllureSha256: raw.allureSha256 };
  let supplemental;
  if (blindRequired) {
    const reviewFile = join(scratch, "blind-agent-review.json");
    const review = JSON.parse(readFileSync(reviewFile, "utf8"));
    projected = finalVerdictsFromBlindReview({ packetDir: join(scratch, "blind-agent-packet"),
      reviewFile, gradingRoom,
      verificationDir: review.verdict === "pass" ? join(scratch, "blind-agent-verification") : undefined,
      out: join(scratch, "blind-agent-allure") });
    supplemental = readBlindAgentAllure({ packetDir: join(scratch, "blind-agent-packet"),
      reviewFile, gradingRoom,
      verificationDir: review.verdict === "pass" ? join(scratch, "blind-agent-verification") : undefined,
      out: join(scratch, "blind-agent-allure") });
    if (raw.allureSha256 !== projected.rawAllureSha256)
      throw new Error("raw grader Allure changed after blind review");
  }
  if (readFileSync(verdictsFile, "utf8") !== JSON.stringify(projected.verdicts))
    throw new Error("scored verdicts differ from the bound Allure projection");
  const rows = await readAuditRows(scratch);
  const stage = (name, outcome) => rows.findLast((row) => row.stage === name && row.outcome === outcome);
  const cut = stage("cut", "pinned"), grade = stage("grade", "completed");
  const blind = stage("blind-review", "completed"), filed = stage("score", "filed");
  if (cut?.approved_commit !== scoreInput.source_commit
      || grade?.allure_results_sha256 !== projected.rawAllureSha256
      || (blindRequired && blind?.raw_allure_sha256 !== projected.rawAllureSha256)
      || (blindRequired && blind?.review_sha256 !== projected.reviewSha256)
      || filed?.score_file_sha256 !== score.scoreSha256
      || filed?.score_input_sha256 !== fileHash(join(scratch, "score-input.json"))
      || !stage("cycle", "measured"))
    throw new Error("scored Allure evidence differs from committed Pi audit entries");
  const fixture = rows.some((row) => row.fixture === true || row.fixture_grader === true);

  const out = join(scratch, "allure-report");
  const cli = join(HERE, "node_modules", ".bin", "allure");
  if (!existsSync(cli)) throw new Error("Allure CLI missing; run npm ci in the prototype");
  const rendered = spawnSync(cli, ["generate", join(gradingRoom, "work", "allure-results"),
    ...(blindRequired ? [join(scratch, "blind-agent-allure")] : []), "--config", join(HERE, "allurerc.mjs"),
    "--output", out, "--clean"], { cwd: HERE, encoding: "utf8" });
  if (rendered.error || rendered.status !== 0)
    throw new Error(`Allure render failed: ${rendered.error ?? rendered.stderr}`);
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  const expected = { total: score.items.length + (blindRequired ? 1 : 0) };
  for (const result of [...raw.results, ...(supplemental ? [supplemental.result] : [])])
    expected[result.status] = (expected[result.status] ?? 0) + 1;
  for (const key of new Set([...Object.keys(expected), ...Object.keys(summary.stats)])) {
    if ((summary.stats[key] ?? 0) !== (expected[key] ?? 0))
      throw new Error(`Allure report ${key} count differs from scored evidence`);
  }
  const report = join(out, "index.html");
  const manifest = { schema: "loyly.allure-report.v1",
    evidence_kind: fixture ? "fixture" : "live measurement, not accepted",
    audit_entries_sha256: hash(rows.map((row) => JSON.stringify(row)).join("\n")),
    source_commit: scoreInput.source_commit,
    candidate_sha256: scoreInput.candidate_sha256, checklist_sha256: scoreInput.checklist_sha256,
    score_sha256: score.scoreSha256, score: score.score,
    raw_allure_sha256: projected.rawAllureSha256,
    ...(blindRequired ? { blind_review_sha256: projected.reviewSha256 } : {}),
    report_html_sha256: fileHash(report), result_count: expected.total,
    note: blindRequired
      ? "One raw pending 01-011 result plus one separate blind subagent result; the score has one final verdict per checklist item."
      : "One direct grader result and one filed verdict per selected checklist item." };
  writeFileSync(join(out, "loyly-report-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, report, manifest, stats: summary.stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("usage: node render-allure.mjs <scored-cycle-scratch>");
  const result = await renderScoredAllure(process.argv[2]);
  console.log(`${result.report}\n${result.manifest.score} scored; ${result.stats.total} Allure cases`);
}
