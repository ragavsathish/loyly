import { randomUUID } from 'node:crypto'
import { allSlots, dateAt, dayMs, initialHouses, instant, sameSlot, startAt, validDate, validateResources, weekdayOf } from './calendar.mjs'

export const newRecord = () => ({ clock: null, houses: initialHouses.map(h => ({
  id: h.id, name: h.name, zone: h.zone, policies: [{ ...structuredClone(h.policy), resources: structuredClone(h.resources) }],
  bookings: [], offers: [], queue: [], notices: [], events: [], disputes: []
})) })
const isText = value => typeof value === 'string' && value.trim().length > 0
const goodObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const byId = (records, id) => records.find(record => record.id === id)
const activeAt = (booking, now) => Date.parse(booking.confirmedAt) <= now && (!booking.endedAt || Date.parse(booking.endedAt) > now)
const activeHoldings = (house, now) => house.bookings.filter(b => b.kind === 'standing' && activeAt(b, now))
const policyAt = (house, now) => house.policies.filter(p => Date.parse(p.effectiveAt) <= now).at(-1) ?? house.policies[0]
const currentHouses = record => record.houses.map(({ id, name, zone }) => ({ id, name, zone }))
const failure = (status, reason, message, extra = {}) => ({ status, body: { reason, message, ...extra } })
const result = (body, status = 200) => ({ status, body })
const err = (reason, message, extra) => failure(409, reason, message, extra)
const invalid = message => failure(400, 'invalid_request', message)
const denied = (reason, message) => failure(403, reason, message)
const missing = type => failure(404, 'not_found', type + ' was not found.')

function append(house, action, at, policyVersion, details = {}) {
  const event = { id: randomUUID(), action, at: instant(at), policyVersion, ...details }
  house.events.push(event)
  return event
}
function confirm(house, slot, household, role, now, policy, coordinates = {}) {
  const booking = {
    ...slot, ...coordinates, id: randomUUID(), house: house.id, household, role,
    kind: coordinates.date ? 'occurrence' : 'standing',
    confirmedAt: instant(now), policyVersion: policy.version,
    priceReference: policy.standingPriceReference, billingRole: policy.billingRole
  }
  house.bookings.push(booking)
  append(house, 'confirm', now, policy.version, { bookingId: booking.id, booking: { ...booking } })
  return booking
}
function endBooking(house, booking, at, policyVersion, action, details = {}) {
  booking.endedAt = instant(at)
  for (const offer of house.offers.filter(o => o.bookingId === booking.id && !o.taker && !o.withdrawnAt && Date.parse(o.startsAt) > at)) {
    offer.withdrawnAt = instant(at)
    append(house, 'withdraw-offer', at, policyVersion, { bookingId: booking.id, offerId: offer.id, reason: 'holding_ended' })
  }
  append(house, action, at, policyVersion, { bookingId: booking.id, ...details })
}
const resourceFor = (policy, value) => policy.resources.find(r =>
  isText(value) && (r.id.toLowerCase() === value.trim().toLowerCase() || r.name.toLowerCase() === value.trim().toLowerCase()))
