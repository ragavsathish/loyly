import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindScoreInput, verifyScoredCycle } from "../score-receipt.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
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
