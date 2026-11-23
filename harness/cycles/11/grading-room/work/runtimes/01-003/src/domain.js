import {
  DRESSING_ROOMS,
  SAUNA_NAME,
  SLOT_DURATION_MINUTES,
} from './config.js';

function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const eh = Math.floor(total / 60);
  const em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

function slotKey(dressingRoom, weekday, startTime) {
  return `${dressingRoom}|${weekday}|${startTime}`;
}

export class BookingStore {
  constructor(rooms = DRESSING_ROOMS) {
    this.rooms = structuredClone(rooms);
    this.bookings = [];
    this._locks = new Map();
    this._billingLedger = [];
  }

  reset() {
    this.bookings = [];
    this._billingLedger = [];
    this._locks.clear();
  }

  /** All standing-slot positions in the weekly grid (bookable whether free or held). */
  allStandingPositions() {
    const positions = [];
    for (const [room, cfg] of Object.entries(this.rooms)) {
      for (const day of cfg.saunaDays) {
        for (const start of cfg.bookableStarts) {
          positions.push({ dressingRoom: room, weekday: day, startTime: start });
        }
      }
    }
    return positions;
  }

  freeStandingPositions() {
    const held = new Set(
      this.bookings.map((b) => slotKey(b.dressingRoom, b.weekday, b.startTime))
    );
    return this.allStandingPositions().filter(
      (p) => !held.has(slotKey(p.dressingRoom, p.weekday, p.startTime))
    );
  }

  weeklySchedule() {
    const weekDays = [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ];
    const schedule = { sauna: SAUNA_NAME, dressingRooms: {} };
    for (const [room, cfg] of Object.entries(this.rooms)) {
      schedule.dressingRooms[room] = {
        saunaDays: [...cfg.saunaDays],
        days: {},
      };
      for (const day of weekDays) {
        if (!cfg.saunaDays.includes(day)) {
          schedule.dressingRooms[room].days[day] = { noSlots: true, slots: [] };
          continue;
        }
        const slots = cfg.bookableStarts.map((start) => {
          const booking = this.bookings.find(
            (b) =>
              b.dressingRoom === room &&
              b.weekday === day &&
              b.startTime === start
          );
          return {
            startTime: start,
            endTime: addMinutes(start, SLOT_DURATION_MINUTES),
            bookable: !booking,
            heldBy: booking ? booking.apartment : null,
          };
        });
        schedule.dressingRooms[room].days[day] = { noSlots: false, slots };
      }
    }
    return schedule;
  }

  bookingsForApartment(apartment) {
    return this.bookings.filter((b) => b.apartment === apartment);
  }

