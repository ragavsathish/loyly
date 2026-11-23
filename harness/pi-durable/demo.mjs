// One-command, throwaway crash/retry/replay demonstration.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

function run(dir, mode, killOnBuilder = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["worker.mjs", dir, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "", killed = false;
    const collect = (chunk) => {
      const s = String(chunk); text += s; process.stdout.write(s);
      if (killOnBuilder && !killed && text.includes("build started attempt 1")) {
        killed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code, signal) => resolveRun({ code, signal, killed, text }));
  });
}
const audit = (dir) => readFileSync(`${dir}/audit.v1.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
function checkRepair(rows) {
  assert.equal(rows.filter((r) => r.stage === "gate" && r.outcome === "failed").length, 1);
  assert.equal(rows.filter((r) => r.stage === "gate" && r.outcome === "passed").length, 1);
  assert.equal(rows.filter((r) => r.stage === "repair" && r.outcome === "started").length, 1);
  for (const s of ["self-check", "fence", "checklist", "render", "builder-continuation", "grading-room", "grade", "score", "scoreboard"])
    assert.ok(rows.some((r) => r.stage === s), `missing ${s}`);
}
function checkThreeRed(rows) {
  assert.deepEqual(rows.filter((r) => r.stage === "gate").map((r) => [r.attempt, r.outcome]),
    [[1, "failed"], [2, "failed"], [3, "failed"]]);
  assert.equal(rows.filter((r) => r.stage === "retry").length, 2);
  assert.ok(!rows.some((r) => r.stage === "grade" || r.stage === "score"));
  assert.ok(rows.some((r) => r.stage === "cycle" && r.reason === "gate-attempts-exhausted"));
}

const repaired = await run("scratch", "repair");
assert.equal(repaired.code, 0, "repaired cycle process did not finish");
const threeRed = await run("scratch-three-red", "three-red");
assert.equal(threeRed.code, 0, "three-red cycle process did not finish");
const crashed = await run("scratch-crash", "three-red", true);
if (crashed.killed) {
  assert.equal(crashed.signal, "SIGKILL");
  const resumed = await run("scratch-crash", "three-red");
  assert.equal(resumed.code, 0, "resumed cycle process did not finish");
}
await new Promise((resolveExport, reject) => {
  const child = spawn(process.execPath, ["export.mjs", "scratch", "scratch-three-red", "scratch-crash"], { stdio: "inherit" });
  child.on("error", reject); child.on("close", (code) => code === 0 ? resolveExport() : reject(new Error(`export exit ${code}`)));
});
checkRepair(audit("scratch"));
checkThreeRed(audit("scratch-three-red"));
checkThreeRed(audit("scratch-crash"));
assert.equal(audit("scratch-crash").filter((r) => r.stage === "build" && r.outcome === "started" && r.attempt === 1).length, 1);
console.log(`PROTOTYPE PASS: real legacy stages, bounded repair, three failures, crash/resume, and stored-entry replay. Open ${resolve("replay.PROTOTYPE.html")}`);
