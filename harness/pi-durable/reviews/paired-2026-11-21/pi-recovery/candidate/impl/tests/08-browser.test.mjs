import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { app, book, setupHouse, houseConfig } from "./support.mjs";
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail("Browser wait timed out");
}
async function browser(t, a) {
  const errors = [],
    virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(await (await fetch(a.url)).text(), {
    url: a.url,
    runScripts: "outside-only",
    virtualConsole,
  });
  t.after(() => {
    dom.window.close();
    assert.deepEqual(errors, []);
  });
  dom.window.fetch = (url, init) => fetch(new URL(url, a.url), init);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.confirm = () => true;
  dom.window.eval(await (await fetch(a.url + "/app.js")).text());
  const d = dom.window.document;
  await until(() => d.querySelector(".slot"));
  return {
    d,
    w: dom.window,
    el: (s) => d.querySelector(s),
    change(s, v) {
      const e = d.querySelector(s);
      e.value = v;
      e.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    submit(s) {
      d.querySelector("#message").hidden = true;
      d.querySelector(s).dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    },
    click(s) {
      d.querySelector(s).click();
    },
    async message(text) {
      await until(
        () =>
          !d.querySelector("#message").hidden &&
          d.querySelector("#message").textContent.includes(text),
      );
    },
  };
}
test("browser workflow: standing confirmation, sale, taking and dated derived views", async (t) => {
  const a = await app(t),
    b = await browser(t, a);
  b.click('[data-resource="ph8"][data-start="17:00"]');
  b.submit("#request-form");
  await b.message("Confirmed");
  assert(b.el("#posted-view").textContent.includes("Apartment 12"));
  const form = b.el(".release-offer");
  form.querySelector("[name=date]").value = "2030-01-08";
  form.querySelector("[name=mode]").value = "SALE";
  b.submit(".release-offer");
  await b.message("One occurrence offered");
  b.change("#household", "3");
  b.click("[data-take]");
  await b.message("Occurrence taken");
  b.change("#view-date", "2030-01-08");
  await until(() => b.el("#posted-view").textContent.includes("Apartment 3"));
  assert(b.el("#billing-view").textContent.includes("resale"));
  assert(b.el("#heater-view").textContent.includes("apartment 3"));
  b.change("#view-date", "2030-01-15");
  await until(() => b.el("#posted-view").textContent.includes("Apartment 12"));
});
test("browser workflow: reasoned refusal and giving up clear current views", async (t) => {
  const a = await app(t),
    b = await browser(t, a);
  b.change("#request-resource", "ph9");
  b.change("#request-weekday", "Tuesday");
  b.submit("#request-form");
  await b.message("It opens Thursday, Friday, Saturday");
  assert(
    b
      .el("#message")
      .textContent.includes("pukuhuone 8 (ph8) on Tuesday at 17:00"),
  );
  b.click('[data-resource="ph8"][data-start="17:00"]');
  b.submit("#request-form");
  await b.message("Confirmed");
  b.click("[data-give-up]");
  await b.message("Booking given up");
  assert(b.el("#posted-view").textContent.includes("No confirmed slots"));
  assert(
    b
      .el("#billing-view")
      .textContent.includes("No standing or occurrence charge"),
  );
});
test("browser workflow: create a family-policy house, register and enforce its class cap", async (t) => {
  const a = await app(t),
    b = await browser(t, a);
  b.click("#family-example");
  b.submit("#house-form");
  await b.message("House created");
  await until(() => b.el("#house").value === "masthugget-example");
  b.el("#household-form [name=id]").value = "12";
  b.el("#household-form [name=role]").value = "tenant";
  b.submit("#household-form");
  await b.message("Household registered");
  b.change("#request-date", "2030-01-05");
  b.change("#request-start", "17:00");
  b.submit("#request-form");
  await b.message("Confirmed");
  b.change("#request-start", "18:30");
  b.submit("#request-form");
  await b.message("family time cap");
  assert(b.el("#message").classList.contains("error"));
});
test("browser workflow: scoped queue, holder choice, pending claim and later lapse", async (t) => {
  const a = await app(t);
  await setupHouse(a, houseConfig("test", 2));
  for (const start of ["17:00", "18:30"])
    await book(a, "12", { resource: "r", weekday: "Tuesday", start }, "test");
  const b = await browser(t, a);
  b.change("#house", "test");
  await until(() => b.el("#queue-tools").hidden === false);
  b.change("#household", "3");
  b.submit("#queue-form");
  await b.message("Waiting request accepted");
  b.click("#evaluate");
  await b.message("Scarcity notice recorded");
  b.change("#household", "12");
  b.submit(".choose-form");
  await b.message("Holding selected");
  b.change("#household", "3");
  b.click('[data-claim][data-action="confirm"]');
  await b.message("Claim confirmed");
  assert(
    b.el("#notice-list").textContent.includes("Pending successor: apartment 3"),
  );
  b.el("#scenario-now").value = "2030-01-31T00:00:00Z";
  b.submit("#clock-form");
  await b.message("Clock updated");
  assert(b.el("#notice-list").textContent.includes("lapsed"));
  assert(b.el("#posted-view").textContent.includes("Apartment 3"));
});
