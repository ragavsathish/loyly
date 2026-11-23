// Fresh Pi process adapter for the one refusal review. Only the two blind text files
// are in the room. The builder host's launch receipt supplies process provenance.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runBuilder } from "./builder-adapter.ts";
import { verifyBlindReviewPacket } from "./blind-review.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
const DAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const REQUEST = new RegExp(`^REQUEST:\\s*pukuhuone\\s+(\\d+)\\s*\\|\\s*(${DAYS})\\s*\\|\\s*(\\d{2}:\\d{2})$`, "i");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fields = (path) => Object.fromEntries(readFileSync(path, "utf8").trim().split("\n")
  .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));

export function prepareBlindAgentRoom({ packetDir, out }) {
  const names = ["question.txt", "refusal.txt"];
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    for (const name of names) cpSync(join(packetDir, name), join(out, name));
  }
  if (readdirSync(out).sort().join() !== names.join()
      || names.some((name) => !lstatSync(join(out, name)).isFile()
        || !readFileSync(join(out, name)).equals(readFileSync(join(packetDir, name)))))
    throw new Error("blind agent room contains more than the exact refusal and question");
  return { roomSha256: hash(names.map((name) => `${name}\0${fileHash(join(out, name))}`).join("\0")) };
}

export function parseBlindAgentAnswer(answer, refusal) {
  const line = answer.trim();
  const unusable = /^UNUSABLE:\s*(.{3,500})$/i.exec(line);
  if (unusable) return { verdict: "fail", reason: unusable[1], request: null };
  const match = REQUEST.exec(line);
  if (!match) throw new Error("blind agent answer did not use REQUEST or UNUSABLE format");
  const [, number, weekdayRaw, start] = match;
  const weekday = weekdayRaw[0].toUpperCase() + weekdayRaw.slice(1).toLowerCase();
  const validTime = (value) => Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59;
  if (!validTime(start)
      || !new RegExp(`pukuhuone\\s*${escape(number)}\\b`, "i").test(refusal)
      || !new RegExp(`\\b${escape(weekday)}\\b`, "i").test(refusal)
      || !refusal.includes(start))
    throw new Error("blind agent named a room, day or start time absent from the refusal");
  return { verdict: "pass", reason: "The fresh agent named a request from the refusal; HTTP confirmation follows.",
    request: { method: "POST", path: "@booking-form",
      body: new URLSearchParams({ household: "12", resource: `@room:${number}`,
        weekday, start }).toString(), matches_answer: true } };
}

export async function runBlindAgent({ packetDir, gradingRoom, room, instruction, command,
  image, settings, model, evidenceDir, stateRoot, sessionId,
  instructionSha256, commandSha256, imageSha256, settingsSha256,
  launch = runBuilder }) {
  const { packet, packetSha256 } = verifyBlindReviewPacket({ packetDir, gradingRoom });
  for (const [path, expected] of [[instruction, instructionSha256], [command, commandSha256],
    [join(image, "manifest.json"), imageSha256], [settings, settingsSha256]])
    if (fileHash(path) !== expected) throw new Error(`blind agent input digest differs: ${path}`);
  const selectedTools = JSON.parse(readFileSync(settings, "utf8")).defaultTools;
  if (JSON.stringify(selectedTools) !== JSON.stringify(["read"]))
    throw new Error("blind agent may receive only the read tool");
  const { roomSha256 } = prepareBlindAgentRoom({ packetDir, out: room });
  const result = await launch({ command, room, instruction, image, evidenceDir, sessionId,
    model, stateRoot, piSettings: settings, roomLabel: "the blind refusal review room",
    prompt: "Read the two room files and answer in the required one-line format." });
  if (result.exit !== 0) throw new Error(`blind agent process exited ${result.exit}`);
  const receipt = fields(result.receipt);
  if (receipt.session_id !== sessionId || receipt.model !== model
      || receipt.room !== room || receipt.instruction_sha256 !== instructionSha256
      || receipt.pi_settings_sha256 !== settingsSha256
      || receipt.image_manifest_sha256 !== imageSha256)
    throw new Error("blind agent launch receipt differs from pinned inputs");
  if (prepareBlindAgentRoom({ packetDir, out: room }).roomSha256 !== roomSha256)
    throw new Error("blind agent room changed during review");
  const stdout = join(dirname(result.receipt), "pi.stdout");
  const answer = readFileSync(stdout, "utf8").trim();
  const parsed = parseBlindAgentAnswer(answer, readFileSync(join(packetDir, "refusal.txt"), "utf8"));
  return { review: { schema: "loyly.blind-review-response.v1", packet_sha256: packetSha256,
    reviewer_kind: "agent", reviewer: `Pi ${model} session ${sessionId}`,
    had_not_read_configuration: true, saw_only_refusal: true,
    answer, verdict: parsed.verdict, reason: parsed.reason, reviewed_at: Date.now(),
    launch_receipt_sha256: fileHash(result.receipt), agent_output_sha256: fileHash(stdout),
    blind_room_sha256: roomSha256 },
    request: parsed.request, reconciled: result.reconciled, launchReceipt: result.receipt,
    candidateSha256: packet.candidate_sha256 };
}
