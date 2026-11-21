import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCandidateCaches, checkContract, checkEvidence, decideAttempt } from "../adapter.ts";

const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const pinned = (path) => ({ path, sha256: hash(path) });
const run = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("candidate cache guard blocks a nested npm cache before grading", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-codex-cache-"));
  mkdirSync(join(room, "impl", "service"), { recursive: true });
  writeFileSync(join(room, "impl", "service", "start.sh"), "#!/bin/sh\n");
  assert.equal(checkCandidateCaches(room).cacheFree, true);
  mkdirSync(join(room, "impl", "service", ".npm-cache"));
  writeFileSync(join(room, "impl", "service", ".npm-cache", "tarball"), "cached bytes");
  assert.throws(() => checkCandidateCaches(room), /disposable package cache.*\.npm-cache/);
  assert.throws(() => checkCandidateCaches(room, "post-gate"), /disposable package cache.*\.npm-cache/);
  rmSync(join(room, "impl", "service", ".npm-cache"), { recursive: true });
  mkdirSync(join(room, "impl", "service", "node_modules"));
  writeFileSync(join(room, "impl", "service", "node_modules", "package"), "installed dependency");
  assert.throws(() => checkCandidateCaches(room), /disposable package cache.*node_modules/);
  assert.equal(checkCandidateCaches(room, "post-gate").cacheFree, true);
  mkdirSync(join(room, "impl", "service", "node_modules", ".cache"));
  assert.throws(() => checkCandidateCaches(room, "post-gate"), /disposable package cache.*\.cache/);
});

test("pinned source and subagent inputs must stay byte identical", () => {
  const repo = mkdtempSync(join(tmpdir(), "loyly-codex-source-"));
  run(repo, "init", "-q");
  run(repo, "config", "user.name", "Test");
  run(repo, "config", "user.email", "test@example.invalid");
  const spec = join(repo, "docs/plan/01-booking-core/spec.feature");
  mkdirSync(join(repo, "docs/plan/01-booking-core"), { recursive: true });
  writeFileSync(
    spec,
    "Feature: Booking core\n  @item-01-001\n  Scenario: One\n",
  );
  const checklist = join(repo, "checklist.json");
  writeFileSync(
    checklist,
    JSON.stringify({
      items: [
        { id: "01-001", source: "docs/plan/01-booking-core/spec.feature:3" },
      ],
    }),
  );
  mkdirSync(join(repo, "harness"), { recursive: true });
  writeFileSync(
    join(repo, "harness/gen_checklist.clj"),
    '(spit (second *command-line-args*) (slurp "checklist.json"))\n',
  );
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "fixture");
  const instruction = join(repo, "..", `instruction-${randomUUID()}.md`);
  const wrapper = join(repo, "..", `wrapper-${randomUUID()}.md`);
  writeFileSync(instruction, "do the work");
  writeFileSync(wrapper, "use the selected model");
  const panelFile = join(repo, "..", `panel-${randomUUID()}.json`);
  writeFileSync(
    panelFile,
    JSON.stringify({
      checks: [
        {
          id: "raw",
          source: "raw-grader",
          role: "scored",
          tool: "Codex black-box grader",
          items: ["01-001"],
        },
      ],
    }),
  );
  const agent = (model) => ({
    model,
    instruction: pinned(instruction),
    wrapper: pinned(wrapper),
  });
  const contract = {
    schema: "loyly.codex-subagent-cycle.v1",
    controllerCommit: run(repo, "rev-parse", "HEAD"),
    runId: "codex-test-01",
    scoreCycle: "04",
    scratch: join(repo, "scratch"),
    source: {
      repo,
      commit: run(repo, "rev-parse", "HEAD"),
      checklist: pinned(checklist),
      itemIds: ["01-001"],
      specs: [pinned(spec)],
    },
    agents: { builder: agent("builder"), grader: agent("grader") },
    execution: {
      builderEngine: "codex-subagent",
      builderRuntime: "host",
      graderEngine: "codex-subagent",
      graderRuntime: "gondolin-qemu-vm",
      blindEngine: "codex-subagent",
      blindProbeRuntime: "gondolin-qemu-vm",
      graderImageManifest: pinned(wrapper),
      allureSchema: pinned(wrapper),
      panelPlan: pinned(panelFile),
    },
  };
  assert.equal(checkContract(contract, repo).itemIds.length, 1);
  writeFileSync(instruction, "changed");
  assert.throws(() => checkContract(contract, repo), /approved file differs/);
});

