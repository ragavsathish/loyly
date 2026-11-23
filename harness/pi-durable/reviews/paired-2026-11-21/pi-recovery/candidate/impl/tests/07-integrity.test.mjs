import { test } from "node:test";
import assert from "node:assert/strict";
import {
  app,
  holding,
  views,
  book,
  houseConfig,
  setupHouse,
} from "./support.mjs";
test("scenario clock can return to real time", async (t) => {
  const a = await app(t);
  assert.equal((await a.post("/api/clock", { now: null })).http, 200);
  assert.equal((await a.get("/api/state")).now, null);
});
test("invalid calendar coordinates fail without an internal error", async (t) => {
  const a = await app(t);
  for (const date of ["2030-02-31", "2030-99-99", "not-a-date"])
    assert.equal(
      (await book(a, "12", { resource: "ph8", date, start: "17:00" })).http,
      400,
    );
});
test("invalid house configuration cannot enter the record", async (t) => {
  const a = await app(t);
  const c = houseConfig();
  c.policy.caps = { family: -1 };
  assert.equal((await a.post("/api/houses", c)).http, 400);
  assert(!(await a.get("/api/houses")).houses.some((h) => h.id === c.id));
  const future = houseConfig("future");
  future.policy.effective = "2031-01-01T00:00:00Z";
  assert.equal((await a.post("/api/houses", future)).http, 400);
});
test("overlapping configured windows are rejected", async (t) => {
  const a = await app(t),
    c = houseConfig();
  c.resources[0].days.Tuesday[1].start = "17:30";
  assert.equal((await a.post("/api/houses", c)).http, 400);
});
test("choice-right transition is recorded at its original instant", async (t) => {
  const a = await app(t);
  await setupHouse(a, houseConfig("test", 2));
  for (const start of ["17:00", "18:30"])
    await book(a, "12", { resource: "r", weekday: "Tuesday", start }, "test");
  await a.post("/api/queue", { house: "test", group: "A", household: "3" });
  await a.post("/api/scarcity/evaluate", { house: "test", group: "A" });
  await a.post("/api/clock", { now: "2030-01-16T00:00:00Z" });
  const n = (await a.get("/api/notices?house=test")).notices[0];
  assert.equal(
    n.history.find((e) => e.type === "choice-right-passed").at,
    n.chooseAt,
  );
});
test("booking and derived views survive a process restart", async (t) => {
  const a = await app(t);
  const b = await holding(a);
  const before = await views(a);
  await a.restart();
  const after = await views(a);
  assert.deepEqual(after, before);
  assert.equal((await a.get("/api/bookings")).bookings[0].id, b.id);
});
test("an accepted transfer cannot be undone via giving up the standing holding", async (t) => {
  const a = await app(t),
    b = await holding(a);
  const r = (
    await a.post("/api/releases", {
      booking: b.id,
      household: "12",
      date: "2030-01-08",
      mode: "SALE",
    })
  ).release;
  await a.post("/api/releases/" + r.id + "/take", { household: "3" });
  await a.post("/api/bookings/" + b.id + "/give-up", { household: "12" });
  const v = await views(a, "soukanvuori", "2030-01-08");
  assert.equal(v.posted[0].household, "3");
  assert.equal(v.heater[0].household, "3");
  assert.equal(v.billing.find((s) => s.kind === "resale").payer, "3");
  assert.equal(v.billing.filter((s) => s.kind === "standing").length, 0);
});
test("initial policy is effective at its exact ISO instant", async (t) => {
  const a = await app(t);
  await a.post("/api/clock", { now: "2020-01-01T00:00:00.000Z" });
  assert.equal((await book(a)).http, 201);
});
