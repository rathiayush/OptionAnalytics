// The Signal backtest's day chart (signalBacktestChart.js): the candles of the run's timeframe, each marker on the candle
// its trade entered / went out in, the signals not taken, the lines the rule reads, and the day picked by default.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { emaSeries, premiumCandles, premiumEma, prepareDay, simulateDay, timeframeView } from '../src/signalBacktest.js'
import { candleStart, dayChartData, dayOptions, defaultChartDay, defaultChartOption, ruleIndicators, skippedMarkers, tradeMarkers } from '../src/signalBacktestChart.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')

test('a minute\'s candle: its start on the timeframe from 09:15', () => {
  assert.equal(candleStart(T915 + 7 * MIN, 1), T915 + 7 * MIN)
  assert.equal(candleStart(T915 + 7 * MIN, 5), T915 + 5 * MIN)
  assert.equal(candleStart(T915 + 4 * MIN, 5), T915)
  assert.equal(candleStart(T915 + 44 * MIN, 15), T915 + 30 * MIN)
  assert.equal(candleStart(T915 + 3 * MIN, 3), T915 + 3 * MIN)
})

test('the trades tagged: BUY / SELL at the entry candle (bullish under it, up; bearish over it, down), the exit with its net', () => {
  const trades = [
    { dir: 1, action: 'BUY', strike: 25000, side: 'CE', entryTime: T915 + 22 * MIN, exitTime: T915 + 41 * MIN, net: 1234.4 },
    { dir: -1, action: 'SELL', strike: 25100, side: 'CE', entryTime: T915 + 64 * MIN, exitTime: T915 + 70 * MIN, net: -560 },
  ]
  const m = tradeMarkers(trades, 5, { up: 'g', down: 'r' })
  assert.deepEqual(m.map((x) => [x.time, x.position, x.shape, x.color, x.text]), [
    [T915 + 20 * MIN, 'belowBar', 'arrowUp', 'g', 'BUY 25000 CE'],
    [T915 + 40 * MIN, 'aboveBar', 'circle', 'g', 'Exit +₹1,234'],
    [T915 + 60 * MIN, 'aboveBar', 'arrowDown', 'r', 'SELL 25100 CE'],
    [T915 + 70 * MIN, 'belowBar', 'circle', 'r', 'Exit −₹560'],
  ])
  // The signals not taken: grey, by their direction - none on a candle a trade entered on, one a candle and side.
  const signals = [
    { time: T915 + 22 * MIN, dir: 1, taken: true }, { time: T915 + 23 * MIN, dir: 1, taken: false },      // the entry's candle
    { time: T915 + 30 * MIN, dir: -1, taken: false }, { time: T915 + 31 * MIN, dir: -1, taken: false },    // one dot for both
    { time: T915 + 50 * MIN, dir: 1, taken: false },
  ]
  assert.deepEqual(skippedMarkers(signals, trades, 5).map((x) => [x.time, x.position]), [[T915 + 30 * MIN, 'aboveBar'], [T915 + 50 * MIN, 'belowBar']])
})

test('what the chart draws of a day: its timeframe\'s candles, the VWAP of the price shown, the rule\'s EMAs / RSI, the pivots', () => {
  const { run } = syntheticDay()
  const profile = { success: true, profileDate: '2026-10-02', bars: [{ time: '2026-10-02T03:45:00Z', open: 22600, high: 22700, low: 22500, close: 22650, volume: 1 }] }
  const day = prepareDay(run, { underlying: 'NIFTY', prevProfile: profile })
  const spot = dayChartData(day, { timeframe: 5, ema: [9, 21], rsi: 14 })
  const view = timeframeView(day, 5)
  assert.equal(spot.candles.length, view.n)
  assert.deepEqual(spot.candles[1], { time: T915 + 5 * MIN, open: day.spot.o[5], high: Math.max(...day.spot.h.slice(5, 10)), low: Math.min(...day.spot.l.slice(5, 10)), close: day.spot.c[9] })
  assert.equal(spot.futures, false)
  assert.equal(spot.vwap.length, 0)                                      // the synthetic index has no VWAP of its own
  assert.deepEqual(spot.emas.map((e) => e.period), [9, 21])
  assert.equal(spot.emas[0].points.at(-1).value, emaSeries(view, 9).at(-1))
  assert.ok(spot.rsi.points.length > 0 && spot.pivots.p > 0)
  // The futures: their own candles and VWAP (the rule's); the EMAs and pivots - spot's prices - left out, RSI kept.
  const fut = dayChartData(day, { timeframe: 5, source: 'futures', ema: [9], rsi: 14 })
  assert.equal(fut.futures, true)
  assert.equal(fut.candles[0].close, view.price.c[0])
  assert.equal(fut.vwap.length, view.n)
  assert.deepEqual([fut.emas, fut.pivots], [[], null])
  assert.ok(fut.rsi.points.length > 0)
  assert.equal(dayChartData({ ok: false }), null)
  // The chart's tags are the day's own trades: each entry on its signal candle.
  const { trades } = simulateDay(day, { lotSize: 65, rule: { conditions: { vwap: 'crossedAbove' }, action: 'buyCE', mirror: true }, timeframe: 5 })
  assert.ok(trades.length > 0)
  const times = new Set(spot.candles.map((c) => c.time))
  for (const m of tradeMarkers(trades, 5)) assert.ok(times.has(m.time), 'on a candle of the chart')
})

