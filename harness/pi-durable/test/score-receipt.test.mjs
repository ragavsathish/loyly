import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindScoreInput, scoreCycleFor, verifyScoredCycle } from "../score-receipt.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${program}: ${result.stdout}${result.stderr}`);
}

test("an existing legacy score is reconciled only against its original cut and verdicts", () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-score-receipt-"));
  const instrument = join(scratch, "instrument");
  try {
    run("git", ["clone", "-q", `file://${root}`, instrument], root);
    const cycle = join(instrument, "harness", "cycles", "02");
    rmSync(cycle, { recursive: true, force: true });
    mkdirSync(cycle, { recursive: true });
    const checklistFile = join(scratch, "checklist.json");
    run("bb", ["harness/gen_checklist.clj", "--out", checklistFile], instrument);
    cpSync(checklistFile, join(cycle, "checklist.json"));
    const checklist = JSON.parse(readFileSync(checklistFile, "utf8"));
    const verdictsFile = join(scratch, "verdicts.json");
    const verdicts = checklist.items.map((item) => ({ id: item.id,
      verdict: "pass", evidence: `observed ${item.id}` }));
    writeFileSync(verdictsFile, JSON.stringify(verdicts));
    bindScoreInput({ scratch, sourceRoot: root, instrument,
      candidateSha256: "a".repeat(64), verdictsFile });
    run("bb", ["harness/score.clj", "02", "--verdicts", verdictsFile], instrument);
    assert.equal(verifyScoredCycle({ scratch, instrument, verdictsFile }).score, "11/11");
    const scoresFile = join(cycle, "scores.json");
    const originalScores = readFileSync(scoresFile);
    const tampered = JSON.parse(originalScores);
    tampered.items[0].verdict = "fail";
    writeFileSync(scoresFile, JSON.stringify(tampered));
    assert.throws(() => verifyScoredCycle({ scratch, instrument, verdictsFile }),
      /existing legacy score differs/);
    writeFileSync(scoresFile, originalScores);
    verdicts[0].evidence = "changed after scoring";
    writeFileSync(verdictsFile, JSON.stringify(verdicts));
    assert.throws(() => verifyScoredCycle({ scratch, instrument, verdictsFile }),
      /scored cycle inputs differ/);
    assert.throws(() => bindScoreInput({ scratch, sourceRoot: root, instrument,
      candidateSha256: "b".repeat(64), verdictsFile }), /score input changed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a filed score binds the selected pre-score panel manifest", () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-panel-score-receipt-"));
  const instrument = join(scratch, "instrument");
  try {
    run("git", ["clone", "-q", `file://${root}`, instrument], root);
    const cycle = join(instrument, "harness", "cycles", "02");
    rmSync(cycle, { recursive: true, force: true });
    mkdirSync(cycle, { recursive: true });
    const checklistFile = join(scratch, "checklist.json");
    run("bb", ["harness/gen_checklist.clj", "--out", checklistFile], instrument);
    cpSync(checklistFile, join(cycle, "checklist.json"));
    const verdictsFile = join(scratch, "verdicts.json");
    const verdicts = JSON.parse(readFileSync(checklistFile)).items.map((item) => ({
      id: item.id, verdict: "pass", evidence: `observed ${item.id}` }));
    writeFileSync(verdictsFile, JSON.stringify(verdicts));
    const attempt = join(scratch, "panel-vm", "attempt-01");
    mkdirSync(attempt, { recursive: true });
    const manifest = join(attempt, "manifest.json");
    writeFileSync(manifest, '{"candidate":"frozen"}');
    const digest = createHash("sha256").update(readFileSync(manifest)).digest("hex");
    writeFileSync(join(scratch, "panel-vm", "selected.json"),
      JSON.stringify({ attempt: 1, manifest_sha256: digest }));
    const bound = bindScoreInput({ scratch, sourceRoot: root, instrument,
      candidateSha256: "a".repeat(64), verdictsFile });
    assert.equal(bound.panel_manifest_sha256, digest);
    run("bb", ["harness/score.clj", "02", "--verdicts", verdictsFile], instrument);
    assert.equal(verifyScoredCycle({ scratch, instrument, verdictsFile }).score, "11/11");
    writeFileSync(manifest, '{"candidate":"changed"}');
    assert.throws(() => verifyScoredCycle({ scratch, instrument, verdictsFile }),
      /selected panel manifest changed/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a later product cycle binds its own score directory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "loyly-score-cycle-03-"));
  const instrument = join(scratch, "instrument");
  try {
    run("git", ["clone", "-q", `file://${root}`, instrument], root);
    const cycle = join(instrument, "harness", "cycles", "03");
    mkdirSync(cycle, { recursive: true });
    const checklistFile = join(scratch, "checklist.json");
    run("bb", ["harness/gen_checklist.clj", "--out", checklistFile], instrument);
    cpSync(checklistFile, join(cycle, "checklist.json"));
    const verdictsFile = join(scratch, "verdicts.json");
    writeFileSync(verdictsFile, JSON.stringify(JSON.parse(readFileSync(checklistFile)).items
      .map((item) => ({ id: item.id, verdict: "pass", evidence: `observed ${item.id}` }))));
    const input = bindScoreInput({ scratch, sourceRoot: root, instrument,
      candidateSha256: "c".repeat(64), verdictsFile, scoreCycle: "03" });
    assert.equal(input.score_cycle, "03");
    assert.equal(scoreCycleFor(scratch), "03");
    run("bb", ["harness/score.clj", "03", "--verdicts", verdictsFile], instrument);
    assert.equal(verifyScoredCycle({ scratch, instrument, verdictsFile, cycle: "03" }).score, "11/11");
    assert.throws(() => verifyScoredCycle({ scratch, instrument, verdictsFile }),
      /scored cycle inputs differ/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
