const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const pretty = (x) => esc(JSON.stringify(x, null, 2));
const empty = (text) => `<p class="empty">${esc(text)}</p>`;
const option = (value, text, selected = false) =>
  `<option value="${esc(value)}" ${selected ? "selected" : ""}>${esc(text)}</option>`;
let state,
  hs = [],
  current,
  slots = [],
  offers = [],
  ns = [];
const house = () => $("house").value;
const hh = () => $("household").value;
const p = () => current.currentPolicy;
async function api(url, body) {
  const r = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(Error(data.reason || "Request failed"), { data });
  return data;
}
function message(text, error = false) {
  $("message").hidden = false;
  $("message").className = error ? "error" : "";
  $("message").textContent = text;
}
async function mutate(url, body, text = "Booking record updated.") {
  try {
    const r = await api(url, body);
    await refresh();
    message(text);
    return r;
  } catch (e) {
    message(e.message, true);
    try {
      await refresh();
    } catch {}
    return null;
  }
}
const subject = (b) =>
  `${b.resourceName || b.resource} · ${b.date || b.weekday} ${b.start}–${b.end}`;
function active(b) {
  return !b.endedAt || b.endedAt > state.clock;
}
async function refresh() {
  const selectedHouse = house(),
    selectedHousehold = hh();
  const result = await Promise.all([api("/api/state"), api("/api/houses")]);
  state = result[0];
  hs = result[1].houses;
  $("house").innerHTML = hs
    .map((h) => option(h.id, h.name, h.id === selectedHouse))
    .join("");
  current = hs.find((h) => h.id === house());
  const households = state.households.filter((h) => h.house === house());
  $("household").innerHTML = households.length
    ? households
        .map((h) =>
          option(
            h.id,
            `Apartment ${h.id} · ${h.role}`,
            h.id === selectedHousehold,
          ),
        )
        .join("")
    : option("", "Register a household below");
  const data = await Promise.all([
    api("/api/schedule?house=" + encodeURIComponent(house())),
    api("/api/releases?house=" + encodeURIComponent(house())),
    api("/api/notices?house=" + encodeURIComponent(house())),
  ]);
  slots = data[0].slots;
  offers = data[1].releases;
  ns = data[2].notices;
  $("clock-label").textContent =
    (state.now ? "Scenario time: " : "Current time: ") +
    state.clock.replace("T", " ").slice(0, 19) +
    " UTC";
  $("route").textContent =
    p().route === "manager"
      ? `${current.name}: booking is manager-mediated. Requests go through ${p().bookingRole}; there is no resident self-service queue.`
      : `${current.name}: resident self-service, with a FIFO waiting queue within each eligible resource group.`;
  $("request-operator").value = p().bookingRole;
  $("operator-label").hidden = p().route !== "manager";
  const oldResource = $("request-resource").value;
  $("request-resource").innerHTML = current.resources
    .map((r) => option(r.id, r.name, r.id === oldResource))
    .join("");
  renderSchedule();
  renderBookings();
  renderOffers();
  renderQueue();
  renderNotices();
  renderPolicy();
  await renderViews();
}
function renderSchedule() {
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  $("schedule-grid").innerHTML = current.resources
    .map(
      (r) =>
        `<article class="resource"><h3>${esc(r.name)}</h3><small>${esc(r.sauna)} · ${r.duration} minutes · group ${esc(r.group)}</small>${days
          .filter((d) => r.days[d]?.length)
          .map(
            (d) =>
              `<div class="day"><div class="day-title">${d}</div>${slots
                .filter((s) => s.resource === r.id && s.weekday === d)
                .map(
                  (s) =>
                    `<button type="button" class="slot ${s.state}" data-resource="${esc(r.id)}" data-weekday="${d}" data-start="${s.start}"><span>${s.start} – ${s.end}<small>${esc(s.class)}</small></span><span class="tag">${s.state === "held" ? "Apartment " + esc(s.household) : "Free"}</span></button>`,
                )
                .join("")}</div>`,
          )
          .join(
            "",
          )}<p class="muted">Closed: ${days.filter((d) => !r.days[d]?.length).join(", ") || "none"}</p></article>`,
    )
    .join("");
}
function renderBookings() {
  const bs = state.bookings.filter(
    (b) => b.house === house() && b.household === hh() && active(b),
  );
  $("booking-list").innerHTML = bs.length
    ? bs
        .map(
          (b) =>
            `<article class="card"><span class="tag">${b.kind === "standing" ? "Standing weekly" : "One occurrence"}</span><h3 style="margin-top:14px">${esc(subject(b))}</h3><code>${esc(b.id)} · policy ${esc(b.policyVersion)}</code><p>Held by apartment ${esc(b.household)}${ns.some((n) => !n.lapsedAt && n.selected === b.id) ? " · Selected for lapse" : ""}</p><button class="danger" type="button" data-give-up="${esc(b.id)}">Give up ${b.kind === "standing" ? "standing slot" : "booking"}</button>${b.kind === "standing" ? `<details><summary>Release one week only</summary><form class="release-offer" data-booking="${esc(b.id)}"><label>Occurrence date (${esc(b.weekday)})<input name="date" type="date" required></label><label>Release mode<select name="mode"><option value="FREE">FREE · holder still pays</option><option value="SALE">SALE · bill the taker separately</option></select></label><button type="submit">Offer this occurrence</button></form></details>` : ""}</article>`,
        )
        .join("")
    : empty(
        "No current holdings for this household. Select a free window above.",
      );
}
function renderOffers() {
  const available = offers.filter((r) => r.state !== "withdrawn");
  $("release-list").innerHTML = available.length
    ? available
        .map((r) => {
          const b = state.bookings.find((b) => b.id === r.booking);
          return `<article class="card"><span class="tag">${esc(r.mode)} · ${esc(r.state)}</span><h3 style="margin-top:14px">${esc(b.resourceName)} · ${r.date}</h3><p>${b.start}–${b.end} · holder: apartment ${esc(r.holder)}${r.taker ? `<br>Taker: apartment ${esc(r.taker)}` : ""}</p><code>${esc(r.id)}</code><p class="muted">Later weeks remain with apartment ${esc(r.holder)}. ${r.mode === "FREE" ? "No occurrence fee for the taker." : "House resale price reference applies."}</p><div class="inline">${r.state === "released" && active(b) ? (hh() === r.holder ? `<button type="button" class="secondary" data-withdraw-offer="${r.id}">Withdraw untaken offer</button>` : `<button type="button" data-take="${r.id}">${r.mode === "SALE" ? "Buy" : "Take free"} occurrence</button>`) : ""}</div></article>`;
        })
        .join("")
    : empty(
        "No one-week offers. A standing holder can release one named occurrence from their booking above.",
      );
}
async function renderViews() {
  if (!current) return;
  const date = $("view-date").value,
    v = await api(
      "/api/views?house=" +
        encodeURIComponent(house()) +
        (date ? "&date=" + date : ""),
    );
  $("posted-view").innerHTML = v.posted.length
    ? v.posted
        .map(
          (b) =>
            `<div class="view-row"><p><strong>${esc(b.resourceName)}</strong><br>${esc(b.date || b.weekday)} ${b.start}–${b.end}<br>${b.household ? "Apartment " + esc(b.household) : "No user · " + esc(b.state)}</p><small>${esc(b.booking)}${b.occurrence ? " · " + esc(b.occurrence) : ""}</small></div>`,
        )
        .join("")
    : empty("No confirmed slots.");
  $("heater-view").innerHTML = v.heater.length
    ? v.heater
        .map(
          (b) =>
            `<div class="view-row"><p><strong>${esc(b.sauna)} / ${esc(b.resourceName)}</strong><br>${esc(b.date || b.weekday)} ${b.start}–${b.end}<br>Heat for apartment ${esc(b.household)}</p><small>${esc(b.booking)}</small></div>`,
        )
        .join("")
    : empty("No heating signal for these slots.");
  $("billing-view").innerHTML = v.billing.length
    ? v.billing
        .map(
          (b) =>
            `<div class="view-row"><p><strong>${esc(b.kind)} · payer: apartment ${esc(b.payer)}</strong><br>${b.date ? b.date + "<br>" : ""}Price reference: ${esc(b.priceReference)}</p><small>${esc(b.occurrence || b.booking)} · policy ${esc(b.policyVersion)}</small></div>`,
        )
        .join("")
    : empty("No standing or occurrence charge signal.");
}
function renderQueue() {
  const self = p().route === "self-service";
  $("queue-tools").hidden = !self;
  $("queue-route").textContent = self
    ? "Two independent clocks: choose a holding first; lose it only at its recorded lapse instant."
    : `Contact ${p().bookingRole} for bookings. This manager-mediated house does not offer a resident queue or automated scarcity notice.`;
  if (!self) return;
  const group = $("queue-group").value,
    groups = [...new Set(current.resources.map((r) => r.group))];
  $("queue-group").innerHTML = groups
    .map((g) => option(g, g, g === group))
    .join("");
  const entries = state.queues
    .filter(
      (q) =>
        q.house === house() &&
        q.group === $("queue-group").value &&
        q.status === "waiting",
    )
    .sort((a, b) => a.sequence - b.sequence);
  $("queue-list").innerHTML = entries.length
    ? entries
        .map(
          (q, i) =>
            `<div class="view-row"><strong>${i + 1}. Apartment ${esc(q.household)}${i === 0 ? " · queue-head" : ""}</strong> · accepted ${esc(q.acceptedAt)} ${q.household === hh() ? `<button type="button" class="secondary" data-withdraw-queue="${q.id}">Withdraw</button>` : ""}</div>`,
        )
        .join("")
    : empty("Nobody is waiting in this group.");
}
function renderNotices() {
  const list = ns;
  $("notice-list").innerHTML = list.length
    ? list
        .map(
          (n) =>
            `<article class="card"><span class="tag">${esc(n.status)} · group ${esc(n.group)}</span><h3 style="margin-top:14px">Apartment ${esc(n.household)}</h3><code>${n.id} · policy ${esc(n.policyVersion)}</code><p><strong>Choose by</strong> ${esc(n.chooseAt)}<br><strong>Lapse at</strong> ${esc(n.lapseAt)}</p><p>${n.selected ? "Selected holding: " + esc(n.selected) : "Choice right: " + (n.chooser ? "apartment " + esc(n.chooser) : "awaiting an eligible queue-head")}${n.pendingSuccessor ? "<br>Pending successor: apartment " + esc(n.pendingSuccessor) : ""}${n.offeredTo && !n.pendingSuccessor ? "<br>Pending offer to apartment " + esc(n.offeredTo) : ""}</p>${
              !n.lapsedAt && !n.selected && n.chooser === hh()
                ? `<form class="choose-form" data-notice="${n.id}"><label>Holding to yield<select name="booking">${n.holdings
                    .map((id) => {
                      const b = state.bookings.find((b) => b.id === id);
                      return option(id, subject(b));
                    })
                    .join(
                      "",
                    )}</select></label><button type="submit">Select holding for later lapse</button></form>`
                : ""
            }${!n.lapsedAt && n.selected && n.offeredTo === hh() && !n.pendingSuccessor ? `<div class="inline"><button type="button" data-claim="${n.id}" data-action="confirm">Confirm pending claim</button><button type="button" class="secondary" data-claim="${n.id}" data-action="decline">Decline</button></div>` : ""}<details><summary>Notice transitions</summary><pre>${pretty(n.history)}</pre></details></article>`,
        )
        .join("")
    : empty("No recorded notices.");
}
function renderPolicy() {
  const cp = p();
  $("roles").textContent =
    `Bookers: ${cp.bookerRoles.join(", ")} · Booking: ${cp.bookingRole} · Operations: ${cp.operationsRole} · Billing: ${cp.billingRole} · Disputes: ${cp.disputeRole} · Rule authority: ${cp.authority}`;
  $("policy-list").innerHTML = current.policies
    .map(
      (v) =>
        `<details><summary>${esc(v.version)} · effective ${esc(v.effective)} · ${esc(v.authority)}${v.version === cp.version ? " · current" : ""}</summary><pre>${pretty(v)}</pre></details>`,
    )
    .join("");
  if ($("policy-json").dataset.house !== house() || !$("policy-json").value) {
    const revision = {
      ...cp,
      version: cp.version + "-next",
      effective: new Date(Date.parse(state.clock) + 86400000).toISOString(),
    };
    delete revision.recordedAt;
    delete revision.recordedBy;
    $("policy-json").value = JSON.stringify(revision, null, 2);
    $("policy-json").dataset.house = house();
    $("policy-actor").value = cp.authority;
  }
  $("dispute-role").value = cp.disputeRole;
  const old = $("dispute-booking").value;
  $("dispute-booking").innerHTML = state.bookings
    .filter((b) => b.house === house())
    .map((b) =>
      option(
        b.id,
        b.id + " · apartment " + b.household + " · " + subject(b),
        b.id === old,
      ),
    )
    .join("");
  const bs = state.bookings.filter((b) => b.house === house()),
    ds = state.decisions.filter((d) => d.house === house());
  $("history-list").innerHTML =
    bs
      .map(
        (b) =>
          `<details><summary>${esc(b.id)} · ${esc(subject(b))}${b.endedAt ? " · ended" : ""}</summary><pre>${pretty(b.history)}</pre></details>`,
      )
      .join("") +
    ds
      .map(
        (d) =>
          `<details><summary>Refused ${esc(d.id)} · policy ${esc(d.policyVersion)}</summary><pre>${pretty(d)}</pre></details>`,
      )
      .join("") +
    (!bs.length && !ds.length ? empty("No booking decisions yet.") : "");
}
$("house").addEventListener("change", () =>
  refresh().catch((e) => message(e.message, true)),
);
$("household").addEventListener("change", () => {
  renderBookings();
  renderOffers();
  renderNotices();
  renderQueue();
});
$("refresh").addEventListener("click", () =>
  refresh().catch((e) => message(e.message, true)),
);
$("view-date").addEventListener("change", () =>
  renderViews().catch((e) => message(e.message, true)),
);
$("queue-group").addEventListener("change", renderQueue);
$("schedule-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-resource]");
  if (!b) return;
  $("request-resource").value = b.dataset.resource;
  $("request-weekday").value = b.dataset.weekday;
  $("request-start").value = b.dataset.start;
  $("request-date").value = "";
  $("request-details").open = true;
  $("request-details").scrollIntoView({ behavior: "smooth", block: "center" });
  $("request-start").focus({ preventScroll: true });
});
$("request-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = Object.fromEntries(new FormData(e.target));
  if (!input.date) delete input.date;
  const r = await mutate(
    "/api/bookings",
    { ...input, house: house(), household: hh() },
    "Slot confirmed. All three views now read this booking.",
  );
  if (r)
    message(
      `Confirmed ${subject(r.booking)} for apartment ${r.booking.household}. ${r.booking.id}`,
    );
});
$("booking-list").addEventListener("submit", async (e) => {
  if (!e.target.matches(".release-offer")) return;
  e.preventDefault();
  const input = Object.fromEntries(new FormData(e.target));
  await mutate(
    "/api/releases",
    { ...input, booking: e.target.dataset.booking, household: hh() },
    "One occurrence offered. Your weekly standing holding is unchanged.",
  );
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const d = b.dataset;
  if (d.giveUp) {
    if (
      !confirm(
        "Give up this booking? For a standing slot this ends the whole recurring holding, not just one week.",
      )
    )
      return;
    await mutate(
      "/api/bookings/" + d.giveUp + "/give-up",
      { household: hh() },
      "Booking given up. The list, heater and future standing charge no longer claim it.",
    );
  }
  if (d.take)
    await mutate(
      "/api/releases/" + d.take + "/take",
      { household: hh() },
      "Occurrence taken for this week only. Later weeks stay with the original holder.",
    );
  if (d.withdrawOffer)
    await mutate(
      "/api/releases/" + d.withdrawOffer + "/withdraw",
      { household: hh() },
      "Untaken offer withdrawn. Its holder may use the occurrence again.",
    );
  if (d.withdrawQueue)
    await mutate(
      "/api/queue/" + d.withdrawQueue + "/withdraw",
      { household: hh() },
      "Queue entry withdrawn. Existing notices retain their deadlines.",
    );
  if (d.claim)
    await mutate(
      "/api/notices/" + d.claim + "/claim",
      { household: hh(), action: d.action },
      d.action === "confirm"
        ? "Claim confirmed, pending the recorded lapse instant."
        : "Claim declined; the next eligible queue entry is offered the holding.",
    );
});
$("queue-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await mutate(
    "/api/queue",
    { house: house(), household: hh(), group: $("queue-group").value },
    "Waiting request accepted into this group’s FIFO queue.",
  );
});
$("evaluate").addEventListener("click", async () => {
  const r = await mutate("/api/scarcity/evaluate", {
    house: house(),
    group: $("queue-group").value,
  });
  if (r)
    message(
      r.notices.length
        ? "Scarcity notice recorded with two independent deadlines."
        : "No new notices. A free eligible slot, empty queue, or existing active notice prevents a new notice.",
    );
});
$("notice-list").addEventListener("submit", async (e) => {
  if (!e.target.matches(".choose-form")) return;
  e.preventDefault();
  await mutate(
    "/api/notices/" + e.target.dataset.notice + "/choose",
    { household: hh(), booking: new FormData(e.target).get("booking") },
    "Holding selected. It remains usable until the recorded lapse instant.",
  );
});
$("household-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = Object.fromEntries(new FormData(e.target));
  const r = await mutate(
    "/api/households",
    { ...input, house: house() },
    "Household registered in this house.",
  );
  if (r) {
    $("household").value = input.id;
    renderBookings();
    renderOffers();
    renderQueue();
    renderNotices();
    e.target.reset();
  }
});
$("house-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const config = JSON.parse($("house-json").value),
      r = await mutate(
        "/api/houses",
        config,
        "House created. Register an eligible household to book here.",
      );
    if (r) {
      $("house").value = config.id;
      await refresh();
      $("household-form").scrollIntoView({ behavior: "smooth" });
    }
  } catch (e) {
    message(e.message, true);
  }
});
$("policy-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await mutate(
      "/api/houses/" + encodeURIComponent(house()) + "/policies",
      {
        actor: $("policy-actor").value,
        policy: JSON.parse($("policy-json").value),
      },
      "Revision recorded. Earlier decisions and notice deadlines retain their original policy version.",
    );
    if (r) $("policy-json").value = "";
  } catch (e) {
    message(e.message, true);
  }
});
$("dispute-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await mutate(
    "/api/disputes",
    {
      booking: $("dispute-booking").value,
      role: $("dispute-role").value,
      reason: $("dispute-reason").value,
    },
    "Dispute opened with its booking evidence.",
  );
  if (r) $("dispute-result").textContent = JSON.stringify(r, null, 2);
});
$("clock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await mutate(
    "/api/clock",
    { now: $("scenario-now").value || null },
    "Clock updated. Due selected holdings have lapsed; untaken offers expire at their starts.",
  );
});
function example(family = false) {
  return {
    id: family ? "masthugget-example" : "self-service",
    name: family
      ? "Family-time example (Masthugget policy)"
      : "Self-service example",
    resources: [
      {
        id: "room",
        name: "Dressing room",
        sauna: "Example sauna",
        group: "A",
        duration: 90,
        days: family
          ? {
              Saturday: [
                { start: "17:00", class: "family" },
                { start: "18:30", class: "family" },
              ],
              Sunday: [{ start: "17:00", class: "family" }],
              Tuesday: [{ start: "17:00", class: "women" }],
              Wednesday: [{ start: "17:00", class: "men" }],
            }
          : {
              Tuesday: [
                { start: "17:00", class: "ordinary" },
                { start: "18:30", class: "ordinary" },
                { start: "20:00", class: "ordinary" },
              ],
            },
      },
    ],
    policy: {
      version: "v1",
      authority: "board",
      effective: "2020-01-01T00:00:00Z",
      bookerRoles: ["tenant"],
      route: "self-service",
      bookingRole: "manager",
      operationsRole: "caretaker",
      billingRole: "billing",
      disputeRole: "caretaker",
      chooseDays: 14,
      noticeDays: 30,
      caps: family ? { family: 1 } : {},
      priceReference: "house-standing-fee",
      salePriceReference: "house-resale-fee",
    },
  };
}
$("self-example").addEventListener(
  "click",
  () => ($("house-json").value = JSON.stringify(example(), null, 2)),
);
$("family-example").addEventListener(
  "click",
  () => ($("house-json").value = JSON.stringify(example(true), null, 2)),
);
$("house-json").value = JSON.stringify(example(), null, 2);
refresh().catch((e) =>
  message("Could not read booking record: " + e.message, true),
);
