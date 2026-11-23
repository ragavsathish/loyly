import http from 'node:http';
import { BookingStore } from './domain.js';
import { SAUNA_NAME } from './config.js';

export function createApp(store = new BookingStore()) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      const schedule = store.weeklySchedule();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head><title>Löyly — ${SAUNA_NAME}</title></head>
<body>
<h1>Löyly sauna booking</h1>
<p>Weekly schedule for <strong>${SAUNA_NAME}</strong> (sauna).</p>
<pre id="schedule">${JSON.stringify(schedule, null, 2)}</pre>
</body>
</html>`);
      return;
    }

    if (req.method === 'GET' && path === '/api/schedule') {
      return json(res, 200, store.weeklySchedule());
    }

    if (req.method === 'GET' && path === '/api/views/slot-list') {
      return json(res, 200, { slots: store.postedSlotList() });
    }

    if (req.method === 'GET' && path === '/api/views/heater') {
      return json(res, 200, { schedule: store.heaterSchedule() });
    }

    if (req.method === 'GET' && path === '/api/views/billing') {
      return json(res, 200, store.invoicingSignals());
    }

    if (req.method === 'POST' && path === '/api/standing-slot/request') {
      try {
        const body = await readBody(req);
        const result = await store.requestStandingSlot({
          apartment: String(body.apartment),
          dressingRoom: body.dressingRoom,
          weekday: body.weekday,
          startTime: body.startTime || '17:00',
        });
        const status = result.ok ? 200 : 409;
        return json(res, status, result);
      } catch {
        return json(res, 400, { ok: false, message: 'Invalid JSON body' });
      }
    }

    if (req.method === 'POST' && path === '/api/standing-slot/give-up') {
      try {
        const body = await readBody(req);
        const result = store.giveUpStandingSlot({
          apartment: String(body.apartment),
          dressingRoom: body.dressingRoom,
          weekday: body.weekday,
          startTime: body.startTime || '17:00',
        });
        const status = result.ok ? 200 : 404;
        return json(res, status, result);
      } catch {
        return json(res, 400, { ok: false, message: 'Invalid JSON body' });
      }
    }

    if (req.method === 'POST' && path === '/api/test/reset') {
      store.reset();
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not_found' });
  };

  return http.createServer(handler);
}

export function startServer(port, store) {
  const server = createApp(store);
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}