import { test } from "node:test";
import assert from "node:assert/strict";
import { app, book, houseConfig, setupHouse } from "./support.mjs";
function config(id = "classes", cap = true) {
  const c = houseConfig(id);
  c.resources[0].days = {
    Saturday: [
      { start: "17:00", class: "family" },
      { start: "18:30", class: "family" },
    ],
    Tuesday: [{ start: "17:00", class: "ordinary" }],
  };
  c.policy.caps = cap ? { family: 1 } : {};
  return c;
}
const fam = { resource: "r", date: "2030-01-05", start: "17:00" };
const other = { resource: "r", date: "2030-01-08", start: "17:00" };
test("@item-05-001 family cap identifies the existing household booking", async (t) => {
  const a = await app(t);
  await setupHouse(a, config());
  const first = await book(a, "12", fam, "classes");
  assert.equal(first.http, 201);
  const r = await book(a, "12", { ...fam, start: "18:30" }, "classes");
  assert.equal(r.http, 409);
  assert.equal(r.code, "class-cap");
  assert.match(r.reason, /family/);
  assert.equal(r.existingBooking, first.booking.id);
});
test("@item-05-002 unrelated booking does not use family allowance", async (t) => {
  const a = await app(t);
  await setupHouse(a, config());
  assert.equal((await book(a, "12", other, "classes")).http, 201);
  assert.equal((await book(a, "12", fam, "classes")).http, 201);
});
test("@item-05-003 family allowance does not block other classes", async (t) => {
  const a = await app(t);
  await setupHouse(a, config());
  assert.equal((await book(a, "12", fam, "classes")).http, 201);
  assert.equal((await book(a, "12", other, "classes")).http, 201);
});
test("@item-05-004 caps do not leak between houses", async (t) => {
  const a = await app(t);
  await setupHouse(a, config("A"));
  await setupHouse(a, config("B", false));
  assert.equal((await book(a, "12", fam, "B")).http, 201);
  assert.equal(
    (await book(a, "12", { ...fam, start: "18:30" }, "B")).http,
    201,
  );
});
test("@item-05-005 completed occurrence releases the class allowance", async (t) => {
  const a = await app(t);
  await setupHouse(a, config());
  assert.equal((await book(a, "12", fam, "classes")).http, 201);
  await a.post("/api/clock", { now: "2030-01-05T18:30:00Z" });
  assert.equal(
    (await book(a, "12", { ...fam, date: "2030-01-12" }, "classes")).http,
    201,
  );
});
