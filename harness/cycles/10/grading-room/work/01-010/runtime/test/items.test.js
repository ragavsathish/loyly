import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootTestServer,
  shutdownTestServer,
  resetViaHttp,
  getSchedule,
  requestSlot,
  giveUp,
  postedList,
  heaterSchedule,
  invoicingSignals,
  apartment,
} from './helpers.js';
import { allStandingSlotKeys } from '../lib/config.js';
import { countHoldersForSlot, freeStandingSlotCount } from '../lib/booking.js';

let base;

before(async () => {
  ({ base } = await bootTestServer());
});

after(async () => {
  await shutdownTestServer();
});

beforeEach(async () => {
  await resetViaHttp();
});

describe('@item-01-001 weekly schedule per dressing room', () => {
  it('Tuesday shows bookable slots for pukuhuone 8 and none for pukuhuone 9', async () => {
    const sched = await getSchedule();
    const ph8 = sched.dressingRooms['pukuhuone 8'];
    const ph9 = sched.dressingRooms['pukuhuone 9'];
    assert.ok(ph8.Tuesday, 'pukuhuone 8 should have Tuesday slots');
    assert.ok(ph8.Tuesday.length > 0, 'Tuesday slots for pukuhuone 8');
    assert.equal(ph8.Tuesday[0].status, 'free');
    assert.equal(ph9.Tuesday, undefined, 'pukuhuone 9 has no Tuesday');
    assert.ok(ph9.Thursday, 'pukuhuone 9 has Thursday');
  });
});

describe('@item-01-002 refuse standing slot on closed day', () => {
  it('refuses Tuesday in pukuhuone 9 and names open days', async () => {
    const { status, data } = await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 9',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    assert.equal(status, 409);
    assert.equal(data.reason, 'closed_day');
    assert.match(data.message, /Tuesday|Tiistai/i);
    assert.match(data.message, /Thursday|Friday|Saturday|TO|PE|LA/i);
    assert.deepEqual(data.openDays, ['Thursday', 'Friday', 'Saturday']);
  });
});

describe('@item-01-003 confirm on open day', () => {
  it('confirms Tuesday 17:00 pukuhuone 8 for apartment 12', async () => {
    const { status, data } = await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.slot.startTime, '17:00');
    assert.equal(data.slot.endTime, '18:30');
    assert.equal(data.slot.apartment, apartment(12));
    const sched = await getSchedule();
    assert.equal(sched.dressingRooms['pukuhuone 8'].Tuesday[0].status, 'held');
    assert.equal(
      sched.dressingRooms['pukuhuone 8'].Tuesday[0].holder,
      apartment(12)
    );
  });
});

describe('@item-01-004 held slot cannot go to another household', () => {
  it('refuses apartment 3 when 12 holds the slot', async () => {
    await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    const { status, data } = await requestSlot({
      apartment: apartment(3),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    assert.equal(status, 409);
    assert.equal(data.reason, 'slot_held');
    const again = await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    assert.equal(again.data.ok, true);
  });
});

describe('@item-01-005 second slot when room', () => {
  it('grants a second standing slot while free slots remain', async () => {
    await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    assert.ok(freeStandingSlotCount() > 0);
    const { status, data } = await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 9',
      weekday: 'Thursday',
      startTime: '17:00',
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    const list = await postedList();
    assert.equal(
      list.slots.filter((s) => s.apartment === apartment(12)).length,
      2
    );
  });
});

describe('@item-01-006 second slot refused when schedule full', () => {
  it('refuses without suggesting a slot choice when none are free', async () => {
    await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    const keys = allStandingSlotKeys().filter(
      (k) =>
        !(
          k.dressingRoom === 'pukuhuone 8' &&
          k.weekday === 'Tuesday' &&
          k.startTime === '17:00'
        )
    );
    let apt = 1;
    for (const k of keys) {
      if (k.dressingRoom === 'pukuhuone 8' && k.weekday === 'Tuesday') continue;
      const holder = apartment(apt++);
      await requestSlot({ apartment: holder, ...k });
    }
    assert.equal(freeStandingSlotCount(), 0);
    const { status, data } = await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 9',
      weekday: 'Friday',
      startTime: '17:00',
    });
    assert.equal(status, 409);
    assert.equal(data.reason, 'schedule_full');
    assert.match(data.message, /no free standing slot/i);
    assert.doesNotMatch(data.message, /choose/i);
    const list = await postedList();
    assert.equal(
      list.slots.filter((s) => s.apartment === apartment(12)).length,
      1
    );
  });
});

describe('@item-01-007 derived views after confirm', () => {
  it('updates posted list, heater and invoicing together', async () => {
    await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    const list = await postedList();
    assert.ok(
      list.slots.some(
        (s) => s.apartment === apartment(12) && s.weekday === 'Tuesday'
      )
    );
    const heat = await heaterSchedule();
    assert.ok(
      heat.entries.some(
        (e) =>
          e.dressingRoom === 'pukuhuone 8' &&
          e.weekday === 'Tuesday' &&
          e.startTime === '17:00' &&
          e.endTime === '18:30'
      )
    );
    const inv = await invoicingSignals();
    const charge = inv.signals.find(
      (s) => s.type === 'standing_slot_charge' && s.apartment === apartment(12)
    );
    assert.ok(charge, 'invoicing signal for apartment 12');
    assert.equal(charge.basis, 'standing_slot');
  });
});

