import { test } from "node:test";
import assert from "node:assert/strict";
import { app, holding, views } from "./support.mjs";
const date = "2030-01-08";
async function release(a, mode = "FREE") {
  const b = await holding(a);
  const r = await a.post("/api/releases", {
    booking: b.id,
    household: "12",
    date,
    mode,
  });
  assert.equal(r.http, 201);
  return { b, r: r.release };
}
async function take(a, r, household = "3") {
  return a.post("/api/releases/" + r.id + "/take", { household });
}
async function withdraw(a, r) {
  return a.post("/api/releases/" + r.id + "/withdraw", { household: "12" });
}
test("@item-02-001 FREE offers only one occurrence", async (t) => {
  const a = await app(t);
  const { r } = await release(a);
  assert.equal(r.mode, "FREE");
  assert.equal(
    (await views(a, "soukanvuori", date)).posted[0].state,
    "released",
  );
  assert.equal(
    (await views(a, "soukanvuori", "2030-01-15")).posted[0].household,
    "12",
  );
});
test("@item-02-002 next Tuesday remains assigned", async (t) => {
  const a = await app(t);
  const { r } = await release(a);
  assert.equal((await take(a, r)).http, 200);
  assert.equal((await views(a, "soukanvuori", date)).posted[0].household, "3");
  assert.equal(
    (await views(a, "soukanvuori", "2030-01-15")).posted[0].household,
    "12",
  );
});
test("@item-02-003 unused offer preserves normal fee and holding", async (t) => {
  const a = await app(t);
  await release(a);
  await a.post("/api/clock", { now: "2030-01-08T19:00:00Z" });
  const v = await views(a, "soukanvuori", date);
  assert.equal(v.posted[0].state, "unclaimed");
  assert.equal(v.posted[0].household, null);
  assert.equal(v.heater.length, 0);
  assert.equal(v.billing[0].payer, "12");
  assert.equal((await views(a)).posted[0].household, "12");
});
test("@item-02-004 free taker owes no charge, holder owes normal fee", async (t) => {
  const a = await app(t);
  const { r } = await release(a);
  await take(a, r);
  const v = await views(a, "soukanvuori", date);
  assert.equal(v.posted[0].household, "3");
  assert.equal(v.billing.length, 1);
  assert.equal(v.billing[0].payer, "12");
  assert.equal(v.billing[0].kind, "standing");
  assert.equal(
    (await views(a, "soukanvuori", "2030-01-15")).posted[0].household,
    "12",
  );
});
test("@item-02-005 sale emits distinct priced policy-bound charge", async (t) => {
  const a = await app(t);
  const { r } = await release(a, "SALE");
  await take(a, r);
  const v = await views(a, "soukanvuori", date);
  const sale = v.billing.find((x) => x.kind === "resale");
  assert.equal(sale.payer, "3");
  assert.equal(sale.occurrence, r.id);
  assert.equal(sale.date, date);
  assert.equal(sale.policyVersion, "v1");
  assert.equal(sale.priceReference, "resale-fee");
  assert(v.billing.some((x) => x.kind === "standing" && x.payer === "12"));
  assert.equal(
    (await views(a, "soukanvuori", "2030-01-15")).posted[0].household,
    "12",
  );
});
test("@item-02-006 untaken withdrawal restores holder and prevents taking", async (t) => {
  const a = await app(t);
  const { r } = await release(a);
  assert.equal((await withdraw(a, r)).http, 200);
  assert.equal((await take(a, r)).http, 409);
  assert.equal((await views(a, "soukanvuori", date)).posted[0].household, "12");
  assert.equal((await views(a)).posted[0].household, "12");
});
test("@item-02-007 taken transfer cannot be withdrawn", async (t) => {
  const a = await app(t);
  const { r } = await release(a);
  await take(a, r);
  assert.equal((await withdraw(a, r)).http, 409);
  assert.equal((await views(a, "soukanvuori", date)).posted[0].household, "3");
});
test("@item-02-008 offer expires precisely at occurrence start", async (t) => {
  const a = await app(t);
  const { r } = await release(a);
  await a.post("/api/clock", { now: date + "T17:00:00Z" });
  assert.equal((await take(a, r)).code, "expired");
  assert.equal(
    (await views(a, "soukanvuori", date)).posted[0].state,
    "unclaimed",
  );
  assert.equal((await views(a)).billing[0].payer, "12");
  assert.equal((await views(a)).posted[0].household, "12");
});
test("@item-02-009 one taker across all views", async (t) => {
  const a = await app(t);
  const { r } = await release(a, "SALE");
  await take(a, r);
  assert.equal((await take(a, r, "4")).http, 409);
  const v = await views(a, "soukanvuori", date);
  assert.equal(v.posted.length, 1);
  assert.equal(v.posted[0].household, "3");
  assert.equal(v.heater[0].household, "3");
  assert.equal(v.billing.find((x) => x.kind === "resale").payer, "3");
});
test("@item-02-010 concurrent takers have one winner", async (t) => {
  const a = await app(t);
  const { r } = await release(a, "SALE");
  const rs = await Promise.all(["3", "4"].map((k) => take(a, r, k)));
  assert.equal(rs.filter((x) => x.http === 200).length, 1);
  assert.equal(rs.filter((x) => x.http === 409).length, 1);
  const v = await views(a, "soukanvuori", date);
  assert.equal(v.posted.length, 1);
  assert.equal(v.heater[0].household, v.posted[0].household);
  assert.equal(
    v.billing.find((x) => x.kind === "resale").payer,
    v.posted[0].household,
  );
});
