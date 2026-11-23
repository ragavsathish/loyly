// Keep the black-box grader's pending result intact. A later blind agent review is a
// separate, candidate-bound Allure result, never an edit to the model's evidence.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { compileAllureSchema } from "../evidence-core/validate-schema.ts";
import { readAllureResults } from "./allure-results.ts";
import { candidateDigest } from "./grading-room.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
const REVIEW_ID = "01-011";
const SPEC = join("plan", "01-booking-core", "spec.feature");
const PERSON_SPEC_SHA256 = "b28ee83dfaada8df0ed99b90121a50f3c55885ade4db323b68e03c4d5f15005e";
const QUESTION = "Without reading the sauna-day configuration or another project file, read only refusal.txt. "
  + "Name a request you expect to be accepted using that refusal alone.\n";

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
  writeFileSync(join(out, "question.txt"), QUESTION);
  writeFileSync(join(out, "packet.json"), `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(join(out, "response-template.json"), `${JSON.stringify({
    schema: "loyly.blind-review-response.v1",
    packet_sha256: fileHash(join(out, "packet.json")), reviewer_kind: "agent", reviewer: "",
    had_not_read_configuration: false, saw_only_refusal: false,
    answer: "", verdict: "", reason: "", reviewed_at: 0,
  }, null, 2)}\n`);
  return packet;
}

export function verifyBlindReviewPacket({ packetDir, gradingRoom }) {
  const packetFile = join(packetDir, "packet.json");
  const packet = JSON.parse(readFileSync(packetFile, "utf8"));
  const judged = readAllureResults(gradingRoom);
  const pending = judged.results.find((result) => result.labels.some((label) =>
    label.name === "tag" && label.value === `@item-${REVIEW_ID}`));
  const refusal = readFileSync(join(packetDir, "refusal.txt"));
  if (packet.schema !== "loyly.blind-review-packet.v1" || packet.item !== REVIEW_ID
      || packet.candidate_sha256 !== candidateDigest(gradingRoom)
      || packet.checklist_sha256 !== fileHash(join(gradingRoom, "checklist.json"))
      || packet.spec_sha256 !== fileHash(join(gradingRoom, SPEC))
      || packet.allure_results_sha256 !== judged.allureSha256
      || packet.refusal_sha256 !== hash(refusal)
      || readFileSync(join(packetDir, "question.txt"), "utf8") !== QUESTION
      || pending?.status !== "skipped" || pending.stage !== "pending"
      || !pending.attachments?.some((attachment) => readFileSync(join(gradingRoom, "work",
        "allure-results", attachment.source)).equals(refusal)))
    throw new Error("blind review packet no longer matches candidate, spec, checklist or grader result");
  return { packet, packetSha256: fileHash(packetFile) };
}

export function validateBlindReview({ packetDir, reviewFile, gradingRoom }) {
  const { packet, packetSha256 } = verifyBlindReviewPacket({ packetDir, gradingRoom });
  const review = JSON.parse(readFileSync(reviewFile, "utf8"));
  if (review.schema !== "loyly.blind-review-response.v1"
      || review.packet_sha256 !== packetSha256
      || review.reviewer_kind !== "agent"
      || typeof review.reviewer !== "string" || !review.reviewer.trim()
      || review.had_not_read_configuration !== true || review.saw_only_refusal !== true
      || typeof review.answer !== "string" || !review.answer.trim()
      || !["pass", "fail"].includes(review.verdict)
      || typeof review.reason !== "string" || !review.reason.trim()
      || !Number.isInteger(review.reviewed_at) || review.reviewed_at <= 0)
    throw new Error("invalid or unbound blind subagent review");
  return { packet, review, packetSha256, reviewSha256: fileHash(reviewFile) };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function bookingFormAction(html) {
  const attribute = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i")
    .exec(tag)?.[1];
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].filter(([, tag, body]) =>
    attribute(tag, "method")?.toLowerCase() === "post"
    && ["household", "resource", "weekday", "start"].every((name) =>
      new RegExp(`<(?:input|select)\\b[^>]*\\bname\\s*=\\s*["']${name}["']`, "i").test(body)));
  if (forms.length > 1) throw new Error("expected at most one public booking form");
  if (!forms.length) return null;
  const path = attribute(forms[0][1], "action");
  if (!/^\/[A-Za-z0-9/?=&%._-]*$/.test(path ?? "") || path.startsWith("//"))
    throw new Error("booking form action must be a same-origin path");
  return path;
}
async function publicJsonBooking(base, body, answer) {
  const params = new URLSearchParams(body);
  const room = /^@room:(\d+)$/.exec(params.get("resource") ?? "")?.[1];
  if (!room || !new RegExp(`^REQUEST:\\s*pukuhuone\\s+${room}\\s*\\|`, "i").test(answer))
    throw new Error("blind answer and requested room differ");
  const housesResponse = await fetch(`${base}/api/houses`, { signal: AbortSignal.timeout(1000) });
  if (!housesResponse.ok) throw new Error("no public booking form or house API");
  const houseListing = await housesResponse.json();
  const houses = Array.isArray(houseListing) ? houseListing : houseListing.houses;
  if (!Array.isArray(houses)) throw new Error("public house API has no houses");
  const matches = [];
  for (const house of houses) {
    if (typeof house.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(house.id)) continue;
    let policy = house.policy, resources = policy?.resources;
    let route = policy?.route ?? policy?.bookingMode;
    const modernRoles = typeof policy?.bookingMode === "string";
    const houseScoped = Array.isArray(houseListing) || modernRoles;
    let path = houseScoped ? `/api/houses/${house.id}/bookings` : "/api/bookings";
    if (!Array.isArray(resources)) {
      const stateResponse = await fetch(`${base}/api/houses/${house.id}/state`,
        { signal: AbortSignal.timeout(1000) });
      if (!stateResponse.ok) continue;
      const state = await stateResponse.json();
      policy = state.policy;
      resources = state.resources;
      route = state.route?.kind;
      path = `/api/houses/${house.id}/bookings`;
    }
    const named = resources?.filter((resource) =>
      resource.name?.trim().toLowerCase() === `pukuhuone ${room}`) ?? [];
    if (route === "self-service" && named.length === 1)
      matches.push({ house: house.id, resource: named[0].id,
        role: policy?.eligibleRoles?.[0] ?? policy?.bookerRoles?.[0], path, modernRoles });
  }
  if (matches.length !== 1) throw new Error("blind room is not unique in the public self-service API");
  const match = matches[0];
  const payload = { house: match.house, household: params.get("household"), resource: match.resource,
    weekday: params.get("weekday"), start: params.get("start"), kind: "standing",
    ...(match.modernRoles ? { bookerRole: match.role, actorRole: match.role } : { role: match.role }) };
  if (!Object.values(payload).every((value) => typeof value === "string" && value.trim()))
    throw new Error("public booking request is incomplete");
  return { path: match.path, body: JSON.stringify(payload), contentType: "application/json" };
}
function resolveRoomInPublicForm(html, body, answer) {
  const params = new URLSearchParams(body);
  const token = /^@room:(\d+)$/.exec(params.get("resource") ?? "");
  if (!token) return body;
  if (!new RegExp(`^REQUEST:\\s*pukuhuone\\s+${token[1]}\\s*\\|`, "i").test(answer))
    throw new Error("blind answer and requested room differ");
  const select = /<select\b[^>]*\bname\s*=\s*["']resource["'][^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!select) throw new Error("public booking form has no resource selection");
  const options = [...select[1].matchAll(/<option\b[^>]*\bvalue\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi)];
  const matching = options.filter(([, , label]) => label.replace(/<[^>]+>/g, "").trim().toLowerCase()
    === `pukuhuone ${token[1]}`);
  if (matching.length !== 1) throw new Error("blind room is not a unique public form option");
  params.set("resource", matching[0][1]);
  return params.toString();
}
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
  if (request?.method !== "POST" || (request.path !== "@booking-form"
      && !/^\/[A-Za-z0-9/?=&%._-]*$/.test(request.path ?? ""))
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
    let ready = false, homepage;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) break;
      try {
        const health = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (health.ok) { homepage = await health.text(); ready = true; break; }
      } catch { /* waiting for startup */ }
      await pause(100);
    }
    if (!ready) throw new Error("review probe app did not start within ten seconds");
    const formPath = request.path === "@booking-form" ? bookingFormAction(homepage) : null;
    const jsonBooking = request.path === "@booking-form" && !formPath
      ? await publicJsonBooking(`http://127.0.0.1:${port}`, request.body, review.answer) : null;
    const resolvedPath = jsonBooking?.path ?? formPath ?? request.path;
    const resolvedBody = jsonBooking?.body ?? (formPath
      ? resolveRoomInPublicForm(homepage, request.body, review.answer) : request.body);
    const http = await fetch(`http://127.0.0.1:${port}${resolvedPath}`, {
      method: "POST", headers: { "content-type": jsonBooking?.contentType
        ?? "application/x-www-form-urlencoded" },
      body: resolvedBody, signal: AbortSignal.timeout(10_000) });
    response = { status: http.status, body: await http.text(), resolvedPath, resolvedBody };
  } finally {
    if (child.exitCode === null && child.signalCode === null && !spawnError)
      child.kill("SIGTERM");
    await exited;
    writeFileSync(join(out, "server.log"), logs.join(""));
  }
  writeFileSync(join(out, "response.txt"), response.body);
  const verification = { schema: "loyly.blind-review-probe.v1", item: REVIEW_ID,
    candidate_sha256: packet.candidate_sha256, packet_sha256: packetSha256,
    review_sha256: reviewSha256, request: { ...request,
      resolved_path: response.resolvedPath, resolved_body: response.resolvedBody },
    http_status: response.status,
    response_sha256: hash(response.body), accepted: response.status >= 200 && response.status < 300,
    observed_at: Date.now() };
  writeFileSync(join(out, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  return verification;
}

export function writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom, verificationDir, out }) {
  const { packet, review, packetSha256, reviewSha256 } = validateBlindReview({ packetDir, reviewFile, gradingRoom });
  if (existsSync(out)) return readBlindAgentAllure({ packetDir, reviewFile, gradingRoom, verificationDir, out });
  let verification;
  if (review.verdict === "pass") {
    if (!verificationDir) throw new Error("positive blind review needs an independent HTTP probe");
    verification = JSON.parse(readFileSync(join(verificationDir, "verification.json"), "utf8"));
    if (verification.schema !== "loyly.blind-review-probe.v1"
        || verification.item !== REVIEW_ID || verification.candidate_sha256 !== packet.candidate_sha256
        || verification.packet_sha256 !== packetSha256 || verification.review_sha256 !== reviewSha256
        || verification.request?.matches_answer !== true
        || verification.response_sha256 !== fileHash(join(verificationDir, "response.txt"))
        || verification.accepted !== (verification.http_status >= 200 && verification.http_status < 300))
      throw new Error("blind review HTTP probe is missing, failed or unbound");
  }
  const item = JSON.parse(readFileSync(join(gradingRoom, "checklist.json"), "utf8"))
    .items.find((value) => value.id === REVIEW_ID);
  if (!item) throw new Error("01-011 not selected");
  const uuid = randomUUID(), attachment = `${randomUUID()}-attachment.json`;
  const responseAttachment = verification ? `${randomUUID()}-attachment.txt` : null;
  const fullName = `loyly.booking-core.${REVIEW_ID}.blind-agent-review`;
  const status = review.verdict === "pass" && verification?.accepted === true ? "passed" : "failed";
  const result = {
    uuid, name: item.name, fullName, testCaseId: fullName, historyId: fullName,
    status, stage: "finished", start: review.reviewed_at, stop: review.reviewed_at,
    statusDetails: { message: `${review.reason} Answer: ${review.answer}${verification?.accepted === false
      ? ` HTTP ${verification.http_status} did not confirm the suggested request.` : ""}` },
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
  compileAllureSchema(
    JSON.parse(readFileSync(join(gradingRoom, "allure-lifecycle-result.schema.json"), "utf8")),
  )(result, "blind-result");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, attachment), JSON.stringify({ packet_sha256: packetSha256,
    review_sha256: reviewSha256, review, verification }));
  if (responseAttachment)
    writeFileSync(join(out, responseAttachment), readFileSync(join(verificationDir, "response.txt")));
  writeFileSync(join(out, `${uuid}-result.json`), JSON.stringify(result));
  return { result, packetSha256, reviewSha256 };
}

