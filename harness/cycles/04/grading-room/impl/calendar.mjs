export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const duration = (start, minutes) => {
  const [hours, mins] = start.split(':').map(Number)
  const end = hours * 60 + mins + minutes
  return [Math.floor(end / 60) % 24, end % 60].map(n => String(n).padStart(2, '0')).join(':')
}
export const instant = ms => new Date(ms).toISOString().replace('.000Z', 'Z')
export const dayMs = 86400000
export function validDate(value) {
  if (typeof value !== 'string' || !dayPattern.test(value)) return false
  const ms = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(ms) && instant(ms).startsWith(value + 'T')
}
export const weekdayOf = date => weekdays[(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7]
const formatters = new Map()
function wallClock(ms, zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }))
  }
  return formatters.get(zone).format(ms).replace(' ', 'T')
}
export const dateAt = (ms, zone) => wallClock(ms, zone).slice(0, 10)
export function startAt(date, time, zone) {
  const wall = Date.parse(date + 'T' + time + ':00Z')
  let ms = wall
  for (let i = 0; i < 4; i++) {
    const offset = Date.parse(wallClock(ms, zone) + 'Z') - ms
    const next = wall - offset
    if (next === ms) return ms
    ms = next
  }
  throw new Error('This local time does not exist in the house time zone')
}

function windows(days, times, timeClass = 'general', minutes = 90) {
  return Object.fromEntries(days.map(day => [day, times.map(start => ({ start, minutes, timeClass }))]))
}
const family = {
  id: 'family-room', name: 'Family dressing room', sauna: 'Family sauna', group: 'A',
  calendar: windows(['Saturday', 'Sunday'], ['17:00', '18:30'], 'family')
}
const regular = {
  id: 'regular-room', name: 'Regular dressing room', sauna: 'Main sauna', group: 'B',
  calendar: {
    ...Object.fromEntries(['Monday', 'Wednesday'].map(day => [day, [
      { start: '17:00', minutes: 90, timeClass: 'women' },
      { start: '18:30', minutes: 90, timeClass: 'men' }
    ]])),
    Friday: [
      { start: '17:00', minutes: 90, timeClass: 'general' },
      { start: '18:30', minutes: 90, timeClass: 'men' }
    ]
  }
}
const basePolicy = {
  version: 'v1', effectiveAt: '2000-01-01T00:00:00Z', authority: 'board', authorityRole: 'board',
  bookerRoles: ['tenant'], bookingOperatorRole: 'booking-operator', billingRole: 'billing',
  disputeRole: 'booking-operator', route: 'self-service', chooseDays: 14, lapseDays: 30,
  standingLimit: null, classCaps: {}, standingPriceReference: 'standing-tariff',
  resalePriceReference: 'resale-tariff'
}
const soukanvuori = {
  id: 'soukanvuori', name: 'Soukanvuori', zone: 'Europe/Helsinki',
  resources: [
    { id: 'pukuhuone-8', name: 'pukuhuone 8', sauna: 'Sauna F', group: 'A', calendar: windows(['Tuesday'], ['17:00', '18:30']) },
    { id: 'pukuhuone-9', name: 'pukuhuone 9', sauna: 'Sauna F', group: 'B', calendar: windows(['Thursday', 'Friday', 'Saturday'], ['17:00', '18:30']) }
  ],
  policy: {
    ...basePolicy, bookerRoles: ['shareholder'], bookingOperatorRole: 'manager',
    disputeRole: 'manager', route: 'manager-mediated', standingLimit: 2
  }
}
const masthugget = {
  id: 'masthugget', name: 'Masthugget', zone: 'Europe/Stockholm', resources: [family, regular],
  policy: { ...basePolicy, classCaps: { family: 1 } }
}
const selfService = {
  id: 'self-service', name: 'Self-service example', zone: 'Europe/Stockholm', resources: [family, regular],
  policy: basePolicy
}
export const initialHouses = [soukanvuori, masthugget, selfService]
export const sameSlot = (a, b) => a.resource === b.resource && a.weekday === b.weekday && a.start === b.start
export function allSlots(house) {
  return house.resources.flatMap(resource => weekdays.flatMap(weekday =>
    (resource.calendar[weekday] ?? []).map(window => ({
      resource: resource.id, room: resource.name, sauna: resource.sauna, group: resource.group, weekday,
      ...window, end: duration(window.start, window.minutes)
    }))))
}
export function validateResources(resources) {
  if (!Array.isArray(resources) || !resources.length) return false
  const ids = new Set()
  for (const room of resources) {
    if (!room || typeof room !== 'object' || ![room.id, room.name, room.sauna, room.group].every(v => typeof v === 'string' && v.trim()) ||
        ids.has(room.id) || !room.calendar || typeof room.calendar !== 'object') return false
    ids.add(room.id)
    for (const [day, windows] of Object.entries(room.calendar)) {
      if (!weekdays.includes(day) || !Array.isArray(windows)) return false
      if (!windows.every(w => w && timePattern.test(w.start) && Number.isInteger(w.minutes) &&
        w.minutes > 0 && w.minutes <= 1440 && typeof w.timeClass === 'string')) return false
      if (new Set(windows.map(w => w.start)).size !== windows.length) return false
    }
  }
  return true
}
