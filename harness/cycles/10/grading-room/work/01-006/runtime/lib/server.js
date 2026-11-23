import http from 'node:http';
import {
  requestStandingSlot,
  giveUpStandingSlot,
  getWeeklySchedule,
  getPostedSlotList,
  getHeaterSchedule,
  getInvoicingSignals,
  resetBookingState,
} from './booking.js';
import { SAUNA_ID } from './config.js';

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Löyly sauna booking</title></head>
<body>
<h1>Löyly — sauna slot booking</h1>
<p>Cooperative sauna (sauna) standing-slot booking for housing cooperatives.</p>
</body>
</html>`;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, contentType = 'application/json') {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

export function createApp() {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/') {
        return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && path === '/api/health') {
        return send(res, 200, { ok: true, sauna: SAUNA_ID });
      }

      if (req.method === 'POST' && path === '/api/admin/reset') {
        resetBookingState();
        return send(res, 200, { reset: true });
      }

      if (req.method === 'GET' && path === '/api/schedule') {
        const sauna = url.searchParams.get('sauna') || SAUNA_ID;
        return send(res, 200, getWeeklySchedule(sauna));
      }

      if (req.method === 'GET' && path === '/api/views/posted-list') {
        return send(res, 200, { slots: getPostedSlotList() });
      }

      if (req.method === 'GET' && path === '/api/views/heater-schedule') {
        return send(res, 200, { entries: getHeaterSchedule() });
      }

      if (req.method === 'GET' && path === '/api/views/invoicing-signals') {
        return send(res, 200, { signals: getInvoicingSignals() });
      }

      if (req.method === 'POST' && path === '/api/standing-slots/request') {
        const body = await readJson(req);
        const result = await requestStandingSlot(body);
        const status = result.ok ? 200 : 409;
        return send(res, status, result);
      }

      if (req.method === 'POST' && path === '/api/standing-slots/give-up') {
        const body = await readJson(req);
        const result = giveUpStandingSlot(body);
        const status = result.ok ? 200 : 404;
        return send(res, status, result);
      }

      if (req.method === 'GET' && path.startsWith('/api/refusal/')) {
        const last = decodeURIComponent(path.slice('/api/refusal/'.length));
        return send(res, 200, { refusal: last });
      }

      send(res, 404, { error: 'not_found' });
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  };
}

export function startServer(port) {
  const handler = createApp();
  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}