export function readBlindAgentAllure({ packetDir, reviewFile, gradingRoom, verificationDir, out }) {
  const { packet, review, packetSha256, reviewSha256 } = validateBlindReview({ packetDir, reviewFile, gradingRoom });
  const names = readdirSync(out).sort();
  const resultFiles = names.filter((name) => /^[0-9a-f-]{36}-result\.json$/.test(name));
  if (resultFiles.length !== 1) throw new Error("blind subagent Allure result is incomplete");
  const result = JSON.parse(readFileSync(join(out, resultFiles[0]), "utf8"));
  const item = JSON.parse(readFileSync(join(gradingRoom, "checklist.json"), "utf8"))
    .items.find((value) => value.id === REVIEW_ID);
  const fullName = `loyly.booking-core.${REVIEW_ID}.blind-agent-review`;
  if (review.verdict === "pass" && !verificationDir)
    throw new Error("positive blind review needs an independent HTTP probe");
  const verification = review.verdict === "pass"
    ? JSON.parse(readFileSync(join(verificationDir, "verification.json"), "utf8")) : null;
  const expectedStatus = review.verdict === "pass" && verification?.accepted === true ? "passed" : "failed";
  compileAllureSchema(
    JSON.parse(readFileSync(join(gradingRoom, "allure-lifecycle-result.schema.json"), "utf8")),
  )(result, resultFiles[0]);
  if (resultFiles[0] !== `${result.uuid}-result.json`
      || result.name !== item?.name || result.fullName !== fullName
      || result.testCaseId !== fullName || result.historyId !== fullName
      || result.status !== expectedStatus || result.stage !== "finished"
      || result.labels?.filter((label) => label.name === "tag" && label.value === `@item-${REVIEW_ID}`).length !== 1
      || result.parameters?.find((p) => p.name === "candidate_sha256")?.value !== packet.candidate_sha256
      || result.parameters?.find((p) => p.name === "grader_allure_sha256")?.value !== packet.allure_results_sha256)
    throw new Error("blind subagent Allure result differs from the bound review");
  const attachmentNames = result.attachments.map((a) => a.source);
  if (new Set(attachmentNames).size !== attachmentNames.length
      || names.length !== attachmentNames.length + 1
      || attachmentNames.some((name) => !names.includes(name) || !lstatSync(join(out, name)).isFile()))
    throw new Error("blind subagent Allure attachments are incomplete");
  const evidence = JSON.parse(readFileSync(join(out, result.attachments[0].source), "utf8"));
  if (evidence.packet_sha256 !== packetSha256 || evidence.review_sha256 !== reviewSha256
      || JSON.stringify(evidence.review) !== JSON.stringify(review))
    throw new Error("blind subagent Allure evidence differs from the bound review");
  if (review.verdict === "pass") {
    if (result.attachments.length !== 2 || evidence.verification?.review_sha256 !== reviewSha256
        || JSON.stringify(evidence.verification) !== JSON.stringify(verification)
        || verification.packet_sha256 !== packetSha256
        || verification.accepted !== (verification.http_status >= 200 && verification.http_status < 300)
        || verification.response_sha256 !== fileHash(join(verificationDir, "response.txt"))
        || !readFileSync(join(out, result.attachments[1].source)).equals(
          readFileSync(join(verificationDir, "response.txt"))))
      throw new Error("blind subagent Allure probe differs from the bound HTTP response");
  } else if (result.attachments.length !== 1 || evidence.verification !== undefined) {
    throw new Error("failed blind review must not claim an HTTP confirmation");
  }
  return { result, packetSha256, reviewSha256 };
}

export function finalVerdictsFromBlindReview(args) {
  const { packetDir, reviewFile, gradingRoom } = args;
  const { packet } = validateBlindReview({ packetDir, reviewFile, gradingRoom });
  if (packet.spec_sha256 === PERSON_SPEC_SHA256)
    throw new Error("the historical person-worded cut cannot be scored with a blind subagent");
  const raw = readAllureResults(gradingRoom);
  const supplemental = readBlindAgentAllure(args);
  return { verdicts: raw.verdicts.map((v) => v.id === REVIEW_ID
    ? { id: REVIEW_ID, verdict: supplemental.result.status === "passed" ? "pass" : "fail",
      evidence: supplemental.result.statusDetails.message } : v),
    rawAllureSha256: raw.allureSha256, reviewSha256: supplemental.reviewSha256 };
}
