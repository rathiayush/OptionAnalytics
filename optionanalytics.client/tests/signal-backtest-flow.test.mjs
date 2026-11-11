// The Signal backtest's FUTURES ORDER FLOW conditions (orderFlowFeatures.js + the OrderFlow group of signalBacktest.js):
// the futures Δ, the cumulative Δ (CVD) and the liquidity heatmap read off the Order Flow page's day - each minute from
// data up to its end (a day cut part way = the whole day's up to the cut), every condition firing on its case, both sides,
// and not without its key part; the timeframes; the loader (asked only when the rule reads it, a 404 kept as "none", a
// server error retried) and the report's notes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULE_CONDITIONS, cleanLine, lineText, mirrorLines, orderFlowNeeded, timeframeView } from '../src/signalBacktest.js'
import { FLOW_BOOK, FLOW_DELTA, FLOW_NONE, orderFlowMinutes, orderFlowUrl } from '../src/orderFlowFeatures.js'
import { attachOrderFlow, backtestReport, dayOutcome } from '../src/signalBacktestJob.js'
import { liquidityMap } from '../src/orderFlowMath.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const iso = (ms) => new Date(ms).toISOString()
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)
const optionOf = (id, value) => cond(id).options.find((o) => o.value === value)
// Does condition `id` say `value` at candle i of `d` (window `w` candles; `p` / `p2` its numbers, else the defaults)?
const holds = (d, id, value, i, w = 5, p = optionOf(id, value).param?.default ?? 0, p2 = optionOf(id, value).param2?.default) => cond(id).test(d, i, value, w, p, p2)

// An Order Flow day as the server sends it (`/api/order-flow/{u}/day/{date}`): `n` minutes from 09:15, each minute's
// buy / sell / futures OHLC from `minute(i)`, its footprint rows `levels(i)` and - `book(t)` - a heatmap column every 30 s.
function flowBody({ n = 120, minute = () => ({}), levels = () => [], book = null, source = 'live', backfill = [], lotSize = 75 } = {}) {
  const bars = []
  for (let i = 0; i < n; i++) {
    const m = { buy: 1000, sell: 1000, open: 25000, high: 25002, low: 24998, close: 25000, ...minute(i) }
    if (m.skip) continue
    bars.push({ time: iso(T915 + i * MIN), open: m.open, high: m.high, low: m.low, close: m.close, buy: m.buy, sell: m.sell, trades: 10, levels: levels(i) })
  }
  const heatmap = []
  if (book) for (let ms = T915; ms < T915 + n * MIN; ms += 30_000) heatmap.push({ time: iso(ms), ...book(ms) })
  return { meta: { lotSize }, rowSize: 1, bars, heatmap, source, backfill }
}
// A backtest day carrying it: spot = the futures' close less a basis (the rule's price reads), `flow` from the body.
function dayWith(body, { n = 120, spot = (i, f) => (f ?? 25000) - 60 } = {}) {
  const t = Array.from({ length: n }, (_, i) => T915 + i * MIN)
  const closes = new Map(body.bars.map((b) => [Date.parse(b.time), b.close]))
  const c = t.map((ms, i) => spot(i, closes.get(ms)))
  const d = { ok: true, date: '2026-10-05', underlying: 'NIFTY', n, t, spot: { o: c, h: c, l: c, c }, price: { o: c, h: c, l: c, c, v: c.map(() => 0) }, breaks: [], hp: [], ib: null }
  d.flow = orderFlowMinutes(body, t)
  return d
}

