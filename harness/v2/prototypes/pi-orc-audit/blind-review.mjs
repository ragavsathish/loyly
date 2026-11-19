// Keep the black-box grader's pending result intact. A later blind agent review is a
// separate, candidate-bound Allure result, never an edit to the model's evidence.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { readAllureResults } from "./allure-results.mjs";
import { candidateDigest } from "./grading-room.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
const REVIEW_ID = "01-011";
const SPEC = join("plan", "01-booking-core", "spec.feature");

export function prepareBlindReview({ gradingRoom, out }) {
  if (existsSync(out)) throw new Error("blind review packet already exists");
  const judged = readAllureResults(gradingRoom);
  const pending = judged.results.find((result) => result.labels.some((label) =>
    label.name === "tag" && label.value === `@item-${REVIEW_ID}`));
  if (!pending || pending.status !== "skipped" || pending.stage !== "pending")
    throw new Error("grader did not leave 01-011 pending");
  const shardRoot = join(gradingRoom, "work", "shards");
  const sources = readdirSync(shardRoot).map((name) => join(shardRoot, name, "blind-review-011.txt"))
    .filter((path) => existsSync(path));
  if (sources.length !== 1 || !lstatSync(sources[0]).isFile())
    throw new Error("need exactly one regular blind-review refusal file");
  const refusal = readFileSync(sources[0]);
  if (!refusal.length || refusal.length > 8192) throw new Error("blind-review refusal is empty or too large");
  const attachments = pending.attachments ?? [];
  if (!attachments.some((attachment) => readFileSync(join(gradingRoom, "work", "allure-results",
    attachment.source)).equals(refusal)))
    throw new Error("blind packet differs from the pending Allure refusal attachment");
  const packet = {
    schema: "loyly.blind-review-packet.v1", item: REVIEW_ID,
    candidate_sha256: candidateDigest(gradingRoom),
    checklist_sha256: fileHash(join(gradingRoom, "checklist.json")),
    spec_sha256: fileHash(join(gradingRoom, SPEC)),
    allure_results_sha256: judged.allureSha256,
    refusal_sha256: hash(refusal),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "refusal.txt"), refusal);
  writeFileSync(join(out, "question.txt"),
    "Without reading the sauna-day configuration or another project file, read only refusal.txt. "
    + "Name a request you expect to be accepted using that refusal alone.\n");
  writeFileSync(join(out, "packet.json"), `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(join(out, "response-template.json"), `${JSON.stringify({
    schema: "loyly.blind-review-response.v1",
    packet_sha256: fileHash(join(out, "packet.json")), reviewer_kind: "agent", reviewer: "",
    had_not_read_configuration: false, saw_only_refusal: false,
    answer: "", verdict: "", reason: "", reviewed_at: 0,
  }, null, 2)}\n`);
  return packet;
}

export function validateBlindReview({ packetDir, reviewFile, gradingRoom }) {
  const packetFile = join(packetDir, "packet.json");
  const packet = JSON.parse(readFileSync(packetFile, "utf8"));
  const review = JSON.parse(readFileSync(reviewFile, "utf8"));
  const judged = readAllureResults(gradingRoom);
  if (packet.schema !== "loyly.blind-review-packet.v1" || packet.item !== REVIEW_ID
      || packet.candidate_sha256 !== candidateDigest(gradingRoom)
      || packet.checklist_sha256 !== fileHash(join(gradingRoom, "checklist.json"))
      || packet.spec_sha256 !== fileHash(join(gradingRoom, SPEC))
      || packet.allure_results_sha256 !== judged.allureSha256
      || packet.refusal_sha256 !== fileHash(join(packetDir, "refusal.txt")))
    throw new Error("blind review packet no longer matches candidate, checklist or grader result");
  if (review.schema !== "loyly.blind-review-response.v1"
      || review.packet_sha256 !== fileHash(packetFile)
      || review.reviewer_kind !== "agent"
      || typeof review.reviewer !== "string" || !review.reviewer.trim()
      || review.had_not_read_configuration !== true || review.saw_only_refusal !== true
      || typeof review.answer !== "string" || !review.answer.trim()
      || !["pass", "fail"].includes(review.verdict)
      || typeof review.reason !== "string" || !review.reason.trim()
      || !Number.isInteger(review.reviewed_at) || review.reviewed_at <= 0)
    throw new Error("invalid or unbound blind subagent review");
  return { packet, review, packetSha256: fileHash(packetFile), reviewSha256: fileHash(reviewFile) };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function probeBlindAnswer({ packetDir, reviewFile, gradingRoom, request, out }) {
  const { packet, reviewSha256, packetSha256, review } = validateBlindReview({ packetDir, reviewFile, gradingRoom });
  if (review.verdict !== "pass") throw new Error("a failed blind review needs no acceptance probe");
  if (existsSync(out)) throw new Error("blind review probe already exists");
  if (request?.method !== "POST" || !/^\/[A-Za-z0-9/?=&%._-]*$/.test(request.path ?? "")
      || typeof request.body !== "string" || request.body.length > 4096
      || request.matches_answer !== true)
    throw new Error("probe needs a POST path, bounded body and operator answer-match attestation");
  mkdirSync(out, { recursive: true });
  const runtime = join(out, "runtime");
  cpSync(join(gradingRoom, "impl"), runtime, { recursive: true });
  const port = await freePort();
  const child = spawn(join(runtime, "start.sh"), [String(port)], {
    cwd: runtime, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  const logs = [];
  child.stdout.on("data", (data) => logs.push(String(data)));
  child.stderr.on("data", (data) => logs.push(String(data)));
  let response;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) break;
      try {
        const health = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (health.ok) { ready = true; break; }
      } catch { /* waiting for startup */ }
      await pause(100);
    }
    if (!ready) throw new Error("review probe app did not start within ten seconds");
    const http = await fetch(`http://127.0.0.1:${port}${request.path}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: request.body, signal: AbortSignal.timeout(10_000) });
    response = { status: http.status, body: await http.text() };
  } finally {
    if (child.exitCode === null && child.signalCode === null && !spawnError)
      child.kill("SIGTERM");
    await exited;
    writeFileSync(join(out, "server.log"), logs.join(""));
  }
  writeFileSync(join(out, "response.txt"), response.body);
  const verification = { schema: "loyly.blind-review-probe.v1", item: REVIEW_ID,
    candidate_sha256: packet.candidate_sha256, packet_sha256: packetSha256,
    review_sha256: reviewSha256, request, http_status: response.status,
    response_sha256: hash(response.body), accepted: response.status >= 200 && response.status < 300,
    observed_at: Date.now() };
  writeFileSync(join(out, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  return verification;
}

export function writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom, verificationDir, out }) {
  const { packet, review, packetSha256, reviewSha256 } = validateBlindReview({ packetDir, reviewFile, gradingRoom });
  if (existsSync(out)) throw new Error("blind subagent Allure result already exists");
  let verification;
  if (review.verdict === "pass") {
    if (!verificationDir) throw new Error("positive blind review needs an independent HTTP probe");
    verification = JSON.parse(readFileSync(join(verificationDir, "verification.json"), "utf8"));
    if (verification.schema !== "loyly.blind-review-probe.v1"
        || verification.item !== REVIEW_ID || verification.candidate_sha256 !== packet.candidate_sha256
        || verification.packet_sha256 !== packetSha256 || verification.review_sha256 !== reviewSha256
        || verification.request?.matches_answer !== true
        || verification.response_sha256 !== fileHash(join(verificationDir, "response.txt"))
        || verification.accepted !== true || verification.http_status < 200 || verification.http_status >= 300)
      throw new Error("blind review HTTP probe is missing, failed or unbound");
  }
  const item = JSON.parse(readFileSync(join(gradingRoom, "checklist.json"), "utf8"))
    .items.find((value) => value.id === REVIEW_ID);
  if (!item) throw new Error("01-011 not selected");
  const uuid = randomUUID(), attachment = `${randomUUID()}-attachment.json`;
  const responseAttachment = verification ? `${randomUUID()}-attachment.txt` : null;
  const fullName = `loyly.booking-core.${REVIEW_ID}.blind-agent-review`;
  const status = review.verdict === "pass" ? "passed" : "failed";
  const result = {
    uuid, name: item.name, fullName, testCaseId: fullName, historyId: fullName,
    status, stage: "finished", start: review.reviewed_at, stop: review.reviewed_at,
    statusDetails: { message: `${review.reason} Answer: ${review.answer}` },
    labels: [{ name: "lifecycle", value: "pre-production" },
      { name: "technique", value: "usability" }, { name: "tool", value: "fresh blind subagent" },
      { name: "feature", value: "Booking core" }, { name: "story", value: item.rule },
      { name: "tag", value: `@item-${REVIEW_ID}` }],
    steps: [{ name: "Given the fresh subagent had no configuration and saw only the refusal",
      status: "passed", stage: "finished" },
    { name: "When the reviewer named an expected accepted request", status: "passed", stage: "finished" },
    { name: "Then the refusal was judged usable", status, stage: "finished" }],
    attachments: [{ name: "Blind review and packet digests", source: attachment,
      type: "application/json" },
    ...(responseAttachment ? [{ name: "Independent HTTP confirmation", source: responseAttachment,
      type: "text/plain" }] : [])],
    parameters: [{ name: "candidate_sha256", value: packet.candidate_sha256 },
      { name: "grader_allure_sha256", value: packet.allure_results_sha256 }],
  };
  const schema = JSON.parse(readFileSync(join(gradingRoom, "allure-lifecycle-result.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  if (!validate(result)) throw new Error(`blind subagent Allure schema rejected result: ${JSON.stringify(validate.errors)}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, attachment), JSON.stringify({ packet_sha256: packetSha256,
    review_sha256: reviewSha256, review, verification }));
  if (responseAttachment)
    writeFileSync(join(out, responseAttachment), readFileSync(join(verificationDir, "response.txt")));
  writeFileSync(join(out, `${uuid}-result.json`), JSON.stringify(result));
  return { result, packetSha256, reviewSha256 };
}
