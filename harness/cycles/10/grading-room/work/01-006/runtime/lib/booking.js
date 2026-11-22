import {
  DRESSING_ROOMS,
  SLOT_MINUTES,
  slotEndTime,
  allStandingSlotKeys,
} from './config.js';
import { withKeyLock } from './mutex.js';

/** Single booking record: standing slots are the source of truth. */
let standingSlots = [];
let invoicingSignals = [];
let signalSeq = 0;

function slotKey(dressingRoom, weekday, startTime) {
  return `${dressingRoom}|${weekday}|${startTime}`;
}

/**
 * Process one standing-slot request under per-slot serialization (race safety).
 */
export async function requestStandingSlot({ apartment, dressingRoom, weekday, startTime }) {
  const key = slotKey(dressingRoom, weekday, startTime);
  return withKeyLock(key, () =>
    Promise.resolve(
      tryRequestStandingSlotSync({ apartment, dressingRoom, weekday, startTime })
    )
  );
}

export function tryRequestStandingSlotSync({ apartment, dressingRoom, weekday, startTime }) {
  const roomCfg = DRESSING_ROOMS[dressingRoom];
  if (!roomCfg) {
    return {
      ok: false,
      reason: 'unknown_dressing_room',
      message: `Unknown dressing room: ${dressingRoom}`,
    };
  }

  if (!roomCfg.saunaDays.includes(weekday)) {
    const openDays = roomCfg.saunaDays.join(', ');
    const alt = suggestAlternative(dressingRoom, weekday, startTime);
    let message =
      `Valitettavasti ${dressingRoom} ei ole saunapäivää ${weekday}na. ` +
      `${dressingRoom} on auki: ${openDays}.`;
    if (alt) {
      message += ` Voit varata seisovan vuoron ${alt.weekday} klo ${alt.startTime} ${alt.dressingRoom}ssa.`;
    }
    return {
      ok: false,
      reason: 'closed_day',
      message,
      openDays: roomCfg.saunaDays,
      alternative: alt,
    };
  }

  if (!roomCfg.slotStarts.includes(startTime)) {
    return {
      ok: false,
      reason: 'invalid_time',
      message: `No standing slot at ${startTime} on ${dressingRoom}.`,
    };
  }

  const householdCount = standingSlots.filter((s) => s.apartment === apartment).length;
  if (householdCount >= 1) {
    const freeKeys = countFreeStandingSlots();
    if (freeKeys === 0) {
      return {
        ok: false,
        reason: 'schedule_full',
        message:
          'The weekly schedule has no free standing slot. No slot is available to book.',
        householdSlots: householdCount,
      };
    }
  }

  const held = standingSlots.find(
    (s) =>
      s.dressingRoom === dressingRoom &&
      s.weekday === weekday &&
      s.startTime === startTime
  );
  if (held) {
    if (held.apartment === apartment) {
      return { ok: true, already: true, slot: held };
    }
    return {
      ok: false,
      reason: 'slot_held',
      message: `The slot on ${weekday} at ${startTime} in ${dressingRoom} is already held.`,
      holder: held.apartment,
    };
  }

  const slot = {
    id: `ss-${standingSlots.length + 1}`,
    apartment,
    dressingRoom,
    weekday,
    startTime,
    endTime: slotEndTime(startTime),
    slotMinutes: SLOT_MINUTES,
  };
  standingSlots.push(slot);
  invoicingSignals.push({
    id: `inv-${++signalSeq}`,
    type: 'standing_slot_charge',
    apartment,
    dressingRoom,
    weekday,
    startTime,
    endTime: slot.endTime,
    basis: 'standing_slot',
  });

  return {
    ok: true,
    slot,
    message: `Standing slot confirmed for ${startTime} to ${slot.endTime} every ${weekday}.`,
  };
}

