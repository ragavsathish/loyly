import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA =
  process.env.LOyly_DATA ||
  process.env.LOYLY_DATA ||
  path.join(ROOT, "data/record.json");
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const clone = (x) => JSON.parse(JSON.stringify(x));
const basePolicy = {
  version: "v1",
  authority: "board",
  effective: "2020-01-01T00:00:00.000Z",
  bookerRoles: ["shareholder"],
  route: "manager",
  bookingRole: "manager",
  operationsRole: "maintenance",
  billingRole: "vastikekirjanpitaja",
  disputeRole: "manager",
  chooseDays: 14,
  noticeDays: 30,
  caps: {},
  priceReference: "standing-fee",
  salePriceReference: "resale-fee",
};
const windows = () => [
  { start: "17:00", class: "ordinary" },
  { start: "18:30", class: "ordinary" },
];
function initial() {
  const resources = [
    {
      id: "ph8",
      name: "pukuhuone 8",
      sauna: "sauna F",
      group: "ph8",
      duration: 90,
      days: { Tuesday: windows() },
    },
    {
      id: "ph9",
      name: "pukuhuone 9",
      sauna: "sauna F",
      group: "ph9",
      duration: 90,
      days: { Thursday: windows(), Friday: windows(), Saturday: windows() },
    },
  ];
  return {
    sequence: 0,
    now: null,
    houses: [
      {
        id: "soukanvuori",
        name: "As Oy Soukanvuori",
        resources,
        policies: [clone(basePolicy)],
      },
    ],
    households: ["12", "3", "4"].map((id) => ({
      id,
      house: "soukanvuori",
      role: "shareholder",
    })),
    bookings: [],
    decisions: [],
    releases: [],
    queues: [],
    notices: [],
    disputes: [],
  };
}
let db = fs.existsSync(DATA)
  ? JSON.parse(fs.readFileSync(DATA, "utf8"))
  : initial();
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(DATA + ".tmp", DATA);
}
function now() {
  return db.now || new Date().toISOString();
}
function id(prefix) {
  return prefix + "-" + ++db.sequence;
}
function fail(code, reason, status = 409, extra = {}) {
  throw Object.assign(new Error(reason), { code, status, ...extra });
}
function house(h) {
  const v = db.houses.find((x) => x.id === h);
  if (!v) fail("not-found", "House not found", 404);
  return v;
}
function policy(h) {
  const ps = house(h)
    .policies.filter((p) => p.effective <= now())
    .sort((a, b) => a.effective.localeCompare(b.effective));
  if (!ps.length) fail("policy", "No rule effective at decision time");
  return ps.at(-1);
}
function household(h, k) {
  const v = db.households.find((x) => x.house === h && x.id === k);
  if (!v) fail("household", "Household not registered in this house", 403);
  return v;
}
function eligible(h, k) {
  const v = household(h, k),
    p = policy(h);
  if (!p.bookerRoles.includes(v.role))
    fail(
      "booker-role",
      `House ${h} permits booker roles: ${p.bookerRoles.join(", ")}; ${v.role} is not eligible`,
      403,
    );
  return v;
}
function addTime(start, duration) {
  const [h, m] = start.split(":").map(Number),
    v = h * 60 + m + duration;
  return (
    String(Math.floor(v / 60)).padStart(2, "0") +
    ":" +
    String(v % 60).padStart(2, "0")
  );
}
function day(date) {
  return DAYS[new Date(date + "T12:00:00Z").getUTCDay()];
}
function validDate(d) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(d || "") &&
    Number.isFinite(Date.parse(d + "T00:00:00Z")) &&
    new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d
  );
}
function key(s) {
  return [s.resource, s.weekday, s.start].join("|");
}
function active(b) {
  return !b.endedAt || b.endedAt > now();
}
function allSlots(h) {
  return house(h).resources.flatMap((r) =>
    Object.entries(r.days).flatMap(([weekday, ws]) =>
      ws.map((w) => ({
        resource: r.id,
        resourceName: r.name,
        sauna: r.sauna,
        group: r.group,
        weekday,
        start: w.start,
        end: addTime(w.start, r.duration),
        class: w.class || "ordinary",
      })),
    ),
  );
}
function schedule(h) {
  return allSlots(h).map((s) => {
    const b = db.bookings.find(
      (b) =>
        b.house === h &&
        b.kind === "standing" &&
        active(b) &&
        key(b) === key(s),
    );
    return {
      ...s,
      state: b ? "held" : "free",
      booking: b?.id,
      household: b?.household,
    };
  });
}
function booking(k) {
  const b = db.bookings.find((x) => x.id === k);
  if (!b) fail("not-found", "Booking not found", 404);
  return b;
}
function event(b, type, extra = {}) {
  const e = {
    id: id("event"),
    booking: b.id,
    type,
    at: now(),
    policyVersion: policy(b.house).version,
    ...extra,
  };
  b.history.push(e);
  return e;
}
function checkClassCap(h, k, timeClass) {
  const cap = policy(h).caps?.[timeClass];
  if (cap === undefined) return;
  const counted = db.bookings
    .filter(
      (b) =>
        b.house === h &&
        b.household === k &&
        b.class === timeClass &&
        active(b) &&
        (!b.date || b.date + "T" + b.end + ":00.000Z" > now()),
    )
    .map((b) => b.id);
  for (const r of db.releases.filter(
    (r) =>
      r.house === h &&
      r.taker === k &&
      r.date + "T" + booking(r.booking).end + ":00.000Z" > now(),
  ))
    if (booking(r.booking).class === timeClass) counted.push(r.id);
  if (counted.length >= cap)
    fail(
      "class-cap",
      timeClass +
        " time cap is " +
        cap +
        " active or upcoming booking(s) per household; existing booking " +
        counted[0] +
        " uses the allowance.",
      409,
      { existingBooking: counted[0] },
    );
}
function requestBooking(input) {
  const { house: h, household: k, resource, start } = input,
    p = policy(h);
  eligible(h, k);
  if (p.route === "manager" && input.operator !== p.bookingRole)
    fail(
      "manager-route",
      `Contact ${p.bookingRole} for booking in ${house(h).name}`,
      403,
    );
  const kind = input.date ? "occurrence" : "standing";
  if (input.date && !validDate(input.date))
    fail("date", "Use a calendar date YYYY-MM-DD", 400);
  const weekday = input.date ? day(input.date) : input.weekday;
  if (
    kind === "standing" &&
    db.bookings.some(
      (b) =>
        b.house === h &&
        b.household === k &&
        b.kind === "standing" &&
        active(b),
    ) &&
    !schedule(h).some((s) => s.state === "free")
  )
    fail("full", "The weekly schedule has no free standing slot.");
  const r = house(h).resources.find((x) => x.id === resource);
  if (!r) fail("resource", "Unknown bookable resource", 400);
  if (!r.days[weekday]) {
    const alt = schedule(h).find((s) => s.state === "free");
    const alternative = alt
      ? { resource: alt.resource, weekday: alt.weekday, start: alt.start }
      : null;
    fail(
      "closed-day",
      `${r.name} has no sauna day on ${weekday}. It opens ${Object.keys(r.days).join(", ")}.${alt ? ` You can request ${alt.resourceName} (${alt.resource}) on ${alt.weekday} at ${alt.start}. This alternative is open and free. Its standing-slot request fields are ${JSON.stringify(alternative)}.` : " The weekly schedule has no free standing slot."}`,
      409,
      { alternative },
    );
  }
  const s = allSlots(h).find(
    (s) =>
      s.resource === resource && s.weekday === weekday && s.start === start,
  );
  if (!s)
    fail("window", "Choose a configured start time on this resource.", 409);
  if (kind === "occurrence" && input.date + "T" + s.end + ":00.000Z" <= now())
    fail("past", "This occurrence has already ended.");
  const collision = db.bookings.find(
    (b) =>
      b.house === h &&
      active(b) &&
      key(b) === key(s) &&
      (b.kind === "standing" || kind === "standing" || b.date === input.date),
  );
  if (collision) fail("held", "This slot is held.");
  checkClassCap(h, k, s.class);
  const b = {
    id: id("booking"),
    house: h,
    household: k,
    kind,
    ...s,
    ...(input.date ? { date: input.date } : {}),
    confirmedAt: now(),
    policyVersion: p.version,
    priceReference: p.priceReference,
    history: [],
  };
  db.bookings.push(b);
  event(b, "confirmed");
  return b;
}
function giveUp(b, input) {
  if (input.household !== b.household)
    fail("owner", "Only the holding household can give up this booking", 403);
  if (!active(b)) fail("ended", "Booking has ended");
  b.endedAt = now();
  event(b, "given-up");
  return b;
}
// Queue and notice transitions are part of the same booking transaction.
function groupSlots(h, g) {
  const slots = allSlots(h).filter((s) => s.group === g);
  if (!slots.length)
    fail("group", "No eligible resource group with that name", 400);
  return slots;
}
function waiting(h, g) {
  return db.queues
    .filter(
      (q) =>
        q.house === h &&
        q.group === g &&
        q.status === "waiting" &&
        policy(h).bookerRoles.includes(household(h, q.household).role),
    )
    .sort((a, b) => a.sequence - b.sequence);
}
function joinQueue(input) {
  const { house: h, household: k, group: g } = input,
    p = policy(h);
  eligible(h, k);
  if (p.route !== "self-service")
    fail(
      "manager-route",
      `Contact ${p.bookingRole}; this house does not offer a resident queue.`,
      403,
    );
  groupSlots(h, g);
  if (waiting(h, g).some((q) => q.household === k))
    fail("duplicate", "Household already waiting in this group");
  const q = {
    id: id("queue"),
    house: h,
    group: g,
    household: k,
    acceptedAt: now(),
    sequence: db.sequence,
    status: "waiting",
    policyVersion: p.version,
  };
  db.queues.push(q);
  return q;
}
function notice(k) {
  const n = db.notices.find((n) => n.id === k);
  if (!n) fail("not-found", "Notice not found", 404);
  return n;
}
function offeredEntry(n) {
  return waiting(n.house, n.group).find(
    (q) =>
      !n.declined.includes(q.id) &&
      !db.notices.some(
        (other) =>
          other.id !== n.id && !other.lapsedAt && other.pendingQueue === q.id,
      ),
  );
}
function noticeView(n) {
  const q = offeredEntry(n);
  return {
    ...n,
    chooser: n.selected
      ? null
      : now() < n.chooseAt
        ? n.household
        : q?.household || null,
    offeredTo:
      n.selected && !n.lapsedAt
        ? n.pendingSuccessor || q?.household || null
        : null,
    status: n.lapsedAt ? "lapsed" : "under-notice",
  };
}
function evaluateScarcity(h, g) {
  const p = policy(h);
  groupSlots(h, g);
  if (p.route !== "self-service")
    fail(
      "manager-route",
      "This manager-mediated house has no automated scarcity queue",
      403,
    );
  const slots = schedule(h).filter((s) => s.group === g);
  if (slots.some((s) => s.state === "free") || !waiting(h, g).length) return [];
  const held = db.bookings.filter(
      (b) =>
        b.house === h && b.group === g && b.kind === "standing" && active(b),
    ),
    holders = [...new Set(held.map((b) => b.household))],
    created = [];
  for (const k of holders) {
    const bs = held.filter((b) => b.household === k);
    if (
      bs.length < 2 ||
      db.notices.some((n) => n.house === h && n.household === k && !n.lapsedAt)
    )
      continue;
    const startedAt = now(),
      n = {
        id: id("notice"),
        house: h,
        group: g,
        household: k,
        holdings: bs.map((b) => b.id),
        selected: null,
        pendingSuccessor: null,
        pendingQueue: null,
        declined: [],
        startedAt,
        chooseAt: new Date(
          Date.parse(startedAt) + p.chooseDays * 86400000,
        ).toISOString(),
        lapseAt: new Date(
          Date.parse(startedAt) + p.noticeDays * 86400000,
        ).toISOString(),
        policyVersion: p.version,
        priceReference: p.priceReference,
        history: [
          { type: "notice-started", at: startedAt, policyVersion: p.version },
        ],
      };
    db.notices.push(n);
    for (const b of bs)
      event(b, "notice-started", { notice: n.id, policyVersion: p.version });
    created.push(n);
  }
  return created;
}
function chooseHolding(n, input) {
  if (n.lapsedAt || n.selected)
    fail("choice", "This notice already has a selected holding or has lapsed");
  const expected =
    now() < n.chooseAt ? n.household : offeredEntry(n)?.household;
  if (!expected || input.household !== expected)
    fail("chooser", "Only the current choice-right holder may choose", 403);
  if (!n.holdings.includes(input.booking) || !active(booking(input.booking)))
    fail("holding", "Choose one of this notice household’s current holdings");
  n.selected = input.booking;
  n.history.push({
    type: "holding-selected",
    booking: input.booking,
    by: input.household,
    at: now(),
    policyVersion: n.policyVersion,
  });
  event(booking(input.booking), "selected-for-lapse", {
    notice: n.id,
    policyVersion: n.policyVersion,
  });
  return n;
}
function claimNotice(n, input) {
  if (n.lapsedAt || !n.selected)
    fail("notice", "A selected, pending notice is required");
  const q = offeredEntry(n);
  if (n.pendingSuccessor || !q || q.household !== input.household)
    fail("claimant", "Only the next eligible claimant may act", 403);
  if (!["confirm", "decline"].includes(input.action))
    fail("action", "Claim action must be confirm or decline", 400);
  if (input.action === "decline") n.declined.push(q.id);
  else {
    n.pendingSuccessor = q.household;
    n.pendingQueue = q.id;
  }
  n.history.push({
    type: "claim-" + input.action,
    by: input.household,
    at: now(),
    policyVersion: n.policyVersion,
  });
  return n;
}
function withdrawQueue(k, input) {
  const q = db.queues.find((x) => x.id === k);
  if (!q) fail("not-found", "Queue entry not found", 404);
  if (q.household !== input.household)
    fail("owner", "Only this household can withdraw its queue entry", 403);
  q.status = "withdrawn";
  q.withdrawnAt = now();
  for (const n of db.notices.filter(
    (n) => !n.lapsedAt && n.pendingQueue === q.id,
  )) {
    n.pendingSuccessor = null;
    n.pendingQueue = null;
    n.history.push({
      type: "pending-claim-withdrawn",
      at: now(),
      policyVersion: n.policyVersion,
    });
  }
  return q;
}
function settle() {
  let changed = false;
  for (const n of db.notices.filter(
    (n) =>
      !n.lapsedAt && !n.selected && !n.choicePassedAt && n.chooseAt <= now(),
  )) {
    n.choicePassedAt = n.chooseAt;
    n.history.push({
      type: "choice-right-passed",
      at: n.chooseAt,
      policyVersion: n.policyVersion,
    });
    changed = true;
  }
  for (const n of db.notices.filter(
    (n) => !n.lapsedAt && n.selected && n.lapseAt <= now(),
  )) {
    const b = booking(n.selected);
    if (active(b)) {
      b.endedAt = n.lapseAt;
      event(b, "lapsed", {
        at: n.lapseAt,
        notice: n.id,
        policyVersion: n.policyVersion,
      });
      if (n.pendingSuccessor) {
        const q = db.queues.find((q) => q.id === n.pendingQueue);
        if (q?.status === "waiting") {
          const next = {
            ...clone(b),
            id: id("booking"),
            household: n.pendingSuccessor,
            confirmedAt: n.lapseAt,
            policyVersion: n.policyVersion,
            priceReference: n.priceReference,
            history: [],
          };
          delete next.endedAt;
          db.bookings.push(next);
          event(next, "confirmed-by-succession", {
            at: n.lapseAt,
            notice: n.id,
            policyVersion: n.policyVersion,
          });
          q.status = "claimed";
          q.claimedAt = n.lapseAt;
          n.successorBooking = next.id;
        }
      }
    }
    n.lapsedAt = n.lapseAt;
    n.history.push({
      type: "lapsed",
      at: n.lapseAt,
      policyVersion: n.policyVersion,
    });
    changed = true;
  }
  if (changed) save();
}