test("core decisions bound the gate retry to three attempts", () => {
  assert.deepEqual(
    decideAttempt(
      1,
      { status: "completed" },
      { status: "completed", result: { passed: false, log: "/gate.log" } },
    ).afterGate,
    { phase: "build", attempt: 2, retry: "gate", failureLog: "/gate.log" },
  );
  assert.deepEqual(
    decideAttempt(
      3,
      { status: "completed" },
      { status: "completed", result: { passed: false } },
    ).afterGate,
    {
      terminal: true,
      reason: "gate-attempts-exhausted",
      exhausted: true,
      attempt: 3,
    },
  );
});

test("raw Codex Allure and final verdict must agree", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-codex-evidence-"));
  const dir = join(room, "work/allure-results");
  mkdirSync(dir, { recursive: true });
  const checklist = join(room, "checklist.json");
  const verdicts = join(room, "verdicts.json");
  const surprises = join(room, "work/surprises.json");
  writeFileSync(checklist, JSON.stringify({ items: [{ id: "01-001" }] }));
  writeFileSync(
    verdicts,
    JSON.stringify([
      { id: "01-001", verdict: "pass", evidence: "HTTP observed" },
    ]),
  );
  writeFileSync(surprises, "[]");
  const uuid = randomUUID();
  writeFileSync(join(dir, `${uuid}-attachment.txt`), "HTTP 200");
  const result = {
    uuid,
    name: "One booking",
    status: "passed",
    stage: "finished",
    statusDetails: { message: "HTTP observed" },
    start: 1,
    stop: 2,
    labels: [
      { name: "lifecycle", value: "pre-production" },
      { name: "technique", value: "acceptance" },
      { name: "tool", value: "Codex black-box grader" },
      { name: "tag", value: "@item-01-001" },
    ],
    steps: [{ name: "Request", status: "passed", stage: "finished" }],
    attachments: [
      {
        name: "response",
        source: `${uuid}-attachment.txt`,
        type: "text/plain",
      },
    ],
  };
  writeFileSync(join(dir, `${uuid}-result.json`), JSON.stringify(result));
  const files = { checklist, verdicts, surprises, room, rawAllureDirs: [dir] };
  assert.equal(checkEvidence(files).passed, 1);
  writeFileSync(
    verdicts,
    JSON.stringify([
      { id: "01-001", verdict: "fail", evidence: "HTTP observed" },
    ]),
  );
  assert.throws(() => checkEvidence(files), /verdict differs/);
});

test("booking refusal stays pending until one blind result resolves it", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-codex-blind-"));
  const raw = join(room, "work/allure-results");
  const blind = join(room, "blind-allure");
  mkdirSync(raw, { recursive: true });
  mkdirSync(blind);
  const checklist = join(room, "checklist.json");
  const verdicts = join(room, "verdicts.json");
  const surprises = join(room, "work/surprises.json");
  writeFileSync(checklist, JSON.stringify({ items: [{ id: "01-011" }] }));
  writeFileSync(
    verdicts,
    JSON.stringify([
      { id: "01-011", verdict: "pass", evidence: "blind request confirmed" },
    ]),
  );
  writeFileSync(surprises, "[]");
  const rawId = randomUUID();
  const result = (uuid, status, tool) => ({
    uuid,
    name: "Actionable refusal",
    status,
    stage: status === "skipped" ? "pending" : "finished",
    statusDetails: {
      message:
        status === "skipped"
          ? "not reached: blind subagent review required"
          : "request confirmed",
    },
    start: 1,
    stop: 2,
    labels: [
      { name: "lifecycle", value: "pre-production" },
      { name: "technique", value: "usability" },
      { name: "tool", value: tool },
      { name: "tag", value: "@item-01-011" },
    ],
    steps: [{ name: "Observe refusal", status, stage: "finished" }],
    attachments: [
      { name: "refusal", source: `${uuid}-attachment.txt`, type: "text/plain" },
    ],
  });
  writeFileSync(join(raw, `${rawId}-attachment.txt`), "refusal text");
  const rawFile = join(raw, `${rawId}-result.json`);
  writeFileSync(
    rawFile,
    JSON.stringify(result(rawId, "passed", "Codex black-box grader")),
  );
  const files = {
    checklist,
    verdicts,
    surprises,
    room,
    rawAllureDirs: [raw],
    blindAllureDir: blind,
  };
  assert.throws(() => checkEvidence(files), /must remain pending/);
  writeFileSync(
    rawFile,
    JSON.stringify(result(rawId, "skipped", "Codex black-box grader")),
  );
  assert.throws(() => checkEvidence(files), /exactly one blind/);
  const blindId = randomUUID();
  writeFileSync(
    join(blind, `${blindId}-attachment.txt`),
    "confirmed HTTP response",
  );
  writeFileSync(
    join(blind, `${blindId}-result.json`),
    JSON.stringify(result(blindId, "passed", "fresh blind subagent")),
  );
  assert.equal(checkEvidence(files).passed, 1);
});
