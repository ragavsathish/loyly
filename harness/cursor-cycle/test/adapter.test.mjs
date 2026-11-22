import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkCandidateCaches,
  checkContract,
  checkEvidence,
  decideAttempt,
} from "../adapter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = resolve(
  HERE,
  "../../pi-durable/Dockerfile.panel-multistack",
);
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const pinned = (path) => ({ path, sha256: hash(path) });
const run = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function fixtureSource() {
  const repo = mkdtempSync(join(tmpdir(), "loyly-cursor-source-"));
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
  return { repo, spec, checklist };
}

test("candidate cache guard blocks a nested npm cache before grading", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-cursor-cache-"));
  mkdirSync(join(room, "impl", "service"), { recursive: true });
  writeFileSync(join(room, "impl", "service", "start.sh"), "#!/bin/sh\n");
  assert.equal(checkCandidateCaches(room).cacheFree, true);
  mkdirSync(join(room, "impl", "service", ".npm-cache"));
  writeFileSync(
    join(room, "impl", "service", ".npm-cache", "tarball"),
    "cached bytes",
  );
  assert.throws(
    () => checkCandidateCaches(room),
    /disposable package cache.*\.npm-cache/,
  );
  rmSync(room, { recursive: true, force: true });
});

test("remote-session contracts omit Docker pins", () => {
  const { repo, spec, checklist } = fixtureSource();
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
          tool: "Cursor black-box grader",
          items: ["01-001"],
          target_runtime: "cursor-remote-session",
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
    schema: "loyly.cursor-subagent-cycle.v1",
    controllerCommit: run(repo, "rev-parse", "HEAD"),
    runId: "cursor-test-01",
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
      builderEngine: "cursor-cloud-agent",
      builderRuntime: "cursor-remote-session",
      graderEngine: "cursor-cloud-agent",
      graderRuntime: "cursor-remote-session",
      blindEngine: "cursor-cloud-agent",
      blindProbeRuntime: "cursor-remote-session",
      allureSchema: pinned(wrapper),
      panelPlan: pinned(panelFile),
    },
  };
  assert.equal(checkContract(contract, repo).probeRuntime, "cursor-remote-session");
  contract.execution.dockerImage = pinned(wrapper);
  assert.throws(
    () => checkContract(contract, repo),
    /does not pin a Docker image/,
  );
  rmSync(repo, { recursive: true, force: true });
});

test("host contracts require Dockerfile.panel-multistack and a docker image pin", () => {
  const { repo, spec, checklist } = fixtureSource();
  const instruction = join(repo, "..", `instruction-${randomUUID()}.md`);
  const wrapper = join(repo, "..", `wrapper-${randomUUID()}.md`);
  const image = join(repo, "..", `image-${randomUUID()}.txt`);
  writeFileSync(instruction, "do the work");
  writeFileSync(wrapper, "use the selected model");
  writeFileSync(image, "sha256:deadbeef");
  const panelFile = join(repo, "..", `panel-${randomUUID()}.json`);
  writeFileSync(
    panelFile,
    JSON.stringify({
      checks: [
        {
          id: "raw",
          source: "raw-grader",
          role: "scored",
          tool: "Cursor black-box grader",
          items: ["01-001"],
          target_runtime: "docker",
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
    schema: "loyly.cursor-subagent-cycle.v1",
    controllerCommit: run(repo, "rev-parse", "HEAD"),
    runId: "cursor-host-01",
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
      builderEngine: "cursor-cloud-agent",
      builderRuntime: "host",
      graderEngine: "cursor-cloud-agent",
      graderRuntime: "docker",
      blindEngine: "cursor-cloud-agent",
      blindProbeRuntime: "docker",
      dockerfile: pinned(DOCKERFILE),
      dockerImage: pinned(image),
      allureSchema: pinned(wrapper),
      panelPlan: pinned(panelFile),
    },
  };
  const report = checkContract(contract, repo);
  assert.equal(report.probeRuntime, "docker");
  assert.equal(report.dockerfile.path, DOCKERFILE);
  delete contract.execution.dockerImage;
  assert.throws(() => checkContract(contract, repo), /docker image digest/);
  rmSync(repo, { recursive: true, force: true });
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
});

test("raw Cursor Allure and final verdict must agree", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-cursor-evidence-"));
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
  writeFileSync(
    join(dir, `${uuid}-result.json`),
    JSON.stringify({
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
        { name: "tool", value: "Cursor black-box grader" },
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
    }),
  );
  const files = { checklist, verdicts, surprises, room, rawAllureDirs: [dir] };
  assert.equal(checkEvidence(files).passed, 1);
  rmSync(room, { recursive: true, force: true });
});
