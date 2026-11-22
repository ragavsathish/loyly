import { startServer } from '../lib/server.js';
import { resetBookingState } from '../lib/booking.js';

let server;
let base;

export async function bootTestServer() {
  resetBookingState();
  server = await startServer(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  return { base, server };
}

export async function shutdownTestServer() {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
  }
  resetBookingState();
}

export async function resetViaHttp() {
  const r = await fetch(`${base}/api/admin/reset`, { method: 'POST' });
  if (!r.ok) throw new Error('reset failed');
}

export async function getSchedule() {
  const r = await fetch(`${base}/api/schedule?sauna=sauna-F`);
  return r.json();
}

export async function requestSlot(body) {
  const r = await fetch(`${base}/api/standing-slots/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  return { status: r.status, data };
}

export async function giveUp(body) {
  const r = await fetch(`${base}/api/standing-slots/give-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

export async function postedList() {
  return (await fetch(`${base}/api/views/posted-list`)).json();
}

export async function heaterSchedule() {
  return (await fetch(`${base}/api/views/heater-schedule`)).json();
}

export async function invoicingSignals() {
  return (await fetch(`${base}/api/views/invoicing-signals`)).json();
}

export function apartment(n) {
  return `apartment ${n}`;
}