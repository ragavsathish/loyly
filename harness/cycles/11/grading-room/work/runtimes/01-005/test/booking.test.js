import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { BookingStore } from '../src/domain.js';
import { createApp } from '../src/server.js';

const BASE = 'http://127.0.0.1:0';
let port;
let server;
let baseUrl;

function storeFromServer() {
  return globalThis.__loylyStore;
}

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const body = await res.json();
  return { status: res.status, body };
}

before(async () => {
  const store = new BookingStore();
  globalThis.__loylyStore = store;
  const app = createApp(store);
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
});

beforeEach(async () => {
  await api('/api/test/reset', { method: 'POST', body: '{}' });
});

describe('@item-01-001', () => {
  it('The weekly schedule shows each dressing rooms own sauna days', async () => {
    const { body } = await api('/api/schedule');
    const ph8Tue = body.dressingRooms['pukuhuone 8'].days.Tuesday;
    const ph9Tue = body.dressingRooms['pukuhuone 9'].days.Tuesday;
    assert.equal(ph8Tue.noSlots, false);
    assert.ok(ph8Tue.slots.some((s) => s.bookable));
    assert.equal(ph9Tue.noSlots, true);
    assert.equal(ph9Tue.slots.length, 0);
  });
});

describe('@item-01-002', () => {
  it('A standing slot cannot be requested on a closed day', async () => {
    const { status, body } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 9',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 409);
    assert.equal(body.reason, 'closed_day');
    assert.match(body.message, /Thursday/);
    assert.match(body.message, /Friday/);
    assert.match(body.message, /Saturday/);
  });
});

describe('@item-01-003', () => {
  it('A requested slot on an open day is confirmed', async () => {
    const { status, body } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.booking.endTime, '18:30');
    assert.match(body.message, /17:00/);
    assert.match(body.repeats, /Tuesday/);
  });
});

describe('@item-01-004', () => {
  it('A held slot cannot be confirmed for another household', async () => {
    await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    const { status, body } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '3',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 409);
    assert.equal(body.reason, 'held');
    const store = storeFromServer();
    assert.equal(
      store.bookings.filter(
        (b) =>
          b.dressingRoom === 'pukuhuone 8' &&
          b.weekday === 'Tuesday' &&
          b.startTime === '17:00'
      ).length,
      1
    );
    assert.equal(store.bookings[0].apartment, '12');
  });
});

describe('@item-01-005', () => {
  it('A second standing slot is granted while there is room', async () => {
    await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    const { status, body } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 9',
        weekday: 'Thursday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(storeFromServer().bookingsForApartment('12').length, 2);
  });
});

describe('@item-01-006', () => {
  it('A second standing slot is refused when the schedule is full', async () => {
    const store = storeFromServer();
    const positions = store.allStandingPositions();
    assert.ok(positions.length >= 2);
    const first = positions[0];
    await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: first.dressingRoom,
        weekday: first.weekday,
        startTime: first.startTime,
      }),
    });
    let i = 0;
    for (const p of positions) {
      if (p.dressingRoom === first.dressingRoom && p.weekday === first.weekday) {
        continue;
      }
      await api('/api/standing-slot/request', {
        method: 'POST',
        body: JSON.stringify({
          apartment: `99${i++}`,
          dressingRoom: p.dressingRoom,
          weekday: p.weekday,
          startTime: p.startTime,
        }),
      });
    }
    assert.equal(store.freeStandingPositions().length, 0);
    const { status, body } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 9',
        weekday: 'Friday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 409);
    assert.equal(body.reason, 'schedule_full');
    assert.match(body.message, /no free standing slot/i);
    assert.equal(body.suggestChoosing, false);
    assert.equal(store.bookingsForApartment('12').length, 1);
  });
});

