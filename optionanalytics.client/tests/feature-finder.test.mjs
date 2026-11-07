// The feature finder (featureFinder.js): every reading at every candle as one table, what happened after it, and which
// readings ranked what came next on the earlier days AND still did on the later days.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { emaOver, istMinute, optionFor, prepareDay, rsiOver, simulateTrade, timeframeView } from '../src/signalBacktest.js'
import { FEATURES, HOLD_IC, LABELS, dayRows, featureReport, featureReports, rowsCsv, spearman } from '../src/featureFinder.js'
import { atr, bollinger, cci, dmi, macd, stochastic, supertrend } from './ta-reference.mjs'

const LEVELS = { slPct: 30, targetPct: 60, levelUnit: 'pct', entryFrom: '09:30', lastEntry: '14:45' }
const prepared = () => {
  const { run } = syntheticDay()
  return { run, d: prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' }) }
}
// The previous session (the profile response's own minutes - the indicators warm up on them, the pivots / gap read them):
// the synthetic day three days earlier, a little lower.
const prevProfileOf = (run) => ({
  success: true, profileDate: '2026-10-02', poc: 22740, vah: 22790, val: 22700, hvn: [22770], lvn: [22720], bins: [],
  bars: run.spotCandlesOneMinute.map((b) => ({ ...b, time: new Date(Date.parse(b.time) - 3 * 864e5).toISOString(), open: b.open - 40, high: b.high - 40, low: b.low - 40, close: b.close - 40 })),
})

test('a row a candle in the entry window, every feature and label', () => {
  const { d } = prepared()
  const rows = dayRows(d, { timeframe: 5, ...LEVELS })
  const v = timeframeView(d, 5)
  assert.ok(rows.length > 40 && rows.length < v.n)
  for (const r of rows) {
    assert.deepEqual(Object.keys(r.f), FEATURES.map((f) => f.key))
    assert.deepEqual(Object.keys(r.y), LABELS.map((l) => l.key))
    const m = new Date(r.time).getUTCHours() * 60 + new Date(r.time).getUTCMinutes() + 330
    assert.ok(m >= 9 * 60 + 30 && m <= 14 * 60 + 45, `row at ${m}`)
  }
  // Most features have a reading on this day (the synthetic one has OI, walls, straddle, VWAP ...).
  const filled = FEATURES.filter((f) => rows.some((r) => Number.isFinite(r.f[f.key])))
  assert.ok(filled.length >= 20, `${filled.length} features read`)
})

test('NO LOOK-AHEAD: the features of a day cut part way are the whole day\'s up to the cut - with and without the previous session', () => {
  const { run } = prepared()
  for (const prevProfile of [null, prevProfileOf(run)]) {
  const d = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', prevProfile })
  const cutMinute = 180
  const cut = Date.parse(run.spotCandlesOneMinute[cutMinute].time)
  const keep = (list) => list.filter((p) => Date.parse(p.time) <= cut)
  const part = prepareDay({ ...run, optionExpiry: '2026-10-06', spotCandlesOneMinute: keep(run.spotCandlesOneMinute), futuresBars: keep(run.futuresBars),
    cePoints: keep(run.cePoints), pePoints: keep(run.pePoints) }, { underlying: 'NIFTY', prevProfile })
  for (const tf of [1, 5, 15]) {
    const full = dayRows(d, { timeframe: tf, ...LEVELS })
    const cutRows = dayRows(part, { timeframe: tf, ...LEVELS })
    // Every candle that ended by the cut - the last one of the cut day may be a candle still forming at 5 min.
    const done = cutRows.filter((r) => r.time + (tf - 1) * 60_000 < cut)
    assert.ok(done.length > (tf === 15 ? 8 : 20), `${tf}m: ${done.length} candles`)
    for (const r of done) {
      const same = full.find((x) => x.time === r.time)
      for (const f of FEATURES) {
        const a = r.f[f.key], b = same.f[f.key]
        assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9, `${tf}m ${f.key} at ${new Date(r.time).toISOString()}: ${a} vs ${b}`)
      }
    }
  }
  }
})

