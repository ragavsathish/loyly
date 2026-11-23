/** Soukanvuori example configuration for sauna F (slice 01). */

export const SAUNA_ID = 'sauna-F';
export const SLOT_MINUTES = 90;

export const DRESSING_ROOMS = {
  'pukuhuone 8': {
    saunaDays: ['Tuesday'],
    slotStarts: ['17:00'],
  },
  'pukuhuone 9': {
    saunaDays: ['Thursday', 'Friday', 'Saturday'],
    slotStarts: ['17:00'],
  },
};

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function slotEndTime(start) {
  const [h, m] = start.split(':').map(Number);
  const total = h * 60 + m + SLOT_MINUTES;
  const eh = Math.floor(total / 60);
  const em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

export function allStandingSlotKeys() {
  const keys = [];
  for (const [room, cfg] of Object.entries(DRESSING_ROOMS)) {
    for (const day of cfg.saunaDays) {
      for (const start of cfg.slotStarts) {
        keys.push({ dressingRoom: room, weekday: day, startTime: start });
      }
    }
  }
  return keys;
}