describe('@item-01-007', () => {
  it('Confirming a booking updates all three derived views together', async () => {
    const { status } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 200);
    const list = (await api('/api/views/slot-list')).body.slots;
    const heater = (await api('/api/views/heater')).body.schedule;
    const billing = (await api('/api/views/billing')).body;
    assert.ok(list.some((s) => s.apartment === '12'));
    assert.ok(
      heater.some(
        (h) =>
          h.dressingRoom === 'pukuhuone 8' &&
          h.weekday === 'Tuesday' &&
          h.heatFrom === '17:00' &&
          h.heatTo === '18:30'
      )
    );
    assert.ok(
      billing.activeCharges.some(
        (c) => c.payer === '12' && c.basis === 'standing_slot'
      )
    );
    assert.equal(storeFromServer().derivedViewsConsistent(), true);
  });
});

describe('@item-01-008', () => {
  it('Giving up a slot leaves no derived view still claiming it', async () => {
    await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    const { status } = await api('/api/standing-slot/give-up', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 200);
    const list = (await api('/api/views/slot-list')).body.slots;
    const heater = (await api('/api/views/heater')).body.schedule;
    const billing = (await api('/api/views/billing')).body;
    assert.equal(list.length, 0);
    assert.equal(heater.length, 0);
    assert.equal(billing.activeCharges.length, 0);
    const stopped = billing.ledger.filter((e) => e.action === 'stopped');
    assert.ok(stopped.length >= 1);
    assert.equal(storeFromServer().derivedViewsConsistent(), true);
  });
});

describe('@item-01-009', () => {
  it('Two households request the same free slot with neither request answered', async () => {
    const payload = (apt) => ({
      method: 'POST',
      body: JSON.stringify({
        apartment: apt,
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    const [ra, rb] = await Promise.all([
      api('/api/standing-slot/request', payload('12')),
      api('/api/standing-slot/request', payload('3')),
    ]);
    const results = [ra.body, rb.body];
    const confirmed = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    assert.equal(confirmed.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, 'held');
    const list = (await api('/api/views/slot-list')).body.slots;
    assert.equal(
      list.filter(
        (s) =>
          s.weekday === 'Tuesday' &&
          s.dressingRoom === 'pukuhuone 8' &&
          s.time.startsWith('17:00')
      ).length,
      1
    );
    const billing = (await api('/api/views/billing')).body.activeCharges;
    assert.equal(
      billing.filter(
        (c) => c.weekday === 'Tuesday' && c.dressingRoom === 'pukuhuone 8'
      ).length,
      1
    );
    assert.equal(storeFromServer().derivedViewsConsistent(), true);
  });
});

describe('@item-01-010', () => {
  it('The race is run one hundred times and never confirms twice', async () => {
    for (let run = 0; run < 100; run++) {
      const store = new BookingStore();
      const [a, b] = await Promise.all([
        store.requestStandingSlot({
          apartment: '12',
          dressingRoom: 'pukuhuone 8',
          weekday: 'Tuesday',
          startTime: '17:00',
        }),
        store.requestStandingSlot({
          apartment: '3',
          dressingRoom: 'pukuhuone 8',
          weekday: 'Tuesday',
          startTime: '17:00',
        }),
      ]);
      const confirmed = [a, b].filter((r) => r.ok);
      const refused = [a, b].filter((r) => !r.ok);
      assert.equal(confirmed.length, 1, `run ${run}: must confirm exactly one`);
      assert.equal(refused.length, 1, `run ${run}: must refuse exactly one`);
      assert.equal(store.bookings.length, 1, `run ${run}: one holder in record`);
    }
  });
});

describe('@item-01-011', () => {
  it('The refusal for a closed day is judged usable', async () => {
    const { body: refusal } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 9',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    assert.equal(refusal.ok, false);
    const msg = refusal.message;
    assert.match(msg, /pukuhuone 8/i);
    assert.match(msg, /Tuesday/i);
    assert.match(msg, /17:00/);
    const { status, body: confirm } = await api('/api/standing-slot/request', {
      method: 'POST',
      body: JSON.stringify({
        apartment: '12',
        dressingRoom: 'pukuhuone 8',
        weekday: 'Tuesday',
        startTime: '17:00',
      }),
    });
    assert.equal(status, 200);
    assert.equal(confirm.ok, true);
  });
});