import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const base = '2030-01-01T08:00:00Z'
const date = '2030-01-08'
const afterChoose = '2030-01-15T08:00:00Z'
const afterLapse = '2030-01-31T08:00:00Z'
const standing = { resource: 'pukuhuone-8', weekday: 'Tuesday', start: '17:00' }
const booking = { ...standing, household: '12', role: 'shareholder' }
const family = { resource: 'family-room', date: '2030-01-05', start: '17:00', household: '12', role: 'tenant' }
function scenario(id, label, run) {
  test(id + ' ' + label, async () => {
    const { createServer } = await import('./server.mjs')
    const dir = mkdtempSync(new URL('./.test-', import.meta.url).pathname)
    const server = createServer({ allowClock: true, file: join(dir, 'record.json'), now: () => new Date(base) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const root = 'http://127.0.0.1:' + server.address().port
    const request = async (path, data) => {
      const response = await fetch(root + '/api/' + path, data === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
      })
      return { status: response.status, ...await response.json() }
    }
    try { await run(request) } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
const read = (api, view, house = 'soukanvuori', query = '') => api(house + '/' + view + query)
const act = (api, action, data, house = 'soukanvuori') => api(house + '/' + action, data)
const book = (api, fields = {}, house) => act(api, 'standing', { ...booking, ...fields }, house)
const ok = result => { assert.ok(result.status < 300, JSON.stringify(result)); return result }
const refuse = (result, reason) => { assert.ok(result.status >= 400); assert.equal(result.reason, reason); return result }
const release = async (api, mode = 'free') => {
  const holding = ok(await book(api)).booking
  return ok(await act(api, 'release', { bookingId: holding.id, date, household: '12', mode })).offer
}
const openViews = (api, day = date, house) => read(api, 'views', house, '?date=' + day)
const starts = (api, day, house) => openViews(api, day, house)
const take = (api, offer, household = '3') => act(api, 'take', { offerId: offer.id, household, role: 'shareholder' })
const clock = (api, now, house) => act(api, 'clock', { now }, house)
const race = async api => {
  const outcomes = await Promise.all([book(api), book(api, { household: '3' })])
  assert.equal(outcomes.filter(r => r.status === 201).length, 1)
  refuse(outcomes.find(r => r.status !== 201), 'held')
  const views = await openViews(api)
  assert.equal(views.posted.length, 1)
  assert.equal(views.heater.length, 1)
  assert.equal(views.billing.length, 1)
  assert.equal(views.posted[0].household, outcomes.find(r => r.status === 201).booking.household)
  return outcomes.find(r => r.status === 201).booking
}
scenario('@item-01-001', 'each dressing room has its own sauna days', async api => {
  const { slots } = await read(api, 'schedule')
  assert.ok(slots.some(s => s.weekday === 'Tuesday' && s.resource === 'pukuhuone-8' && s.state === 'free'))
  assert.ok(slots.every(s => s.weekday !== 'Tuesday' || s.resource !== 'pukuhuone-9'))
  assert.deepEqual([...new Set(slots.filter(s => s.resource === 'pukuhuone-9').map(s => s.weekday))], ['Thursday', 'Friday', 'Saturday'])
})
scenario('@item-01-002', 'closed-day refusal names open days', async api => {
  const result = refuse(await book(api, { resource: 'pukuhuone-9' }), 'closed_day')
  for (const word of ['pukuhuone 9', 'Tuesday', 'Thursday', 'Friday', 'Saturday']) assert.ok(result.message.includes(word))
})
scenario('@item-01-003', 'confirmed standing slot recurs', async api => {
  const result = ok(await book(api))
  assert.equal(result.booking.end, '18:30')
  for (const tuesday of [date, '2030-01-15', '2030-03-05']) assert.equal((await openViews(api, tuesday)).posted[0].household, '12')
})
scenario('@item-01-004', 'held slot refuses a second household', async api => {
  ok(await book(api))
  refuse(await book(api, { household: '3' }), 'held')
  assert.equal((await openViews(api)).posted[0].household, '12')
})
scenario('@item-01-005', 'a second holding is confirmed while capacity remains', async api => {
  ok(await book(api))
  ok(await book(api, { start: '18:30' }))
  assert.equal((await read(api, 'schedule')).slots.filter(s => s.household === '12').length, 2)
})
scenario('@item-01-006', 'full weekly schedule refuses a second holding', async api => {
  ok(await book(api))
  let n = 20
  for (const slot of (await read(api, 'schedule')).slots.filter(s => s.state === 'free')) ok(await book(api, { ...slot, household: String(n++) }))
  const result = refuse(await book(api), 'schedule_full')
  assert.match(result.message, /no free standing slot/i)
  assert.equal(result.alternative, undefined)
  assert.equal((await read(api, 'schedule')).slots.filter(s => s.household === '12').length, 1)
})
scenario('@item-01-007', 'confirmation updates list heater and billing', async api => {
  const { booking: held } = ok(await book(api))
  const views = await openViews(api)
  assert.equal(views.posted[0].household, '12')
  assert.deepEqual(views.heater.map(({ resource, start, end }) => [resource, start, end]), [['pukuhuone-8', '17:00', '18:30']])
  assert.deepEqual(views.billing.map(({ payer, bookingId, kind }) => [payer, bookingId, kind]), [['12', held.id, 'standing']])
})
scenario('@item-01-008', 'give-up removes all three claims', async api => {
  const { booking: held } = ok(await book(api))
  ok(await act(api, 'give-up', { bookingId: held.id, household: '12' }))
  const { posted, heater, billing } = await openViews(api)
  assert.deepEqual([posted, heater, billing], [[], [], []])
})
scenario('@item-01-009', 'overlapping standing requests pick one household', race)
scenario('@item-01-010', 'one hundred overlapping standing races pick one household each', async api => {
  for (let i = 0; i < 100; i++) {
    const held = await race(api)
    ok(await act(api, 'give-up', { bookingId: held.id, household: held.household }))
    assert.equal((await openViews(api)).posted.length, 0)
  }
})
scenario('@item-01-011', 'closed-day refusal alone supplies a confirmable request', async api => {
  const result = refuse(await book(api, { resource: 'pukuhuone-9' }), 'closed_day')
  const [, room, weekday, start] = /Request (pukuhuone \d+) on (\w+) at (\d\d:\d\d)/.exec(result.message)
  ok(await book(api, { resource: room, weekday, start }))
})
scenario('@item-02-001', 'free offer preserves the recurring holding', async api => {
  const offer = await release(api)
  assert.equal((await starts(api, date)).offers[0].state, 'available')
  assert.equal((await starts(api, '2030-01-15')).posted[0].household, '12')
  assert.equal(ok(await take(api, offer)).offer.taker, '3')
})
scenario('@item-02-002', 'offer covers only one week', async api => {
  const offer = await release(api)
  assert.equal((await starts(api, '2030-01-15')).offers.length, 0)
  ok(await take(api, offer))
  assert.equal((await starts(api, '2030-01-15')).posted[0].household, '12')
})
scenario('@item-02-003', 'expired unused occurrence preserves the standing fee', async api => {
  await release(api)
  ok(await clock(api, '2030-01-08T23:00:00Z'))
  const views = await starts(api, date)
  assert.equal(views.offers[0].state, 'unclaimed')
  assert.equal(views.posted.length + views.heater.length, 0)
  assert.equal(views.billing[0].payer, '12')
  assert.equal((await starts(api, '2030-01-15')).posted[0].household, '12')
})
scenario('@item-02-004', 'free occurrence has no taker fee', async api => {
  ok(await take(api, await release(api)))
  const views = await starts(api, date)
  assert.equal(views.posted[0].household, '3')
  assert.deepEqual(views.billing.map(s => s.payer), ['12'])
  assert.equal((await starts(api, '2030-01-15')).posted[0].household, '12')
})
scenario('@item-02-005', 'sale occurrence emits a distinct policy-bound charge', async api => {
  const offer = await release(api, 'sale')
  ok(await take(api, offer))
  const views = await starts(api, date)
  assert.equal(views.posted[0].household, '3')
  const resale = views.billing.find(s => s.kind === 'resale')
  assert.equal(resale.payer, '3')
  assert.equal(resale.occurrenceId, offer.id)
  assert.equal(resale.policyVersion, offer.policyVersion)
  assert.ok(resale.priceReference)
  assert.ok(views.billing.some(s => s.payer === '12' && s.kind === 'standing'))
  assert.equal((await starts(api, '2030-01-15')).posted[0].household, '12')
})
scenario('@item-02-006', 'untaken offer can be withdrawn before start', async api => {
  const offer = await release(api)
  ok(await act(api, 'withdraw-offer', { offerId: offer.id, household: '12' }))
  refuse(await take(api, offer), 'offer_unavailable')
  assert.equal((await starts(api, date)).posted[0].household, '12')
  assert.equal((await starts(api, '2030-01-15')).posted[0].household, '12')
})
scenario('@item-02-007', 'accepted transfer cannot be withdrawn', async api => {
  const offer = await release(api)
  ok(await take(api, offer))
  refuse(await act(api, 'withdraw-offer', { offerId: offer.id, household: '12' }), 'offer_unavailable')
  assert.equal((await starts(api, date)).posted[0].household, '3')
})
scenario('@item-02-008', 'offer expires at the exact local start instant', async api => {
  const offer = await release(api)
  ok(await clock(api, '2030-01-08T15:00:00Z'))
  refuse(await take(api, offer), 'offer_unavailable')
  const views = await starts(api, date)
  assert.equal(views.offers[0].state, 'unclaimed')
  assert.equal(views.billing[0].payer, '12')
  assert.equal((await starts(api, '2030-01-15')).posted[0].household, '12')
})
scenario('@item-02-009', 'all views follow one taken occurrence', async api => {
  const offer = await release(api, 'sale')
  ok(await take(api, offer))
  refuse(await take(api, offer, '4'), 'offer_unavailable')
  const { posted, heater, billing } = await starts(api, date)
  assert.equal(posted[0].household, '3')
  assert.equal(heater[0].occurrenceId, offer.id)
  assert.equal(billing.find(s => s.kind === 'resale').payer, '3')
})
scenario('@item-02-010', 'overlapping takes have one winner across views', async api => {
  const offer = await release(api, 'sale')
  const results = await Promise.all([take(api, offer), take(api, offer, '4')])
  assert.equal(results.filter(r => r.status < 300).length, 1)
  const { posted, heater, billing } = await starts(api, date)
  assert.equal(posted.length, 1)
  assert.equal(heater.length, 1)
  assert.equal(heater[0].household, posted[0].household)
  assert.equal(billing.filter(s => s.kind === 'resale').length, 1)
  assert.equal(billing.find(s => s.kind === 'resale').payer, posted[0].household)
})
const self = 'masthugget'
const grouped = { weekday: 'Saturday', resource: 'family-room' }
const queue = (api, household = '3', group = 'A') => act(api, 'queue', { household, role: 'tenant', group }, self)
const notices = async api => (await read(api, 'notices', self)).notices
const evaluate = (api, group = 'A') => act(api, 'evaluate-scarcity', { group, role: 'booking-operator' }, self)
async function capacity(api, { full = true, queued = true, count = 2 } = {}) {
  const slots = (await read(api, 'schedule', self)).slots.filter(s => s.group === 'A')
  const ids = []
  for (const [index, slot] of (full ? slots : slots.slice(0, count)).entries()) {
    ids.push(ok(await book(api, { ...slot, household: index < count ? '12' : String(20 + index), role: 'tenant' }, self)).booking)
  }
  if (queued) ok(await queue(api))
  return ids
}
const choose = (api, notice, selected, household = '12') => act(api, 'choose', { noticeId: notice.id, bookingId: selected.id, household }, self)
const claim = (api, notice, household, decision) => act(api, 'claim', { noticeId: notice.id, household, decision }, self)
const advance = (api, now) => clock(api, now, self)
async function setupNotice(api, selected = false) {
  const [first, second] = await capacity(api)
  const notice = ok(await evaluate(api)).notices[0]
  if (selected) ok(await choose(api, notice, first))
  return { notice, first, second }
}
const sched = (api, house = self) => read(api, 'schedule', house)
const holders = async api => (await sched(api)).slots.filter(s => s.household === '12')

scenario('@item-03-001', 'free eligible slot prevents scarcity notice', async api => {
  await capacity(api, { full: false })
  assert.equal(ok(await evaluate(api)).notices.length, 0)
  assert.equal((await holders(api)).length, 2)
})
scenario('@item-03-002', 'empty queue prevents scarcity notice', async api => {
  await capacity(api, { queued: false })
  assert.equal(ok(await evaluate(api)).notices.length, 0)
})
scenario('@item-03-003', 'one-week offer does not free standing capacity', async api => {
  const [held] = await capacity(api)
  ok(await act(api, 'release', { bookingId: held.id, date: '2030-01-05', household: '12', mode: 'free' }, self))
  assert.equal(ok(await evaluate(api)).notices[0].household, '12')
})
scenario('@item-03-004', 'another resource group does not trigger notice', async api => {
  await capacity(api, { queued: false })
  const bSlots = (await sched(api)).slots.filter(s => s.group === 'B')
  for (const [i, slot] of bSlots.entries()) ok(await book(api, { ...slot, household: String(40 + i), role: 'tenant' }, self))
  ok(await queue(api, '3', 'B'))
  assert.equal(ok(await evaluate(api)).notices.length, 0)
})
scenario('@item-03-005', 'queue is FIFO within its eligible group', async api => {
  await capacity(api)
  ok(await queue(api, '4'))
  const { groups } = await read(api, 'queue', self)
  assert.deepEqual(groups.A.map(entry => entry.household), ['3', '4'])
  assert.deepEqual(groups.B, [])
})
scenario('@item-03-006', 'holder chooses which holding to lose at lapse', async api => {
  const { notice, first, second } = await setupNotice(api)
  const result = ok(await choose(api, notice, second))
  assert.equal(result.notice.selectedBookingId, second.id)
  assert.equal(result.notice.lapseAt, afterLapse)
  assert.deepEqual((await holders(api)).map(s => s.bookingId).sort(), [first.id, second.id].sort())
})
scenario('@item-03-007', 'queue-head gains choice when the shorter clock elapses', async api => {
  const { notice, first } = await setupNotice(api)
  ok(await advance(api, afterChoose))
  const [updated] = await notices(api)
  assert.equal(updated.chooser, '3')
  refuse(await choose(api, notice, first), 'not_chooser')
  ok(await choose(api, notice, first, '3'))
  assert.equal((await holders(api)).length, 2)
})
scenario('@item-03-008', 'choose deadline is separate from loss', async api => {
  const { notice } = await setupNotice(api)
  assert.equal(notice.chooseAt, afterChoose)
  assert.equal(notice.lapseAt, afterLapse)
  ok(await advance(api, afterChoose))
  assert.equal((await notices(api))[0].lapseAt, notice.lapseAt)
  assert.equal((await holders(api)).length, 2)
})
scenario('@item-03-009', 'lapse affects only the selected holding and its views', async api => {
  const { first, second } = await setupNotice(api, true)
  ok(await advance(api, afterLapse))
  const views = await read(api, 'views', self)
  for (const entries of [views.posted, views.heater, views.billing]) {
    assert.ok(entries.some(s => s.bookingId === second.id))
    assert.ok(entries.every(s => s.bookingId !== first.id))
  }
  const history = await read(api, 'history', self, '?bookingId=' + first.id)
  assert.equal(history.events.at(-1).action, 'lapse')
})
scenario('@item-03-010', 'confirmed claim remains pending until lapse', async api => {
  const { notice, first } = await setupNotice(api, true)
  const result = ok(await claim(api, notice, '3', 'confirm'))
  assert.equal(result.notice.pendingSuccessor, '3')
  assert.ok((await holders(api)).some(s => s.bookingId === first.id))
  ok(await advance(api, afterLapse))
  assert.equal((await sched(api)).slots.find(s => s.resource === first.resource && s.weekday === first.weekday && s.start === first.start).household, '3')
})
scenario('@item-03-011', 'decline passes the claim to the next FIFO entry', async api => {
  const { notice, first } = await setupNotice(api, true)
  ok(await queue(api, '4'))
  assert.equal(ok(await claim(api, notice, '3', 'decline')).notice.offeredTo, '4')
  assert.ok((await holders(api)).some(s => s.bookingId === first.id))
})
scenario('@item-03-012', 'all declines return the selected holding to its pool', async api => {
  const { notice, first, second } = await setupNotice(api, true)
  ok(await queue(api, '4'))
  ok(await claim(api, notice, '3', 'decline'))
  ok(await claim(api, notice, '4', 'decline'))
  ok(await advance(api, afterLapse))
  assert.deepEqual((await holders(api)).map(s => s.bookingId), [second.id])
  assert.equal((await sched(api)).slots.find(s => s.resource === first.resource && s.weekday === first.weekday && s.start === first.start).state, 'free')
})
scenario('@item-03-013', 'withdrawal leaves recorded deadlines and loss intact', async api => {
  const { notice, first } = await setupNotice(api, true)
  ok(await act(api, 'withdraw-queue', { household: '3', group: 'A' }, self))
  const current = (await notices(api))[0]
  for (const field of ['chooseAt', 'lapseAt', 'policyVersion', 'selectedBookingId']) assert.equal(current[field], notice[field] ?? first.id)
  ok(await advance(api, afterLapse))
  assert.equal((await holders(api)).length, 1)
  assert.equal((await sched(api)).slots.find(s => s.resource === first.resource && s.weekday === first.weekday && s.start === first.start).state, 'free')
})
scenario('@item-03-014', 'repeated evaluation starts one notice on three holdings', async api => {
  await capacity(api, { count: 3 })
  const first = ok(await evaluate(api)).notices
  const second = ok(await evaluate(api)).notices
  assert.equal(second.length, 1)
  assert.equal(second[0].id, first[0].id)
  assert.equal(second[0].selectedBookingId, null)
})
const revise = (api, changes, house) => act(api, 'policies', {
  role: 'board', authority: 'board', version: 'v2', effectiveAt: '2030-01-02T08:00:00Z', changes
}, house)
scenario('@item-04-001', 'weekly calendars are scoped to their house', async api => {
  assert.ok((await sched(api, 'soukanvuori')).slots.some(s => s.weekday === 'Tuesday'))
  assert.ok((await sched(api)).slots.every(s => s.weekday !== 'Tuesday'))
})
scenario('@item-04-002', 'booker standing is checked against house role policy', async api => {
  ok(await book(api))
  refuse(await book(api, grouped, self), 'ineligible_role')
  ok(await book(api, { ...grouped, role: 'tenant' }, self))
  refuse(await book(api, { start: '18:30', role: 'tenant' }), 'ineligible_role')
})
scenario('@item-04-003', 'manager route and self-service queue remain house-specific', async api => {
  const manager = await read(api, 'route')
  assert.equal(manager.bookingOperatorRole, 'manager')
  assert.equal(manager.queueAvailable, false)
  assert.equal((await read(api, 'route', self)).queueAvailable, true)
  refuse(await act(api, 'queue', { household: '3', role: 'shareholder', group: 'A' }), 'queue_disabled')
})
scenario('@item-04-004', 'authorized revisions take effect only at their effective instant', async api => {
  const revised = ok(await revise(api, { bookerRoles: ['tenant'] })).policy
  assert.equal(revised.authority, 'board')
  assert.equal(ok(await book(api)).booking.policyVersion, 'v1')
  ok(await clock(api, revised.effectiveAt))
  const later = ok(await book(api, { start: '18:30', role: 'tenant' })).booking
  assert.equal(later.policyVersion, 'v2')
})
scenario('@item-04-005', 'dispute reconstructs confirmation and change', async api => {
  const booking = ok(await book(api)).booking
  ok(await act(api, 'give-up', { bookingId: booking.id, household: '12' }))
  const result = ok(await act(api, 'disputes', { bookingId: booking.id, role: 'manager' }))
  assert.deepEqual(result.events.map(e => [e.action, e.policyVersion, e.bookingId]), [['confirm', 'v1', booking.id], ['give-up', 'v1', booking.id]])
})
scenario('@item-04-006', 'policy revision leaves earlier refusal evidence intact', async api => {
  const refused = refuse(await book(api, { resource: 'pukuhuone-9' }), 'closed_day')
  ok(await revise(api, { bookerRoles: ['tenant'] }))
  ok(await clock(api, '2030-01-03T08:00:00Z'))
  const { events } = await read(api, 'history', undefined, '?decisionId=' + refused.decisionId)
  assert.deepEqual(events.map(e => [e.reason, e.message, e.policyVersion]), [[refused.reason, refused.message, 'v1']])
})
scenario('@item-04-007', 'new notice uses revised clocks while existing ones remain bound', async api => {
  const slots = (await sched(api)).slots.filter(s => s.group === 'A')
  for (const [i, slot] of slots.entries()) ok(await book(api, { ...slot, household: i < 2 ? '12' : (i === 2 ? '13' : String(20 + i)), role: 'tenant' }, self))
  ok(await queue(api))
  const old = ok(await evaluate(api)).notices.find(n => n.household === '12')
  ok(await revise(api, { chooseDays: 7, lapseDays: 21 }, self))
  ok(await advance(api, '2030-01-02T08:00:00Z'))
  const otherFree = (await sched(api)).slots.filter(s => s.group === 'A').at(-1)
  ok(await act(api, 'give-up', { bookingId: otherFree.bookingId, household: otherFree.household }, self))
  ok(await book(api, { ...otherFree, household: '13', role: 'tenant' }, self))
  const next = ok(await evaluate(api)).notices
  assert.deepEqual(next.find(n => n.id === old.id), old)
  const other = next.find(n => n.household === '13')
  assert.equal(other.policyVersion, 'v2')
  assert.equal(other.chooseAt, '2030-01-09T08:00:00Z')
  assert.equal(other.lapseAt, '2030-01-23T08:00:00Z')
})
const onceBooking = (api, fields, house = self) => act(api, 'occurrences', { ...family, ...fields }, house)
const laterFamily = { date: '2030-01-06' }
const other = { resource: 'regular-room', date: '2030-01-04' }
scenario('@item-05-001', 'family cap identifies the booking using the allowance', async api => {
  const { booking } = ok(await onceBooking(api))
  const refusal = refuse(await onceBooking(api, laterFamily), 'class_cap')
  assert.equal(refusal.existingBookingIds[0], booking.id)
  assert.match(refusal.message, /family time/i)
})
scenario('@item-05-002', 'another class does not consume family allowance', async api => {
  ok(await onceBooking(api, other))
  assert.equal(ok(await onceBooking(api)).booking.timeClass, 'family')
})
scenario('@item-05-003', 'family allowance does not block general windows', async api => {
  ok(await onceBooking(api))
  assert.equal(ok(await onceBooking(api, other)).booking.timeClass, 'general')
})
scenario('@item-05-004', 'another house does not inherit a class cap', async api => {
  ok(await onceBooking(api, {}, 'self-service'))
  ok(await onceBooking(api, laterFamily, 'self-service'))
})
scenario('@item-05-005', 'completed occurrence frees the allowance', async api => {
  ok(await onceBooking(api))
  ok(await advance(api, '2030-01-05T17:30:00Z'))
  ok(await onceBooking(api, laterFamily))
})
