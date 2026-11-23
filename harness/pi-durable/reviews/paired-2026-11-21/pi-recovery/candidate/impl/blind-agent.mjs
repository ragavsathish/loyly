// A fresh, tool-free local language-model agent. It deliberately imports no
// product code, schedule, policy, example request, or prior transcript.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Llama } from "@hpcc-js/wasm-llama";
const require = createRequire(import.meta.url);
const prompt = JSON.parse(fs.readFileSync(0, "utf8"));
if (
  Object.keys(prompt).sort().join(",") !== "question,refusal" ||
  typeof prompt.question !== "string" ||
  typeof prompt.refusal !== "string"
) {
  throw Error("The blind agent accepts only the exact refusal and question");
}
const parts = [];
for (let i = 1; i <= 5; i++) {
  const pkg = require.resolve(`tripilot-model-qwen-part-${i}/package.json`);
  parts.push(
    fs.readFileSync(new URL("artifacts/weights.part", "file://" + pkg)),
  );
}
const model = Buffer.concat(parts);
const sha256 = createHash("sha256").update(model).digest("hex");
if (
  sha256 !== "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a"
) {
  throw Error("Unrecognized model weights; refusing an unpinned judge");
}
const llama = await Llama.load();
// The engine sees only a virtual model file and these input tokens. There are
// no tool callbacks, system instructions, conversation history or network calls.
const input = `<|im_start|>user\n${prompt.refusal}\n\n${prompt.question}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
const result = llama.main(
  [
    "--log-disable",
    "--no-conversation",
    "--no-display-prompt",
    "--temp",
    "0",
    "--seed",
    "42",
    "-t",
    "1",
    "-tb",
    "1",
    "-c",
    "1024",
    "-b",
    "128",
    "-n",
    "160",
    "-p",
    input,
  ],
  model,
);
if (result.exitCode !== 0) throw Error(result.stderr || "Inference failed");
const raw = result.stdout;
// Decode, but never repair, supply defaults, retry, or guess missing fields.
const objects = raw.match(/\{[^{}]*\}/g) || [];
if (objects.length !== 1)
  throw Error("The blind answer is not one JSON object: " + raw);
const answer = JSON.parse(objects[0]);
process.stdout.write(
  JSON.stringify({
    model: {
      name: "Qwen3-0.6B-Q4_K_M",
      sha256,
      runtime: "@hpcc-js/wasm-llama@1.7.0",
    },
    prompt,
    isolation: {
      tools: false,
      freshProcess: true,
      history: [],
      suppliedContext: ["refusal", "question"],
    },
    raw,
    answer,
  }),
);
llama.dispose();