const waiting = (house, group) => house.queue.filter(q => q.group === group && q.state === 'waiting')
const queueHead = (house, notice) => {
  const reserved = new Set(house.notices.filter(n => n.id !== notice.id && !n.closedAt && n.pendingEntryId).map(n => n.pendingEntryId))
  return waiting(house, notice.group).find(q => q.household !== notice.household &&
    !notice.declinedEntryIds.includes(q.id) && !reserved.has(q.id))
}
function readableNotice(house, notice, now) {
  const head = queueHead(house, notice)
  const pending = byId(house.queue, notice.pendingEntryId)
  return {
    ...notice,
    chooser: notice.closedAt || notice.selectedBookingId ? null : now < Date.parse(notice.chooseAt) ? notice.household : head?.household ?? null,
    offeredTo: !notice.closedAt && notice.selectedBookingId && !pending ? head?.household ?? null : null,
    pendingSuccessor: pending?.household ?? null
  }
}
function settle(house, now) {
  const due = house.notices.filter(n => !n.closedAt && Date.parse(n.lapseAt) <= now)
  for (const notice of due.sort((a, b) => Date.parse(a.lapseAt) - Date.parse(b.lapseAt))) {
    const at = Date.parse(notice.lapseAt)
    const selected = byId(house.bookings, notice.selectedBookingId)
    const successor = byId(house.queue, notice.pendingEntryId)
    if (selected && activeAt(selected, at)) {
      endBooking(house, selected, at, notice.policyVersion, 'lapse', { noticeId: notice.id })
      if (successor?.state === 'waiting') {
        const policy = house.policies.find(p => p.version === notice.policyVersion)
        const { resource, room, sauna, group, weekday, start, end, minutes, timeClass } = selected
        const booking = confirm(house, { resource, room, sauna, group, weekday, start, end, minutes, timeClass },
          successor.household, successor.role, at, policy)
        successor.state = 'fulfilled'
        notice.successorBookingId = booking.id
      }
    }
    notice.closedAt = notice.lapseAt
    append(house, 'close-notice', at, notice.policyVersion, { noticeId: notice.id })
  }
}
function offerState(offer, now) {
  if (offer.taker) return 'taken'
  if (offer.withdrawnAt) return 'withdrawn'
  return now >= Date.parse(offer.startsAt) ? 'unclaimed' : 'available'
}
function schedule(house, policy, now) {
  const held = activeHoldings(house, now)
  return allSlots(policy).map(slot => {
    const booking = held.find(b => sameSlot(b, slot))
    return { ...slot, state: booking ? 'held' : 'free', household: booking?.household ?? null, bookingId: booking?.id ?? null }
  })
}
function views(house, now, date) {
  const posted = []
  const billing = []
  const add = (booking, household, occurrenceId) => {
    posted.push({
      bookingId: booking.id, household, resource: booking.resource, room: booking.room,
      sauna: booking.sauna, weekday: booking.weekday, start: booking.start, end: booking.end,
      date: date ?? null, occurrenceId: occurrenceId ?? null, timeClass: booking.timeClass
    })
  }
  const charge = (booking, payer, kind, offer) => {
    billing.push({
      bookingId: booking.id, payer, kind, resource: booking.resource, weekday: booking.weekday,
      start: booking.start, date: offer?.date ?? booking.date ?? null,
      occurrenceId: offer?.id ?? (booking.kind === 'occurrence' ? booking.id : null),
      policyVersion: offer?.salePolicyVersion ?? booking.policyVersion,
      priceReference: offer?.priceReference ?? booking.priceReference,
      billingRole: offer?.billingRole ?? booking.billingRole
    })
  }
  const transfers = date ? house.offers.filter(o => o.date === date && o.taker) : []
  const offers = house.offers.filter(o => date ? o.date === date : offerState(o, now) === 'available')
  for (const booking of house.bookings) {
    if (booking.kind === 'occurrence') {
      if (booking.date === date) add(booking, booking.household, booking.id)
      continue
    }
    if (date && booking.weekday !== weekdayOf(date)) continue
    const at = date ? startAt(date, booking.start, house.zone) : now
    if (!activeAt(booking, at)) continue
    charge(booking, booking.household, 'standing')
    const reserved = transfers.find(o => sameSlot(byId(house.bookings, o.bookingId), booking))
    if (reserved && reserved.bookingId !== booking.id) continue
    const offer = date ? house.offers.findLast(o => o.bookingId === booking.id && o.date === date) : null
    if (!offer || offer.withdrawnAt) add(booking, booking.household)
    else if (offer.taker) add(booking, offer.taker, offer.id)
  }
  for (const offer of house.offers) {
    if (offer.taker && offer.mode === 'sale' && (!date || date === offer.date)) {
      charge(byId(house.bookings, offer.bookingId), offer.taker, 'resale', offer)
    }
    // A confirmed transfer keeps its dated use even if the standing holder later gives up.
    if (date && offer.date === date && offer.taker && !posted.some(row => row.occurrenceId === offer.id)) {
      add(byId(house.bookings, offer.bookingId), offer.taker, offer.id)
    }
  }
  const heater = posted.map(({ bookingId, household, resource, room, sauna, weekday, date, start, end, occurrenceId }) =>
    ({ bookingId, household, resource, room, sauna, weekday, date, start, end, occurrenceId }))
  return { date: date ?? null, posted, heater, billing, offers: offers.map(o => ({ ...o, state: offerState(o, now) })) }
}

