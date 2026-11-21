import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
test("every stamped ready-for-development scenario has a named public-surface test", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const plan = fileURLToPath(new URL("../../docs/plan/", import.meta.url));
  const source = fs
    .readdirSync(dir)
    .filter((f) => /^(0[1-5])-.*\.test\.mjs$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  let count = 0;
  for (const slice of fs.readdirSync(plan)) {
    const p = path.join(plan, slice);
    if (
      !fs.statSync(p).isDirectory() ||
      !fs.existsSync(path.join(p, "plan.md"))
    )
      continue;
    if (
      !/status: ready-for-development/.test(
        fs.readFileSync(path.join(p, "plan.md"), "utf8"),
      )
    )
      continue;
    for (const id of fs
      .readFileSync(path.join(p, "spec.feature"), "utf8")
      .match(/@item-\d+-\d+/g) || []) {
      count++;
      assert(source.includes(id), "Missing public-surface test for " + id);
    }
  }
  assert(count > 0, "No stamped scenarios discovered");
});
