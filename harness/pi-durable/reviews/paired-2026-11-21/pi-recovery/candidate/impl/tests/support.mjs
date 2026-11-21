import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function app(t) {
  const dir = await mkdtemp(
    fileURLToPath(new URL("../.test-", import.meta.url)),
  );
  let child, url;
  async function launch() {
    child = spawn(process.execPath, ["server.mjs", "0"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, LOYLY_DATA: dir + "/record.json" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("boot timeout " + stderr)),
        5000,
      );
      child.stdout.on("data", (d) => {
        const m = String(d).match(/LISTEN (\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve("http://127.0.0.1:" + m[1]);
        }
      });
      child.on("exit", (c) => {
        clearTimeout(timer);
        reject(Error("server exit " + c + " " + stderr));
      });
    });
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      await done;
    }
  }
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  await launch();
  async function req(method, path, body) {
    const r = await fetch(url + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const v = await r.json();
    return { ...v, http: r.status };
  }
  const api = {
    get url() {
      return url;
    },
    get: (p) => req("GET", p),
    post: (p, b) => req("POST", p, b),
    restart: async () => {
      await stop();
      await launch();
    },
  };
  await api.post("/api/clock", { now: "2030-01-01T00:00:00Z" });
  return api;
}
export const slot = { resource: "ph8", weekday: "Tuesday", start: "17:00" };
export async function book(
  a,
  household = "12",
  s = slot,
  house = "soukanvuori",
) {
  return a.post("/api/bookings", {
    house,
    household,
    ...s,
    operator: "manager",
  });
}
export async function views(a, house = "soukanvuori", date) {
  return a.get("/api/views?house=" + house + (date ? "&date=" + date : ""));
}
export async function holding(a) {
  return (await book(a)).booking;
}
export function houseConfig(id = "test", n = 3) {
  return {
    id,
    name: id,
    resources: [
      {
        id: "r",
        name: "Room",
        sauna: "Sauna",
        group: "A",
        duration: 90,
        days: {
          Tuesday: Array.from({ length: n }, (_, i) => ({
            start: ["17:00", "18:30", "20:00", "15:30"][i],
            class: "ordinary",
          })),
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
      disputeRole: "manager",
      chooseDays: 14,
      noticeDays: 30,
      caps: {},
      priceReference: "standing-price",
      salePriceReference: "sale-price",
    },
  };
}
export async function setupHouse(a, c = houseConfig()) {
  await a.post("/api/houses", c);
  for (const id of ["12", "3", "4", "5"])
    await a.post("/api/households", { id, house: c.id, role: "tenant" });
  return c;
}