test('the minutes: each one\'s Δ and volume, the CVD from 09:15, the futures\' candle; estimated minutes marked', () => {
  const body = flowBody({ n: 10, minute: (i) => (i === 3 ? { skip: true } : { buy: 1000 + 100 * i, sell: 1000 }), backfill: [{ time: iso(T915), buy: 9, sell: 9 }] })
  // The recording began at 09:16: the estimated 09:15 minute leads it.
  body.bars.shift()
  body.backfill = [{ time: iso(T915), buy: 500, sell: 800 }]
  const f = orderFlowMinutes(body, Array.from({ length: 10 }, (_, i) => T915 + i * MIN))
  assert.deepEqual(Array.from(f.delta.slice(0, 5)), [-300, 100, 200, NaN, 400])
  assert.deepEqual(Array.from(f.cvd.slice(0, 6)), [-300, -200, 0, 0, 400, 900])    // a missing minute (09:18) carries it on
  assert.deepEqual(Array.from(f.est.slice(0, 3)), [1, 0, 0])
  assert.equal(f.estimated, 1)
  assert.equal(f.vol[1], 2100)
  assert.ok(Number.isNaN(f.fc[0]) && f.fc[1] === 25000)                           // the estimated minute has no candle
  // A day estimated from candles: every minute estimated, no book.
  const est = orderFlowMinutes(flowBody({ n: 10, source: 'estimated', book: () => ({ bids: [[24999, 5e4]], asks: [] }) }), Array.from({ length: 10 }, (_, i) => T915 + i * MIN))
  assert.equal(est.estimated, 10)
  assert.equal(est.book, false)
  assert.ok(est.liq.every((x) => x == null))
})

test('futures Δ: buyers / sellers ahead by % of the volume, over the look-back, a big candle, absorption - both sides', () => {
  // Candle 40: buyers 3000 v 1000 (Δ +2000 = 50% of 4000). Candle 60: sellers. 80: Δ −1500 but the candle closed UP.
  const minute = (i) => (i === 40 ? { buy: 3000, sell: 1000 } : i === 60 ? { buy: 1000, sell: 3000 } : i === 80 ? { buy: 1000, sell: 2500, open: 25000, close: 25004 } : i === 90 ? { buy: 2500, sell: 1000, open: 25004, close: 25000 } : { buy: 1050, sell: 1000 })
  const d = dayWith(flowBody({ minute }))
  assert.ok(holds(d, 'futDelta', 'buyers', 40, 1, 50) && !holds(d, 'futDelta', 'buyers', 40, 1, 51))
  assert.ok(holds(d, 'futDelta', 'sellers', 60, 1, 50) && !holds(d, 'futDelta', 'buyers', 60, 1, 0))
  // Over the look-back: candles 36 - 40 added up (+2000 + 4 x 50 = +2200 of 4000 + 4 x 2050 = 12 200 = 18.0%).
  assert.ok(holds(d, 'futDelta', 'sumBuyers', 40, 5, 17) && !holds(d, 'futDelta', 'sumBuyers', 40, 5, 19))
  // Big: +2000 against an average |Δ| of 50 = 40x; a −2000 at 60 is big selling, not buying.
  assert.ok(holds(d, 'futDelta', 'bigBuy', 42, 5, 10) && !holds(d, 'futDelta', 'bigBuy', 46, 5, 10))   // out of the look-back
  assert.ok(holds(d, 'futDelta', 'bigSell', 60, 1, 10) && !holds(d, 'futDelta', 'bigBuy', 60, 1, 10))
  // Selling absorbed (Δ −1500, the candle closed up) - bullish; buying absorbed at 90 - bearish; not on a plain sell candle.
  assert.ok(holds(d, 'futDelta', 'absorbSell', 82, 5) && !holds(d, 'futDelta', 'absorbSell', 62, 5))
  assert.ok(holds(d, 'futDelta', 'absorbBuy', 90, 1) && !holds(d, 'futDelta', 'absorbBuy', 80, 1))
  // No order flow on the day: nothing holds.
  assert.ok(!holds({ ...d, flow: { missing: 'none' } }, 'futDelta', 'buyers', 40, 1, 0) && !holds({ ...d, flow: undefined }, 'futDelta', 'buyers', 40, 1, 0))
})

