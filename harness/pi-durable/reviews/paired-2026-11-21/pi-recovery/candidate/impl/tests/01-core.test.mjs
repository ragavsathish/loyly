import { test } from "node:test";
import assert from "node:assert/strict";
import { app, book, holding, views, slot } from "./support.mjs";
test("@item-01-001 per-dressing-room weekly days", async (t) => {
  const a = await app(t),
    s = await a.get("/api/schedule?house=soukanvuori");
  assert(s.slots.some((x) => x.resource === "ph8" && x.weekday === "Tuesday"));
  assert(!s.slots.some((x) => x.resource === "ph9" && x.weekday === "Tuesday"));
});
test("@item-01-002 closed day names opening days", async (t) => {
  const a = await app(t),
    r = await book(a, "12", { ...slot, resource: "ph9" });
  assert.equal(r.http, 409);
  assert.equal(r.code, "closed-day");
  for (const day of ["Thursday", "Friday", "Saturday"])
    assert(r.reason.includes(day));
});
test("@item-01-003 confirmation recurs with configured duration", async (t) => {
  const a = await app(t),
    b = await holding(a);
  assert.equal(b.end, "18:30");
  assert.equal(b.household, "12");
  for (const date of ["2030-01-08", "2030-01-15"]) {
    const v = await views(a, "soukanvuori", date);
    assert.equal(v.posted[0].household, "12");
  }
});
test("@item-01-004 held slot is refused without revealing holder", async (t) => {
  const a = await app(t);
  await holding(a);
  const r = await book(a, "3");
  assert.equal(r.code, "held");
  assert(!r.reason.includes("12"));
  assert.equal((await views(a)).posted[0].household, "12");
});
test("@item-01-005 second slot while room remains", async (t) => {
  const a = await app(t);
  await holding(a);
  assert.equal((await book(a, "12", { ...slot, start: "18:30" })).http, 201);
  assert.equal(
    (await views(a)).posted.filter((x) => x.household === "12").length,
    2,
  );
});
test("@item-01-006 full schedule refusal does not suggest unavailable choices", async (t) => {
  const a = await app(t);
  await holding(a);
  for (const s of (await a.get("/api/schedule?house=soukanvuori")).slots.filter(
    (x) => x.state === "free",
  ))
    assert.equal((await book(a, "3", s)).http, 201);
  const r = await book(a);
  assert.equal(r.code, "full");
  assert.match(r.reason, /no free standing slot/i);
  assert(!/choose|try|request .* at/i.test(r.reason));
  assert.equal(
    (await views(a)).posted.filter((x) => x.household === "12").length,
    1,
  );
});
test("@item-01-007 three views derive confirmation", async (t) => {
  const a = await app(t),
    b = await holding(a),
    v = await views(a);
  assert.equal(v.posted[0].booking, b.id);
  assert.equal(v.heater[0].booking, b.id);
  assert.equal(v.heater[0].end, "18:30");
  assert.equal(v.billing[0].booking, b.id);
  assert.equal(v.billing[0].payer, "12");
  assert.equal(v.billing[0].kind, "standing");
});
test("@item-01-008 give up removes every current derived claim", async (t) => {
  const a = await app(t),
    b = await holding(a);
  assert.equal(
    (await a.post("/api/bookings/" + b.id + "/give-up", { household: "12" }))
      .http,
    200,
  );
  const v = await views(a);
  for (const key of ["posted", "heater", "billing"])
    assert.deepEqual(v[key], []);
});
async function race(a) {
  const requests = ["12", "3"].map((h) => book(a, h));
  const rs = await Promise.all(requests);
  assert.equal(rs.filter((r) => r.http === 201).length, 1);
  assert.equal(rs.filter((r) => r.code === "held").length, 1);
  const v = await views(a);
  assert.equal(v.posted.length, 1);
  assert.equal(v.heater.length, 1);
  assert.equal(v.billing.length, 1);
  assert.equal(v.billing[0].payer, v.posted[0].household);
  return v.posted[0];
}
test("@item-01-009 overlapping requests have one winner", async (t) => {
  await race(await app(t));
});
test("@item-01-010 one hundred two-household races", async (t) => {
  const a = await app(t);
  for (let i = 0; i < 100; i++) {
    const b = await race(a);
    assert.equal(
      (
        await a.post("/api/bookings/" + b.booking + "/give-up", {
          household: b.household,
        })
      ).http,
      200,
    );
  }
});
test("@item-01-011 actionable refusal HTTP replay prerequisite", async (t) => {
  const a = await app(t),
    r = await book(a, "12", { ...slot, resource: "ph9" });
  assert(r.alternative);
  assert(r.reason.includes(r.alternative.weekday));
  assert(r.reason.includes(r.alternative.start));
  const fresh = await app(t);
  assert.equal((await book(fresh, "12", r.alternative)).http, 201);
});