function bookingDecision(house, policy, now, body, standing) {
  const { household, role, start, date } = body
  const weekday = standing && isText(body.weekday)
    ? body.weekday.trim()[0].toUpperCase() + body.weekday.trim().slice(1).toLowerCase()
    : validDate(date) ? weekdayOf(date) : null
  const reject = (status, reason, message, details = {}) => {
    const event = append(house, 'refuse', now, policy.version, {
      household, request: { kind: standing ? 'standing' : 'occurrence', resource: body.resource, weekday, start, date, role },
      reason, message, ...details
    })
    return failure(status, reason, message, { policyVersion: policy.version, decisionId: event.id, ...details })
  }
  if (!isText(household)) return invalid('Enter a household or apartment number.')
  if (!policy.bookerRoles.includes(role)) return reject(403, 'ineligible_role',
    'This house accepts bookings from ' + policy.bookerRoles.join(', ') + '.')
  const held = activeHoldings(house, now)
  const slots = allSlots(policy)
  const own = held.filter(b => b.household === household)
  const free = slots.filter(s => !held.some(b => sameSlot(b, s)))
  if (standing && own.length && !free.length) return reject(409, 'schedule_full', 'The weekly schedule has no free standing slot.')
  if (standing && policy.standingLimit !== null && own.length >= policy.standingLimit) {
    return reject(409, 'standing_cap', 'This house allows up to ' + policy.standingLimit + ' standing slots per household.')
  }
  const resource = resourceFor(policy, body.resource)
  if (!resource) return reject(400, 'unknown_resource', 'Choose a dressing room from this house’s weekly schedule.')
  if (!weekday || (!standing && !validDate(date))) return invalid('Enter a weekday for a standing slot or a valid YYYY-MM-DD occurrence date.')
  const open = slots.filter(s => s.resource === resource.id)
  const onDay = open.filter(s => s.weekday === weekday)
  if (!onDay.length) {
    const days = [...new Set(open.map(s => s.weekday))]
    const alternative = standing && (free.find(s => s.weekday === weekday && s.start === start) ??
      free.find(s => s.resource === resource.id) ?? free[0])
    const hint = alternative ? ' Request ' + alternative.room + ' on ' + alternative.weekday + ' at ' + alternative.start + ' for a free standing slot.' : ''
    return reject(409, 'closed_day', resource.name + ' has no sauna day on ' + weekday + '. Open days: ' +
      (days.join(', ') || 'none configured') + '.' + hint, { openDays: days })
  }
  const slot = onDay.find(s => s.start === start)
  if (!slot) return reject(409, 'invalid_start', 'Choose a configured start time: ' + onDay.map(s => s.start).join(', ') + '.')
  const collides = b => b.resource === slot.resource && b.weekday === slot.weekday && b.start === slot.start
  if (held.some(collides)) return reject(409, 'held', 'That standing slot is already held.')
  if (standing) {
    if (house.bookings.some(b => b.kind === 'occurrence' && !b.endedAt && Date.parse(b.endsAt) > now && collides(b))) {
      return reject(409, 'held', 'A confirmed occurrence already uses that standing window.')
    }
    return result({ booking: confirm(house, slot, household, role, now, policy) }, 201)
  }
  const begins = startAt(date, start, house.zone)
  if (begins <= now) return reject(409, 'occurrence_started', 'That occurrence has already begun.')
  const dated = house.bookings.filter(b => b.kind === 'occurrence' && !b.endedAt)
  if (dated.some(b => b.date === date && collides(b)) || house.offers.some(o => o.date === date && o.taker &&
    collides(byId(house.bookings, o.bookingId)))) {
    return reject(409, 'held', 'That occurrence is already held.')
  }
  const cap = Object.hasOwn(policy.classCaps, slot.timeClass) ? policy.classCaps[slot.timeClass] : undefined
  const matching = dated.filter(b => b.household === household && b.timeClass === slot.timeClass && Date.parse(b.endsAt) > now)
  if (cap !== undefined && matching.length >= cap) {
    const label = slot.timeClass === 'family' ? 'family time' : slot.timeClass
    const descriptions = matching.map(b => b.room + ' on ' + b.date + ' at ' + b.start + ' (' + b.id + ')')
    return reject(409, 'class_cap', 'The ' + label + ' cap is ' + cap + ' active or upcoming bookings. Existing: ' + descriptions.join(', ') + '.',
      { timeClass: slot.timeClass, existingBookingIds: matching.map(b => b.id) })
  }
  return result({ booking: confirm(house, slot, household, role, now, policy, {
    date, startsAt: instant(begins), endsAt: instant(begins + slot.minutes * 60000)
  }) }, 201)
}