test('futures cumulative Δ: sign, a turn, a flip after the morning, rising, a new high, divergence, % change', () => {
  // Sellers 300 a minute until 50, then buyers 600 a minute: the CVD falls to −15 000, turns +ve at 75.
  const minute = (i) => (i < 50 ? { buy: 1000, sell: 1300 } : { buy: 1600, sell: 1000 })
  const d = dayWith(flowBody({ minute }))
  assert.ok(holds(d, 'futCvd', 'negative', 40) && !holds(d, 'futCvd', 'positive', 40))
  assert.equal(d.flow.cvd[75], 600)   // −15 000 + 26 x 600
  assert.ok(holds(d, 'futCvd', 'turnedPositive', 76, 5) && !holds(d, 'futCvd', 'turnedPositive', 90, 5))
  assert.ok(holds(d, 'futCvd', 'flipPositive', 76, 5) && !holds(d, 'futCvd', 'flipNegative', 76, 5))
  assert.ok(holds(d, 'futCvd', 'rising', 70, 10) && holds(d, 'futCvd', 'falling', 40, 10) && !holds(d, 'futCvd', 'rising', 40, 10))
  assert.ok(holds(d, 'futCvd', 'newHigh', 100, 3) && !holds(d, 'futCvd', 'newHigh', 60, 3) && holds(d, 'futCvd', 'newLow', 49, 3))
  // +600 a minute from 13 800 (at 97): 10 minutes = 6 000 = 43%.
  assert.ok(holds(d, 'futCvd', 'upPct', 107, 10, 40) && !holds(d, 'futCvd', 'upPct', 107, 10, 45) && !holds(d, 'futCvd', 'downPct', 107, 10, 0))
  // Divergence: spot falls 0.4% over the look-back while the CVD keeps rising - bullish (it did not follow the fall).
  const div = dayWith(flowBody({ minute }), { spot: (i) => (i < 95 ? 24940 : 24840) })
  assert.ok(holds(div, 'futCvd', 'divBull', 98, 5, 0.2) && !holds(div, 'futCvd', 'divBear', 98, 5, 0.2))
  // Falling with the price: it followed - no divergence.
  const followed = dayWith(flowBody({ minute }), { spot: (i) => (i < 45 ? 24940 : 24840) })
  assert.ok(!holds(followed, 'futCvd', 'divBull', 48, 5, 0.2))
})

test('a timeframe\'s candles: Δ and volume their minutes\' sums, the CVD and the walls their last minute\'s', () => {
  const minute = (i) => ({ buy: 1000 + i, sell: 1000, open: 25000 + i, high: 25003 + i, low: 24999 + i, close: 25001 + i })
  const d = dayWith(flowBody({ minute }))
  d.tf = 1
  const v = timeframeView(d, 5)
  assert.equal(v.flow.delta[2], 10 + 11 + 12 + 13 + 14)
  assert.equal(v.flow.vol[2], 2000 * 5 + 60)
  assert.equal(v.flow.cvd[2], d.flow.cvd[14])
  assert.deepEqual([v.flow.fo[2], v.flow.fh[2], v.flow.fl[2], v.flow.fc[2]], [25010, 25017, 25009, 25015])
  assert.ok(holds(v, 'futDelta', 'buyers', 2, 1, 0))
})

// A book with a big BID WALL at 24 999 (50 000 - the rest 1 000 a row), the futures at 25 000.
const wallBook = (wall = 5e4, at = 24999) => () => ({
  bids: Array.from({ length: 20 }, (_, k) => [25000 - 1 - k, 25000 - 1 - k === at ? wall : 1000]),
  asks: Array.from({ length: 20 }, (_, k) => [25001 + k, 1000]),
})
// Sellers hitting the wall's row: 30 000 a minute sold at 24 999 - 0.6x its size (absorption) while it holds.
const intoWall = () => [{ price: 25000, buy: 1000, sell: 1000 }, { price: 24999, buy: 0, sell: 30000 }]

