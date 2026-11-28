// NO LOOK-AHEAD AUDIT of the Signal backtest, end to end: the same day read WHOLE (the backtest) and read CUT at a clock
// (as the live scan reads it - only the minutes completed then) must agree on everything up to the cut - every feature
// array prepareDay makes, on every timeframe's candles, and every template's signals / entries / closed trades.
// If anything up to a minute depended on a later minute, the cut day would differ from the whole day there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { prepareDay, simulateDay, timeframeView } from '../src/signalBacktest.js'
import { orderFlowMinutes } from '../src/orderFlowFeatures.js'
import { engineSettings } from '../src/signalBacktestJob.js'
import { completedRun } from '../src/signalLive.js'
import { RULE_TEMPLATES, withTemplate } from '../src/signalTemplates.js'

const MIN = 60_000
const { run: base, minuteBars, prints, T915 } = syntheticDay()
// The run with what the synthetic day lacks: option volume and index volume (the premium VWAPs, candle volume reads).
const run = {
  ...base, optionExpiry: '2026-10-06',
  cePoints: base.cePoints.map((p, k) => ({ ...p, volume: 1000 + (k % 13) * 70 })),
  pePoints: base.pePoints.map((p, k) => ({ ...p, volume: 1000 + (k % 11) * 90 })),
  spotVolume: base.spotCandlesOneMinute.map((b, k) => ({ time: b.time, volume: 5000 + (k % 17) * 300 })),
}
// The previous session (pivots, CPR, yesterday's profile levels, the indicators' warm-up).
const prevProfile = {
  success: true, profileDate: '2026-10-02', poc: 22680, vah: 22730, val: 22640, hvn: [22700], lvn: [22660], bins: [],
  bars: base.spotCandlesOneMinute.map((b) => ({ ...b, time: new Date(Date.parse(b.time) - 3 * 864e5).toISOString(), open: b.open - 40, high: b.high - 40, low: b.low - 40, close: b.close - 40 })),
}
// The Order Flow day: footprint bars, prints and a heatmap column every second's bucket (30 s).
const heatmap = []
for (let ms = T915; ms < T915 + 300 * MIN; ms += 30_000) {
  const m = Math.floor((ms - T915) / MIN), p = minuteBars[m]?.close ?? 22700
  heatmap.push({ time: new Date(ms).toISOString(), bids: [[p - 1, 4e4], [p - 5, 2e5 + m * 300], [p - 9, 6e4]], asks: [[p + 1, 4e4], [p + 6, 1.8e5], [p + 10, 5e4]] })
}
const flowBody = { meta: { lotSize: 75 }, rowSize: 1, bars: minuteBars, trades: prints.map((t) => ({ ...t, time: new Date(t.time).toISOString() })), heatmap, source: 'live', backfill: [] }

const withFlow = (d, asOfMs = null) => { d.flow = orderFlowMinutes(flowBody, d.t, asOfMs == null ? {} : { asOfMs }); return d }
const whole = withFlow(prepareDay(run, { underlying: 'NIFTY', prevProfile, minMinutes: 5 }))
const cutAt = (nowMs) => withFlow(prepareDay(completedRun(run, nowMs), { underlying: 'NIFTY', prevProfile, minMinutes: 5 }), nowMs)

// A value as plain data, NaN kept (JSON drops it).
const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? `#${v}` : v instanceof Set ? [...v] : ArrayBuffer.isView(v) ? Array.from(v) : v)))
// Every per-minute array of a prepared day (or a view), recursively: [path, array].
function perMinute(obj, n, path = '', out = []) {
  if (obj == null || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k
    if ((Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === n) out.push([p, v])
    else if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof Map) && !(v instanceof Set)) perMinute(v, n, p, out)
  }
  return out
}
// Day-level values allowed to differ between a cut and the whole day (they describe the WHOLE loaded data, not a minute).
const DAY_LEVEL = new Set(['n', 't'])

const CUTS = [40, 77, 121, 168, 222, 271].map((m) => T915 + m * MIN + 20_000)   // 20 s into a minute: the one before completed