function releaseOccurrence(house, policy, now, body) {
  const { bookingId, date, household, mode = 'free' } = body
  const booking = byId(house.bookings, bookingId)
  if (!booking || booking.kind !== 'standing' || !activeAt(booking, now)) return missing('Active standing holding')
  if (household !== booking.household) return denied('not_holder', 'Only the standing holder can release its occurrence.')
  if (!validDate(date) || weekdayOf(date) !== booking.weekday || !['free', 'sale'].includes(mode)) {
    return invalid('Select one occurrence on ' + booking.weekday + ' and choose free or sale.')
  }
  const start = startAt(date, booking.start, house.zone)
  if (start <= now || house.offers.some(o => o.bookingId === bookingId && o.date === date && !o.withdrawnAt)) {
    return err('offer_unavailable', 'The occurrence has started or already has an offer.')
  }
  if (mode === 'sale' && !policy.resalePriceReference) return denied('sale_disabled', 'This house has no resale policy.')
  const offer = {
    id: randomUUID(), bookingId, date, household, mode, startsAt: instant(start),
    endsAt: instant(start + booking.minutes * 60000), policyVersion: policy.version
  }
  house.offers.push(offer)
  append(house, 'release', now, policy.version, { bookingId, offerId: offer.id, date, mode })
  return result({ offer: { ...offer, state: 'available' } }, 201)
}
function changeOffer(house, policy, now, body, taking) {
  const offer = byId(house.offers, body.offerId)
  if (!offer) return missing('Occurrence offer')
  if (!taking && body.household !== offer.household) return denied('not_holder', 'Only the standing holder can withdraw the offer.')
  if (offerState(offer, now) !== 'available') return err('offer_unavailable', 'That offer is taken, withdrawn, or has reached its start time.')
  if (taking) {
    if (!isText(body.household)) return invalid('Enter the taking household.')
    if (body.household === offer.household) return invalid('The standing holder can withdraw its offer instead.')
    if (!policy.bookerRoles.includes(body.role)) return denied('ineligible_role', 'Your role cannot book in this house.')
    if (offer.mode === 'sale' && !policy.resalePriceReference) return denied('sale_disabled', 'This house has no resale policy.')
    Object.assign(offer, {
      taker: body.household, takenAt: instant(now), takePolicyVersion: policy.version,
      ...(offer.mode === 'sale' && {
        salePolicyVersion: policy.version, priceReference: policy.resalePriceReference, billingRole: policy.billingRole
      })
    })
  } else {
    offer.withdrawnAt = instant(now)
  }
  append(house, taking ? 'take' : 'withdraw-offer', now, policy.version, {
    bookingId: offer.bookingId, offerId: offer.id, household: body.household, date: offer.date
  })
  return result({ offer: { ...offer, state: offerState(offer, now) } })
}

