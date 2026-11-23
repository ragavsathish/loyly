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
test("blind request needs only the room, weekday and start given by the refusal", () => {
  const refusal = "pukuhuone 9 is closed Tuesday. Request apartment 12, pukuhuone 8, Tuesday at 17:00 instead.";
  const accepted = parseBlindAgentAnswer("REQUEST: pukuhuone 8 | Tuesday | 17:00", refusal);
  assert.equal(accepted.verdict, "pass");
  assert.equal(new URLSearchParams(accepted.request.body).get("start"), "17:00");
  assert.throws(() => parseBlindAgentAnswer("REQUEST: pukuhuone 8 | Tuesday | 18:30", refusal),
    /absent from the refusal/);
  assert.throws(() => parseBlindAgentAnswer("REQUEST: pukuhuone 8 | Friday | 17:00", refusal),
    /absent from the refusal/);
  assert.throws(() => parseBlindAgentAnswer("REQUEST: pukuhuone 7 | Tuesday | 17:00", refusal),
    /absent from the refusal/);
});
test("a blind subagent's Allure result is separate, bound and confirmed over HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-blind-review-"));
  const room = join(root, "room"), packetDir = join(root, "packet"), agentDir = join(root, "agent");
  const results = join(room, "work", "allure-results");
  mkdirSync(join(room, "impl"), { recursive: true });
  mkdirSync(join(room, "plan", "01-booking-core"), { recursive: true });
  const specFile = join(room, "plan", "01-booking-core", "spec.feature");
  writeFileSync(specFile, "Feature: Booking core\nScenario: The refusal for a closed day is judged usable\n");
  mkdirSync(join(room, "work", "shards", "shard-01"), { recursive: true });
  mkdirSync(results, { recursive: true });
  writeFileSync(join(room, "impl", "start.sh"), '#!/bin/sh\ncd "$(dirname "$0")"\nexec node server.js "$1"\n');
  chmodSync(join(room, "impl", "start.sh"), 0o755);
  writeFileSync(join(room, "impl", "server.js"), 'require("http").createServer((req,res)=>{let body="";req.on("data",x=>body+=x);req.on("end",()=>{if(req.url==="/"){res.statusCode=200;res.end(`<form method="post" action="/request"><input name="household"><select name="resource"><option value="ph9">pukuhuone 9</option></select><select name="weekday"></select><select name="start"></select></form>`);return}res.statusCode=req.url==="/request"?(body.includes("Thursday")?201:409):404;res.end(String(res.statusCode))})}).listen(Number(process.argv[2]),"127.0.0.1")\n');
  cpSync(schema, join(room, "allure-lifecycle-result.schema.json"));
  writeFileSync(join(room, '.grading-room.json'), JSON.stringify({ schema: 'loyly.grading-room.v1' }));
  writeFileSync(join(room, "checklist.json"), JSON.stringify({ items: [
    { id: "01-011", name: "The refusal for a closed day is judged usable",
      rule: "A refusal is judged by whether a resident can act on it without asking again",
      source: "docs/plan/01-booking-core/spec.feature:1" }] }));
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
  const parsed = parseBlindAgentAnswer("REQUEST: pukuhuone 9 | Thursday | 17:00",
    "Try Thursday at 17:00 in pukuhuone 9.\n");
  assert.equal(parsed.request.path, "@booking-form");
  const verification = await probeBlindAnswer({ packetDir, reviewFile, gradingRoom: room,
    request: { ...parsed.request, body: "weekday=Thursday" }, out: verificationDir });
  assert.equal(verification.http_status, 201);
  assert.equal(verification.request.resolved_path, "/request");
  const mappedReviewFile = join(root, "mapped-review.json");
  writeFileSync(mappedReviewFile, JSON.stringify({ ...review,
    answer: "REQUEST: pukuhuone 9 | Thursday | 17:00" }));
  const mapped = await probeBlindAnswer({ packetDir, reviewFile: mappedReviewFile,
    gradingRoom: room, request: parsed.request, out: join(root, "mapped-probe") });
  assert.equal(mapped.http_status, 201);
  assert.equal(new URLSearchParams(mapped.request.resolved_body).get("resource"), "ph9");
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
  const apiRoom = join(root, "api-room"), apiPacket = join(root, "api-packet");
  cpSync(room, apiRoom, { recursive: true });
  writeFileSync(join(apiRoom, "impl", "server.js"), `require("http").createServer((req,res)=>{
    const send=(status,body)=>{res.statusCode=status;res.setHeader("content-type","application/json");res.end(JSON.stringify(body))};
    if(req.url==="/"){res.statusCode=200;res.end('<form id="booking-form"></form>');return}
    if(req.url==="/api/houses")return send(200,{houses:[{id:"house1"}]});
    if(req.url==="/api/houses/house1/state")return send(200,{route:{kind:"self-service"},
      resources:[{id:"ph9",name:"pukuhuone 9"}],policy:{eligibleRoles:["tenant"]}});
    let body="";req.on("data",x=>body+=x);req.on("end",()=>{
      const p=JSON.parse(body);send(req.url==="/api/houses/house1/bookings"&&p.resource==="ph9"
        &&p.weekday==="Thursday"&&p.start==="17:00"&&p.role==="tenant"?200:409,{status:"confirmed"})
    });
  }).listen(Number(process.argv[2]),"127.0.0.1")\n`);
  prepareBlindReview({ gradingRoom: apiRoom, out: apiPacket });
  const apiReview = { ...review, answer: "REQUEST: pukuhuone 9 | Thursday | 17:00",
    packet_sha256: JSON.parse(readFileSync(join(apiPacket,
    "response-template.json"))).packet_sha256 };
  const apiReviewFile = join(root, "api-review.json");
  writeFileSync(apiReviewFile, JSON.stringify(apiReview));
  const apiProbe = await probeBlindAnswer({ packetDir: apiPacket, reviewFile: apiReviewFile,
    gradingRoom: apiRoom, request: parsed.request, out: join(root, "api-probe") });
  assert.equal(apiProbe.http_status, 200);
  assert.equal(apiProbe.request.resolved_path, "/api/houses/house1/bookings");
  const workbenchRoom = join(root, "workbench-room"), workbenchPacket = join(root, "workbench-packet");
  cpSync(room, workbenchRoom, { recursive: true });
  writeFileSync(join(workbenchRoom, "impl", "server.js"), `require("http").createServer((req,res)=>{
    const send=(status,body)=>{res.statusCode=status;res.setHeader("content-type","application/json");res.end(JSON.stringify(body))};
    if(req.url==="/"){res.statusCode=200;res.end('<form id="booking-form"></form>');return}
    if(req.url==="/api/houses")return send(200,{houses:[{id:"house2",policy:{route:"self-service",
      resources:[{id:"ph9",name:"pukuhuone 9"}],bookerRoles:["tenant"]}}]});
    let body="";req.on("data",x=>body+=x);req.on("end",()=>{
      const p=JSON.parse(body);send(req.url==="/api/bookings"&&p.house==="house2"
        &&p.resource==="ph9"&&p.weekday==="Thursday"&&p.start==="17:00"
        &&p.role==="tenant"?200:409,{status:"confirmed"})
    });
  }).listen(Number(process.argv[2]),"127.0.0.1")\n`);
  prepareBlindReview({ gradingRoom: workbenchRoom, out: workbenchPacket });
  const workbenchReviewFile = join(root, "workbench-review.json");
  writeFileSync(workbenchReviewFile, JSON.stringify({ ...apiReview,
    packet_sha256: JSON.parse(readFileSync(join(workbenchPacket,
      "response-template.json"))).packet_sha256 }));
  const workbenchProbe = await probeBlindAnswer({ packetDir: workbenchPacket,
    reviewFile: workbenchReviewFile, gradingRoom: workbenchRoom,
    request: parsed.request, out: join(root, "workbench-probe") });
  assert.equal(workbenchProbe.http_status, 200);
  assert.equal(workbenchProbe.request.resolved_path, "/api/bookings");
  const scopedRoom = join(root, "scoped-room"), scopedPacket = join(root, "scoped-packet");
  cpSync(room, scopedRoom, { recursive: true });
  writeFileSync(join(scopedRoom, "impl", "server.js"), `require("http").createServer((req,res)=>{
    const send=(status,body)=>{res.statusCode=status;res.setHeader("content-type","application/json");res.end(JSON.stringify(body))};
    if(req.url==="/"){res.statusCode=200;res.end('<form id="booking-form"></form>');return}
    if(req.url==="/api/houses")return send(200,{houses:[
      {id:"demo",policy:{bookingMode:"self-service",bookerRoles:["resident"],
        resources:[{id:"ph8",name:"pukuhuone 8"}]}},
      {id:"managed",policy:{bookingMode:"manager-mediated",bookerRoles:["shareholder"],
        resources:[{id:"ph8",name:"pukuhuone 8"}]}}]});
    let body="";req.on("data",x=>body+=x);req.on("end",()=>{
      const p=JSON.parse(body);send(req.url==="/api/houses/demo/bookings"
        &&p.resource==="ph8"&&p.weekday==="Tuesday"&&p.start==="17:00"
        &&p.bookerRole==="resident"&&p.actorRole==="resident"?200:409,{status:"confirmed"})
    });
  }).listen(Number(process.argv[2]),"127.0.0.1")\n`);
  prepareBlindReview({ gradingRoom: scopedRoom, out: scopedPacket });
  const scopedReviewFile = join(root, "scoped-review.json");
  writeFileSync(scopedReviewFile, JSON.stringify({ ...apiReview,
    answer: "REQUEST: pukuhuone 8 | Tuesday | 17:00",
    packet_sha256: JSON.parse(readFileSync(join(scopedPacket,
      "response-template.json"))).packet_sha256 }));
  const scopedRequest = parseBlindAgentAnswer("REQUEST: pukuhuone 8 | Tuesday | 17:00",
    "Request pukuhuone 8 on Tuesday at 17:00 instead.").request;
  const scopedProbe = await probeBlindAnswer({ packetDir: scopedPacket,
    reviewFile: scopedReviewFile, gradingRoom: scopedRoom,
    request: scopedRequest, out: join(root, "scoped-probe") });
  assert.equal(scopedProbe.http_status, 200);
  assert.equal(scopedProbe.request.resolved_path, "/api/houses/demo/bookings");
  const arrayRoom = join(root, "array-room"), arrayPacket = join(root, "array-packet");
  cpSync(scopedRoom, arrayRoom, { recursive: true });
  writeFileSync(join(arrayRoom, "impl", "server.js"), `require("http").createServer((req,res)=>{
    const send=(status,body)=>{res.statusCode=status;res.setHeader("content-type","application/json");res.end(JSON.stringify(body))};
    if(req.url==="/"){res.statusCode=200;res.end('<div id="app"></div>');return}
    if(req.url==="/api/houses")return send(200,[
      {id:"demo",policy:{route:"self-service",bookerRoles:["tenant"],
        resources:[{id:"8",name:"pukuhuone 8"}]}},
      {id:"managed",policy:{route:"manager",bookerRoles:["shareholder"],
        resources:[{id:"8",name:"pukuhuone 8"}]}}]);
    let body="";req.on("data",x=>body+=x);req.on("end",()=>{
      const p=JSON.parse(body);send(req.url==="/api/houses/demo/bookings"
        &&p.resource==="8"&&p.weekday==="Tuesday"&&p.start==="17:00"
        &&p.role==="tenant"?200:409,{status:"confirmed"})
    });
  }).listen(Number(process.argv[2]),"127.0.0.1")\n`);
  prepareBlindReview({ gradingRoom: arrayRoom, out: arrayPacket });
  const arrayReviewFile = join(root, "array-review.json");
  writeFileSync(arrayReviewFile, JSON.stringify({ ...apiReview,
    answer: "REQUEST: pukuhuone 8 | Tuesday | 17:00",
    packet_sha256: JSON.parse(readFileSync(join(arrayPacket,
      "response-template.json"))).packet_sha256 }));
  const arrayProbe = await probeBlindAnswer({ packetDir: arrayPacket,
    reviewFile: arrayReviewFile, gradingRoom: arrayRoom,
    request: scopedRequest, out: join(root, "array-probe") });
  assert.equal(arrayProbe.http_status, 200);
  assert.equal(arrayProbe.request.resolved_path, "/api/houses/demo/bookings");
  review.packet_sha256 = "0".repeat(64);
  writeFileSync(reviewFile, JSON.stringify(review));
  assert.throws(() => validateBlindReview({ packetDir, reviewFile, gradingRoom: room }), /unbound/);
  review.packet_sha256 = JSON.parse(readFileSync(join(packetDir, "response-template.json"))).packet_sha256;
  writeFileSync(reviewFile, JSON.stringify(review));
  writeFileSync(specFile, "Feature: Booking core\nScenario: The refusal for a closed day is judged usable\n# changed wording\n");
  assert.throws(() => validateBlindReview({ packetDir, reviewFile, gradingRoom: room }),
    /packet no longer matches/);
  writeFileSync(join(room, "work", "shards", "shard-01", "blind-review-011.txt"), "Different refusal\n");
  assert.throws(() => prepareBlindReview({ gradingRoom: room, out: join(root, "changed-packet") }),
    /differs from the pending Allure refusal attachment/);
});
