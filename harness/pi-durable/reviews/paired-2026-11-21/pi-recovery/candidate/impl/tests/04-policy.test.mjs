import { test } from "node:test";
import assert from "node:assert/strict";
import { app, book, houseConfig, setupHouse, views } from "./support.mjs";
async function revise(a, config, changes = {}) {
  return a.post("/api/houses/" + config.id + "/policies", {
    actor: "board",
    policy: {
      ...config.policy,
      ...changes,
      version: "v2",
      effective: "2030-01-10T00:00:00Z",
    },
  });
}
test("@item-04-001 calendars belong to their own house", async (t) => {
  const a = await app(t),
    ca = houseConfig("A"),
    cb = houseConfig("B");
  cb.resources[0].days = { Thursday: [{ start: "17:00" }] };
  await setupHouse(a, ca);
  await setupHouse(a, cb);
  assert(
    (await a.get("/api/schedule?house=A")).slots.some(
      (s) => s.weekday === "Tuesday",
    ),
  );
  assert(
    !(await a.get("/api/schedule?house=B")).slots.some(
      (s) => s.weekday === "Tuesday",
    ),
  );
});
test("@item-04-002 booker roles are checked per house", async (t) => {
  const a = await app(t),
    ca = houseConfig("A"),
    cb = houseConfig("B");
  cb.policy.bookerRoles = ["shareholder"];
  await setupHouse(a, ca);
  await setupHouse(a, cb);
  const s = { resource: "r", weekday: "Tuesday", start: "17:00" };
  assert.equal((await book(a, "12", s, "A")).http, 201);
  const refused = await book(a, "12", s, "B");
  assert.equal(refused.code, "booker-role");
  await a.post("/api/households", {
    id: "owner",
    house: "B",
    role: "shareholder",
  });
  assert.equal((await book(a, "owner", s, "B")).http, 201);
});
test("@item-04-003 manager route does not expose or accept self-service queue", async (t) => {
  const a = await app(t),
    c = houseConfig("self");
  await setupHouse(a, c);
  const houses = (await a.get("/api/houses")).houses;
  const manager = houses.find((h) => h.id === "soukanvuori").currentPolicy,
    self = houses.find((h) => h.id === "self").currentPolicy;
  assert.equal(manager.route, "manager");
  assert.equal(manager.bookingRole, "manager");
  assert.equal(self.route, "self-service");
  assert.equal(
    (
      await a.post("/api/queue", {
        house: "soukanvuori",
        group: "ph8",
        household: "12",
      })
    ).http,
    403,
  );
  assert.equal(
    (await a.post("/api/queue", { house: "self", group: "A", household: "12" }))
      .http,
    200,
  );
});
test("@item-04-004 effective-dated rules record authorized governance", async (t) => {
  const a = await app(t),
    c = houseConfig();
  await setupHouse(a, c);
  const bad = await a.post("/api/houses/test/policies", {
    actor: "tenant",
    policy: {
      ...c.policy,
      version: "unauthorized",
      effective: "2030-01-10T00:00:00Z",
    },
  });
  assert.equal(bad.http, 403);
  const r = await revise(a, c);
  assert.equal(r.http, 201);
  assert.equal(r.policy.authority, "board");
  assert.equal(r.policy.effective, "2030-01-10T00:00:00.000Z");
  const s = { resource: "r", weekday: "Tuesday", start: "17:00" };
  assert.equal((await book(a, "12", s, "test")).booking.policyVersion, "v1");
  await a.post("/api/clock", { now: "2030-01-10T00:00:00Z" });
  assert.equal(
    (await book(a, "3", { ...s, start: "18:30" }, "test")).booking
      .policyVersion,
    "v2",
  );
});
test("@item-04-005 configured dispute role reconstructs booking history", async (t) => {
  const a = await app(t),
    c = houseConfig();
  await setupHouse(a, c);
  const b = (
    await book(
      a,
      "12",
      { resource: "r", weekday: "Tuesday", start: "17:00" },
      "test",
    )
  ).booking;
  await a.post("/api/bookings/" + b.id + "/give-up", { household: "12" });
  const denied = await a.post("/api/disputes", {
    booking: b.id,
    role: "billing",
    reason: "My slot vanished",
  });
  assert.equal(denied.http, 403);
  const r = await a.post("/api/disputes", {
    booking: b.id,
    role: "manager",
    reason: "My slot vanished",
  });
  assert.equal(r.http, 201);
  assert.equal(r.evidence.booking.id, b.id);
  assert.deepEqual(
    r.evidence.booking.history.map((e) => e.type),
    ["confirmed", "given-up"],
  );
  assert(
    r.evidence.booking.history.every(
      (e) => e.booking === b.id && e.policyVersion === "v1",
    ),
  );
  assert.equal(r.evidence.policies[0].version, "v1");
  assert.equal(r.dispute.firstStop, "manager");
});
test("@item-04-006 later revision cannot rewrite refusal evidence", async (t) => {
  const a = await app(t),
    c = houseConfig();
  await setupHouse(a, c);
  const r = await book(
    a,
    "12",
    { resource: "r", weekday: "Monday", start: "17:00" },
    "test",
  );
  assert.equal(r.http, 409);
  const old = r.decision;
  assert.equal(old.policyVersion, "v1");
  await revise(a, c);
  await a.post("/api/clock", { now: "2030-01-11T00:00:00Z" });
  const record = (await a.get("/api/state")).decisions.find(
    (d) => d.id === old.id,
  );
  assert.deepEqual(record, old);
});
test("@item-04-007 revisions affect new notice clocks only", async (t) => {
  const a = await app(t),
    c = houseConfig("test", 2);
  c.resources.push({
    ...structuredClone(c.resources[0]),
    id: "b",
    name: "B",
    group: "B",
  });
  await setupHouse(a, c);
  for (const [resource, household] of [
    ["r", "12"],
    ["b", "3"],
  ])
    for (const start of ["17:00", "18:30"])
      assert.equal(
        (
          await book(
            a,
            household,
            { resource, weekday: "Tuesday", start },
            "test",
          )
        ).http,
        201,
      );
  for (const group of ["A", "B"])
    await a.post("/api/queue", { house: "test", group, household: "4" });
  await a.post("/api/scarcity/evaluate", { house: "test", group: "A" });
  const n = (await a.get("/api/notices?house=test")).notices[0];
  assert.equal(n.policyVersion, "v1");
  await revise(a, c, { chooseDays: 7, noticeDays: 20 });
  await a.post("/api/clock", { now: "2030-01-11T00:00:00Z" });
  await a.post("/api/scarcity/evaluate", { house: "test", group: "B" });
  const ns = (await a.get("/api/notices?house=test")).notices;
  const old = ns.find((x) => x.id === n.id),
    fresh = ns.find((x) => x.group === "B");
  assert.equal(old.chooseAt, n.chooseAt);
  assert.equal(old.lapseAt, n.lapseAt);
  assert.equal(old.policyVersion, "v1");
  assert.equal(fresh.policyVersion, "v2");
  assert.equal(fresh.chooseAt, "2030-01-18T00:00:00.000Z");
  assert.equal(fresh.lapseAt, "2030-01-31T00:00:00.000Z");
});
