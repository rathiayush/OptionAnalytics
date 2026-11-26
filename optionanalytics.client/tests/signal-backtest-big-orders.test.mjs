// The Signal backtest's BIG ORDERS condition (asked for - "add big orders trade as well ... we should be able to specify the
// quantity"): the near futures' prints of at least N lots (the Order Flow day's `trades`), a candle holding its minutes',
// known at the minute's end; the size and the count set on the line; a recorded minute only; the timeframes; the mirror.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULE_CONDITIONS, cleanLine, lineText, mirrorLines, orderFlowNeeded } from '../src/signalBacktest.js'
import { BIG_ORDER_FLOOR_LOTS, FLOW_DELTA, flowView, orderFlowMinutes, orderFlowUrl } from '../src/orderFlowFeatures.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const iso = (ms) => new Date(ms).toISOString()
const cond = RULE_CONDITIONS.find((c) => c.id === 'bigOrder')
const LOT = 75

function body({ n = 60, trades = [], source = 'live', backfill = [] } = {}) {
  const bars = []
  for (let i = 0; i < n; i++) bars.push({ time: iso(T915 + i * MIN), open: 25000, high: 25002, low: 24998, close: 25000, buy: 1000, sell: 1000, levels: [] })
  return { meta: { lotSize: LOT }, rowSize: 1, bars, heatmap: [], source, backfill, trades: trades.map(([min, sec, lots, buy]) => ({ time: iso(T915 + min * MIN + sec * 1000), price: 25000, quantity: lots * LOT, buy })) }
}
const tOf = (n = 60) => Array.from({ length: n }, (_, i) => T915 + i * MIN)
const dayOf = (b, opts) => { const t = tOf(); return { ok: true, n: t.length, t, flow: orderFlowMinutes(b, t, opts) } }
const holds = (d, v, i, w, lots, count = 1) => cond.test(d, i, v, w, lots, count)

test('the day asks the prints from the floor size up; the condition needs the order flow', () => {
  assert.match(orderFlowUrl('NIFTY', '2026-10-05'), new RegExp(`minTradeLots=${BIG_ORDER_FLOOR_LOTS}&`))
  assert.equal(orderFlowNeeded({ lines: [{ id: 'bigOrder', value: 'buy', param: 100 }], logic: '1' }), FLOW_DELTA)
})

test('big buys / sells of at least the size set, how many, in the look-back - and their minute known at its end', () => {
  // 10:00 (minute 45): a 150-lot buy and a 40-lot buy; 10:05 (50): a 300-lot sell.
  const d = dayOf(body({ trades: [[45, 10, 150, true], [45, 40, 40, true], [50, 5, 300, false]] }))
  assert.ok(holds(d, 'buy', 45, 1, 100) && !holds(d, 'buy', 45, 1, 200))           // the size
  assert.ok(holds(d, 'buy', 45, 1, 30, 2) && !holds(d, 'buy', 45, 1, 100, 2))      // the count
  assert.ok(!holds(d, 'buy', 44, 1, 10))                                           // nothing before its minute
  assert.ok(holds(d, 'buy', 49, 5, 100) && !holds(d, 'buy', 50, 5, 100))           // the look-back
  assert.ok(holds(d, 'sell', 50, 1, 250) && !holds(d, 'sell', 50, 1, 301))
  assert.ok(holds(d, 'buyOnly', 47, 5, 100) && !holds(d, 'buyOnly', 50, 10, 100))  // a big sell in it
  assert.ok(holds(d, 'sellAhead', 50, 10, 100) && !holds(d, 'buyAhead', 50, 10, 100))   // 300 sold v 150 bought
  assert.ok(holds(d, 'buyAhead', 50, 10, 100) === false && holds(d, 'buyAhead', 48, 10, 100))
  // Live: a print in the minute still forming is not known yet.
  const live = dayOf(body({ trades: [[45, 10, 150, true]] }), { asOfMs: T915 + 45 * MIN + 30_000 })
  assert.ok(!holds(live, 'buy', 45, 1, 100))
})

test('none on an estimated day or minute; none before the server\'s 5 000-print window', () => {
  assert.ok(!holds(dayOf(body({ source: 'estimated', trades: [[45, 0, 150, true]] })), 'buy', 45, 1, 100))
  const part = body({ trades: [[2, 0, 150, true]] })
  part.bars.splice(0, 5)                                                           // recording began at 09:20
  part.backfill = [0, 1, 2, 3, 4].map((i) => ({ time: iso(T915 + i * MIN), buy: 1, sell: 1 }))
  assert.ok(!holds(dayOf(part), 'buy', 2, 1, 100))
  const many = Array.from({ length: 5000 }, (_, k) => [30 + Math.floor(k / 200), k % 60, 20, k % 2 === 0])
  const cut = dayOf(body({ trades: many }))
  assert.equal(cut.flow.prints[10], null)                                          // before the first print kept: unknown
  assert.ok(holds(cut, 'buy', 31, 1, 20))
})

test('a timeframe\'s candle holds its minutes\' prints; the mirror swaps the side and keeps the numbers', () => {
  const d = dayOf(body({ trades: [[46, 0, 150, true]] }))
  // 5-minute candles: candle 9 = minutes 45 - 49.
  const first = Array.from({ length: 12 }, (_, k) => k * 5), last = first.map((f) => f + 4)
  const v = { flow: flowView(d.flow, first, last) }
  assert.ok(holds(v, 'buy', 9, 1, 100) && !holds(v, 'buy', 8, 1, 100) && !holds(v, 'buy', 10, 1, 100))
  const line = cleanLine({ id: 'bigOrder', value: 'buy', param: 250, param2: 3, windowMin: 10 })
  assert.equal(line.param, 250)
  assert.equal(line.param2, 3)
  assert.match(lineText(line), /Big BUY/)
  const [m] = mirrorLines([line])
  assert.equal(m.value, 'sell')
  assert.equal(m.param, 250)
  assert.equal(m.param2, 3)
  assert.equal(cleanLine({ id: 'bigOrder', value: 'buy', param: 1 }).param, BIG_ORDER_FLOOR_LOTS)   // held to the floor
})
