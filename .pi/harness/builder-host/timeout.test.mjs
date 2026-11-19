import test from "node:test";
import assert from "node:assert/strict";
import { timeoutCeilingFromEnv, withTimeoutFloor } from "./host.ts";

test("grader bash calls have a hard bound even when the model omits timeout", async () => {
  const bash = withTimeoutFloor({ name: "bash", execute: async (args) => args }, 300, 300);
  assert.equal((await bash.execute({ command: "wait" })).timeout, 300);
  assert.equal((await bash.execute({ command: "wait", timeout: 30 })).timeout, 300);
  assert.equal((await bash.execute({ command: "wait", timeout: 1800 })).timeout, 300);
  assert.equal(timeoutCeilingFromEnv(300, "300"), 300);
  assert.throws(() => timeoutCeilingFromEnv(300, "60"), /expected integer >= floor/);
});
