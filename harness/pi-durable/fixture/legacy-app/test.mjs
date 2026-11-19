import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the fixture has a runnable server and the legacy app marker", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /createServer/);
  assert.match(source, /sauna/);
});
