import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateVerdicts } from "../validate-verdicts.ts";

test("verdicts preserve the approved denominator and reserve blind review", () => {
  const room = mkdtempSync(join(tmpdir(), "loyly-verdicts-"));
  mkdirSync(join(room, "work"));
  const ids = Array.from({ length: 11 }, (_, i) => `01-${String(i + 1).padStart(3, "0")}`);
  writeFileSync(join(room, "checklist.json"), JSON.stringify({ items: ids.map((id) => ({ id })) }));
  const verdicts = ids.map((id) => ({ id, verdict: id === "01-011" ? "fail" : "pass",
    evidence: id === "01-011" ? "not reached: blind subagent review required" : "Observed request and response" }));
  const file = join(room, "work", "verdicts.json");
  writeFileSync(file, JSON.stringify(verdicts));
  writeFileSync(join(room, "work", "surprises.json"), "[]");
  writeFileSync(join(room, "work", "blind-review-011.txt"), "Try Thursday in room 9.\n");
  assert.equal(validateVerdicts(room).pass, 10);
  verdicts[10].verdict = "pass";
  writeFileSync(file, JSON.stringify(verdicts));
  assert.throws(() => validateVerdicts(room), /blind subagent review/);
  verdicts[10].verdict = "fail";
  verdicts[0].id = "01-002";
  writeFileSync(file, JSON.stringify(verdicts));
  assert.throws(() => validateVerdicts(room), /invalid verdict/);
});