test('the indicators: TradingView\'s, on the spot candles of the timeframe, warmed up on the previous session\'s candles', () => {
  const { run } = prepared()
  const prevProfile = prevProfileOf(run)
  const d = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', prevProfile })
  for (const tf of [1, 5]) {
    const v = timeframeView(d, tf)
    // The previous session's minutes in candles of the timeframe from 09:15, then the day's - put together by hand here.
    const prev = []
    for (const b of prevProfile.bars) {
      const bucket = Math.floor((istMinute(Date.parse(b.time)) - (9 * 60 + 15)) / tf)
      const last = prev.at(-1)
      if (last?.bucket === bucket) { last.h = Math.max(last.h, b.high); last.l = Math.min(last.l, b.low); last.c = b.close } else prev.push({ bucket, h: b.high, l: b.low, c: b.close })
    }
    const H = [...prev.map((x) => x.h), ...v.spot.h], L = [...prev.map((x) => x.l), ...v.spot.l], C = [...prev.map((x) => x.c), ...v.spot.c]
    const w = prev.length
    const m = macd(C), st = stochastic(H, L, C), bb = bollinger(C), di = dmi(H, L, C), sup = supertrend(H, L, C), at = atr(H, L, C), cc = cci(H, L, C)
    const rsi7 = rsiOver(Float64Array.from(C), 7), ema50 = emaOver(Float64Array.from(C), 50)
    const rows = dayRows(d, { timeframe: tf, ...LEVELS })
    const near = (a, b, what) => assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${tf}m ${what}: ${a} vs ${b}`)
    let checked = 0
    for (const r of rows) {
      const k = v.t.indexOf(r.time)
      const c = v.spot.c[k]
      near(r.f.macd, (m.macd[w + k] / c) * 100, 'macd')
      near(r.f.macdHist, (m.hist[w + k] / c) * 100, 'macdHist')
      near(r.f.macdHistChange, ((m.hist[w + k] - m.hist[w + k - 1]) / c) * 100, 'macdHistChange')
      near(r.f.stochK, st.k[w + k], 'stochK')
      near(r.f.stochD, st.d[w + k], 'stochD')
      near(r.f.cci, cc[w + k], 'cci')
      near(r.f.bbPctB, bb.pctB[w + k], 'bbPctB')
      near(r.f.bbWidth, bb.width[w + k], 'bbWidth')
      near(r.f.atrPct, (at[w + k] / c) * 100, 'atrPct')
      near(r.f.adx, di.adx[w + k], 'adx')
      near(r.f.diSpread, di.plus[w + k] - di.minus[w + k], 'diSpread')
      near(r.f.superTrend, sup.dir[w + k], 'superTrend')
      near(r.f.superTrendDist, ((c - sup.line[w + k]) / sup.line[w + k]) * 100, 'superTrendDist')
      near(r.f.rsi7, rsi7[w + k], 'rsi7')
      near(r.f.ema50, ((c - ema50[w + k]) / ema50[w + k]) * 100, 'ema50')
      if (Number.isFinite(r.f.macd) && Number.isFinite(r.f.adx) && Number.isFinite(r.f.superTrend)) checked++
    }
    // Warmed up on the day before, every one reads from the first row.
    assert.equal(checked, rows.length, `${tf}m`)
  }
})

test('the other new readings: VWAP in deviations, the candle\'s volume, the basis, the gap, yesterday\'s range, the premiums, the days to expiry', () => {
  const { run } = prepared()
  const prevProfile = prevProfileOf(run)
  const d = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', prevProfile })
  const rows = dayRows(d, { timeframe: 1, ...LEVELS })
  const r = rows[40]
  const m = d.t.indexOf(r.time)
  // The futures' volume-weighted mean and deviation of the typical price up to the minute.
  let pv = 0, pv2 = 0, vol = 0
  for (const b of run.futuresBars) {
    if (Date.parse(b.time) > d.t[m] || !(b.volume > 0)) continue
    const tp = (b.high + b.low + b.close) / 3
    pv += tp * b.volume; pv2 += tp * tp * b.volume; vol += b.volume
  }
  const vwap = pv / vol, sd = Math.sqrt(pv2 / vol - vwap * vwap)
  assert.equal(d.priceSource, 'futures')
  assert.ok(Math.abs(r.f.vwapZ - (d.price.c[m] - vwap) / sd) < 1e-6, `${r.f.vwapZ}`)
  const volumes = d.price.v.slice(0, m + 1)
  assert.ok(Math.abs(r.f.relVolume - d.price.v[m] / (volumes.reduce((a, b) => a + b, 0) / volumes.length)) < 1e-9)
  assert.ok(Math.abs(r.f.basis - ((d.price.c[m] - d.spot.c[m]) / d.spot.c[m]) * 100) < 1e-9)
  const prevClose = prevProfile.bars.at(-1).close
  assert.ok(Math.abs(r.f.gap - ((d.spot.o[0] - prevClose) / prevClose) * 100) < 1e-9)
  const hi = Math.max(...prevProfile.bars.map((b) => b.high)), lo = Math.min(...prevProfile.bars.map((b) => b.low))
  assert.ok(Math.abs(r.f.prevRange - ((d.spot.c[m] - lo) / (hi - lo)) * 100) < 1e-9)
  assert.equal(r.f.daysToExpiry, 1)                         // 5 Oct, options expiring 6 Oct
  assert.equal(r.f.weekday, 1)                              // a Monday
  assert.ok(r.f.candleBody >= -1 && r.f.candleBody <= 1)
  assert.ok(Number.isFinite(r.f.cePremRsi) && Number.isFinite(r.f.straddle15))
  // The premiums' own VWAP needs the strike's traded volume - the synthetic chain has none: no reading, never a made-up one.
  assert.ok(rows.every((x) => Number.isNaN(x.f.cePremVwap) && Number.isNaN(x.f.pePremVwap)))
  // With option volume it reads the strike's own VWAP: the premium's typical price x volume from the day's first minute.
  const withVolume = prepareDay({ ...run, optionExpiry: '2026-10-06', cePoints: run.cePoints.map((p) => ({ ...p, volume: 10 })) }, { underlying: 'NIFTY', prevProfile })
  const vr = dayRows(withVolume, { timeframe: 1, ...LEVELS })[40]
  assert.ok(Number.isFinite(vr.f.cePremVwap) && Number.isNaN(vr.f.pePremVwap))
})

test('the labels: spot N minutes later, and the backtest\'s own trade bought at the candle', () => {
  const { d } = prepared()
  const rows = dayRows(d, { timeframe: 1, ...LEVELS })
  const r = rows[20]
  const m = d.t.indexOf(r.time)
  assert.ok(Math.abs(r.y.fwd15 - ((d.spot.c[m + 15] - d.spot.c[m]) / d.spot.c[m]) * 100) < 1e-9)
  const ce = simulateTrade(d, m, optionFor(1, 'buy', d.atm[m], d.step, 0), { slPct: 30, targetPct: 60, levelUnit: 'pct' })
  assert.ok(Math.abs(r.y.ceBuy - (ce.points / ce.entry) * 100) < 1e-9)
  const pe = simulateTrade(d, m, optionFor(-1, 'buy', d.atm[m], d.step, 0), { slPct: 30, targetPct: 60, levelUnit: 'pct' })
  assert.ok(Math.abs(r.y.peBuy - (pe.points / pe.entry) * 100) < 1e-9)
  // SOLD there with the same levels - the backtest's own sell (a sold CE / PE: its return positive when the premium fell).
  const ceSold = simulateTrade(d, m, optionFor(-1, 'sell', d.atm[m], d.step, 0), { slPct: 30, targetPct: 60, levelUnit: 'pct' })
  assert.equal(optionFor(-1, 'sell', d.atm[m], d.step, 0).side, 'CE')
  assert.ok(Math.abs(r.y.ceSell - (ceSold.points / ceSold.entry) * 100) < 1e-9)
  const peSold = simulateTrade(d, m, optionFor(1, 'sell', d.atm[m], d.step, 0), { slPct: 30, targetPct: 60, levelUnit: 'pct' })
  assert.ok(Math.abs(r.y.peSell - (peSold.points / peSold.entry) * 100) < 1e-9)
  // Every row: a buy and a sale of the same option, held to the same exit, are equal and opposite - else a level ended one.
  const allRows = dayRows(d, { timeframe: 1, slPct: 0, targetPct: 0, entryFrom: '09:30', lastEntry: '14:45' })
  for (const x of allRows) if (Number.isFinite(x.y.ceBuy)) assert.ok(Math.abs(x.y.ceBuy + x.y.ceSell) < 1e-9)
  // The highest / lowest spot of the next 30 minutes.
  let hi = -Infinity, lo = Infinity
  for (let k = m + 1; k <= m + 30; k++) { hi = Math.max(hi, d.spot.h[k]); lo = Math.min(lo, d.spot.l[k]) }
  assert.ok(Math.abs(r.y.up30 - ((hi - d.spot.c[m]) / d.spot.c[m]) * 100) < 1e-9)
  assert.ok(Math.abs(r.y.down30 - ((lo - d.spot.c[m]) / d.spot.c[m]) * 100) < 1e-9)
  assert.ok(r.y.up30 >= r.y.fwd15 - 1e-9 && r.y.down30 <= r.y.fwd15 + 1e-9)
  // No label from past the day's last minute.
  const late = dayRows(d, { timeframe: 1, ...LEVELS, lastEntry: '15:29' }).at(-1)
  assert.ok(Number.isNaN(late.y.fwd60))
  assert.ok(Number.isNaN(late.y.up30) && Number.isNaN(late.y.down30))
  // Every label's report, keyed as LABELS.
  assert.deepEqual(Object.keys(featureReports(allRows)), LABELS.map((l) => l.key))
})

test('Spearman: ranks, ties, too few pairs', () => {
  const x = Array.from({ length: 20 }, (_, k) => k)
  assert.equal(spearman(x, x.map((v) => v * v)), 1)
  assert.equal(spearman(x, x.map((v) => -v)), -1)
  assert.ok(Number.isNaN(spearman(x.slice(0, 9), x.slice(0, 9))))
  assert.ok(Math.abs(spearman(x, x.map((v) => (v % 2 ? 1 : 0)))) < 0.2)       // no order between them
  assert.equal(spearman([...x, NaN], [...x, 5]), 1)                           // a pair without both numbers is left out
})

test('the report: what held on the LATER days, not what only worked on the earlier ones', () => {
  // 12 days, 40 rows each. move15 predicts fwd30 every day; rsi predicts it on the first 8 days and the other way after;
  // ema20 is noise.
  let seed = 3
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 }
  const rows = []
  for (let day = 0; day < 12; day++) {
    const date = `2026-10-${String(day + 1).padStart(2, '0')}`
    for (let k = 0; k < 40; k++) {
      const y = rnd()
      const f = Object.fromEntries(FEATURES.map((ft) => [ft.key, NaN]))
      f.move15 = y + rnd() * 0.5
      f.rsi = (day < 8 ? y : -y) + rnd() * 0.5
      f.ema20 = rnd()
      rows.push({ date, time: Date.parse(`${date}T04:00:00Z`) + k * 60_000, f, y: { fwd30: y, ceBuy: y > 0 ? 10 : -5 } })
    }
  }
  const rep = featureReport(rows, 'fwd30')
  assert.equal(rep.split, true)
  assert.equal(rep.days, 12)
  assert.equal(rep.laterDays, 4)
  assert.equal(rep.firstLater, '2026-10-09')
  const by = Object.fromEntries(rep.features.map((x) => [x.key, x]))
  assert.ok(by.move15.holds && by.move15.icEarly > 0.5 && by.move15.icLater > 0.5 && by.move15.dayAgree === 100)
  assert.ok(!by.rsi.holds && by.rsi.icEarly > 0.5 && by.rsi.icLater < -0.5 && by.rsi.dayAgree === 0)
  assert.ok(!by.ema20.holds || Math.abs(by.ema20.icLater) < 0.2)
  assert.equal(rep.features[0].key, 'move15')                                   // what holds comes first
  assert.ok(Math.abs(by.move15.icLater) >= HOLD_IC)
  // The top fifth of move15 had far more CE wins than its bottom fifth (on the later days).
  const ce = featureReport(rows, 'ceBuy')
  const m = ce.features.find((x) => x.key === 'move15')
  assert.ok(m.fifths.high.win > 80 && m.fifths.low.win < 20)
  // Too few days for an honest split: every day in both, nothing "holds".
  const few = featureReport(rows.filter((r) => r.date < '2026-10-05'), 'fwd30')
  assert.equal(few.split, false)
  assert.ok(few.features.every((x) => !x.holds))
})

test('the CSV: a header of the keys, a row a candle, numbers rounded, cells formula-safe', () => {
  const { d } = prepared()
  const rows = dayRows(d, { timeframe: 15, ...LEVELS })
  const csv = rowsCsv(rows).trim().split('\n')
  assert.equal(csv[0], ['date', 'time', ...FEATURES.map((f) => f.key), ...LABELS.map((l) => l.key)].join(','))
  assert.equal(new Set(csv[0].split(',')).size, csv[0].split(',').length)                // every column named once
  assert.equal(csv.length, rows.length + 1)
  assert.match(csv[1], /^2026-10-05,09:(29|30|44|45),/)
  assert.equal(csv[1].split(',').length, 2 + FEATURES.length + LABELS.length)
})
