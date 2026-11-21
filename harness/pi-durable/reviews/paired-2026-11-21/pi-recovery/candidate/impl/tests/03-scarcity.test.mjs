import { test } from "node:test";
import assert from "node:assert/strict";
import { app, book, houseConfig, setupHouse, views } from "./support.mjs";
const ts = ["17:00", "18:30", "20:00"];
async function queue(a, k = "3", group = "A") {
  return a.post("/api/queue", { house: "test", group, household: k });
}
async function evaluate(a, group = "A") {
  return a.post("/api/scarcity/evaluate", { house: "test", group });
}
async function notices(a) {
  return (await a.get("/api/notices?house=test")).notices;
}
async function setup(t, { n = 2, free = 0, wait = true, groupB = false } = {}) {
  const a = await app(t),
    c = houseConfig("test", n);
  if (groupB)
    c.resources.push({
      ...structuredClone(c.resources[0]),
      id: "b",
      name: "Room B",
      group: "B",
    });
  await setupHouse(a, c);
  const bs = [];
  for (let i = 0; i < n - free; i++) {
    const r = await book(
      a,
      "12",
      { resource: "r", weekday: "Tuesday", start: ts[i] },
      "test",
    );
    assert.equal(r.http, 201);
    bs.push(r.booking);
  }
  if (wait) await queue(a);
  return { a, bs };
}
async function under(t) {
  const s = await setup(t);
  await evaluate(s.a);
  s.n = (await notices(s.a))[0];
  assert(s.n);
  return s;
}
async function choose(a, n, b, household = "12") {
  return a.post("/api/notices/" + n.id + "/choose", {
    household,
    booking: b.id,
  });
}
async function claim(a, n, household = "3", action = "confirm") {
  return a.post("/api/notices/" + n.id + "/claim", { household, action });
}
async function clock(a, date) {
  return a.post("/api/clock", { now: date + "T00:00:00Z" });
}
test("@item-03-001 free eligible capacity prevents notice", async (t) => {
  const { a } = await setup(t, { n: 3, free: 1 });
  await evaluate(a);
  assert.deepEqual(await notices(a), []);
});
test("@item-03-002 full capacity alone is not scarcity", async (t) => {
  const { a } = await setup(t, { wait: false });
  await evaluate(a);
  assert.deepEqual(await notices(a), []);
});
test("@item-03-003 release is not free standing capacity", async (t) => {
  const { a, bs } = await setup(t);
  await a.post("/api/releases", {
    booking: bs[0].id,
    household: "12",
    mode: "FREE",
    date: "2030-01-08",
  });
  await evaluate(a);
  assert.equal((await notices(a)).length, 1);
});
test("@item-03-004 other resource group queue does not trigger notice", async (t) => {
  const { a } = await setup(t, { wait: false, groupB: true });
  await queue(a, "3", "B");
  await evaluate(a);
  assert.equal((await notices(a)).length, 0);
});
test("@item-03-005 accepted sequence gives scoped FIFO head", async (t) => {
  const { a } = await setup(t, { wait: false, groupB: true });
  const first = await queue(a, "4"),
    second = await queue(a, "3");
  assert(first.entry.sequence < second.entry.sequence);
  const q = await a.get("/api/queue?house=test&group=A");
  assert.equal(q.head.household, "4");
  assert.equal(q.entries.length, 2);
  assert.equal(
    (await a.get("/api/queue?house=test&group=B")).entries.length,
    0,
  );
});
test("@item-03-014 repeated evaluation issues one active notice for three holdings", async (t) => {
  const { a } = await setup(t, { n: 3 });
  await evaluate(a);
  await evaluate(a);
  const ns = await notices(a);
  assert.equal(ns.length, 1);
  assert.equal(ns[0].selected, null);
  assert.equal((await views(a, "test")).posted.length, 3);
});
test("@item-03-006 holder chooses before shorter deadline but keeps using both", async (t) => {
  const { a, bs, n } = await under(t);
  assert.equal(n.chooseAt, "2030-01-15T00:00:00.000Z");
  assert.equal(n.lapseAt, "2030-01-31T00:00:00.000Z");
  assert.equal((await choose(a, n, bs[1])).http, 200);
  const updated = (await notices(a))[0];
  assert.equal(updated.selected, bs[1].id);
  assert.equal((await views(a, "test")).posted.length, 2);
});
test("@item-03-007 choice right passes to queue-head at deadline", async (t) => {
  const { a, bs, n } = await under(t);
  await clock(a, "2030-01-15");
  assert.equal((await notices(a))[0].chooser, "3");
  assert.equal((await choose(a, n, bs[0])).http, 403);
  assert.equal((await choose(a, n, bs[0], "3")).http, 200);
  assert.equal((await views(a, "test")).posted.length, 2);
});
test("@item-03-008 choose deadline leaves loss deadline and holdings unchanged", async (t) => {
  const { a, n } = await under(t);
  await clock(a, "2030-01-16");
  assert.equal((await notices(a))[0].lapseAt, n.lapseAt);
  assert.equal((await views(a, "test")).posted.length, 2);
});
test("@item-03-009 lapse removes only selected holding with consistent history", async (t) => {
  const { a, bs, n } = await under(t);
  await choose(a, n, bs[0]);
  await clock(a, "2030-01-31");
  const v = await views(a, "test");
  assert.equal(v.posted.length, 1);
  assert.equal(v.posted[0].booking, bs[1].id);
  assert.equal(v.billing.length, 1);
  assert.equal(v.billing[0].booking, bs[1].id);
  const old = (await a.get("/api/bookings?house=test")).bookings.find(
    (b) => b.id === bs[0].id,
  );
  assert(old.history.some((x) => x.type === "lapsed"));
});
test("@item-03-010 confirmed claim is pending until lapse", async (t) => {
  const { a, bs, n } = await under(t);
  await choose(a, n, bs[0]);
  assert.equal((await claim(a, n)).http, 200);
  assert.equal((await notices(a))[0].pendingSuccessor, "3");
  assert((await views(a, "test")).posted.every((b) => b.household === "12"));
  await clock(a, "2030-01-31");
  const v = await views(a, "test");
  assert(v.posted.some((b) => b.household === "3" && b.start === bs[0].start));
  assert.equal(v.posted.filter((b) => b.household === "12").length, 1);
  assert.equal(v.billing.find((b) => b.payer === "3").kind, "standing");
});
test("@item-03-011 decline offers next eligible entry without early loss", async (t) => {
  const { a, bs, n } = await under(t);
  await queue(a, "4");
  await choose(a, n, bs[0]);
  assert.equal((await claim(a, n, "3", "decline")).http, 200);
  assert.equal((await notices(a))[0].offeredTo, "4");
  assert((await views(a, "test")).posted.every((b) => b.household === "12"));
  assert.equal((await claim(a, n, "4")).http, 200);
});
test("@item-03-012 all declines return selected slot to pool at lapse", async (t) => {
  const { a, bs, n } = await under(t);
  await queue(a, "4");
  await choose(a, n, bs[0]);
  await claim(a, n, "3", "decline");
  await claim(a, n, "4", "decline");
  await clock(a, "2030-01-31");
  const s = await a.get("/api/schedule?house=test");
  assert.equal(s.slots.find((x) => x.start === bs[0].start).state, "free");
  assert.equal(s.slots.filter((x) => x.state === "held").length, 1);
});
test("@item-03-013 queue withdrawal does not erase notice deadlines or rule", async (t) => {
  const { a, bs, n } = await under(t);
  await choose(a, n, bs[0]);
  const q = (await a.get("/api/queue?house=test&group=A")).head;
  await a.post("/api/queue/" + q.id + "/withdraw", { household: "3" });
  const after = (await notices(a))[0];
  for (const k of ["chooseAt", "lapseAt", "policyVersion"])
    assert.equal(after[k], n[k]);
  await clock(a, "2030-01-31");
  assert.equal((await views(a, "test")).posted.length, 1);
});
