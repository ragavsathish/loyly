import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateDigest, checkReassessment } from "../reassessment.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = (path) => ({ path, sha256: sha(readFileSync(path)) });
const write = (path, data) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
};
const git = (repo, ...args) => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("reassessment pins original candidate, score and every failed item", () => {
  const root = mkdtempSync(join(tmpdir(), "loyly-reassess-"));
  const cycle = join(root, "harness/cycles/04");
  const impl = join(cycle, "candidate/impl");
  const spec = join(
    cycle,
    "grading-room/plan/02-occurrence-release/spec.feature",
  );
  const checklist = {
    items: [
      {
        id: "02-001",
        name: "first",
        rule: "R",
        source: "docs/plan/02-occurrence-release/spec.feature:2",
      },
      {
        id: "02-002",
        name: "second",
        rule: "R",
        source: "docs/plan/02-occurrence-release/spec.feature:5",
      },
    ],
  };
  write(join(impl, "start.sh"), "#!/bin/sh\nexit 0\n");
  write(
    spec,
    "Feature: Occurrence release\n  @item-02-001\n  Scenario: first\n  @item-02-002\n  Scenario: second\n",
  );
  write(join(cycle, "checklist.json"), JSON.stringify(checklist));
  write(
    join(cycle, "scores.json"),
    JSON.stringify({
      items: [
        { ...checklist.items[0], verdict: "pass", evidence: "observed" },
        { ...checklist.items[1], verdict: "fail", evidence: "not reached" },
      ],
    }),
  );
  const sourceCommit = "1".repeat(40);
  write(
    join(cycle, "run-contract.json"),
    JSON.stringify({
      source: { commit: sourceCommit },
      agents: { builder: { model: "builder" } },
    }),
  );
  const selectedFile = join(root, "selected.json");
  write(selectedFile, JSON.stringify({ items: [checklist.items[1]] }));
  const instruction = join(root, "grader.md"),
    wrapper = join(root, "preamble.md");
  const panel = join(root, "panel.json"),
    manifest = join(root, "manifest.json");
  const schema = join(root, "allure.json");
  write(instruction, "grade independently\n");
  write(wrapper, "use private VMs\n");
  write(
    panel,
    JSON.stringify({
      checks: [
        {
          id: "raw",
          source: "raw-grader",
          role: "scored",
          tool: "Codex black-box grader",
          items: ["02-002"],
        },
      ],
    }),
  );
  write(manifest, "{}\n");
  write(schema, "{}\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  const contract = {
    schema: "loyly.codex-grader-reassessment.v1",
    controllerCommit: git(root, "rev-parse", "HEAD"),
    reassessmentId: "targeted-04-01",
    output: join(root, "reassessment-output"),
    original: {
      cycleDir: cycle,
      sourceCommit,
      builderModel: "builder",
      candidateSha256: candidateDigest(impl),
      scoreSha256: pin(join(cycle, "scores.json")).sha256,
      checklistSha256: pin(join(cycle, "checklist.json")).sha256,
      runContractSha256: pin(join(cycle, "run-contract.json")).sha256,
    },
    selection: {
      itemIds: ["02-002"],
      checklist: pin(selectedFile),
      specs: [pin(spec)],
    },
    grader: {
      model: "grader",
      instruction: pin(instruction),
      wrapper: pin(wrapper),
    },
    execution: {
      engine: "codex-subagent",
      runtime: "gondolin-qemu-vm",
      graderImageManifest: pin(manifest),
      allureSchema: pin(schema),
      panelPlan: pin(panel),
    },
  };
  assert.deepEqual(checkReassessment(contract, root).selectedItemIds, [
    "02-002",
  ]);
  assert.throws(
    () =>
      checkReassessment(
        {
          ...contract,
          selection: { ...contract.selection, itemIds: ["02-001"] },
        },
        root,
      ),
    /exactly the original failed items/,
  );
  write(join(impl, "start.sh"), "#!/bin/sh\nexit 1\n");
  assert.throws(() => checkReassessment(contract, root), /controller differs/);
  // Commit the mutation to prove the candidate pin is checked independently of cleanliness.
  git(root, "add", ".");
  git(root, "commit", "-qm", "mutated candidate");
  const changedHead = {
    ...contract,
    controllerCommit: git(root, "rev-parse", "HEAD"),
  };
  assert.throws(
    () => checkReassessment(changedHead, root),
    /candidate differs/,
  );
  write(join(cycle, "scores.json"), "{}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "mutated score");
  assert.throws(
    () =>
      checkReassessment(
        { ...changedHead, controllerCommit: git(root, "rev-parse", "HEAD") },
        root,
      ),
    /scores.json differs/,
  );
});
