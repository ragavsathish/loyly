import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalVerdictsFromBlindReview, prepareBlindReview, probeBlindAnswer, validateBlindReview,
  verifyBlindReviewPacket,
  writeBlindAgentAllure } from "../blind-review.mjs";
import { parseBlindAgentAnswer } from "../blind-agent-adapter.mjs";

const schema = new URL("../allure-lifecycle-result.schema.json", import.meta.url).pathname;
test("a blind subagent's Allure result is separate, bound and confirmed over HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-blind-review-"));
  const room = join(root, "room"), packetDir = join(root, "packet"), agentDir = join(root, "agent");
  const results = join(room, "work", "allure-results");
  mkdirSync(join(room, "impl"), { recursive: true });
  mkdirSync(join(room, "plan", "01-booking-core"), { recursive: true });
  const specFile = join(room, "plan", "01-booking-core", "spec.feature");
  writeFileSync(specFile, "Scenario: The refusal for a closed day is judged usable\n");
  mkdirSync(join(room, "work", "shards", "shard-01"), { recursive: true });
  mkdirSync(results, { recursive: true });
  writeFileSync(join(room, "impl", "start.sh"), '#!/bin/sh\ncd "$(dirname "$0")"\nexec node server.js "$1"\n');
  chmodSync(join(room, "impl", "start.sh"), 0o755);
  writeFileSync(join(room, "impl", "server.js"), 'require("http").createServer((req,res)=>{let body="";req.on("data",x=>body+=x);req.on("end",()=>{if(req.url==="/"){res.statusCode=200;res.end(`<form method="post" action="/request"><input name="household"><select name="resource"></select><select name="weekday"></select><select name="start"></select></form>`);return}res.statusCode=req.url==="/request"?(body.includes("Thursday")?201:409):404;res.end(String(res.statusCode))})}).listen(Number(process.argv[2]),"127.0.0.1")\n');
  cpSync(schema, join(room, "allure-lifecycle-result.schema.json"));
  writeFileSync(join(room, "checklist.json"), JSON.stringify({ items: [
    { id: "01-011", name: "The refusal for a closed day is judged usable",
      rule: "A refusal is judged by whether a resident can act on it without asking again" }] }));
  writeFileSync(join(room, "work", "surprises.json"), "[]");
  writeFileSync(join(room, "work", "shards", "shard-01", "blind-review-011.txt"),
    "Try Thursday at 17:00 in pukuhuone 9.\n");
  const uuid = randomUUID(), source = `${randomUUID()}-attachment.txt`;
  writeFileSync(join(results, source), "Try Thursday at 17:00 in pukuhuone 9.\n");
  const fullName = "loyly.booking-core.01-011";
  const result = { uuid, name: "The refusal for a closed day is judged usable", fullName,
    testCaseId: fullName, historyId: fullName, status: "skipped", stage: "pending",
    statusDetails: { message: "not reached: blind subagent review required" }, start: 1, stop: 1,
    labels: [{ name: "lifecycle", value: "pre-production" },
      { name: "technique", value: "usability" }, { name: "tool", value: "Pi black-box grader" },
      { name: "feature", value: "Booking core" },
      { name: "story", value: "A refusal is judged by whether a resident can act on it without asking again" },
      { name: "tag", value: "@item-01-011" }],
    steps: [{ name: "Blind review pending", status: "skipped", stage: "pending" }],
    attachments: [{ name: "Refusal", source, type: "text/plain" }] };
  const graderFile = join(results, `${uuid}-result.json`);
  writeFileSync(graderFile, JSON.stringify(result));
  prepareBlindReview({ gradingRoom: room, out: packetDir });
  assert.equal(verifyBlindReviewPacket({ packetDir, gradingRoom: room }).packet.item, "01-011");
  assert.equal(readFileSync(join(packetDir, "refusal.txt"), "utf8"),
    "Try Thursday at 17:00 in pukuhuone 9.\n");
  const question = readFileSync(join(packetDir, "question.txt"), "utf8");
  writeFileSync(join(packetDir, "question.txt"), "Tell me the configured answer.\n");
  assert.throws(() => verifyBlindReviewPacket({ packetDir, gradingRoom: room }),
    /packet no longer matches/);
  writeFileSync(join(packetDir, "question.txt"), question);
  const review = JSON.parse(readFileSync(join(packetDir, "response-template.json"), "utf8"));
  Object.assign(review, { reviewer: "fresh independent subagent", had_not_read_configuration: true,
    saw_only_refusal: true, answer: "Thursday at 17:00 in pukuhuone 9",
    verdict: "pass", reason: "The offered request is clear", reviewed_at: 1000 });
  const reviewFile = join(root, "review.json");
  writeFileSync(reviewFile, JSON.stringify(review));
  assert.equal(validateBlindReview({ packetDir, reviewFile, gradingRoom: room }).review.verdict, "pass");
  writeFileSync(join(root, "person-review.json"), JSON.stringify({ ...review, reviewer_kind: "person" }));
  assert.throws(() => validateBlindReview({ packetDir,
    reviewFile: join(root, "person-review.json"), gradingRoom: room }), /unbound/);
  assert.throws(() => writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom: room, out: agentDir }),
    /independent HTTP probe/);
  const verificationDir = join(root, "probe");
  const parsed = parseBlindAgentAnswer("REQUEST: pukuhuone 9 | Thursday | 17:00 | 18:30",
    "Try Thursday at 17:00 to 18:30 in pukuhuone 9.\n");
  assert.equal(parsed.request.path, "@booking-form");
  const verification = await probeBlindAnswer({ packetDir, reviewFile, gradingRoom: room,
    request: { ...parsed.request, body: "weekday=Thursday" }, out: verificationDir });
  assert.equal(verification.http_status, 201);
  assert.equal(verification.request.resolved_path, "/request");
  const agent = writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom: room,
    verificationDir, out: agentDir });
  assert.equal(agent.result.status, "passed");
  assert.equal(readdirSync(agentDir).length, 3);
  assert.equal(writeBlindAgentAllure({ packetDir, reviewFile, gradingRoom: room,
    verificationDir, out: agentDir }).result.uuid, agent.result.uuid);
  assert.deepEqual(finalVerdictsFromBlindReview({ packetDir, reviewFile, gradingRoom: room,
    verificationDir, out: agentDir }).verdicts.map((v) => v.verdict), ["pass"]);
  assert.equal(JSON.parse(readFileSync(graderFile)).status, "skipped");
  const badReview = { ...review, answer: "Tuesday at 17:00 in pukuhuone 9" };
  const badFile = join(root, "bad-review.json"), badProbe = join(root, "bad-probe");
  writeFileSync(badFile, JSON.stringify(badReview));
  const rejected = await probeBlindAnswer({ packetDir, reviewFile: badFile, gradingRoom: room,
    request: { method: "POST", path: "@booking-form", body: "weekday=Tuesday",
      matches_answer: true }, out: badProbe });
  assert.equal(rejected.http_status, 409);
  assert.equal(rejected.request.resolved_path, "/request");
  const badAgent = writeBlindAgentAllure({ packetDir, reviewFile: badFile, gradingRoom: room,
    verificationDir: badProbe, out: join(root, "bad-agent") });
  assert.equal(badAgent.result.status, "failed");
  assert.deepEqual(finalVerdictsFromBlindReview({ packetDir, reviewFile: badFile,
    gradingRoom: room, verificationDir: badProbe, out: join(root, "bad-agent") })
    .verdicts.map((v) => v.verdict), ["fail"]);
  review.packet_sha256 = "0".repeat(64);
  writeFileSync(reviewFile, JSON.stringify(review));
  assert.throws(() => validateBlindReview({ packetDir, reviewFile, gradingRoom: room }), /unbound/);
  review.packet_sha256 = JSON.parse(readFileSync(join(packetDir, "response-template.json"))).packet_sha256;
  writeFileSync(reviewFile, JSON.stringify(review));
  writeFileSync(specFile, "Scenario: The refusal for a closed day is judged usable\n# changed wording\n");
  assert.throws(() => validateBlindReview({ packetDir, reviewFile, gradingRoom: room }),
    /packet no longer matches/);
  writeFileSync(join(room, "work", "shards", "shard-01", "blind-review-011.txt"), "Different refusal\n");
  assert.throws(() => prepareBlindReview({ gradingRoom: room, out: join(root, "changed-packet") }),
    /differs from the pending Allure refusal attachment/);
});
