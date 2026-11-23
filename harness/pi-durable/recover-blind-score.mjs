// File a supplemental legacy score after a blind HTTP probe instrument failure.
// The failed Pi cycle remains immutable; this is not a Pi cycle acceptance.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAuditRows } from "./audit-rows.mjs";
import { readAllureResults } from "./allure-results.mjs";
import { finalVerdictsFromBlindReview, probeBlindAnswer, writeBlindAgentAllure } from "./blind-review.mjs";
import { candidateDigest } from "./grading-room.ts";
import { bindScoreInput, verifyScoredCycle } from "./score-receipt.ts";
import { verifyPanelVmRun } from "./panel-vm-run.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => sha(readFileSync(path));
function command(program, args, cwd, log) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error || result.status !== 0)
    throw Error(`${program} failed: ${result.error ?? String(result.stderr).slice(-1200)}`);
}
function head(path) {
  const r = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) throw Error(`cannot read git cut ${path}`);
  return r.stdout.trim();
}

export async function recoverBlindScore(priorArg, outArg, panelArg) {
  const prior = resolve(priorArg), out = resolve(outArg);
  if (!out.startsWith(`${prior}/`) || existsSync(out))
    throw Error("new recovery output must be inside the original scratch");
  const rows = await readAuditRows(prior);
  const stage = (name, outcome) => rows.findLast((row) => row.stage === name && row.outcome === outcome);
  const cut = stage("cut", "pinned"), gate = stage("gate", "passed");
  const grade = stage("grade", "completed"), blind = stage("blind-review", "failed");
  if (!cut || !gate || !grade || !blind || stage("score", "filed")
      || grade.fixture || grade.model !== "openai-codex/gpt-6.1-terra"
      || grade.item_count !== 47 || grade.shards?.length !== 6
      || !blind.agent_launch_receipt_sha256)
    throw Error("original is not the expected live grade stopped at blind review");
  const source = join(prior, "cut", "project"), room = join(prior, "grading-room");
  const candidate = candidateDigest(join(prior, "fenced-room"));
  if (head(source) !== cut.approved_commit || candidate !== gate.candidate_digest
      || candidateDigest(room) !== candidate
      || fileSha(join(prior, `gate-${gate.attempt}-evidence`, "gate.log")) !== gate.gate_log_sha256)
    throw Error("source, gate or frozen candidate changed");
  const raw = readAllureResults(room);
  if (raw.allureSha256 !== grade.allure_results_sha256
      || raw.results.length !== 47
      || raw.results.filter((result) => result.status === "passed").length !== 46
      || raw.results.filter((result) => result.status === "skipped").length !== 1)
    throw Error("raw independent grade changed");
  const reviewFile = join(prior, "blind-agent-review.json");
  const review = JSON.parse(readFileSync(reviewFile, "utf8"));
  if (review.verdict !== "pass" || review.launch_receipt_sha256 !== blind.agent_launch_receipt_sha256
      || fileSha(join(prior, "blind-agent-evidence", "launch-1", "launch.txt"))
        !== review.launch_receipt_sha256
      || fileSha(join(prior, "blind-agent-evidence", "launch-1", "pi.stdout"))
        !== review.agent_output_sha256
      || readdirSync(join(prior, "blind-agent-room")).sort().join() !== "question.txt,refusal.txt")
    throw Error("blind agent receipt or isolation changed");
  mkdirSync(out);
  const packetDir = join(prior, "blind-agent-packet"), verificationDir = join(out, "probe");
  const request = JSON.parse(readFileSync(join(prior, "blind-agent-request.json"), "utf8"));
  const verification = await probeBlindAnswer({ packetDir, reviewFile, gradingRoom: room,
    request, out: verificationDir });
  if (!verification.accepted) throw Error("blind request was not confirmed over fresh HTTP");
  const allureDir = join(out, "blind-agent-allure");
  writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom: room, verificationDir, out: allureDir });
  const projected = finalVerdictsFromBlindReview({ packetDir, reviewFile, gradingRoom: room,
    verificationDir, out: allureDir });
  if (projected.rawAllureSha256 !== grade.allure_results_sha256
      || projected.verdicts.length !== 47
      || projected.verdicts.some((item) => item.verdict !== "pass"))
    throw Error("recovered verdicts differ from the independent grade");
  const verdictsFile = join(out, "final-verdicts.json");
  writeFileSync(verdictsFile, JSON.stringify(projected.verdicts));
  cpSync(join(prior, "checklist.json"), join(out, "checklist.json"));
  const instrument = join(out, "instrument"), cycle = "03";
  command("git", ["clone", "-q", "--depth", "1", `file://${source}`, instrument],
    out, join(out, "clone.log"));
  const cycleDir = join(instrument, "harness", "cycles", cycle);
  mkdirSync(cycleDir, { recursive: true });
  command("bb", ["harness/gen_checklist.clj", "--out", join(cycleDir, "checklist.json")],
    instrument, join(out, "checklist.log"));
  if (fileSha(join(cycleDir, "checklist.json")) !== fileSha(join(out, "checklist.json")))
    throw Error("recovered checklist differs from approved selection");
  bindScoreInput({ scratch: out, sourceRoot: source, instrument, candidateSha256: candidate,
    verdictsFile, scoreCycle: cycle });
  command("bb", ["harness/score.clj", cycle, "--verdicts", verdictsFile],
    instrument, join(out, "score.log"));
  const score = verifyScoredCycle({ scratch: out, instrument, verdictsFile, cycle });
  if (score.score !== "47/47") throw Error("recovery did not score every selected item");
  command("bb", ["harness/scoreboard.clj", cycle], instrument, join(out, "scoreboard.log"));
  let panel;
  if (panelArg) {
    const panelDir = resolve(panelArg), config = JSON.parse(readFileSync(join(prior, "live-run.json")));
    const planFile = resolve(import.meta.dirname, config.panel.plan_file);
    panel = verifyPanelVmRun({ original: prior, out: panelDir,
      imageDigest: `sha256:${config.panel.image_sha256}`, planFile }).manifest;
    if (panel.plan_sha256 !== config.panel.plan_sha256 || panel.score_state !== "pre-score")
      throw Error("exploratory panel differs from the approved plan or pre-score state");
    const reportDir = join(out, "allure-report");
    command(join(import.meta.dirname, "node_modules", ".bin", "allure"),
      ["generate", join(room, "work", "allure-results"), allureDir,
        ...panel.producers.map((producer) => join(panelDir, producer.id)),
        "--config", join(import.meta.dirname, "allurerc.mjs"), "--output", reportDir, "--clean"],
      import.meta.dirname, join(out, "allure-render.log"));
    const stats = JSON.parse(readFileSync(join(reportDir, "summary.json"))).stats;
    if (stats.total !== 51 || stats.passed !== 47 || stats.skipped !== 1 || stats.failed !== 3)
      throw Error("Allure report omitted or changed raw, blind or panel results");
  }
  const receipt = { schema: "loyly.supplemental-blind-recovery.v1",
    kind: "same-candidate-supplemental-legacy-score",
    original_run_id: rows[0].run_id, original_pi_outcome: "failed-blind-review",
    source_commit: cut.approved_commit, controller_commit: head(resolve(import.meta.dirname, "../..")),
    recovery_script_sha256: fileSha(import.meta.filename),
    blind_probe_sha256: fileSha(join(import.meta.dirname, "blind-review.mjs")),
    candidate_sha256: candidate, raw_allure_sha256: projected.rawAllureSha256,
    blind_review_sha256: projected.reviewSha256,
    blind_launch_receipt_sha256: blind.agent_launch_receipt_sha256,
    corrected_probe_sha256: fileSha(join(verificationDir, "verification.json")),
    resolved_path: verification.request.resolved_path,
    checklist_sha256: fileSha(join(out, "checklist.json")),
    verdicts_sha256: fileSha(verdictsFile),
    supplemental_score: score.score, supplemental_score_sha256: score.scoreSha256,
    ...(panel ? { exploratory_panel_manifest_sha256: fileSha(join(resolve(panelArg), "manifest.json")),
      exploratory_panel_results: Object.fromEntries(panel.producers.map((producer) =>
        [producer.id, producer.status])),
      allure_report_html_sha256: fileSha(join(out, "allure-report", "index.html")) } : {}),
    original_pi_cycle_rewritten: false, acceptance_authorized: false };
  writeFileSync(join(out, "recovery.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  if (![4, 5].includes(process.argv.length))
    throw Error("usage: node recover-blind-score.mjs <failed-cycle-scratch> <new-recovery-dir> [exploratory-panel-dir]");
  console.log(JSON.stringify(await recoverBlindScore(process.argv[2], process.argv[3], process.argv[4])));
}