test('the liquidity map\'s read: the Order Flow page\'s own liquidityMap at each minute\'s end - absorption at a bid wall', () => {
  const body = flowBody({ n: 40, book: wallBook(), levels: intoWall })
  const d = dayWith(body, { n: 40 })
  // The same read as liquidityMap itself at 09:35 (the minute's end), on the snapshots of its last 10 minutes.
  const end = T915 + 21 * MIN
  const columns = body.heatmap.map((c) => ({ t: Date.parse(c.time), bids: c.bids, asks: c.asks })).filter((c) => c.t <= end)
  const bars = body.bars.map((b) => ({ ...b, time: Date.parse(b.time) }))
  const own = liquidityMap({ columns, minuteBars: bars, rowSize: 1, lotSize: 75, price: 25000, nowMs: end })
  assert.equal(own.now.state, 'absorption')
  assert.equal(d.flow.liq[20].state, 'absorption')
  assert.equal(d.flow.liq[20].sup.price, 24999)
  assert.ok(holds(d, 'liqRead', 'absorbBid', 20, 1) && holds(d, 'liqRead', 'bullish', 20, 1))
  assert.ok(!holds(d, 'liqRead', 'absorbAsk', 20, 1) && !holds(d, 'liqRead', 'bearish', 20, 1))
  // Not before the map has 5 snapshots in its window (the first minutes), nor without the selling into it.
  assert.equal(d.flow.liq[0], null)
  const quiet = dayWith(flowBody({ n: 40, book: wallBook() }), { n: 40 })
  assert.ok(!holds(quiet, 'liqRead', 'absorbBid', 20, 1) && quiet.flow.liq[20].state !== 'absorption')
  // The mirror: an offer wall over the price, buyers lifting into it - absorption at an offer wall, bearish.
  const offer = () => ({ bids: Array.from({ length: 20 }, (_, k) => [24999 - k, 1000]), asks: Array.from({ length: 20 }, (_, k) => [25001 + k, k === 0 ? 5e4 : 1000]) })
  const up = dayWith(flowBody({ n: 40, book: offer, levels: () => [{ price: 25000, buy: 1000, sell: 1000 }, { price: 25001, buy: 30000, sell: 0 }] }), { n: 40 })
  assert.ok(holds(up, 'liqRead', 'absorbAsk', 20, 1) && holds(up, 'liqRead', 'bearish', 20, 1) && !holds(up, 'liqRead', 'bullish', 20, 1))
})

test('the walls: near a bid wall, support held, an offer wall broken, building / pulling, the bigger side; the book\'s lean', () => {
  // The bid wall at 24 999 all day, the futures' lows at 24 999.6; at 25 they dip to 24 999.1 (within 0.001% of the wall)
  // and close back at 25 000 - support held.
  const minute = (i) => (i === 25 ? { low: 24999.1, close: 25000 } : { low: 24999.6 })
  const d = dayWith(flowBody({ n: 40, minute, book: wallBook() }), { n: 40 })
  assert.ok(holds(d, 'liqWalls', 'nearBid', 20, 1, 0.01) && !holds(d, 'liqWalls', 'nearAsk', 20, 1, 0.01))
  assert.ok(holds(d, 'liqWalls', 'heldBid', 27, 5, 0.001) && !holds(d, 'liqWalls', 'heldBid', 22, 5, 0.001) && !holds(d, 'liqWalls', 'heldAsk', 27, 5, 0.001))
  assert.ok(holds(d, 'liqWalls', 'bidBigger', 20, 1, 0) === false)   // no offer wall at all: nothing to compare
  // The book near the price: 50 000 + 9 x 1 000 bids v 10 x 1 000 offers within 10 rows = 86% bids.
  assert.ok(holds(d, 'liqLean', 'bidHeavy', 20, 1, 85) && !holds(d, 'liqLean', 'bidHeavy', 20, 1, 87) && !holds(d, 'liqLean', 'askHeavy', 20, 1, 50))
  // An offer wall at 25 004; the futures close through it at 30 and stay over - resistance gave way (bullish).
  const both = (ms) => ({
    bids: Array.from({ length: 20 }, (_, k) => [24999 - k, k === 0 ? 5e4 : 1000]),
    asks: Array.from({ length: 20 }, (_, k) => [25001 + k, 25001 + k === 25004 && ms < T915 + 30 * MIN ? 6e4 : 1000]),
  })
  const brk = dayWith(flowBody({ n: 40, book: both, minute: (i) => (i >= 30 ? { open: 25003, high: 25007, low: 25003, close: 25006 } : {}) }), { n: 40 })
  assert.equal(brk.flow.liq[29].res.price, 25004)
  assert.ok(holds(brk, 'liqWalls', 'brokeAsk', 32, 5) && !holds(brk, 'liqWalls', 'brokeAsk', 28, 5) && !holds(brk, 'liqWalls', 'brokeBid', 32, 5))
  assert.ok(holds(brk, 'liqWalls', 'askBigger', 20, 1, 15) && !holds(brk, 'liqWalls', 'askBigger', 20, 1, 25))   // 60 000 v 50 000 = 20%
  // A bid wall that doubles in the last 2 minutes is building; one that halves is pulling.
  const growing = dayWith(flowBody({ n: 40, book: (ms) => wallBook(ms >= T915 + 18 * MIN ? 1e5 : 5e4)() }), { n: 40 })
  assert.ok(holds(growing, 'liqWalls', 'bidBuilding', 19, 1) && !holds(growing, 'liqWalls', 'bidPulling', 19, 1))
  const pulled = dayWith(flowBody({ n: 40, book: (ms) => wallBook(ms >= T915 + 18 * MIN ? 1.5e4 : 5e4)() }), { n: 40 })
  assert.ok(holds(pulled, 'liqWalls', 'bidPulling', 19, 1) && !holds(pulled, 'liqWalls', 'bidBuilding', 19, 1))
})

