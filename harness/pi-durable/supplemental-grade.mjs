// Merge independent, capability-specific probes for an already scored candidate.
// This is a supplemental report: it never rewrites the Pi audit or legacy score.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileAllureSchema } from "../evidence-core/validate-schema.ts";
import { candidateDigest } from "./grading-room.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => sha(readFileSync(path));
const PRODUCERS = [
  { id: "browser", tool: "Playwright" },
  { id: "protocol", tool: "Node.js" },
  { id: "telemetry", tool: "OpenTelemetry" },
];

function loadProducerResult(dir, producer, validate) {
  const resultFiles = readdirSync(dir).filter((name) => /^[0-9a-f-]{36}-result\.json$/.test(name));
  if (resultFiles.length !== 1) throw new Error(`${producer.id}: need one Allure result`);
  const file = resultFiles[0];
  const result = JSON.parse(readFileSync(join(dir, file), "utf8"));
  try {
    validate(result, `${producer.id}/${file}`);
  } catch (cause) {
    throw new Error(`${producer.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { file, result };
}

function assertProducerShape(producer, result, file, candidateSha256) {
  const hasTool = result.labels?.some((label) => label.name === "tool" && label.value === producer.tool);
  const hasItem = result.labels?.some((label) => label.name === "tag" && /^@item-01-0\d\d$/.test(label.value));
  const hasCandidate = result.parameters?.some((parameter) =>
    parameter.name === "candidate_sha256" && parameter.value === candidateSha256);
  const hasReceipt = result.attachments?.some((attachment) =>
    /execution receipt/i.test(attachment.name) && attachment.type === "application/json");
  if (file !== `${result.uuid}-result.json`)
    throw new Error(`${producer.id}: result lacks bound identity, observation or evidence`);
  if (!["passed", "failed", "skipped", "broken"].includes(result.status))
    throw new Error(`${producer.id}: result lacks bound identity, observation or evidence`);
  if (result.stage !== "finished")
    throw new Error(`${producer.id}: result lacks bound identity, observation or evidence`);
  if (!Number.isInteger(result.start) || !Number.isInteger(result.stop) || result.stop < result.start)
    throw new Error(`${producer.id}: result lacks bound identity, observation or evidence`);
  if (!hasTool || !hasItem || !hasCandidate)
    throw new Error(`${producer.id}: result lacks bound identity, observation or evidence`);
  if (!result.statusDetails?.message || !result.steps?.length || !result.attachments?.length || !hasReceipt)
    throw new Error(`${producer.id}: result lacks bound identity, observation or evidence`);
}

function assertProducerReceipt(producer, result, dir, candidateSha256) {
  const receiptAttachment = result.attachments.find((attachment) =>
    /execution receipt/i.test(attachment.name) && attachment.type === "application/json");
  const receipt = JSON.parse(readFileSync(join(dir, receiptAttachment.source), "utf8"));
  const receiptCandidate = receipt.candidate_sha256 ?? receipt.candidateSha
    ?? receipt.result?.candidateSha256;
  const imageDigest = receipt.imageDigest ?? receipt.image_oci_digest;
  if (receiptCandidate !== candidateSha256 || !/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? ""))
    throw new Error(`${producer.id}: VM receipt is not bound to the candidate and image`);
  if (producer.id === "browser") {
    if (receipt.exitCode !== 0 || receipt.candidateMount?.RW !== false
        || receipt.readOnlyRootFilesystem !== true || receipt.networkMode !== "none")
      throw new Error("browser VM receipt lacks read-only, no-network execution proof");
  }
  if (producer.id === "protocol" && receipt.vm_exit_code !== 0)
    throw new Error("protocol Gondolin VM did not exit successfully");
  if (producer.id === "telemetry") {
    if (!receipt.containerId || !String(receipt.isolation).includes("Docker Desktop Linux VM"))
      throw new Error("telemetry Linux VM receipt is incomplete");
  }
  return { receiptAttachment, imageDigest };
}

function copyProducerEvidence(producer, result, file, dir, results, names) {
  const files = [file, ...result.attachments.map((attachment) => attachment.source)];
  if (new Set(files).size !== files.length) throw new Error(`${producer.id}: duplicate attachment name`);
  const hashes = {};
  for (const name of files) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || names.has(name)
        || !lstatSync(join(dir, name)).isFile())
      throw new Error(`${producer.id}: missing, unsafe or colliding evidence file ${name}`);
    names.add(name);
    hashes[name] = fileSha(join(dir, name));
    cpSync(join(dir, name), join(results, name));
  }
  return hashes;
}

function collectProducer(producer, probes, validate, candidateSha256, results, names) {
  const dir = join(probes, producer.id);
  const { file, result } = loadProducerResult(dir, producer, validate);
  assertProducerShape(producer, result, file, candidateSha256);
  const { receiptAttachment, imageDigest } = assertProducerReceipt(
    producer, result, dir, candidateSha256);
  const hashes = copyProducerEvidence(producer, result, file, dir, results, names);
  return {
    id: producer.id,
    tool: producer.tool,
    result: file,
    item: result.labels.find((label) => label.name === "tag").value,
    status: result.status,
    start: result.start,
    stop: result.stop,
    image_digest: imageDigest,
    execution_receipt_sha256: hashes[receiptAttachment.source],
    files: hashes,
  };
}

function renderSupplementalReport(out, results) {
  const cli = join(HERE, "node_modules", ".bin", "allure");
  const report = join(out, "allure-report");
  const rendered = spawnSync(cli, ["generate", results, "--config", join(HERE, "allurerc.mjs"),
    "--output", report, "--clean"], { cwd: HERE, encoding: "utf8" });
  if (rendered.error || rendered.status !== 0)
    throw new Error(`Allure render failed: ${rendered.error ?? rendered.stderr}`);
  const summary = JSON.parse(readFileSync(join(report, "summary.json"), "utf8"));
  if (summary.stats.total !== PRODUCERS.length)
    throw new Error("Allure report omitted a specialist probe");
  return { report, summary };
}

export function collectSupplementalGrade(original, probes) {
  original = resolve(original);
  probes = resolve(probes);
  const scoreFile = join(original, "instrument", "harness", "cycles", "02", "scores.json");
  const scoreBefore = fileSha(scoreFile);
  const candidateSha256 = candidateDigest(join(original, "fenced-room"));
  const scoreInput = JSON.parse(readFileSync(join(original, "score-input.json"), "utf8"));
  if (candidateSha256 !== scoreInput.candidate_sha256)
    throw new Error("frozen candidate differs from the original scored candidate");
  const schemaFile = join(HERE, "../evidence-core/allure-lifecycle-result.schema.json");
  const schemaSha256 = fileSha(schemaFile);
  const validate = compileAllureSchema(JSON.parse(readFileSync(schemaFile, "utf8")));
  const out = join(probes, "combined");
  if (existsSync(out)) throw new Error("supplemental combined output already exists");
  const results = join(out, "allure-results");
  mkdirSync(results, { recursive: true });
  const manifest = { schema: "loyly.supplemental-grade.v1", evidence_kind: "grading-only; no new Pi cycle",
    source_commit: scoreInput.source_commit, candidate_sha256: candidateSha256,
    original_score_sha256: scoreBefore, allure_schema_sha256: schemaSha256,
    producers: [] };
  const names = new Set();
  for (const producer of PRODUCERS) {
    manifest.producers.push(
      collectProducer(producer, probes, validate, candidateSha256, results, names));
  }
  const overlapStart = Math.max(...manifest.producers.map((producer) => producer.start));
  const overlapStop = Math.min(...manifest.producers.map((producer) => producer.stop));
  manifest.parallel_overlap_ms = overlapStop - overlapStart;
  if (manifest.parallel_overlap_ms <= 0)
    throw new Error("specialist VM probes did not overlap in time");
  const { report, summary } = renderSupplementalReport(out, results);
  manifest.report_html_sha256 = fileSha(join(report, "index.html"));
  manifest.original_score_unchanged = fileSha(scoreFile) === scoreBefore;
  if (!manifest.original_score_unchanged) throw new Error("original score changed during supplemental grading");
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, manifest, stats: summary.stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw new Error("usage: node supplemental-grade.mjs <original-cycle-scratch> <probe-root>");
  const { out, stats } = collectSupplementalGrade(process.argv[2], process.argv[3]);
  console.log(`${out}: ${stats.total} supplemental Allure results`);
}