function queueChange(house, policy, now, body, joining) {
  if (policy.route !== 'self-service') return denied('queue_disabled', 'Contact the ' + policy.bookingOperatorRole + ' for booking requests.')
  if (!policy.resources.some(r => r.group === body.group)) return invalid('Choose a group listed in this house’s schedule.')
  if (!isText(body.household)) return invalid('Enter a household.')
  const existing = waiting(house, body.group).find(q => q.household === body.household)
  if (joining) {
    if (!policy.bookerRoles.includes(body.role)) return denied('ineligible_role', 'Your role cannot book in this house.')
    if (existing) return err('already_waiting', 'That household already has a waiting request for this group.')
    const entry = { id: randomUUID(), household: body.household, role: body.role, group: body.group,
      state: 'waiting', acceptedAt: instant(now), policyVersion: policy.version }
    house.queue.push(entry)
    append(house, 'join-queue', now, policy.version, { entryId: entry.id, group: entry.group, household: entry.household })
    return result({ entry }, 201)
  }
  if (!existing) return missing('Waiting request')
  existing.state = 'withdrawn'
  for (const notice of house.notices.filter(n => !n.closedAt && n.pendingEntryId === existing.id)) {
    notice.pendingEntryId = null
    append(house, 'withdraw-claim', now, notice.policyVersion, { noticeId: notice.id, bookingId: notice.selectedBookingId, entryId: existing.id })
  }
  append(house, 'withdraw-queue', now, policy.version, { entryId: existing.id, group: existing.group, household: existing.household })
  return result({ entry: existing })
}
function evaluateScarcity(house, policy, now, body) {
  if (body.role !== policy.bookingOperatorRole) return denied('unauthorized', 'Only the booking operator can evaluate scarcity.')
  if (policy.route !== 'self-service') return denied('queue_disabled', 'This house does not use a resident waiting queue.')
  const groupSlots = schedule(house, policy, now).filter(row => row.group === body.group)
  if (!groupSlots.length) return invalid('Choose a group listed in the weekly schedule.')
  const groupNotices = () => house.notices.filter(n => n.group === body.group && !n.closedAt).map(n => readableNotice(house, n, now))
  if (groupSlots.some(s => s.state === 'free') || !waiting(house, body.group).length) return result({ notices: groupNotices() })
  const holdings = new Map()
  for (const slot of groupSlots) {
    if (!holdings.has(slot.household)) holdings.set(slot.household, [])
    holdings.get(slot.household).push(slot.bookingId)
  }
  for (const [household, bookingIds] of holdings) {
    if (bookingIds.length < 2 || house.notices.some(n => !n.closedAt && n.household === household)) continue
    if (!waiting(house, body.group).some(q => q.household !== household)) continue
    const notice = {
      id: randomUUID(), group: body.group, household, bookingIds,
      openedAt: instant(now), chooseAt: instant(now + policy.chooseDays * dayMs),
      lapseAt: instant(now + policy.lapseDays * dayMs), policyVersion: policy.version,
      selectedBookingId: null, pendingEntryId: null, declinedEntryIds: []
    }
    house.notices.push(notice)
    append(house, 'open-notice', now, policy.version, { noticeId: notice.id, household, bookingIds, chooseAt: notice.chooseAt, lapseAt: notice.lapseAt })
  }
  return result({ notices: groupNotices() })
}
function noticeChange(house, now, body, choosing) {
  const notice = byId(house.notices, body.noticeId)
  if (!notice || notice.closedAt) return missing('Active notice')
  const current = readableNotice(house, notice, now)
  if (choosing) {
    if (!current.chooser || current.chooser !== body.household) return denied('not_chooser', 'This household does not currently have the right to choose.')
    const booking = byId(house.bookings, body.bookingId)
    if (!notice.bookingIds.includes(body.bookingId) || !activeAt(booking, now)) return invalid('Choose an active holding identified in the notice.')
    notice.selectedBookingId = body.bookingId
    append(house, 'select-holding', now, notice.policyVersion, { noticeId: notice.id, bookingId: booking.id, household: body.household })
  } else {
    if (!current.offeredTo || current.offeredTo !== body.household) return denied('not_queue_head', 'This household does not have the pending claim offer.')
    if (!['confirm', 'decline'].includes(body.decision)) return invalid('Decide whether to confirm or decline the claim.')
    const head = queueHead(house, notice)
    if (body.decision === 'confirm') notice.pendingEntryId = head.id
    else notice.declinedEntryIds.push(head.id)
    append(house, body.decision + '-claim', now, notice.policyVersion, { noticeId: notice.id,
      bookingId: notice.selectedBookingId, entryId: head.id, household: head.household })
  }
  return result({ notice: readableNotice(house, notice, now) })
}

