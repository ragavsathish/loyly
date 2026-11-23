// Allure accepts several result directories. Keep every producer's files in its
// own room; validate their bindings, then hand those directories to Allure.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { compileAllureSchema } from "../evidence-core/validate-schema.ts";
import { readAllureResults } from "./allure-results.mjs";
import { readAuditRows } from "./audit-rows.mjs";
import { finalVerdictsFromBlindReview, readBlindAgentAllure } from "./blind-review.mjs";
import { candidateDigest } from "./grading-room.ts";
import { evaluatePanel } from "./panel-policy.ts";
import { scoreCycleFor, verifyScoredCycle } from "./score-receipt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => sha(readFileSync(path));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const label = (result, name) => result.labels?.find((entry) => entry.name === name)?.value;
function schemaValidator(path) {
  return new Ajv2020({ strict: false }).compile(json(path));
}
function checked(validate, value, name) {
  if (!validate(value)) throw new Error(`${name}: ${JSON.stringify(validate.errors)}`);
}
function checkedAllure(validate, value, name) {
  try {
    validate(value, name);
  } catch (cause) {
    throw new Error(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function specialistResults({ specialists, plan, planSha256, manifest, candidateSha256, schemaSha256,
  scoreSha256, sourceCommit, validate }) {
  const specs = plan.checks.filter((check) => check.source === "specialist");
  if (!["loyly.supplemental-grade.v1", "loyly.panel-vm-run.v1"].includes(manifest.schema)
      || manifest.source_commit !== sourceCommit
      || manifest.candidate_sha256 !== candidateSha256
      || (plan.schema === 'harness.grading-panel-plan.v2'
        && manifest.worker_bundle_sha256 !== plan.bundle?.sha256)
      || manifest.allure_schema_sha256 !== schemaSha256
      || (manifest.schema === "loyly.supplemental-grade.v1" && manifest.original_score_sha256 !== scoreSha256)
      || (manifest.schema === "loyly.panel-vm-run.v1"
        && !((manifest.score_state === "pre-score" && manifest.original_score_sha256 === null)
          || ((manifest.score_state ?? "filed") === "filed" && manifest.original_score_sha256 === scoreSha256)))
      || (manifest.schema === "loyly.supplemental-grade.v1" && manifest.original_score_unchanged !== true)
      || (manifest.schema === "loyly.panel-vm-run.v1" && manifest.plan_sha256 !== planSha256)
      || manifest.producers.length !== specs.length)
    throw new Error("specialist manifest is not bound to this scored candidate and plan");
  const directories = [], observations = [];
  for (const spec of specs) {
    const producer = manifest.producers.find((entry) => entry.id === spec.id);
    if (!producer || producer.tool !== spec.tool || spec.items.length !== 1
        || producer.item !== `@item-${spec.items[0]}`)
      throw new Error(`${spec.id}: missing or incorrect specialist producer`);
    const dir = join(specialists, spec.id);
    const resultFiles = readdirSync(dir).filter((name) => /^[0-9a-f-]{36}-result\.json$/.test(name));
    if (resultFiles.length !== 1 || resultFiles[0] !== producer.result)
      throw new Error(`${spec.id}: expected exactly one result`);
    const result = json(join(dir, producer.result));
    checkedAllure(validate, result, `${spec.id} Allure result`);
    if (producer.result !== `${result.uuid}-result.json` || result.status !== producer.status
        || result.stage !== "finished" || label(result, "tag") !== producer.item
        || label(result, "tool") !== spec.tool || label(result, "technique") !== spec.technique
        || label(result, "feature") !== (spec.feature ?? plan.feature)
        || result.parameters?.find((entry) => entry.name === "candidate_sha256")?.value !== candidateSha256
        || !result.statusDetails?.message || !result.steps?.length)
      throw new Error(`${spec.id}: specialist identity or observation differs from the plan`);
    const receiptFile = result.attachments?.find((attachment) =>
      /execution receipt/i.test(attachment.name) && attachment.type === "application/json")?.source;
    if (!receiptFile) throw new Error(`${spec.id}: missing execution receipt`);
    const files = [producer.result, ...result.attachments.map((attachment) => attachment.source)];
    if (new Set(files).size !== files.length || Object.keys(producer.files).length !== files.length
        || files.some((name) => !/^[A-Za-z0-9._-]+$/.test(name)
          || !existsSync(join(dir, name)) || !lstatSync(join(dir, name)).isFile()
          || producer.files[name] !== fileSha(join(dir, name))))
      throw new Error(`${spec.id}: result or attachment bytes differ from the manifest`);
    const receipt = json(join(dir, receiptFile));
    const imageDigest = receipt.imageDigest ?? receipt.image_oci_digest;
    if ((receipt.candidate_sha256 ?? receipt.candidateSha ?? receipt.result?.candidateSha256) !== candidateSha256
        || imageDigest !== producer.image_digest
      || !/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? "")
      || producer.execution_receipt_sha256 !== fileSha(join(dir, receiptFile)))
      throw new Error(`${spec.id}: execution receipt is not candidate and image bound`);
    let runtime;
    if (manifest.schema === "loyly.panel-vm-run.v1" && Number.isInteger(receipt.vm_exit_code)
        && receipt.isolation === "gondolin-qemu-vm"
        && receipt.mounts?.candidate === "read-only"
        && receipt.mounts?.worker === "read-only")
      runtime = "gondolin-qemu-vm";
    if (spec.id === "protocol" && receipt.vm_exit_code === 0) runtime = "gondolin-qemu-vm";
    if (!runtime && spec.id === "browser" && receipt.exitCode === 0 && receipt.candidateMount?.RW === false
        && receipt.readOnlyRootFilesystem === true && receipt.networkMode === "none")
      runtime = "docker-shared-linux-vm";
    if (!runtime && spec.id === "telemetry" && receipt.containerId
        && String(receipt.isolation).includes("Docker Desktop Linux VM"))
      runtime = "docker-shared-linux-vm";
    if (!runtime) throw new Error(`${spec.id}: runtime receipt is incomplete`);
    directories.push(dir);
    observations.push({ id: spec.id, item: spec.items[0], tool: spec.tool,
      technique: spec.technique, status: result.status, runtime,
      result_sha256: fileSha(join(dir, producer.result)), message: result.statusDetails.message,
      start: result.start, stop: result.stop });
  }
  const intervals = manifest.schema === "loyly.panel-vm-run.v1"
    ? manifest.producers.map((row) => ({ start: row.started, stop: row.stopped })) : observations;
  const overlap = Math.min(...intervals.map((row) => row.stop))
    - Math.max(...intervals.map((row) => row.start));
  if (overlap <= 0 || overlap !== manifest.parallel_overlap_ms)
    throw new Error("the recorded specialist execution overlap is false");
  return { directories, observations };
}

export async function compilePanel({ original, specialists, out,
  planFile = join(HERE, "booking-core.panel.json") }) {
  original = resolve(original); specialists = resolve(specialists); out = resolve(out);
  if (existsSync(out)) throw new Error("panel output already exists");
  const plan = json(planFile);
  checked(schemaValidator(join(HERE, "panel-plan.schema.json")), plan, "panel plan");
  const scoreInput = json(join(original, "score-input.json"));
  const legacy = plan.schema === 'loyly.grading-panel-plan.v1';
  const verdictsFile = join(original, legacy ? 'final-verdicts.json' : 'verdicts.json');
  const candidateSha256 = candidateDigest(join(original, "fenced-room"));
  if (candidateSha256 !== scoreInput.candidate_sha256) throw new Error("candidate changed after scoring");
  const scored = verifyScoredCycle({ scratch: original, instrument: join(original, "instrument"),
    verdictsFile, cycle: scoreCycleFor(original) });
  const room = join(original, "grading-room"), raw = readAllureResults(room);
  if (!legacy && json(join(room, '.grading-room.json')).project !== plan.project)
    throw new Error('grading room project differs from the panel plan');
  let blind;
  if (legacy) {
    const reviewFile = join(original, "blind-agent-review.json"), review = json(reviewFile);
    const blindArgs = { packetDir: join(original, "blind-agent-packet"), reviewFile,
      gradingRoom: room, out: join(original, "blind-agent-allure"),
      verificationDir: review.verdict === "pass" ? join(original, "blind-agent-verification") : undefined };
    blind = readBlindAgentAllure(blindArgs);
    if (JSON.stringify(finalVerdictsFromBlindReview(blindArgs).verdicts)
        !== readFileSync(verdictsFile, "utf8"))
      throw new Error("blind result differs from scored verdicts");
  } else if (JSON.stringify(raw.verdicts) !== readFileSync(verdictsFile, 'utf8')) {
    throw new Error('raw grader result differs from scored verdicts');
  }
  const rows = await readAuditRows(original);
  const stage = (name, outcome) => rows.findLast((row) => row.stage === name && row.outcome === outcome);
  if (stage("cut", "pinned")?.approved_commit !== scoreInput.source_commit
      || stage("grade", "completed")?.allure_results_sha256 !== raw.allureSha256
      || (legacy && stage("blind-review", "completed")?.raw_allure_sha256 !== raw.allureSha256)
      || (legacy && stage("blind-review", "completed")?.review_sha256 !== blind.reviewSha256)
      || stage("score", "filed")?.score_file_sha256 !== scored.scoreSha256
      || stage("score", "filed")?.score_input_sha256 !== fileSha(join(original, "score-input.json")))
    throw new Error("scored evidence differs from committed Pi audit entries");
  const schemaFile = join(HERE, "../evidence-core/allure-lifecycle-result.schema.json");
  const schemaSha256 = fileSha(schemaFile);
  if (fileSha(join(room, "allure-lifecycle-result.schema.json")) !== schemaSha256)
    throw new Error("original room uses a different Allure schema");
  const validate = compileAllureSchema(json(schemaFile)), observations = [];
  for (const result of raw.results) {
    checkedAllure(validate, result, "raw grader result");
    const item = label(result, "tag")?.slice(6);
    const spec = plan.checks.find((check) => check.source === "raw-grader" && check.items.includes(item));
    if (!spec || label(result, "tool") !== spec.tool || label(result, "technique") !== spec.technique)
      throw new Error(`raw grader result differs from panel plan for ${item}`);
    observations.push({ id: spec.id, item, tool: spec.tool, technique: spec.technique,
      status: result.status, runtime: "gondolin-qemu-vm",
      result_sha256: fileSha(join(room, "work", "allure-results", `${result.uuid}-result.json`)),
      message: result.statusDetails.message });
  }
  if (legacy) {
    checkedAllure(validate, blind.result, "blind review Allure result");
    const blindSpec = plan.checks.find((check) => check.source === "blind-review");
    if (!blindSpec || label(blind.result, "tool") !== blindSpec.tool
        || label(blind.result, "technique") !== blindSpec.technique)
      throw new Error("blind review differs from panel plan");
    observations.push({ id: blindSpec.id, item: "01-011", tool: blindSpec.tool,
      technique: blindSpec.technique, status: blind.result.status, runtime: "gondolin-qemu-vm",
      result_sha256: fileSha(join(original, "blind-agent-allure", `${blind.result.uuid}-result.json`)),
      message: blind.result.statusDetails.message });
  }
  const specialistManifestFile = existsSync(join(specialists, "manifest.json"))
    ? join(specialists, "manifest.json") : join(specialists, "combined", "manifest.json");
  const specialistManifest = json(specialistManifestFile);
  const extra = specialistResults({ specialists, plan, planSha256: fileSha(planFile), manifest: specialistManifest,
    candidateSha256, schemaSha256, scoreSha256: scored.scoreSha256,
    sourceCommit: scoreInput.source_commit, validate });
  observations.push(...extra.observations);
  const assessed = evaluatePanel(plan, scored.items, observations);
  const summary = { schema: "loyly.grading-panel-summary.v1", project: plan.project,
    source_commit: scoreInput.source_commit, candidate_sha256: candidateSha256,
    plan_sha256: fileSha(planFile), allure_schema_sha256: schemaSha256,
    original_score_sha256: scored.scoreSha256, filed_score: scored.score,
    panel_outcome: assessed.panel_outcome, checks: assessed.checks,
    items: assessed.items, gaps: assessed.gaps };
  checked(schemaValidator(join(HERE, "panel-summary.schema.json")), summary, "panel summary");
  mkdirSync(out, { recursive: true });
  const report = join(out, "allure-report");
  const directories = [join(room, "work", "allure-results"),
    ...(legacy ? [join(original, "blind-agent-allure")] : []), ...extra.directories];
  const rendered = spawnSync(join(HERE, "node_modules", ".bin", "allure"),
    ["generate", ...directories, "--config", join(HERE, "allurerc.mjs"), "--output", report, "--clean"],
    { cwd: HERE, encoding: "utf8" });
  if (rendered.error || rendered.status !== 0)
    throw new Error(`Allure render failed: ${rendered.error ?? rendered.stderr}`);
  const stats = json(join(report, "summary.json")).stats;
  if (stats.total !== observations.length
      || ["passed", "failed", "broken", "skipped"].some((status) =>
        (stats[status] ?? 0) !== observations.filter((row) => row.status === status).length))
    throw new Error("Allure omitted or changed a panel result");
  if (fileSha(join(original, "instrument", "harness", "cycles", scoreCycleFor(original), "scores.json")) !== scored.scoreSha256)
    throw new Error("original score changed during panel compilation");
  writeFileSync(join(out, "panel-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const manifest = { schema: "loyly.grading-panel-report.v1",
    panel_summary_sha256: fileSha(join(out, "panel-summary.json")),
    report_html_sha256: fileSha(join(report, "index.html")),
    audit_entries_sha256: sha(rows.map((row) => JSON.stringify(row)).join("\n")),
    specialist_manifest_sha256: fileSha(specialistManifestFile),
    result_count: observations.length, original_score_unchanged: true };
  writeFileSync(join(out, "panel-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, summary, manifest, stats };
}

export function verifyCompiledPanel({ original, out,
  planFile = join(HERE, "booking-core.panel.json") }) {
  original = resolve(original); out = resolve(out);
  const summary = json(join(out, "panel-summary.json"));
  checked(schemaValidator(join(HERE, "panel-summary.schema.json")), summary, "panel summary");
  const manifest = json(join(out, "panel-manifest.json"));
  const plan = json(planFile);
  const score = verifyScoredCycle({ scratch: original, instrument: join(original, "instrument"),
    verdictsFile: join(original, plan.schema === 'loyly.grading-panel-plan.v1'
      ? 'final-verdicts.json' : 'verdicts.json'), cycle: scoreCycleFor(original) });
  if (manifest.schema !== "loyly.grading-panel-report.v1"
      || manifest.panel_summary_sha256 !== fileSha(join(out, "panel-summary.json"))
      || manifest.report_html_sha256 !== fileSha(join(out, "allure-report", "index.html"))
      || manifest.result_count !== summary.checks.length
      || manifest.original_score_unchanged !== true
      || summary.original_score_sha256 !== score.scoreSha256
      || summary.candidate_sha256 !== candidateDigest(join(original, "fenced-room"))
      || summary.plan_sha256 !== fileSha(planFile))
    throw new Error("compiled panel report changed after filing");
  return { out, summary, manifest, stats: json(join(out, "allure-report", "summary.json")).stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error("usage: node panel-compile.mjs <scored-cycle-scratch> <specialist-root> <output-dir>");
  const result = await compilePanel({ original: process.argv[2], specialists: process.argv[3], out: process.argv[4] });
  console.log(`${result.out}: ${result.stats.total} Allure cases; filed ${result.summary.filed_score}; panel ${result.summary.panel_outcome}`);
}