test('every per-minute feature of a day cut at a clock = the whole day\'s up to the cut (1 / 3 / 5 / 15-minute candles)', () => {
  assert.ok(whole.ok, whole.reason)
  const checked = new Set()
  for (const nowMs of CUTS) {
    const cut = cutAt(nowMs)
    assert.ok(cut.ok, cut.reason)
    assert.deepEqual(cut.t, whole.t.slice(0, cut.n))
    for (const tf of [1, 3, 5, 15]) {
      const w = timeframeView(whole, tf), c = timeframeView(cut, tf)
      // Candles that had COMPLETED at the clock (the last may be forming in the cut day - its own minutes only).
      const done = c.n - (tf > 1 ? 1 : 0)
      for (const [path, arr] of perMinute(c, c.n)) {
        if (DAY_LEVEL.has(path)) continue
        const full = perMinute(w, w.n).find(([p]) => p === path)?.[1]
        if (!full) continue
        checked.add(path)
        assert.deepEqual(plain(Array.from(arr).slice(0, done)), plain(Array.from(full).slice(0, done)), `${path} on ${tf}-min candles cut at ${new Date(nowMs).toISOString()}`)
      }
    }
  }
  assert.ok(checked.size > 30, `${checked.size} feature series checked`)
})

test('every template, every timeframe: the signals and entries known at a clock are the whole day\'s, closed trades exactly', () => {
  const page = { underlying: 'NIFTY', lots: 1, maxTradesPerDay: 20, cooldownMin: 0 }
  let firing = 0
  for (const tpl of RULE_TEMPLATES) {
    for (const timeframe of [1, 3, 5, 15]) {
      const engine = engineSettings(withTemplate({ ...page, timeframe }, tpl))
      const full = simulateDay(whole, engine)
      if (full.trades.length) firing++
      for (const nowMs of CUTS) {
        const cut = cutAt(nowMs)
        const live = simulateDay(cut, engine, { asOfMs: nowMs })
        const known = cut.t.at(-1)
        const key = (t) => [t.strategy, t.entryTime, t.entry, t.strike, t.side]
        const where = `${tpl.id} ${timeframe}m cut ${new Date(nowMs).toISOString()}`
        assert.deepEqual(live.trades.map(key), full.trades.filter((t) => t.entryTime <= known).map(key), where)
        for (const t of live.trades) {
          if (t.exitTime <= known && t.exitReason !== 'Day end') assert.deepEqual(plain(t), plain(full.trades.find((f) => f.entryTime === t.entryTime && f.strategy === t.strategy)), where)
        }
      }
    }
  }
  assert.ok(firing > 0, 'some template trades on the synthetic day')
})

test('the price series is chosen from the day\'s first minutes, not the whole day: futures that drop out later change no morning', () => {
  // The futures feed stops at 12:00 (more than 20% of the day missing): the morning must read the futures, cut or whole.
  const gap = { ...run, futuresBars: run.futuresBars.filter((b) => Date.parse(b.time) < T915 + 165 * MIN) }
  const all = prepareDay(gap, { underlying: 'NIFTY', prevProfile, minMinutes: 5 })
  const morning = prepareDay(completedRun(gap, T915 + 90 * MIN), { underlying: 'NIFTY', prevProfile, minMinutes: 5 })
  assert.equal(all.priceSource, 'futures')
  assert.equal(morning.priceSource, 'futures')
  assert.deepEqual(plain(all.vwap.slice(0, morning.n)), plain(morning.vwap))
  assert.deepEqual(plain(all.price.c.slice(0, morning.n)), plain(morning.price.c))
  // No futures at the open: the index from the start, whatever comes later.
  const late = { ...run, futuresBars: run.futuresBars.filter((b) => Date.parse(b.time) >= T915 + 20 * MIN) }
  assert.equal(prepareDay(late, { underlying: 'NIFTY', prevProfile, minMinutes: 5 }).priceSource, 'spot')
})