const policyFields = new Set([
  'resources', 'bookerRoles', 'bookingOperatorRole', 'billingRole', 'disputeRole', 'authorityRole',
  'route', 'chooseDays', 'lapseDays', 'standingLimit', 'classCaps', 'standingPriceReference', 'resalePriceReference'
])
function validPolicy(p) {
  return validateResources(p.resources) &&
    Array.isArray(p.bookerRoles) && p.bookerRoles.length && p.bookerRoles.every(isText) &&
    [p.bookingOperatorRole, p.billingRole, p.disputeRole, p.authorityRole, p.standingPriceReference].every(isText) &&
    (p.resalePriceReference === null || isText(p.resalePriceReference)) &&
    ['manager-mediated', 'self-service'].includes(p.route) &&
    Number.isInteger(p.chooseDays) && Number.isInteger(p.lapseDays) &&
    p.chooseDays > 0 && p.lapseDays > p.chooseDays && p.lapseDays <= 3650 &&
    (p.standingLimit === null || (Number.isInteger(p.standingLimit) && p.standingLimit > 0)) &&
    goodObject(p.classCaps) && Object.values(p.classCaps).every(cap => Number.isInteger(cap) && cap > 0)
}
function revisePolicy(house, policy, now, body) {
  const { role, authority, version, effectiveAt, changes } = body
  if (role !== policy.authorityRole) return denied('unauthorized', 'This house requires ' + policy.authorityRole + ' authority.')
  if (!isText(authority) || !isText(version) || !goodObject(changes) ||
      Object.keys(changes).some(key => !policyFields.has(key))) return invalid('Supply a version, authority, effective instant and supported policy changes.')
  const at = Date.parse(effectiveAt)
  if (!Number.isFinite(at) || at < now || house.policies.some(p => p.version === version || Date.parse(p.effectiveAt) === at)) {
    return invalid('The revision needs a unique version and an effective instant at or after the current time.')
  }
  const next = { ...policyAt(house, at), ...changes, version, authority, effectiveAt: instant(at) }
  if (!validPolicy(next)) return invalid('Invalid policy configuration.')
  house.policies.push(next)
  house.policies.sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt))
  append(house, 'revise-policy', now, version, { authority, effectiveAt: next.effectiveAt })
  return result({ policy: next }, 201)
}
function eventsFor(house, bookingId, decisionId) {
  return house.events.filter(e => (!bookingId || e.bookingId === bookingId || e.bookingIds?.includes(bookingId)) &&
    (!decisionId || e.id === decisionId))
}
function dispute(house, policy, now, body) {
  if (body.role !== policy.disputeRole) return denied('unauthorized', 'Contact this house’s first dispute role: ' + policy.disputeRole + '.')
  if (!byId(house.bookings, body.bookingId)) return missing('Booking')
  const entry = { id: randomUUID(), bookingId: body.bookingId, role: body.role, openedAt: instant(now), policyVersion: policy.version }
  house.disputes.push(entry)
  return result({ dispute: entry, events: eventsFor(house, body.bookingId), policies: house.policies }, 201)
}

