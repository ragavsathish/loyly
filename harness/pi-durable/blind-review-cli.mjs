import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { prepareBlindReview, probeBlindAnswer, writeBlindAgentAllure } from "./blind-review.ts";

const [action, ...paths] = process.argv.slice(2);
if (action === "prepare" && paths.length === 2) {
  const packet = prepareBlindReview({ gradingRoom: resolve(paths[0]), out: resolve(paths[1]) });
  console.log(JSON.stringify(packet));
} else if (action === "probe" && paths.length === 5) {
  const verification = await probeBlindAnswer({ packetDir: resolve(paths[0]),
    reviewFile: resolve(paths[1]), gradingRoom: resolve(paths[2]),
    request: JSON.parse(readFileSync(resolve(paths[3]), "utf8")), out: resolve(paths[4]) });
  console.log(JSON.stringify(verification));
} else if (action === "file" && paths.length === 5) {
  const result = writeBlindAgentAllure({ packetDir: resolve(paths[0]), reviewFile: resolve(paths[1]),
    gradingRoom: resolve(paths[2]), verificationDir: resolve(paths[3]), out: resolve(paths[4]) });
  console.log(JSON.stringify({ status: result.result.status, packetSha256: result.packetSha256,
    reviewSha256: result.reviewSha256 }));
} else {
  console.error("usage: node blind-review-cli.mjs prepare <grading-room> <packet-dir>\n"
    + "   or: node blind-review-cli.mjs probe <packet-dir> <review.json> <grading-room> <request.json> <probe-dir>\n"
    + "   or: node blind-review-cli.mjs file <packet-dir> <review.json> <grading-room> <probe-dir> <blind-agent-allure-dir>");
  process.exitCode = 2;
}
