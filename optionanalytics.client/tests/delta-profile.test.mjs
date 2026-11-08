// The delta profiles (deltaProfile.js): the options' on the spot chart (each strike's bar-proxy delta weighted by its
// delta, laid on the spot rows of the minute), the futures' from the footprint - worked values, the sides, the POC /
// value area, and NO LOOK-AHEAD: a profile at a clock equals the one built only from the minutes up to it. Then several
// sessions (OI Replay's "Previous day" / "Days" - a composite, the sessions before alone) and how the days before are
// loaded (deltaProfileDays.js - walked back, a holiday stepped over, stopped at a failure, kept for the tab).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { barProxyDelta, deltaWeight } from '../src/optionFlow.js'
import { finishDeltaProfile, futuresDeltaProfile, futuresDeltaProfileOf, optionDeltaMinutes, optionDeltaProfile, optionDeltaProfileOf, rowAt } from '../src/deltaProfile.js'
import { EXTRA_WEEKDAYS, cachedDay, footprintBars, futuresDayRecord, futuresDayUrl, loadFuturesDay, loadOptionDay, optionDayRecord, optionDayUrl, walkPastSessions, weekdaysBefore } from '../src/deltaProfileDays.js'
import { pastSessionsNeeded, profileSessions } from '../src/profileZones.js'

const T = Date.parse('2026-10-05T04:00:00Z')      // 09:30 IST
const MIN = 60_000
const close = (a, b) => Math.abs(a - b) < 1e-9

test('options on the spot chart: a minute\'s weighted delta and volume spread over the spot rows it traded in', () => {
  // Spot traded 100 - 110 that minute: rows 100, 105, 110 (5-point rows).
  const spot = [{ time: T, open: 101, high: 110, low: 100, close: 108 }]
  // A CE closing at its high (all buying) and a PE closing at its low (all selling).
  const ce = [{ time: new Date(T).toISOString(), strike: 105, open: 2, high: 10, low: 0, price: 10, volume: 300 }]
  const pe = [{ time: new Date(T).toISOString(), strike: 105, open: 8, high: 10, low: 0, price: 0, volume: 120 }]
  const wc = deltaWeight(105, 108, true), wp = deltaWeight(105, 108, false)
  const ceDelta = barProxyDelta({ high: 10, low: 0, close: 10, volume: 300 }) * wc      // +300 x w
  const peDelta = barProxyDelta({ high: 10, low: 0, close: 0, volume: 120 }) * wp       // -120 x w
  const net = optionDeltaProfile(ce, pe, spot, { rowSize: 5 })
  assert.deepEqual(net.rows.map((r) => r.price), [100, 105, 110])
  for (const r of net.rows) {
    assert.ok(close(r.delta, (ceDelta - peDelta) / 3), `${r.price}: ${r.delta}`)   // calls bought + puts sold: bullish
    assert.ok(close(r.volume, (300 * wc + 120 * wp) / 3))
  }
  assert.ok(net.totals.net > 0 && close(net.totals.net, ceDelta - peDelta))
  // CE alone / PE alone: that side's own buying (+) or selling (-).
  const onlyCe = optionDeltaProfile(ce, pe, spot, { rowSize: 5, side: 'ce' })
  const onlyPe = optionDeltaProfile(ce, pe, spot, { rowSize: 5, side: 'pe' })
  assert.ok(onlyCe.rows.every((r) => close(r.delta, ceDelta / 3) && close(r.volume, (300 * wc) / 3)))
  assert.ok(onlyPe.rows.every((r) => close(r.delta, peDelta / 3) && r.delta < 0))
  // A minute the spot had no bar for: its last price, one row.
  const later = [{ ...ce[0], time: new Date(T + MIN).toISOString() }]
  const gap = optionDeltaProfile(later, [], spot, { rowSize: 5, side: 'ce' })
  assert.deepEqual(gap.rows.map((r) => r.price), [105])
  // No spot known yet: nothing to lay it on.
  assert.equal(optionDeltaProfile(ce, pe, [], { rowSize: 5 }).rows.length, 0)
})

test('the POC, the value area, the largest bars, the row under the crosshair', () => {
  const p = finishDeltaProfile([
    { price: 100, volume: 10, delta: -4 }, { price: 105, volume: 50, delta: 12 }, { price: 110, volume: 30, delta: -20 },
    { price: 115, volume: 5, delta: 1 }, { price: 120, volume: 0, delta: 0 },
  ], 5)
  assert.deepEqual(p.rows.map((r) => r.price), [100, 105, 110, 115])        // an empty row left out
  assert.equal(p.poc, 105)
  // The value area as every profile in the app reads it: two rows at a time from the POC (30 + 5 above beat 10 below).
  assert.deepEqual([p.val, p.vah], [105, 115])
  assert.deepEqual([p.maxVolume, p.maxAbsDelta, p.volume, p.delta], [50, 20, 95, -11])
  assert.equal(rowAt(p, 112.4).price, 110)
  assert.equal(rowAt(p, 99), null)
  assert.equal(finishDeltaProfile([], 5).poc, null)
})