function offerState(r) {
  if (r.taker) return "taken";
  if (r.withdrawnAt) return "withdrawn";
  return r.date + "T" + booking(r.booking).start + ":00.000Z" <= now()
    ? "unclaimed"
    : "released";
}
function release(k) {
  const r = db.releases.find((x) => x.id === k);
  if (!r) fail("not-found", "Occurrence offer not found", 404);
  return r;
}
function offer(input) {
  const b = booking(input.booking);
  if (b.kind !== "standing" || !active(b))
    fail("holding", "Release needs an active standing holding");
  if (b.household !== input.household)
    fail("owner", "Only the holder can release an occurrence", 403);
  if (!validDate(input.date) || day(input.date) !== b.weekday)
    fail("date", "Occurrence date must match the holding weekday", 400);
  if (input.date + "T" + b.start + ":00.000Z" <= now())
    fail("past", "Only future occurrences can be offered");
  if (!["FREE", "SALE"].includes(input.mode))
    fail("mode", "Release mode must be FREE or SALE", 400);
  if (
    db.releases.some(
      (r) =>
        r.booking === b.id &&
        r.date === input.date &&
        offerState(r) !== "withdrawn",
    )
  )
    fail("duplicate", "This occurrence is already offered");
  const p = policy(b.house),
    r = {
      id: id("release"),
      house: b.house,
      booking: b.id,
      date: input.date,
      mode: input.mode,
      holder: b.household,
      offeredAt: now(),
      policyVersion: p.version,
    };
  db.releases.push(r);
  event(b, "occurrence-released", {
    occurrence: r.id,
    date: r.date,
    mode: r.mode,
  });
  return r;
}
function take(r, input) {
  const b = booking(r.booking),
    state = offerState(r);
  if (!active(b)) fail("holding", "The standing holding has ended");
  if (state !== "released")
    fail(
      state === "unclaimed" ? "expired" : "unavailable",
      state === "unclaimed"
        ? "The offer expired when its occurrence began."
        : "This offer is no longer available.",
    );
  eligible(b.house, input.household);
  if (input.household === b.household)
    fail("holder", "The holder cannot take their own offer");
  checkClassCap(b.house, input.household, b.class);
  const p = policy(b.house);
  r.taker = input.household;
  r.takenAt = now();
  r.takePolicyVersion = p.version;
  r.priceReference = p.salePriceReference;
  event(b, "occurrence-taken", {
    occurrence: r.id,
    taker: r.taker,
    mode: r.mode,
  });
  return r;
}
function withdraw(r, input) {
  const b = booking(r.booking);
  if (input.household !== r.holder)
    fail("owner", "Only the holder can withdraw the offer", 403);
  if (offerState(r) !== "released")
    fail(
      "unavailable",
      "Only an untaken offer before its start may be withdrawn.",
    );
  r.withdrawnAt = now();
  event(b, "release-withdrawn", { occurrence: r.id });
  return r;
}
function views(h, date) {
  if (date && !validDate(date)) fail("date", "Invalid date", 400);
  const posted = [],
    heater = [],
    billing = [];
  for (const b of db.bookings.filter((b) => b.house === h && active(b))) {
    const row = {
      booking: b.id,
      resource: b.resource,
      resourceName: b.resourceName,
      sauna: b.sauna,
      weekday: b.weekday,
      start: b.start,
      end: b.end,
      household: b.household,
      kind: b.kind,
      policyVersion: b.policyVersion,
      state: "held",
    };
    billing.push({
      booking: b.id,
      payer: b.household,
      kind: b.kind === "standing" ? "standing" : "occurrence",
      policyVersion: b.policyVersion,
      priceReference: b.priceReference,
      ...(b.date ? { date: b.date } : {}),
    });
    if (date && (b.weekday !== day(date) || (b.date && b.date !== date)))
      continue;
    if (!date && b.kind === "occurrence") Object.assign(row, { date: b.date });
    if (date) {
      row.date = date;
      const r = db.releases.find(
        (r) =>
          r.booking === b.id &&
          r.date === date &&
          offerState(r) !== "withdrawn",
      );
      if (r) {
        row.occurrence = r.id;
        row.state = offerState(r);
        row.mode = r.mode;
        row.household = r.taker || null;
      }
    }
    posted.push(row);
    if (row.household) heater.push({ ...row, heat: true });
  }
  for (const r of db.releases.filter(
    (r) =>
      r.house === h &&
      r.taker &&
      (!date || r.date === date) &&
      !active(booking(r.booking)),
  )) {
    const b = booking(r.booking);
    const row = {
      booking: b.id,
      occurrence: r.id,
      resource: b.resource,
      resourceName: b.resourceName,
      sauna: b.sauna,
      weekday: b.weekday,
      start: b.start,
      end: b.end,
      date: r.date,
      household: r.taker,
      kind: "occurrence",
      policyVersion: r.takePolicyVersion,
      state: "taken",
      mode: r.mode,
    };
    posted.push(row);
    heater.push({ ...row, heat: true });
  }
  for (const r of db.releases.filter(
    (r) =>
      r.house === h &&
      r.taker &&
      r.mode === "SALE" &&
      (!date || r.date === date),
  ))
    billing.push({
      booking: r.booking,
      occurrence: r.id,
      date: r.date,
      payer: r.taker,
      kind: "resale",
      policyVersion: r.takePolicyVersion,
      priceReference: r.priceReference,
    });
  return { house: h, date: date || null, asOf: now(), posted, heater, billing };
}
function validateHouse(c) {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(c.id || "") ||
    !c.name ||
    !Array.isArray(c.resources) ||
    !c.resources.length
  )
    fail(
      "configuration",
      "House id, name and resource calendars required",
      400,
    );
  const ids = new Set();
  for (const r of c.resources) {
    if (
      !r.id ||
      ids.has(r.id) ||
      !r.name ||
      !r.group ||
      !Number.isInteger(r.duration) ||
      r.duration <= 0 ||
      !r.days
    )
      fail(
        "configuration",
        "Resource requires unique id, name, group, positive duration and days",
        400,
      );
    ids.add(r.id);
    for (const [d, ws] of Object.entries(r.days)) {
      if (!DAYS.includes(d) || !Array.isArray(ws))
        fail("configuration", "Invalid resource calendar", 400);
      const seen = new Set();
      for (const w of ws) {
        if (
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start || "") ||
          seen.has(w.start) ||
          addTime(w.start, r.duration) > "24:00"
        )
          fail("configuration", "Invalid or duplicate start time", 400);
        seen.add(w.start);
      }
      const ordered = [...ws].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < ordered.length; i++)
        if (ordered[i].start < addTime(ordered[i - 1].start, r.duration))
          fail(
            "configuration",
            "Configured windows on a resource must not overlap",
            400,
          );
    }
  }
  validatePolicy(c.policy);
  if (c.policy.effective > now())
    fail("effective", "The initial house rule must already be effective", 400);
}
function validatePolicy(p) {
  if (
    !p?.version ||
    !p.authority ||
    !p.effective ||
    !Number.isFinite(Date.parse(p.effective)) ||
    !Array.isArray(p.bookerRoles) ||
    !p.bookerRoles.length ||
    !["manager", "self-service"].includes(p.route) ||
    !p.bookingRole ||
    !p.billingRole ||
    !p.operationsRole ||
    !p.disputeRole ||
    !(p.chooseDays > 0 && p.noticeDays > p.chooseDays)
  )
    fail(
      "configuration",
      "Policy requires authority, version, effective instant, roles, route and nested deadlines",
      400,
    );
  if (
    !p.caps ||
    typeof p.caps !== "object" ||
    Array.isArray(p.caps) ||
    Object.values(p.caps).some((v) => !Number.isInteger(v) || v < 1) ||
    !p.priceReference ||
    !p.salePriceReference
  )
    fail(
      "configuration",
      "Class caps must be positive whole numbers and billing price references are required",
      400,
    );
  p.effective = new Date(p.effective).toISOString();
}
function revisePolicy(h, input) {
  const current = policy(h);
  if (input.actor !== current.authority)
    fail(
      "authority",
      "Only " + current.authority + " may record a rule revision",
      403,
    );
  const p = input.policy;
  validatePolicy(p);
  if (p.effective <= now())
    fail("effective", "A revision must take effect in the future", 400);
  if (
    house(h).policies.some(
      (old) => old.version === p.version || old.effective === p.effective,
    )
  )
    fail("duplicate", "Policy version and effective instant must be unique");
  house(h).policies.push({ ...p, recordedAt: now(), recordedBy: input.actor });
  return house(h).policies.at(-1);
}
function disputeEvidence(b) {
  const versions = new Set(b.history.map((e) => e.policyVersion));
  return {
    booking: clone(b),
    policies: house(b.house)
      .policies.filter((p) => versions.has(p.version))
      .map(clone),
    relatedNotices: db.notices
      .filter((n) => n.holdings.includes(b.id))
      .map(clone),
  };
}
function openDispute(input) {
  const b = booking(input.booking),
    p = policy(b.house);
  if (input.role !== p.disputeRole)
    fail(
      "dispute-role",
      "The first stop for this house is " + p.disputeRole,
      403,
    );
  if (!input.reason) fail("reason", "Describe the dispute", 400);
  const d = {
    id: id("dispute"),
    booking: b.id,
    house: b.house,
    reason: input.reason,
    firstStop: p.disputeRole,
    openedAt: now(),
    policyVersion: p.version,
  };
  db.disputes.push(d);
  return { dispute: d, evidence: disputeEvidence(b) };
}
function readRoute(u) {
  const q = Object.fromEntries(u.searchParams);
  if (u.pathname === "/api/queue") {
    house(q.house);
    const entries = db.queues.filter(
      (e) => e.house === q.house && (!q.group || e.group === q.group),
    );
    return {
      entries,
      head: q.group ? waiting(q.house, q.group)[0] || null : null,
    };
  }
  if (u.pathname === "/api/notices")
    return {
      notices: db.notices
        .filter((n) => !q.house || n.house === q.house)
        .map(noticeView),
    };
  if (u.pathname === "/api/state") return { ...db, clock: now() };
  if (u.pathname === "/api/houses")
    return {
      houses: db.houses.map((h) => ({ ...h, currentPolicy: policy(h.id) })),
    };
  if (u.pathname === "/api/households")
    return {
      households: db.households.filter((x) => !q.house || x.house === q.house),
    };
  if (u.pathname === "/api/schedule")
    return { house: q.house, slots: schedule(q.house) };
  if (u.pathname === "/api/views") return views(q.house, q.date);
  if (u.pathname === "/api/releases")
    return {
      releases: db.releases
        .filter((r) => !q.house || r.house === q.house)
        .map((r) => ({ ...r, state: offerState(r) })),
    };
  if (u.pathname === "/api/bookings")
    return {
      bookings: db.bookings.filter((b) => !q.house || q.house === b.house),
    };
  fail("not-found", "Route not found", 404);
}
function command(route, input) {
  if (route === "/api/clock") {
    if (input.now === null) {
      db.now = null;
      settle();
      return { now: now() };
    }
    if (!Number.isFinite(Date.parse(input.now)))
      fail("clock", "ISO instant required", 400);
    db.now = new Date(input.now).toISOString();
    settle();
    return { now: now() };
  }
  if (route === "/api/houses") {
    validateHouse(input);
    if (db.houses.some((h) => h.id === input.id))
      fail("duplicate", "House exists");
    const h = {
      id: input.id,
      name: input.name,
      resources: input.resources,
      policies: [input.policy],
    };
    db.houses.push(h);
    return { house: h };
  }
  if (route === "/api/households") {
    house(input.house);
    if (!input.id || !input.role)
      fail("household", "Household id and tenure role required", 400);
    if (db.households.some((x) => x.house === input.house && x.id === input.id))
      fail("duplicate", "Household already registered");
    db.households.push(input);
    return { household: input };
  }
  if (route === "/api/bookings") {
    let b;
    try {
      b = requestBooking(input);
    } catch (e) {
      if (
        e.status &&
        input.house &&
        db.houses.some((h) => h.id === input.house)
      ) {
        const d = {
          id: id("decision"),
          house: input.house,
          household: input.household,
          request: input,
          outcome: "refused",
          reason: e.message,
          code: e.code,
          policyVersion: policy(input.house).version,
          at: now(),
        };
        db.decisions.push(d);
        e.decision = d;
      }
      throw e;
    }
    return { booking: b };
  }
  if (route === "/api/queue") return { entry: joinQueue(input) };
  if (route === "/api/scarcity/evaluate")
    return {
      notices: evaluateScarcity(input.house, input.group).map(noticeView),
    };
  const qm = route.match(/^\/api\/queue\/([^/]+)\/withdraw$/);
  if (qm) return { entry: withdrawQueue(qm[1], input) };
  const nm = route.match(/^\/api\/notices\/([^/]+)\/(choose|claim)$/);
  if (nm) {
    const n = notice(nm[1]);
    return {
      notice: noticeView(
        nm[2] === "choose" ? chooseHolding(n, input) : claimNotice(n, input),
      ),
    };
  }
  if (route === "/api/releases") return { release: offer(input) };
  const rm = route.match(/^\/api\/releases\/([^/]+)\/(take|withdraw)$/);
  if (rm)
    return {
      release:
        rm[2] === "take"
          ? take(release(rm[1]), input)
          : withdraw(release(rm[1]), input),
    };
  const pm = route.match(/^\/api\/houses\/([^/]+)\/policies$/);
  if (pm) return { policy: revisePolicy(pm[1], input) };
  if (route === "/api/disputes") return openDispute(input);
  const m = route.match(/^\/api\/bookings\/([^/]+)\/give-up$/);
  if (m) return { booking: giveUp(booking(m[1]), input) };
  fail("not-found", "Route not found", 404);
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method === "POST") {
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1000000) fail("body", "Request too large", 413);
        }
        try {
          body = JSON.parse(text || "{}");
        } catch {
          fail("json", "Invalid JSON", 400);
        }
      }
      settle();
      let result;
      if (req.method === "GET") result = readRoute(u);
      else if (req.method === "POST") {
        const before = clone(db);
        try {
          result = command(u.pathname, body);
          save();
        } catch (e) {
          if (e.decision) {
            const d = e.decision;
            db = before;
            db.decisions.push(d);
            db.sequence = Math.max(db.sequence, Number(d.id.split("-").at(-1)));
            save();
          } else db = before;
          throw e;
        }
      } else fail("method", "Method not allowed", 405);
      res.writeHead(
        req.method === "POST" &&
          ([
            "/api/bookings",
            "/api/houses",
            "/api/households",
            "/api/releases",
            "/api/disputes",
          ].includes(u.pathname) ||
            /^\/api\/houses\/[^/]+\/policies$/.test(u.pathname))
          ? 201
          : 200,
        { "Content-Type": "application/json", "Cache-Control": "no-store" },
      );
      res.end(JSON.stringify(result));
      return;
    }
    const files = {
      "/": "index.html",
      "/app.js": "app.js",
      "/style.css": "style.css",
      "/api-docs": "API.md",
    };
    const file = files[u.pathname];
    if (!file || !fs.existsSync(path.join(ROOT, file))) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(fs.readFileSync(path.join(ROOT, file)));
  } catch (e) {
    res.writeHead(e.status || 500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        code: e.code || "internal",
        reason: e.status ? e.message : "Internal error",
        ...(e.alternative ? { alternative: e.alternative } : {}),
        ...(e.existingBooking ? { existingBooking: e.existingBooking } : {}),
        ...(e.decision ? { decision: e.decision } : {}),
      }),
    );
    if (!e.status) console.error(e);
  }
});
server.listen(Number(process.argv[2] || 8901), "0.0.0.0", () =>
  console.log("LISTEN " + server.address().port),
);