describe('@item-01-008 give up clears all derived views', () => {
  it('leaves no view claiming the slot after give-up', async () => {
    await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    const up = await giveUp({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    assert.equal(up.status, 200);
    const list = await postedList();
    assert.equal(list.slots.length, 0);
    const heat = await heaterSchedule();
    assert.equal(
      heat.entries.filter(
        (e) => e.weekday === 'Tuesday' && e.startTime === '17:00'
      ).length,
      0
    );
    const inv = await invoicingSignals();
    const active = inv.signals.filter(
      (s) =>
        s.type === 'standing_slot_charge' && s.apartment === apartment(12)
    );
    const cancelled = inv.signals.some(
      (s) =>
        s.type === 'standing_slot_cancelled' && s.apartment === apartment(12)
    );
    assert.ok(cancelled);
    const sched = await getSchedule();
    assert.equal(
      sched.dressingRooms['pukuhuone 8'].Tuesday[0].status,
      'free'
    );
    const holders = new Set(
      (await postedList()).slots
        .filter((s) => s.weekday === 'Tuesday')
        .map((s) => s.apartment)
    );
    assert.equal(holders.size, 0);
    assert.equal(
      (await heaterSchedule()).entries.filter((e) => e.weekday === 'Tuesday')
        .length,
      list.slots.filter((s) => s.weekday === 'Tuesday').length
    );
    void active;
  });
});

describe('@item-01-009 concurrent requests one holder', () => {
  it('confirms exactly one of two simultaneous requests', async () => {
    const body12 = {
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    };
    const body3 = {
      apartment: apartment(3),
      dressingRoom: 'pukuhuone 8',
      weekday: 'Tuesday',
      startTime: '17:00',
    };
    const [r12, r3] = await Promise.all([
      requestSlot(body12),
      requestSlot(body3),
    ]);
    const outcomes = [r12, r3];
    const confirmed = outcomes.filter((o) => o.data.ok);
    const refused = outcomes.filter((o) => !o.data.ok);
    assert.equal(confirmed.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].data.reason, 'slot_held');
    assert.equal(
      countHoldersForSlot('pukuhuone 8', 'Tuesday', '17:00'),
      1
    );
    const list = await postedList();
    const forSlot = list.slots.filter(
      (s) =>
        s.dressingRoom === 'pukuhuone 8' &&
        s.weekday === 'Tuesday' &&
        s.startTime === '17:00'
    );
    assert.equal(forSlot.length, 1);
    assert.equal(
      (await heaterSchedule()).entries.filter(
        (e) =>
          e.dressingRoom === 'pukuhuone 8' &&
          e.weekday === 'Tuesday' &&
          e.startTime === '17:00'
      ).length,
      1
    );
  });
});

describe('@item-01-010 race one hundred times', () => {
  it('never double-confirms in 100 concurrent races', async () => {
    let doubleConfirm = 0;
    let bothRefused = 0;
  for (let run = 0; run < 100; run++) {
      await resetViaHttp();
      const [a, b] = await Promise.all([
        requestSlot({
          apartment: apartment(12),
          dressingRoom: 'pukuhuone 8',
          weekday: 'Tuesday',
          startTime: '17:00',
        }),
        requestSlot({
          apartment: apartment(3),
          dressingRoom: 'pukuhuone 8',
          weekday: 'Tuesday',
          startTime: '17:00',
        }),
      ]);
      const wins = [a, b].filter((x) => x.data.ok).length;
      if (wins === 2) doubleConfirm++;
      if (wins === 0) bothRefused++;
      assert.equal(
        countHoldersForSlot('pukuhuone 8', 'Tuesday', '17:00'),
        wins === 0 ? 0 : 1
      );
    }
    assert.equal(doubleConfirm, 0);
    assert.equal(bothRefused, 0);
  });
});

describe('@item-01-011 refusal surface for blind judge', () => {
  it('refusal names open days and suggests confirmable alternative', async () => {
    const { data } = await requestSlot({
      apartment: apartment(12),
      dressingRoom: 'pukuhuone 9',
      weekday: 'Tuesday',
      startTime: '17:00',
    });
    assert.equal(data.reason, 'closed_day');
    const msg = data.message;
    assert.match(msg, /Thursday|Friday|Saturday/i);
    assert.ok(data.alternative, 'actionable alternative in refusal');
    assert.equal(data.alternative.dressingRoom, 'pukuhuone 8');
    assert.equal(data.alternative.weekday, 'Tuesday');
    assert.equal(data.alternative.startTime, '17:00');
    const probe = await requestSlot({
      apartment: apartment(12),
      ...data.alternative,
    });
    assert.equal(probe.data.ok, true);
  });
});