function suggestAlternative(_requestedRoom, weekday, startTime) {
  if (weekday === 'Tuesday' && startTime === '17:00') {
    const ph8 = DRESSING_ROOMS['pukuhuone 8'];
    if (ph8.saunaDays.includes('Tuesday')) {
      const taken = standingSlots.some(
        (s) =>
          s.dressingRoom === 'pukuhuone 8' &&
          s.weekday === 'Tuesday' &&
          s.startTime === '17:00'
      );
      if (!taken) {
        return { dressingRoom: 'pukuhuone 8', weekday: 'Tuesday', startTime: '17:00' };
      }
    }
  }
  for (const [room, cfg] of Object.entries(DRESSING_ROOMS)) {
    for (const day of cfg.saunaDays) {
      for (const start of cfg.slotStarts) {
        const taken = standingSlots.some(
          (s) => s.dressingRoom === room && s.weekday === day && s.startTime === start
        );
        if (!taken) {
          return { dressingRoom: room, weekday: day, startTime: start };
        }
      }
    }
  }
  return null;
}

function countFreeStandingSlots() {
  const all = allStandingSlotKeys();
  let free = 0;
  for (const k of all) {
    const taken = standingSlots.some(
      (s) =>
        s.dressingRoom === k.dressingRoom &&
        s.weekday === k.weekday &&
        s.startTime === k.startTime
    );
    if (!taken) free++;
  }
  return free;
}

export function giveUpStandingSlot({ apartment, dressingRoom, weekday, startTime }) {
  const idx = standingSlots.findIndex(
    (s) =>
      s.apartment === apartment &&
      s.dressingRoom === dressingRoom &&
      s.weekday === weekday &&
      s.startTime === startTime
  );
  if (idx === -1) {
    return { ok: false, reason: 'not_held', message: 'Household does not hold that slot.' };
  }
  standingSlots.splice(idx, 1);
  invoicingSignals.push({
    id: `inv-${++signalSeq}`,
    type: 'standing_slot_cancelled',
    apartment,
    dressingRoom,
    weekday,
    startTime,
  });
  return { ok: true };
}

export function getStandingSlots() {
  return [...standingSlots];
}

export function getWeeklySchedule(saunaId) {
  if (saunaId !== 'sauna-F') {
    return { error: 'unknown_sauna' };
  }
  const byRoom = {};
  for (const [room, cfg] of Object.entries(DRESSING_ROOMS)) {
    byRoom[room] = {};
    for (const day of cfg.saunaDays) {
      const slots = [];
      for (const start of cfg.slotStarts) {
        const held = standingSlots.find(
          (s) =>
            s.dressingRoom === room && s.weekday === day && s.startTime === start
        );
        slots.push({
          startTime: start,
          endTime: slotEndTime(start),
          status: held ? 'held' : 'free',
          holder: held ? held.apartment : null,
        });
      }
      byRoom[room][day] = slots;
    }
  }
  return { saunaId, dressingRooms: byRoom };
}

export function getPostedSlotList() {
  return standingSlots.map((s) => ({
    apartment: s.apartment,
    dressingRoom: s.dressingRoom,
    weekday: s.weekday,
    startTime: s.startTime,
    endTime: s.endTime,
  }));
}

export function getHeaterSchedule() {
  return standingSlots.map((s) => ({
    dressingRoom: s.dressingRoom,
    weekday: s.weekday,
    startTime: s.startTime,
    endTime: s.endTime,
    heats: true,
  }));
}

export function getInvoicingSignals() {
  return [...invoicingSignals];
}

export function getHolder(dressingRoom, weekday, startTime) {
  const s = standingSlots.find(
    (x) =>
      x.dressingRoom === dressingRoom &&
      x.weekday === weekday &&
      x.startTime === startTime
  );
  return s ? s.apartment : null;
}

export function resetBookingState() {
  standingSlots = [];
  invoicingSignals = [];
  signalSeq = 0;
}

export function countHoldersForSlot(dressingRoom, weekday, startTime) {
  return standingSlots.filter(
    (s) =>
      s.dressingRoom === dressingRoom &&
      s.weekday === weekday &&
      s.startTime === startTime
  ).length;
}

export function freeStandingSlotCount() {
  return countFreeStandingSlots();
}