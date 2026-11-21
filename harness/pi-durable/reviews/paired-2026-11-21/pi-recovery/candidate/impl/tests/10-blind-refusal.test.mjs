import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, book, slot } from "./support.mjs";

const question =
  'Using only the refusal below, name a dressing room, weekday and start time for a standing-slot request that can be confirmed. Return only a JSON object with string fields resource, weekday and start. Use the resource identifier when the refusal supplies one. Do not invent missing information. If the refusal is insufficient, return {"insufficient":true}. /no_think';

test(
  "@item-01-011 fresh blind language-model subagent names a request confirmed by fresh HTTP replay",
  { timeout: 900000 },
  async (t) => {
    const refusedApp = await app(t);
    const refusal = await book(refusedApp, "12", { ...slot, resource: "ph9" });
    assert.equal(refusal.http, 409);
    assert.equal(refusal.code, "closed-day");

    // Only the exact human-facing refusal and neutral question enter this new agent.
    // No JSON alternative, schedule, candidate URL, policy, examples or transcript.
    const prompt = { question, refusal: refusal.reason };
    const room = await fs.mkdtemp(
      fileURLToPath(new URL("../.test-blind-", import.meta.url)),
    );
    t.after(() => fs.rm(room, { recursive: true, force: true }));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../blind-agent.mjs", import.meta.url))],
      {
        cwd: room,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let output = "",
      errors = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (output += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (errors += d));
    child.stdin.end(JSON.stringify(prompt));
    const code = await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    assert.equal(
      code,
      0,
      "Independent blind agent must run, not be replaced by a canned answer: " +
        errors,
    );
    const judged = JSON.parse(output);
    assert.equal(judged.prompt.refusal, refusal.reason);
    assert.equal(judged.prompt.question, question);
    assert.equal(judged.model.name, "Qwen3-0.6B-Q4_K_M");
    assert.match(judged.model.sha256, /^[a-f0-9]{64}$/);
    assert.equal(judged.isolation.tools, false);
    assert.equal(judged.isolation.freshProcess, true);
    assert(
      !judged.answer.insufficient,
      "The blind agent found the refusal insufficient: " + judged.raw,
    );
    const request = judged.answer;
    for (const field of ["resource", "weekday", "start"])
      assert.equal(typeof request[field], "string", judged.raw);
    const fresh = await app(t);
    const replay = await book(fresh, "12", request);
    assert.equal(replay.http, 201, JSON.stringify({ judged, replay }, null, 2));
    assert.equal(replay.booking.resource, request.resource);
    assert.equal(replay.booking.weekday, request.weekday);
    assert.equal(replay.booking.start, request.start);
    await fs.mkdir(fileURLToPath(new URL("../evidence/", import.meta.url)), {
      recursive: true,
    });
    await fs.writeFile(
      fileURLToPath(
        new URL("../evidence/01-011-independent-verdict.json", import.meta.url),
      ),
      JSON.stringify({ ...judged, replay }, null, 2),
    );
  },
);