test('the indicators a rule reads - its own periods and RSI levels (the mirror\'s from the other end), the pivots', () => {
  const tree = (lines) => ({ tree: { op: 'and', not: false, items: lines.map((line) => ({ line })) }, action: 'buyCE', mirror: true })
  assert.deepEqual(ruleIndicators(tree([
    { id: 'emaCross', value: 'crossedUp', param2: 5, param3: 13 }, { id: 'emaPrice', value: 'above', param2: 50 }, { id: 'rsi', value: 'above', param: 60, param2: 9 }, { id: 'pivotR1', value: 'above' },
  ])), { ema: [5, 13, 50], rsi: 9, rsiLevels: [40, 60], pivots: true, premium: false })
  assert.deepEqual(ruleIndicators(tree([{ id: 'vwap', value: 'above' }])), { ema: [], rsi: null, rsiLevels: [], pivots: false, premium: false })
  // A premium's: its EMAs and RSI - the mirror reads the other side's at the same level.
  assert.deepEqual(ruleIndicators(tree([{ id: 'cePremEmaCross', value: 'crossedUp', param2: 7, param3: 30 }, { id: 'pePremRsi', value: 'above', param: 65, param2: 10 }])),
    { ema: [7, 30], rsi: 10, rsiLevels: [65], pivots: false, premium: true })
  assert.equal(ruleIndicators(tree([{ id: 'cpr', value: 'narrow' }])).pivots, true)
})

test('the day picked by default: the first with a trade, else the first that ran', () => {
  assert.equal(defaultChartDay([{ date: 'a', ok: false, trades: 0 }, { date: 'b', ok: true, trades: 0 }, { date: 'c', ok: true, trades: 2 }]), 'c')
  assert.equal(defaultChartDay([{ date: 'a', ok: false, trades: 0 }, { date: 'b', ok: true, trades: 0 }]), 'b')
  assert.equal(defaultChartDay([]), null)
})

test('an option\'s chart: the strike\'s premium candles with its own VWAP / EMAs / RSI; the strikes offered, the one opened on', () => {
  const { run } = syntheticDay()
  const day = prepareDay({ ...run, cePoints: run.cePoints.map((p) => ({ ...p, volume: 40 })) }, { underlying: 'NIFTY' })
  const strike = day.atm[0]
  const chart = dayChartData(day, { timeframe: 5, source: 'option', option: { side: 'ce', strike }, ema: [9], rsi: 14 })
  const view = timeframeView(day, 5)
  const p = premiumCandles(view, 'ce', strike)
  assert.deepEqual(chart.option, { side: 'ce', strike })
  assert.equal(chart.candles[0].close, p.c[0])
  assert.equal(chart.vwap.at(-1).value, p.vwap.at(-1))
  assert.equal(chart.emas[0].points.at(-1).value, premiumEma(view, 'ce', strike, 9).at(-1))
  assert.ok(chart.rsi.points.length > 0 && chart.pivots === null)
  // The strikes offered: every strike loaded, CE and PE, the open's ATM first.
  const offered = dayOptions(day)
  assert.deepEqual(offered.slice(0, 2).map((o) => o.value), [`ce|${strike}`, `pe|${strike}`])
  assert.equal(offered.length, day.ce.size + day.pe.size)
  // Opened on the day's first trade's option, else the ATM call.
  assert.deepEqual(defaultChartOption(day, [{ side: 'PE', strike: 22800 }]), { side: 'pe', strike: 22800 })
  assert.deepEqual(defaultChartOption(day, []), { side: 'ce', strike })
})