  async _withSlotLock(key, fn) {
    const prior = this._locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((res) => {
      release = res;
    });
    this._locks.set(key, gate);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === gate) {
        this._locks.delete(key);
      }
    }
  }

  async requestStandingSlot({ apartment, dressingRoom, weekday, startTime }) {
    const key = slotKey(dressingRoom, weekday, startTime);
    return this._withSlotLock(key, () =>
      this._requestStandingSlotSync({ apartment, dressingRoom, weekday, startTime })
    );
  }

  _requestStandingSlotSync({ apartment, dressingRoom, weekday, startTime }) {
    const roomCfg = this.rooms[dressingRoom];
    if (!roomCfg) {
      return {
        ok: false,
        reason: 'unknown_dressing_room',
        message: `Unknown dressing room ${dressingRoom}.`,
      };
    }

    if (!roomCfg.saunaDays.includes(weekday)) {
      const openDays = roomCfg.saunaDays.join(', ');
      const alt =
        this.rooms['pukuhuone 8']?.saunaDays.includes('Tuesday') &&
        dressingRoom === 'pukuhuone 9'
          ? ' You may request a standing slot on Tuesday at 17:00 in pukuhuone 8.'
          : '';
      return {
        ok: false,
        reason: 'closed_day',
        message:
          `Refused: ${dressingRoom} has no sauna day on ${weekday}. ` +
          `${dressingRoom} is open on ${openDays}.${alt}`,
        openDays: roomCfg.saunaDays,
      };
    }

    if (!roomCfg.bookableStarts.includes(startTime)) {
      return {
        ok: false,
        reason: 'invalid_time',
        message: `Start time ${startTime} is not bookable in ${dressingRoom}.`,
      };
    }

    const householdCount = this.bookingsForApartment(apartment).length;
    if (householdCount >= 2) {
      return {
        ok: false,
        reason: 'household_cap',
        message: `Apartment ${apartment} already holds two standing slots.`,
      };
    }

    if (householdCount === 1 && this.freeStandingPositions().length === 0) {
      return {
        ok: false,
        reason: 'schedule_full',
        message:
          'Refused: the weekly schedule has no free standing slot. ' +
          'There is no bookable position left in the standing schedule.',
        suggestChoosing: false,
      };
    }

    const existing = this.bookings.find(
      (b) =>
        b.dressingRoom === dressingRoom &&
        b.weekday === weekday &&
        b.startTime === startTime
    );
    if (existing) {
      return {
        ok: false,
        reason: 'held',
        message: `Refused: the slot on ${weekday} at ${startTime} in ${dressingRoom} is already held by apartment ${existing.apartment}.`,
        holder: existing.apartment,
      };
    }

    const endTime = addMinutes(startTime, SLOT_DURATION_MINUTES);
    const booking = {
      id: `${apartment}-${dressingRoom}-${weekday}-${startTime}`,
      apartment,
      dressingRoom,
      weekday,
      startTime,
      endTime,
      standing: true,
    };
    this.bookings.push(booking);
    this._billingLedger.push({
      type: 'standing_slot_charge',
      apartment,
      dressingRoom,
      weekday,
      startTime,
      action: 'raised',
    });

    return {
      ok: true,
      booking,
      message: `Standing slot confirmed for ${startTime} to ${endTime} every ${weekday}.`,
      repeats: `every coming ${weekday}`,
    };
  }

  giveUpStandingSlot({ apartment, dressingRoom, weekday, startTime }) {
    const idx = this.bookings.findIndex(
      (b) =>
        b.apartment === apartment &&
        b.dressingRoom === dressingRoom &&
        b.weekday === weekday &&
        b.startTime === startTime
    );
    if (idx === -1) {
      return { ok: false, reason: 'not_found' };
    }
    this.bookings.splice(idx, 1);
    this._billingLedger.push({
      type: 'standing_slot_charge',
      apartment,
      dressingRoom,
      weekday,
      startTime,
      action: 'stopped',
    });
    return { ok: true };
  }

  postedSlotList() {
    return this.bookings.map((b) => ({
      apartment: b.apartment,
      dressingRoom: b.dressingRoom,
      weekday: b.weekday,
      time: `${b.startTime}-${b.endTime}`,
    }));
  }

  heaterSchedule() {
    return this.bookings.map((b) => ({
      dressingRoom: b.dressingRoom,
      weekday: b.weekday,
      heatFrom: b.startTime,
      heatTo: b.endTime,
    }));
  }

  invoicingSignals() {
    const active = new Map();
    for (const b of this.bookings) {
      active.set(b.id, {
        payer: b.apartment,
        basis: 'standing_slot',
        dressingRoom: b.dressingRoom,
        weekday: b.weekday,
        startTime: b.startTime,
      });
    }
    return {
      activeCharges: [...active.values()],
      ledger: [...this._billingLedger],
    };
  }

  derivedViewsConsistent() {
    const list = this.postedSlotList();
    const heater = this.heaterSchedule();
    const billing = this.invoicingSignals();
    if (list.length !== this.bookings.length) return false;
    if (heater.length !== this.bookings.length) return false;
    if (billing.activeCharges.length !== this.bookings.length) return false;
    for (const b of this.bookings) {
      const inList = list.some(
        (e) =>
          e.apartment === b.apartment &&
          e.dressingRoom === b.dressingRoom &&
          e.weekday === b.weekday
      );
      const inHeat = heater.some(
        (e) =>
          e.dressingRoom === b.dressingRoom &&
          e.weekday === b.weekday &&
          e.heatFrom === b.startTime
      );
      const inBill = billing.activeCharges.some(
        (e) =>
          e.payer === b.apartment &&
          e.dressingRoom === b.dressingRoom &&
          e.weekday === b.weekday
      );
      if (!inList || !inHeat || !inBill) return false;
    }
    return true;
  }
}