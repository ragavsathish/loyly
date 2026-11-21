import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "./support.mjs";
test("browser surface exposes the booking product, scripts and styles", async (t) => {
  const a = await app(t);
  const root = await fetch(a.url);
  assert.equal(root.status, 200);
  const html = await root.text();
  for (const word of [
    "sauna",
    "schedule",
    "releases",
    "notices",
    "policies",
    "app.js",
  ])
    assert(html.includes(word));
  for (const route of ["/app.js", "/style.css", "/api-docs"])
    assert.equal((await fetch(a.url + route)).status, 200);
});