export function execute(record, realNow, method, segments, query, body, allowClock) {
  let now = record.clock ? Date.parse(record.clock) : realNow
  if (method === 'GET' && !segments.length) return result({ houses: currentHouses(record), now: instant(now) })
  const [id, action] = segments
  const house = byId(record.houses, id)
  if (!house || segments.length !== 2) return missing('House or action')
  settle(house, now)
  const policy = policyAt(house, now)
  if (method === 'GET') {
    switch (action) {
      case 'schedule': return result({ house: house.name, policyVersion: policy.version, slots: schedule(house, policy, now) })
      case 'views': {
        const date = query.get('date')
        if (date !== null && !validDate(date)) return invalid('Use a date in YYYY-MM-DD format.')
        return result(views(house, now, date))
      }
      case 'route': {
        const { route, bookingOperatorRole, bookerRoles, billingRole, disputeRole } = policy
        return result({ route, bookingOperatorRole, bookerRoles, billingRole, disputeRole,
          queueAvailable: route === 'self-service', policyVersion: policy.version, today: dateAt(now, house.zone), now: instant(now) })
      }
      case 'queue': {
        if (policy.route !== 'self-service') return denied('queue_disabled', 'Contact the ' + policy.bookingOperatorRole + ' for booking requests.')
        return result({ groups: Object.fromEntries([...new Set(policy.resources.map(r => r.group))].map(g => [g, waiting(house, g)])) })
      }
      case 'notices': return result({ notices: house.notices.map(n => readableNotice(house, n, now)) })
      case 'policies': return result({ current: policy, policies: house.policies })
      case 'history': return result({ events: eventsFor(house, query.get('bookingId'), query.get('decisionId')) })
      default: return missing('View')
    }
  }
  if (method !== 'POST') return failure(405, 'method_not_allowed', 'Use GET or POST.')
  if (!goodObject(body)) return invalid('Submit a JSON object.')
  switch (action) {
    case 'standing': return bookingDecision(house, policy, now, body, true)
    case 'occurrences': return bookingDecision(house, policy, now, body, false)
    case 'give-up': {
      const booking = byId(house.bookings, body.bookingId)
      if (!booking || booking.kind !== 'standing' || !activeAt(booking, now)) return missing('Active standing holding')
      if (booking.household !== body.household) return denied('not_holder', 'Only the standing holder can give it up.')
      endBooking(house, booking, now, policy.version, 'give-up')
      return result({ booking })
    }
    case 'release': return releaseOccurrence(house, policy, now, body)
    case 'take': return changeOffer(house, policy, now, body, true)
    case 'withdraw-offer': return changeOffer(house, policy, now, body, false)
    case 'queue': return queueChange(house, policy, now, body, true)
    case 'withdraw-queue': return queueChange(house, policy, now, body, false)
    case 'evaluate-scarcity': return evaluateScarcity(house, policy, now, body)
    case 'choose': return noticeChange(house, now, body, true)
    case 'claim': return noticeChange(house, now, body, false)
    case 'policies': return revisePolicy(house, policy, now, body)
    case 'disputes': return dispute(house, policy, now, body)
    case 'clock': {
      if (!allowClock) return missing('Action')
      const next = Date.parse(body.now)
      if (!Number.isFinite(next) || next < now) return invalid('Advance the clock to a valid instant at or after the current time.')
      now = next
      record.clock = instant(now)
      for (const item of record.houses) settle(item, now)
      return result({ now: record.clock })
    }
    default: return missing('Action')
  }
}
