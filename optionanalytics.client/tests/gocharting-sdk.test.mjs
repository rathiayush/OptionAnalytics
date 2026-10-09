// The datafeed we give GoCharting's chart SDK (goChartingSdk.js): history = our COMPLETED 1-minute bars (the
// running minute is built by the SDK from the trades - never counted twice), live trades = our tape prints with
// their buy / sell side, the index future's symbol description.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { goChartingSymbol, resolutionMinutes, udfFromBars, tradeTick, symbolInfoFor, createGoChartingDatafeed } from '../src/goChartingSdk.js'

const MIN = 60_000
const T = Date.parse('2026-10-09T04:30:00Z') // 10:00 IST
const bar = (m, c, v = 100) => ({ time: new Date(T + m * MIN).toISOString(), open: c - 1, high: c + 2, low: c - 3, close: c, volume: v })

test('symbol and resolution', () => {
  assert.equal(goChartingSymbol('NIFTY'), 'NSE:FUTURE:NIFTY-I')
  assert.equal(goChartingSymbol('SENSEX'), 'BSE:FUTURE:SENSEX-I')
  assert.equal(resolutionMinutes('5m'), 5)
  assert.equal(resolutionMinutes({ scale: 'minutes', units: 3, type: '3m' }), 3)
  assert.equal(resolutionMinutes({ type: '15m' }), 15)
  assert.equal(resolutionMinutes('1h'), 60)
  assert.equal(resolutionMinutes(null), 1)
})

test('history: completed minutes only (the running one comes from the trades), in seconds, aggregated', () => {
  const bars = [bar(0, 100), bar(1, 101), bar(2, 99), bar(3, 105), bar(4, 104), bar(5, 106)]
  const nowMs = T + 5 * MIN + 20_000 // 10:05:20 - the 10:05 bar is still running
  const u = udfFromBars(bars, { nowMs })
  assert.equal(u.s, 'ok')
  assert.deepEqual(u.t, [0, 1, 2, 3, 4].map((m) => (T + m * MIN) / 1000))
  assert.deepEqual(u.c, [100, 101, 99, 105, 104])
  const five = udfFromBars(bars, { nowMs: T + 6 * MIN, minutes: 5 })
  assert.deepEqual(five.t, [T / 1000, (T + 5 * MIN) / 1000])
  assert.deepEqual([five.o[0], five.h[0], five.l[0], five.c[0], five.v[0]], [99, 107, 96, 104, 500])
  const ranged = udfFromBars(bars, { nowMs: T + 6 * MIN, fromMs: T + 2 * MIN, toMs: T + 3 * MIN })
  assert.deepEqual(ranged.c, [99, 105])
  assert.equal(udfFromBars([], {}).s, 'no_data')
  // buy + sell when there is no volume field
  assert.deepEqual(udfFromBars([{ time: T, open: 1, high: 2, low: 0, close: 1, buy: 30, sell: 20 }], { nowMs: T + MIN }).v, [50])
})

test('a tape print as a trade: price, quantity, its side, its time', () => {
  const t = tradeTick({ seq: 7, time: T + 1500, price: 25010.5, quantity: 150, buy: true }, 'NIFTY')
  assert.deepEqual({ ...t, timeStamp: t.timeStamp.getTime() }, {
    type: 'trade', productId: 'NSE:FUTURE:NIFTY-I', symbol: 'NIFTY-I', exchange: 'NSE', segment: 'FUTURE',
    timeStamp: T + 1500, tradeID: '7', price: 25010.5, quantity: 150, amount: 25010.5 * 150, side: 'BUY',
  })
  assert.equal(tradeTick({ time: new Date(T).toISOString(), price: 1, quantity: 1, buy: false }, 'SENSEX').side, 'SELL')
})

test('symbol description: the future, not the index; IST; tick precision', () => {
  const s = symbolInfoFor('BANKNIFTY', { tickSize: 0.05, contractSymbol: 'BANKNIFTY-Oct2026-FUT' })
  assert.equal(s.full_name, 'NSE:FUTURE:BANKNIFTY-I')
  assert.equal(s.is_index, false)
  assert.equal(s.timezone, 'Asia/Kolkata')
  assert.equal(s.max_tick_precision, 2)
  assert.equal(s.description, 'BANKNIFTY-Oct2026-FUT')
  assert.ok(s.supported_resolutions.includes('1m') && s.exchange_info.valid_intervals.includes('5m'))
})

test('the datafeed: bars to the clock, the running minute\'s trades on subscribing, then live trades', async () => {
  const prints = [
    { seq: 1, time: T + 4 * MIN + 10_000, price: 104, quantity: 75, buy: true },
    { seq: 2, time: T + 5 * MIN + 5_000, price: 106, quantity: 150, buy: false },
    { seq: 3, time: T + 5 * MIN + 9_000, price: 106.5, quantity: 75, buy: true },
  ]
  let source = { underlying: 'NIFTY', meta: { tickSize: 0.1 }, minuteBars: [bar(0, 100), bar(4, 104), bar(5, 106)], nowMs: T + 5 * MIN + 10_000, prints }
  const feed = createGoChartingDatafeed(() => source)
  const ready = await new Promise((r) => feed.onReady(r))
  assert.ok(ready.supported_resolutions.includes('1m'))
  const info = await new Promise((r) => feed.resolveSymbol('NSE:FUTURE:NIFTY-I', r))
  assert.equal(info.symbol, 'NIFTY-I')
  const udf = await feed.getBars(info, '1m', { from: new Date(T - 60 * MIN), to: new Date(T + 10 * MIN) })
  assert.deepEqual(udf.c, [100, 104], 'not the running 10:05 bar')
  const got = []
  feed.subscribeTicks(info, '1m', (t) => got.push(t), 'uid1')
  assert.deepEqual(got.map((t) => t.tradeID), ['2', '3'], 'the running minute\'s prints only')
  feed.push([{ seq: 4, time: T + 5 * MIN + 30_000, price: 107, quantity: 75, buy: true }])
  assert.deepEqual(got.map((t) => t.tradeID), ['2', '3', '4'])
  feed.unsubscribeTicks('uid1')
  feed.push([{ seq: 5, time: T + 5 * MIN + 40_000, price: 107, quantity: 75, buy: true }])
  assert.equal(got.length, 3)
  assert.equal(feed.subscribers(), 0)
  // Live (no replay clock): now.
  const yesterday = (m, c) => ({ ...bar(m, c), time: new Date(T - 86_400_000 + m * MIN).toISOString() })
  source = { ...source, nowMs: null, minuteBars: [yesterday(0, 100), yesterday(1, 101)] }
  assert.deepEqual((await feed.getBars(info, '1m', {})).c, [100, 101])
})
