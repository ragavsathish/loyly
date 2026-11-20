// Reconcile the legacy gate's external process from its own durable receipt.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = fileURLToPath(new URL("./gate-host.sh", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fields(path) {
  return Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((line) => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function live(pid) {
  if (!/^\d+$/.test(pid ?? "")) return false;
  const r = spawnSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("gate-host.sh");
}
function gateSpec({ profile = "booking-core", instrumentRoot, instrumentCommit, slice = "06" }) {
  if (profile === "booking-core") return { profile, instrumentRoot: "", instrumentCommit: "", slice: "" };
  if (profile !== "spec-v2" || !isAbsolute(instrumentRoot ?? "")
      || !/^[0-9a-f]{40}$/.test(instrumentCommit ?? "") || !/^\d\d$/.test(slice))
    throw new Error("spec-v2 gate needs an absolute pinned instrument and two-digit slice");
  const head = spawnSync("git", ["-C", instrumentRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", instrumentRoot, "status", "--porcelain"], { encoding: "utf8" });
  if (head.status !== 0 || head.stdout.trim() !== instrumentCommit
      || status.status !== 0 || status.stdout.trim()
      || !existsSync(join(instrumentRoot, "harness", "v2", "gate.sh")))
    throw new Error("spec-v2 gate instrument is dirty, missing or at another commit");
  return { profile, instrumentRoot, instrumentCommit, slice };
}
function receipt(out, room, candidateSha256, gate) {
  const path = join(out, "receipt.txt");
  if (!existsSync(path)) return null;
  const result = fields(path);
  if (result.room !== room || result.candidate_sha256 !== candidateSha256
      || (result.gate_profile ?? "booking-core") !== gate.profile
      || (result.instrument_root ?? "") !== gate.instrumentRoot
      || (result.instrument_commit ?? "") !== gate.instrumentCommit
      || (result.slice ?? "") !== gate.slice
      || !/^\d+$/.test(result.exit ?? "")
      || !/^[0-9a-f]{64}$/.test(result.log_sha256 ?? "")
      || result.log_sha256 !== hash(readFileSync(join(out, "gate.log"))))
    throw new Error("gate receipt does not match room, candidate or log");
  return { exit: Number(result.exit), logSha256: result.log_sha256, receipt: path };
}
export async function runGate({ room, out, candidateSha256, timeoutMs = 3_600_000,
  profile = "booking-core", instrumentRoot, instrumentCommit, slice = "06" }) {
  if (!isAbsolute(room) || !isAbsolute(out) || !/^[0-9a-f]{64}$/.test(candidateSha256))
    throw new Error("gate needs absolute paths and a candidate SHA-256");
  const gate = gateSpec({ profile, instrumentRoot, instrumentCommit, slice });
  if (profile === "booking-core" && !existsSync(join(room, "harness", "verify.sh")))
    throw new Error("legacy gate missing");
  mkdirSync(out, { recursive: true });
  let done = receipt(out, room, candidateSha256, gate);
  if (done) return { ...done, reconciled: true };
  const intent = join(out, "intent.json"), running = join(out, "running.txt");
  if (existsSync(intent)) {
    const recorded = JSON.parse(readFileSync(intent, "utf8"));
    if (recorded.room !== room || recorded.candidateSha256 !== candidateSha256
        || (recorded.gateProfile ?? "booking-core") !== gate.profile
        || (recorded.instrumentRoot ?? "") !== gate.instrumentRoot
        || (recorded.instrumentCommit ?? "") !== gate.instrumentCommit
        || (recorded.slice ?? "") !== gate.slice)
      throw new Error("gate intent differs from candidate");
    for (let n = 0; n < 100 && !existsSync(running); n++) await pause(50);
    if (!existsSync(running)) throw new Error("gate launch was interrupted before process receipt");
    const started = fields(running);
    if (started.room !== room || started.candidate_sha256 !== candidateSha256
        || (started.gate_profile ?? "booking-core") !== gate.profile
        || (started.instrument_root ?? "") !== gate.instrumentRoot
        || (started.instrument_commit ?? "") !== gate.instrumentCommit
        || (started.slice ?? "") !== gate.slice)
      throw new Error("gate running receipt differs from candidate");
    const began = Date.now();
    while (live(started.pid)) {
      done = receipt(out, room, candidateSha256, gate);
      if (done) return { ...done, reconciled: true };
      if (Date.now() - began > timeoutMs) throw new Error("surviving gate exceeded deadline");
      await pause(250);
    }
    done = receipt(out, room, candidateSha256, gate);
    if (done) return { ...done, reconciled: true };
    throw new Error("gate process ended without a receipt; discard its gate room and retry separately");
  }
  writeFileSync(intent, JSON.stringify({ room, candidateSha256,
    gateProfile: gate.profile, instrumentRoot: gate.instrumentRoot,
    instrumentCommit: gate.instrumentCommit, slice: gate.slice }), { flag: "wx" });
  const child = spawn(HOST, [room, out, candidateSha256,
    gate.profile, gate.instrumentRoot, gate.instrumentCommit, gate.slice], {
    cwd: room, detached: true, stdio: "ignore",
    env: { ...process.env, ...(profile === "spec-v2"
      ? { PI_HARNESS_STATE_ROOT: join(out, "state") } : {}) },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (live(child.pid)) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
      setTimeout(() => {
        if (live(child.pid)) try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
      }, 5000).unref();
    }
  }, timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (timedOut) throw new Error("gate exceeded deadline");
    done = receipt(out, room, candidateSha256, gate);
    if (!done) throw new Error("gate exited without a receipt");
    return { ...done, reconciled: false };
  } finally { clearTimeout(timer); }
}