test('the futures: the footprint\'s buy and sell at each price, regrouped into rows; estimated minutes counted', () => {
  const bar = (k, levels, extra = {}) => ({ time: new Date(T + k * MIN).toISOString(), open: 0, high: 0, low: 0, close: 0, levels, ...extra })
  const bars = [
    bar(0, [{ price: 25001, buy: 100, sell: 40 }, { price: 25003, buy: 10, sell: 70 }]),
    bar(1, [{ price: 25006, buy: 0, sell: 90 }, { price: 25004, buy: 30, sell: 30 }]),
    bar(2, [{ price: 25012, buy: 500, sell: 0 }], { estimated: true }),
  ]
  const p = futuresDeltaProfile(bars, { rowSize: 5 })
  assert.deepEqual(p.rows.map((r) => [r.price, r.buy, r.sell, r.delta]), [[25000, 140, 140, 0], [25005, 0, 90, -90], [25010, 500, 0, 500]])
  assert.deepEqual([p.minutes, p.estimatedMinutes, p.poc], [3, 1, 25010])
  // At the second minute's clock: the third (later) not counted.
  const cut = futuresDeltaProfile(bars, { rowSize: 5, asOfMs: T + MIN + 30_000 })
  assert.deepEqual(cut.rows.map((r) => [r.price, r.delta]), [[25000, 0], [25005, -90]])
  assert.equal(cut.estimatedMinutes, 0)
})