test('no look-ahead: a day cut at any minute (the live scan\'s clock) reads exactly the whole day\'s up to it', () => {
  const minute = (i) => ({ buy: 1000 + 37 * (i % 7), sell: 1000 + 23 * (i % 5), close: 25000 + (i % 3) })
  const body = flowBody({ n: 60, minute, book: wallBook(), levels: intoWall })
  const t = Array.from({ length: 60 }, (_, i) => T915 + i * MIN)
  const whole = orderFlowMinutes(body, t)
  for (const cut of [12, 25, 41]) {
    const asOfMs = T915 + cut * MIN + 20_000          // 20 s into minute `cut`: minutes 0 .. cut - 1 completed
    const part = orderFlowMinutes(body, t.slice(0, cut), { asOfMs })
    for (const key of ['delta', 'vol', 'cvd', 'fc']) assert.deepEqual(Array.from(part[key]), Array.from(whole[key].slice(0, cut)), `${key} at ${cut}`)
    assert.deepEqual(part.liq, whole.liq.slice(0, cut), `liq at ${cut}`)
  }
})

test('what a rule reads: nothing, the Δ, or the book too; the lines in words and mirrored', () => {
  const rule = (lines) => ({ lines, action: 'buyCE', mirror: true })
  assert.equal(orderFlowNeeded(rule([{ id: 'vwap', value: 'above' }])), FLOW_NONE)
  assert.equal(orderFlowNeeded(rule([{ id: 'vwap', value: 'above' }, { id: 'futCvd', value: 'positive' }])), FLOW_DELTA)
  assert.equal(orderFlowNeeded(rule([{ id: 'futDelta', value: 'buyers' }, { id: 'liqWalls', value: 'nearBid' }])), FLOW_BOOK)
  assert.match(orderFlowUrl('NIFTY', '2026-10-05', FLOW_DELTA), /day\/2026-10-05\?rowSize=1000&minTradeLots=100000&heatmapColumns=50$/)
  assert.match(orderFlowUrl('BANKNIFTY', '2026-10-05', FLOW_BOOK), /rowSize=5&minTradeLots=100000&heatmapColumns=750$/)
  const line = cleanLine({ id: 'futDelta', value: 'bigBuy', param: 3, windowMin: 10 })
  assert.match(lineText(line), /^Futures Δ \(the candle's buy − sell\): Big buying: .* ≥ 3× the average \(last 10 min\)$/)
  assert.deepEqual(mirrorLines([line]).map((l) => [l.id, l.value, l.param]), [['futDelta', 'bigSell', 3]])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'liqRead', value: 'absorbBid' })]).map((l) => l.value), ['absorbAsk'])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'liqWalls', value: 'brokeAsk' })]).map((l) => l.value), ['brokeBid'])
  // Every option has an opposite in its list and a number in range (the liquidity map's reads are events - no number).
  for (const c of RULE_CONDITIONS.filter((x) => x.group === 'OrderFlow')) {
    for (const o of c.options) {
      assert.ok(c.options.some((x) => x.value === o.opposite), `${c.id}.${o.value}`)
      if (c.id !== 'liqRead') assert.ok(o.param && o.param.default >= o.param.min && o.param.default <= o.param.max, `${c.id}.${o.value}`)
    }
  }
})

