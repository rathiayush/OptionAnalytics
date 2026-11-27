// SAVED STRATEGIES ON ONE TRADED INDEX, ONE TRADE AT A TIME (asked for - "there are many live strategies ... if they are the same
// direction do not trade another, only trade if there is not any open trade"; "same direction do not add up"), the open trade's
// RUNNING P&L at the option's current price, and the signals NOT TAKEN kept with a tag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulateDay } from '../src/signalBacktest.js'
import { cleanBacktestSettings, engineSettings } from '../src/signalBacktestJob.js'
import { dayReportText, liveDayEvents, liveGroupEvents } from '../src/signalLive.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const at = (m) => T915 + (m - (9 * 60 + 15)) * MIN
// A day by hand: spot flat 25020 over VWAP 25000 for 375 minutes; the options priced off spot (a call 100 + half spot's move over 25000).
function day(spot = () => 25020, n = 375) {
  const t = Array.from({ length: n }, (_, i) => T915 + i * MIN)
  const bar = (f) => Array.from({ length: n }, (_, i) => f(i))
  const legs = (put) => {
    const m = new Map()
    for (let k = 24500; k <= 25600; k += 50) {
      const a = new Float64Array(n * 4)
      for (let i = 0; i < n; i++) { const p = Math.max(1, 100 + (put ? -1 : 1) * (spot(i) - 25000) * 0.5); a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = a[i * 4 + 3] = p }
      m.set(k, a)
    }
    return m
  }
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: bar((i) => Math.round(spot(i) / 50) * 50),
    spot: { o: bar(spot), h: bar(spot), l: bar(spot), c: bar(spot) }, price: { o: bar(spot), h: bar(spot), l: bar(spot), c: bar(spot), v: bar(() => 1000) },
    vwap: bar(() => 25000), oi: bar(() => ({ ce: 0, pe: 0 })), breaks: [], hp: [], prevVp: null, priceSource: 'futures', ce: legs(false), pe: legs(true),
  }
}
const strategy = (name, more) => ({
  name, day: null,
  engine: engineSettings(cleanBacktestSettings({ underlying: 'NIFTY', charges: false, maxTradesPerDay: 5, cooldownMin: 0, ...more, rule: { tree: { op: 'and', not: false, items: [{ line: { id: 'vwap', value: 'above', param: 0 } }] }, action: 'buyCE', mirror: false } })),
})
// The rule is true from the open, so a strategy signals when ITS entries open (09:30 / 09:45 ...): A at 09:30, B at 09:45.
const A = (more = {}) => strategy('A', { entryFrom: '09:30', timeStopMin: 60, ...more })
const B = (more = {}) => strategy('B', { entryFrom: '09:45', timeStopMin: 60, ...more })
const group = (list, opts) => { const d = day(undefined, opts?.n); return liveGroupEvents(list.map((s) => ({ ...s, day: d })), opts) }

test('alone, each strategy trades its own signal - together the second one\'s signal inside the first\'s open trade is NOT TAKEN', () => {
  const d = day()
  assert.equal(simulateDay(d, A().engine).trades.length, 1)
  assert.equal(simulateDay(d, B().engine).trades.length, 1)
  const [a, b] = group([A(), B()])
  assert.equal(a.trades.length, 1)
  assert.equal(b.trades.length, 0)                                       // A's trade (09:30 - 10:30) is open at 09:45
  assert.equal(b.notTaken, 1)
  const skip = b.events.find((e) => e.kind === 'skipped')
  assert.equal(skip.row.status, 'not taken')
  assert.match(skip.row.exitReason, /another strategy's trade is open \(A\)/)
  assert.equal(skip.row.entryTime, '09:45')
  assert.equal(b.events.filter((e) => e.kind === 'entry').length, 0)
  assert.match(dayReportText('B', d, { ...b, tradeIn: '' }), /1 signal not taken - another strategy's trade was open/)
})

test('it is the order of ENTRY TIME, not of the list: whichever signalled first keeps the trade', () => {
  const [b, a] = group([B(), A()])
  assert.equal(a.trades.length, 1); assert.equal(b.trades.length, 0)
  assert.equal(a.trades[0].entryTime, at(9 * 60 + 30))
})

test('a trade that has ended no longer blocks: the next strategy trades after it, same direction or not', () => {
  const [a, b] = group([A({ timeStopMin: 10 }), B()])                    // A is out by 09:42, B signals at 09:45
  assert.equal(a.trades.length, 1); assert.equal(b.trades.length, 1)
  assert.equal(b.notTaken, 0)
})

test('an OPEN trade (the day still running) blocks to the end; a strategy blocked never trades its signal later', () => {
  const [a, b] = group([A({ timeStopMin: 0 }), B()], { nowMs: at(11 * 60), n: 105 })
  assert.equal(a.trades.length, 1)
  assert.equal(b.trades.length, 0)
})

test('an open trade carries its RUNNING P&L at the option\'s current price - a mark each round, no event', () => {
  const d = day((i) => (i < 60 ? 25020 : 25040), 105)                     // the day so far, to 11:00: spot up 20 pts after 10:15 - the call's premium +10
  const live = liveDayEvents(d, A({ timeStopMin: 0 }).engine, { name: 'A', nowMs: at(11 * 60) })
  assert.equal(live.open.length, 1)
  const mark = live.events.find((e) => e.kind === 'mark')
  assert.equal(mark.row.status, 'open')
  assert.equal(mark.row.exit, 120)                                         // 100 + (25040 - 25000) / 2: the current premium
  assert.equal(mark.row.exitReason, 'running')
  assert.ok(Number(mark.row.net) > 0)
  assert.equal(live.events.find((e) => e.kind === 'entry').row.exitReason, 'running')
  // The ENTRY row of a trade that has not closed is its running row too; a closed trade's entry row stays blank (its exit replaces it).
  const done = liveDayEvents(d, A({ timeStopMin: 10 }).engine, { name: 'A', complete: true, nowMs: at(15 * 60 + 40) })
  assert.equal(done.events.some((e) => e.kind === 'mark'), false)
  assert.equal(done.events.find((e) => e.kind === 'entry').row.net, '')
})