test('NO LOOK-AHEAD: the options\' profile at a clock = the one built from the minutes up to it only', () => {
  const { run } = syntheticDay()
  const spot = run.spotCandlesOneMinute.map((b) => ({ time: Date.parse(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))
  // Give the option bars a range and volume (the synthetic chain has prices only).
  const withBars = (list) => list.map((p, k) => ({ ...p, open: p.price * 0.99, high: p.price * 1.02, low: p.price * 0.97, volume: 50 + (k % 7) * 10 }))
  const ce = withBars(run.cePoints), pe = withBars(run.pePoints)
  const full = optionDeltaProfile(ce, pe, spot, { rowSize: 5 })
  assert.ok(full.rows.length > 5 && full.minutes > 200)
  for (const k of [10, 90, 180]) {
    const clock = spot[k].time
    const keep = (list) => list.filter((p) => Date.parse(p.time) <= clock)
    for (const side of ['net', 'ce', 'pe']) {
      const atClock = optionDeltaProfile(ce, pe, spot, { rowSize: 5, side, asOfMs: clock + 40_000 })
      const cutDay = optionDeltaProfile(keep(ce), keep(pe), spot.filter((b) => b.time <= clock), { rowSize: 5, side })
      assert.deepEqual(atClock, cutDay, `${side} at minute ${k}`)
    }
  }
})

test('several sessions: a composite adds each day\'s rows up; one session is the day\'s own profile', () => {
  const { run } = syntheticDay()
  const spot = run.spotCandlesOneMinute.map((b) => ({ time: Date.parse(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))
  const withBars = (list) => list.map((p, k) => ({ ...p, open: p.price * 0.99, high: p.price * (k % 3 ? 1.02 : 1.0), low: p.price * 0.97, volume: 40 + (k % 5) * 10 }))
  const ce = withBars(run.cePoints), pe = withBars(run.pePoints)
  const day = optionDeltaMinutes(ce, pe, spot)
  // The same minutes on an earlier day, 120 points lower.
  const before = day.map((m) => ({ ...m, t: m.t - 86_400_000, low: m.low - 120, high: m.high - 120 }))
  for (const side of ['net', 'ce', 'pe']) {
    assert.deepEqual(optionDeltaProfileOf([day], { rowSize: 5, side }), optionDeltaProfile(ce, pe, spot, { rowSize: 5, side }))
    const both = optionDeltaProfileOf([before, day], { rowSize: 5, side })
    const one = optionDeltaProfileOf([day], { rowSize: 5, side })
    const other = optionDeltaProfileOf([before], { rowSize: 5, side })
    assert.equal(both.minutes, one.minutes + other.minutes)
    assert.ok(close(both.totals.net, one.totals.net + other.totals.net))
    const at = (p, price) => p.rows.find((r) => r.price === price) ?? { volume: 0, delta: 0 }
    for (const r of both.rows) {
      assert.ok(close(r.volume, at(one, r.price).volume + at(other, r.price).volume), `${side} ${r.price}`)
      assert.ok(close(r.delta, at(one, r.price).delta + at(other, r.price).delta), `${side} ${r.price}`)
    }
  }
  // The futures: two days' bars = the profile of both together.
  const bar = (day, k, levels) => ({ time: new Date(T + day * 86_400_000 + k * MIN).toISOString(), open: 0, high: 0, low: 0, close: 0, levels })
  const d1 = [bar(-1, 0, [{ price: 25001, buy: 100, sell: 40 }]), bar(-1, 1, [{ price: 25006, buy: 0, sell: 90 }])]
  const d2 = [bar(0, 0, [{ price: 25003, buy: 10, sell: 70 }]), bar(0, 1, [{ price: 25012, buy: 500, sell: 0 }])]
  assert.deepEqual(futuresDeltaProfileOf([d1, d2], { rowSize: 5 }), futuresDeltaProfile([...d1, ...d2], { rowSize: 5 }))
  assert.deepEqual(futuresDeltaProfileOf([d1, d2], { rowSize: 5 }).rows.map((r) => [r.price, r.delta]), [[25000, 0], [25005, -90], [25010, 500]])
})

test('Previous day / Days: the day so far with the sessions before it, or the sessions before alone - no look-ahead', () => {
  const past = [[{ t: T - 2 * 86_400_000, low: 100, high: 100, ceVol: 10, peVol: 0, ce: 10, pe: 0 }], [{ t: T - 86_400_000, low: 105, high: 105, ceVol: 0, peVol: 20, ce: 0, pe: 20 }]]
  const today = [{ t: T, low: 110, high: 110, ceVol: 5, peVol: 0, ce: -5, pe: 0 }, { t: T + MIN, low: 115, high: 115, ceVol: 7, peVol: 0, ce: 7, pe: 0 }]
  const rowsOf = (days, of, asOf = null) => {
    const known = today.filter((m) => asOf == null || m.t <= asOf)
    return optionDeltaProfileOf(profileSessions({ today: known, past, days, of }), { rowSize: 5 }).rows.map((r) => [r.price, r.delta])
  }
  assert.deepEqual(rowsOf(1, 'today'), [[110, -5], [115, 7]])
  assert.deepEqual(rowsOf(1, 'previous'), [[105, -20]])                       // yesterday alone: puts bought - bearish
  assert.deepEqual(rowsOf(2, 'previous'), [[100, 10], [105, -20]])
  assert.deepEqual(rowsOf(3, 'today'), [[100, 10], [105, -20], [110, -5], [115, 7]])
  // At the first minute's clock the day's second minute is not in it; the days before are whole.
  assert.deepEqual(rowsOf(2, 'today', T + 30_000), [[105, -20], [110, -5]])
  assert.deepEqual([pastSessionsNeeded(1, 'today'), pastSessionsNeeded(3, 'today'), pastSessionsNeeded(1, 'previous'), pastSessionsNeeded(3, 'previous')], [0, 2, 1, 3])
})

test('the days before: weekdays walked back one at a time, a holiday stepped over, stopped at a failure', async () => {
  assert.deepEqual(weekdaysBefore('2026-10-06', 4), ['2026-10-05', '2026-10-02', '2026-10-01', '2026-09-30'])   // Tue: Mon, then Fri...
  const asked = []
  const holiday = new Set(['2026-10-02'])
  const load = async (date) => { asked.push(date); return { date, items: holiday.has(date) ? [] : [{ t: Date.parse(date) }] } }
  const found = await walkPastSessions('2026-10-06', 3, load)
  assert.deepEqual(found.sessions.map((s) => s.date), ['2026-09-30', '2026-10-01', '2026-10-05'])   // oldest first
  assert.deepEqual(asked, ['2026-10-05', '2026-10-02', '2026-10-01', '2026-09-30'])
  assert.equal(found.error, null)
  // A failure stops the walk - what was found is kept, the day named.
  asked.length = 0
  const failing = async (date) => { asked.push(date); if (date === '2026-10-01') throw new Error('HTTP 503'); return { date, items: [1] } }
  const stopped = await walkPastSessions('2026-10-06', 5, failing)
  assert.deepEqual([stopped.sessions.map((s) => s.date), stopped.error], [['2026-10-02', '2026-10-05'], { date: '2026-10-01', message: 'HTTP 503' }])
  assert.deepEqual(asked, ['2026-10-05', '2026-10-02', '2026-10-01'])
  // Nothing anywhere: count + EXTRA_WEEKDAYS weekdays at most.
  asked.length = 0
  const none = await walkPastSessions('2026-10-06', 2, async (date) => { asked.push(date); return { date, items: [] } })
  assert.deepEqual([none.sessions.length, asked.length], [0, 2 + EXTRA_WEEKDAYS])
  assert.deepEqual((await walkPastSessions('2026-10-06', 0, load)).sessions, [])
})

test('a past day as the cards keep it: the run\'s minutes, the footprint in lots with its estimated minutes, the answers', async () => {
  const at = (k) => new Date(T + k * MIN).toISOString()
  const run = {
    success: true,
    spotCandlesOneMinute: [{ time: at(0), open: 101, high: 110, low: 100, close: 108 }, { time: '2026-10-05T10:30:00Z', open: 1, high: 1, low: 1, close: 1 }], // the second after the close
    cePoints: [{ time: at(0), strike: 105, open: 2, high: 10, low: 0, price: 10, volume: 300 }],
    pePoints: [],
  }
  const rec = optionDayRecord('2026-10-05', run)
  assert.equal(rec.candles.length, 1)
  assert.deepEqual(rec.items, optionDeltaMinutes(run.cePoints, run.pePoints, [{ time: T, open: 101, high: 110, low: 100, close: 108 }]))
  // The footprint in lots; the backfill estimated, a recorded minute kept over its estimate; a day estimated throughout.
  const body = {
    source: 'recorded', meta: { lotSize: 75 },
    bars: [{ time: at(1), open: 1, high: 1, low: 1, close: 1, volume: 150, levels: [{ price: 25000, buy: 150, sell: 0 }] }],
    backfillBars: [{ time: at(0), open: 1, high: 1, low: 1, close: 1, volume: 75, levels: [{ price: 25000, buy: 0, sell: 75 }] }, { time: at(1), volume: 999, levels: [] }],
  }
  const bars = footprintBars(body)
  assert.deepEqual(bars.map((b) => [b.time, b.levels[0].buy, b.levels[0].sell, !!b.estimated]), [[at(0), 0, 1, true], [at(1), 2, 0, false]])
  assert.ok(footprintBars({ ...body, source: 'estimated', backfillBars: [] }).every((b) => b.estimated))
  assert.deepEqual(futuresDayRecord('2026-10-05', body).candles.map((c) => c.time), [T, T + MIN])
  // What the server answers: a run without success = no session that day (a holiday); an HTTP error throws.
  const fake = (status, payload) => async () => ({ ok: status < 400, status, json: async () => payload })
  assert.deepEqual((await loadOptionDay('NIFTY', '2026-10-02', 'WEEK', fake(200, { success: false, error: 'No spot' }))).items, [])
  assert.equal((await loadOptionDay('NIFTY', '2026-10-05', 'WEEK', fake(200, run))).items.length, 1)
  await assert.rejects(loadOptionDay('NIFTY', '2026-10-05', 'WEEK', fake(503, { error: 'busy' })), /busy/)
  assert.deepEqual((await loadFuturesDay('NIFTY', '2026-10-02', fake(404, { error: 'no contract' }))).items, [])
  await assert.rejects(loadFuturesDay('NIFTY', '2026-10-05', fake(500, null)), /HTTP 500/)
  assert.equal(optionDayUrl('NIFTY', '2026-10-05', 'WEEK'), '/api/oi-replay/NIFTY/run?date=2026-10-05&timeframeMinutes=1&expiryFlag=WEEK')
  assert.match(futuresDayUrl('BANKNIFTY', '2026-10-05'), /^\/api\/order-flow\/BANKNIFTY\/day\/2026-10-05\?rowSize=5&.*backfillBars=true/)
})

test('a past day is asked once for the tab: kept when it came back with a session, a failure or a holiday asked again', async () => {
  let calls = 0
  const day = async () => { calls++; return { date: 'd', items: [1] } }
  const [a, b] = await Promise.all([cachedDay('k1', day), cachedDay('k1', day)])     // one on its way is shared
  assert.equal(a, b)
  await cachedDay('k1', day)
  assert.equal(calls, 1)
  let failures = 0
  await assert.rejects(cachedDay('k2', async () => { failures++; throw new Error('x') }))
  await assert.rejects(cachedDay('k2', async () => { failures++; throw new Error('x') }))
  assert.equal(failures, 2)
  let holidays = 0
  await cachedDay('k3', async () => { holidays++; return { date: 'h', items: [] } })
  await cachedDay('k3', async () => { holidays++; return { date: 'h', items: [] } })
  assert.equal(holidays, 2)
})