test('the loader: asked only when the rule reads it, the book only for the heatmap; a 404 kept as none, a failure retried', async () => {
  const body = flowBody({ n: 30, book: wallBook() })
  const asked = []
  const fake = (status, answer) => async (url) => { asked.push(url); return { ok: status === 200, status, json: async () => answer } }
  const day = () => ({ ok: true, date: '2026-10-05', t: Array.from({ length: 30 }, (_, i) => T915 + i * MIN) })
  // Not read by the rule: nothing asked.
  const none = day()
  assert.deepEqual(await attachOrderFlow(none, 'NIFTY', FLOW_NONE, { fetch: fake(200, body) }), { ok: true })
  assert.equal(asked.length, 0)
  assert.equal(none.flow, undefined)
  // The Δ: asked once; the book later asks again (in rows), the Δ again does not.
  const d = day()
  assert.deepEqual(await attachOrderFlow(d, 'NIFTY', FLOW_DELTA, { fetch: fake(200, body) }), { ok: true })
  assert.equal(d.flow.source, 'live')
  await attachOrderFlow(d, 'NIFTY', FLOW_DELTA, { fetch: fake(200, body) })
  assert.equal(asked.length, 1)
  await attachOrderFlow(d, 'NIFTY', FLOW_BOOK, { fetch: fake(200, body) })
  assert.equal(asked.length, 2)
  assert.match(asked[1], /heatmapColumns=750/)
  assert.ok(d.flow.book)
  // No order flow for the day (404): the day runs, its order flow lines never hold - "none" in its outcome.
  const missing = day()
  assert.deepEqual(await attachOrderFlow(missing, 'NIFTY', FLOW_DELTA, { fetch: fake(404, { error: 'No NIFTY futures contract found' }) }), { ok: true })
  assert.equal(missing.flow.missing, 'No NIFTY futures contract found')
  // A server error: the day is not run this time (tried again).
  const broken = day()
  const r = await attachOrderFlow(broken, 'NIFTY', FLOW_DELTA, { fetch: fake(500, { error: 'busy' }) })
  assert.equal(r.ok, false)
  assert.equal(r.retry, true)
  assert.equal(broken.flow, undefined)
})

test('the report says which days had no order flow, an estimated Δ, or no book', () => {
  const engine = { rule: { lines: [{ id: 'liqWalls', value: 'nearBid' }], action: 'buyCE', mirror: false } }
  const base = (date) => ({ date, ok: true, trades: [], signals: { rule: 0, mirror: 0 } })
  const outcomes = [
    { ...base('2026-10-05'), flow: 'live', flowEstimated: 0, flowBook: true },
    { ...base('2026-10-06'), flow: 'live', flowEstimated: 40, flowBook: true },
    { ...base('2026-10-07'), flow: 'estimated', flowEstimated: 375, flowBook: false },
    { ...base('2026-10-08'), flow: 'none', flowEstimated: 0, flowBook: false },
    { ...base('2026-10-09') },   // an outcome kept before the order flow (an older background run) - not listed
  ]
  const report = backtestReport(outcomes, engine)
  assert.deepEqual(report.noFlow, ['2026-10-08'])
  assert.deepEqual(report.flowEstimated, ['2026-10-06', '2026-10-07'])
  assert.deepEqual(report.noBook, ['2026-10-07'])
  // The Δ alone: no book needed, none listed.
  assert.deepEqual(backtestReport(outcomes, { rule: { lines: [{ id: 'futCvd', value: 'positive' }], action: 'buyCE', mirror: false } }).noBook, [])
  // A day's outcome carries where its order flow came from.
  const d = dayWith(flowBody({ n: 40, book: wallBook() }), { n: 40 })
  const o = dayOutcome('2026-10-05', { ...d, step: 50, atm: d.t.map(() => 25000), ce: new Map(), pe: new Map(), oi: [], breaks: [], hp: [] }, { rule: engine.rule, slPct: 30, targetPct: 50 })
  assert.equal(o.flow, 'live')
  assert.equal(o.flowBook, true)
})
