// The SIGNAL BACKTEST (the Signal backtest page): past days replayed through ONE strategy the trader builds - a rule of
// conditions read from what the OI Replay page and the Volume & Market Profile page show (OI since the open, the OI
// totals' CE / PE / Net cumulative Δ and their S/R breaks, the 🎯 signal, the OI support / resistance walls, GEX's
// regime and walls, VWAP, spot's move, the ATM straddle, the Initial Balance and the PREVIOUS day's volume profile -
// POC / HVN / LVN / VAH / VAL and its value area), each
// a dropdown of what it can say: a signal when ALL the conditions picked hold, then the trade picked (buy / sell the call
// / put) - and, with the mirror, the opposite conditions' opposite trade.
//
// Two steps, so a change of settings re-runs in an instant:
//   prepareDay(run)       - the day's features at every minute, each from data up to the END of that minute only (a
//                           point / bar stamped at a minute's start holds its close): nothing after a minute is known at
//                           it. Kept per day (compact - the option bars as typed arrays, ~0.5 MB a day).
//   simulateDay(day, s)   - the rule's signals (on the timeframe's candles) and their trades under the settings `s`.
//
// NO LOOK-AHEAD: a signal at minute i is read from the features of minutes <= i; the trade enters at minute i's option
// close (the last finished minute's premium) and is managed from minute i + 1 on the option's own 1-minute bars: a bar
// opening through the stop fills at its open, the stop before the target in the same bar, the target at the target; a
// time stop and the 15:10 square-off at the bar's close. No entry before 09:30 or after 14:45. `tests/signal-backtest.test.mjs`.
//
// It is a backtest of the rule as set, not a tuning.

import { chainOiTotalsAt } from './chainOiTotals.js'
import { oiWalls } from './marketRead.js'
import {
  IST_OFFSET_SECONDS, breakMeaning, changesFromLevels, completedLevelReads, newBreakWatch, newHighProbabilityWatch, perStrikeLevels,
  watchBreaks, watchHighProbability,
} from './oiLevelBreaks.js'
import { buildOiTotalsRows } from './oiTotalsHeatmap.js'
import { gexDay } from './gex.js'
import { straddleRead } from './straddle.js'
import { tradeCharges } from './tradeCharges.js'
import { optionTrailLevel, tighterStop } from './optionTrail.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN
const IST_MS = 330 * MIN
const STALE_MINUTES = 5
const SESSION_FIRST = 9 * 60 + 15     // 09:15
const SESSION_LAST = 15 * 60 + 29     // 15:29
const IB_LAST = 10 * 60 + 14          // the Initial Balance: 09:15 - 10:14 (the first hour)
/** The timeframes the strategies can be read on (minutes) - each divides the session from 09:15 and the IB's hour. */
export const TIMEFRAMES = [1, 3, 5, 15]

const msOf = (t) => (typeof t === 'number' ? t : Date.parse(t))
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN
/** Minutes since IST midnight of `ms`. */
export const istMinute = (ms) => Math.floor((((ms + IST_MS) % DAY) + DAY) % DAY / MIN)
const hhmm = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
/** "HH:mm" -> minutes since midnight. */
export const clockMinute = (text) => {
  const [h, m] = String(text ?? '').split(':').map(Number)
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null
}

// ---- The day's features -------------------------------------------------------------------------------------------

// Each strike's option bars keyed by minute (a later point of the same minute is the newer reading).
function legsByStrike(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !(p.price > 0)) continue
    const t = minuteOf(msOf(p.time))
    if (!Number.isFinite(t)) continue
    let m = byStrike.get(p.strike)
    if (!m) byStrike.set(p.strike, m = new Map())
    m.set(t, { o: p.open > 0 ? p.open : p.price, h: p.high > 0 ? p.high : p.price, l: p.low > 0 ? p.low : p.price, c: p.price, oi: p.openInterest ?? null })
  }
  return byStrike
}

/** A side's bars as one Float64Array per strike: [o, h, l, c] per minute of `times`, NaN where the minute has none. */
function packBars(byStrike, times) {
  const out = new Map()
  for (const [strike, minutes] of byStrike) {
    const a = new Float64Array(times.length * 4).fill(NaN)
    times.forEach((t, i) => {
      const b = minutes.get(t)
      if (b) { a[i * 4] = b.o; a[i * 4 + 1] = b.h; a[i * 4 + 2] = b.l; a[i * 4 + 3] = b.c }
    })
    out.set(strike, a)
  }
  return out
}

/** The OI totals' cumulative Δ breaks and 🎯 signals on `bucketSeconds` buckets, minute by minute: at the end of each
 *  minute only the buckets completed by then are read, so an event is listed at the minute it became known. Also the
 *  CE / PE / Net cumulative Δ lines at the last completed bucket, each minute. */
function oiBreakReads(ceLevelSeries, peLevelSeries, t, atm, bucketSeconds) {
  const n = t.length
  const ceLevels = perStrikeLevels(ceLevelSeries, bucketSeconds)
  const peLevels = perStrikeLevels(peLevelSeries, bucketSeconds)
  const oiTotals = buildOiTotalsRows(changesFromLevels(ceLevels), changesFromLevels(peLevels))
  const breakWatch = newBreakWatch()
  const hpWatch = newHighProbabilityWatch()
  const breaks = []
  const hp = []
  const ceCum = new Float64Array(n).fill(NaN)
  const peCum = new Float64Array(n).fill(NaN)
  const netCum = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    const nowSec = Math.floor(t[i] / 1000) + IST_OFFSET_SECONDS + 60     // the end of minute i
    const reads = completedLevelReads(oiTotals, bucketSeconds, nowSec)
    if (!reads) continue
    ceCum[i] = oiTotals.rows.ceCum.get(reads.last) ?? NaN
    peCum[i] = oiTotals.rows.peCum.get(reads.last) ?? NaN
    netCum[i] = oiTotals.rows.netCum.get(reads.last) ?? NaN
    const fresh = watchBreaks(breakWatch, reads, bucketSeconds)
    for (const b of fresh) breaks.push({ i, line: b.side.key, up: b.up, dir: breakMeaning(b.side.key, b.up), text: `OI ${b.side.label} cumulative Δ broke ${b.up ? 'above resistance' : 'below support'} (${b.up ? b.side.up : b.side.down})` })
    const signals = watchHighProbability(hpWatch, fresh, { totals: oiTotals, ceLevels, peLevels, last: reads.last, atmStrike: atm[i], bucketSeconds })
    for (const x of signals) hp.push({ i, dir: x.hp.bullish ? 1 : -1, text: `🎯 ${x.hp.bullish ? 'bullish' : 'bearish'}: OI ${x.b.side.label} break + ${x.hp.side} OI at ATM ± 1 ${x.hp.pct >= 0 ? '+' : ''}${x.hp.pct.toFixed(0)}%` })
  }
  return { breaks, hp, ceCum, peCum, netCum }
}

/**
 * The day's features at every session minute - each from what was known at the END of that minute. `run`: the OI
 * Replay run (`/api/oi-replay/{u}/run` - spotCandlesOneMinute, cePoints / pePoints, futuresBars, spotVwap, step,
 * optionExpiry); `prevProfile` the previous day's volume profile (`previousProfile`). Returns `{ ok: true, date, underlying, step, n, t, spot, price, priceSource, vwap, oi, breaks, hp,
 * walls, gex, straddle, ib, prevVp, atm, ce, pe, ceCum, peCum, netCum, expiry, isExpiry }` - or `{ ok: false, reason }`.
 * `expiry` = the expiry of the options loaded (the run's `optionExpiry` - the weekly, BANKNIFTY's monthly), `isExpiry` =
 * the day IS that expiry (known before the open - the expiry calendar).
 */
export function prepareDay(run, { underlying = null, prevProfile = null } = {}) {
  const u = String(underlying ?? run?.underlying ?? '').toUpperCase()
  const session = (ms) => { const m = istMinute(ms); return m >= SESSION_FIRST && m <= SESSION_LAST }
  const spotBars = (run?.spotCandlesOneMinute ?? [])
    .map((b) => ({ t: minuteOf(msOf(b.time)), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 }))
    .filter((b) => Number.isFinite(b.t) && b.c > 0 && session(b.t))
    .sort((a, b) => a.t - b.t)
    .filter((b, i, all) => i === 0 || b.t !== all[i - 1].t)
  if (spotBars.length < 30) return { ok: false, reason: 'not enough spot minutes for the day' }
  const n = spotBars.length
  const t = spotBars.map((b) => b.t)
  const date = new Date(t[0] + IST_MS).toISOString().slice(0, 10)
  const expiry = /^\d{4}-\d{2}-\d{2}/.test(String(run?.optionExpiry ?? '')) ? String(run.optionExpiry).slice(0, 10) : null

  // The price the VWAP / Initial Balance are read on: the futures (they carry volume) when they cover the day,
  // else the index (its own VWAP from the server, when it had volume).
  const fut = new Map()
  for (const b of run?.futuresBars ?? []) {
    const ms = minuteOf(msOf(b.time))
    if (Number.isFinite(ms) && b.close > 0 && session(ms)) fut.set(ms, b)
  }
  const useFutures = fut.size >= n * 0.8
  const priceBars = []
  let lastFut = null
  for (let i = 0; i < n; i++) {
    if (useFutures) {
      const f = fut.get(t[i])
      if (f) lastFut = { o: f.open, h: f.high, l: f.low, c: f.close, v: f.volume ?? 0 }
      priceBars.push(lastFut ?? { o: spotBars[i].o, h: spotBars[i].h, l: spotBars[i].l, c: spotBars[i].c, v: 0 })
    } else {
      const s = spotBars[i]
      priceBars.push({ o: s.o, h: s.h, l: s.l, c: s.c, v: s.v })
    }
  }
  const vwap = new Float64Array(n).fill(NaN)
  if (useFutures) {
    let pv = 0, vol = 0
    for (let i = 0; i < n; i++) {
      const b = fut.get(t[i])
      if (b && b.volume > 0) { pv += ((b.high + b.low + b.close) / 3) * b.volume; vol += b.volume }
      if (vol > 0) vwap[i] = pv / vol
    }
  } else {
    const points = (run?.spotVwap ?? []).map((p) => ({ t: minuteOf(msOf(p.time)), v: p.obv ?? p.value })).filter((p) => p.v > 0).sort((a, b) => a.t - b.t)
    let k = 0, last = NaN
    for (let i = 0; i < n; i++) {
      while (k < points.length && points[k].t <= t[i]) last = points[k++].v
      vwap[i] = last
    }
  }

  // Options.
  const ceLegs = legsByStrike(run?.cePoints)
  const peLegs = legsByStrike(run?.pePoints)
  const strikes = [...new Set([...ceLegs.keys(), ...peLegs.keys()])].sort((a, b) => a - b)
  let step = run?.step > 0 ? run.step : null
  if (!step) for (let k = 1; k < strikes.length; k++) { const d = strikes[k] - strikes[k - 1]; if (d > 0 && (step == null || d < step)) step = d }
  if (!step || !strikes.length) return { ok: false, reason: 'no option data for the day' }
  const atm = t.map((_, i) => Math.round(spotBars[i].c / step) * step)

  // OI since the open, chain-wide (a strike joining the band later counts from its first reading - chainOiTotals.js).
  const byStrikeSeries = (legs) => new Map([...legs].map(([k, minutes]) => [k, [...minutes].sort((a, b) => a[0] - b[0])
    .filter(([, b]) => Number.isFinite(b.oi)).map(([ms, b]) => ({ ms, openInterest: b.oi }))]))
  const ceSeries = byStrikeSeries(ceLegs)
  const peSeries = byStrikeSeries(peLegs)
  const totals = chainOiTotalsAt(ceSeries, peSeries, t[0], t)
  const oi = totals.map((x) => ({ ce: x.ce - totals[0].ce, pe: x.pe - totals[0].pe }))
  // Total OI: the chain-wide CE / PE open interest itself (OI Replay's "Total OI" and its lookback table - the same totals).
  const tot = totals.map((x) => ({ ce: x.ce, pe: x.pe }))

  // The OI totals' cumulative Δ breaks (CE / PE / Net) and the 🎯 high-probability signal, stepped minute by minute on
  // the completed buckets (the OI Replay page's own step, `oiLevelBreaks.js`) - 1-minute buckets, and each longer
  // timeframe's own buckets (the OI totals chart at that timeframe) for the strategies read on its candles.
  const levelSeries = (series) => new Map([...series].map(([k, list]) => [k, list.map((p) => ({ t: p.ms, oi: p.openInterest }))]))
  const ceLevelSeries = levelSeries(ceSeries)
  const peLevelSeries = levelSeries(peSeries)
  const { breaks, hp, ceCum, peCum, netCum } = oiBreakReads(ceLevelSeries, peLevelSeries, t, atm, 60)
  const oiTf = {}
  for (const tf of TIMEFRAMES) if (tf > 1) oiTf[tf] = oiBreakReads(ceLevelSeries, peLevelSeries, t, atm, tf * 60)

  // The OI walls (the spot chart's S-R): the most call OI at or above spot, the most put OI at or below it - the strikes'
  // latest OI at the end of each minute.
  const walls = []
  {
    const cursors = strikes.map((k) => ({ k, ce: [...(ceLegs.get(k) ?? new Map())].sort((a, b) => a[0] - b[0]), pe: [...(peLegs.get(k) ?? new Map())].sort((a, b) => a[0] - b[0]), ci: 0, pi: 0, ceOi: null, peOi: null }))
    for (let i = 0; i < n; i++) {
      for (const c of cursors) {
        while (c.ci < c.ce.length && c.ce[c.ci][0] <= t[i]) { const v = c.ce[c.ci++][1].oi; if (Number.isFinite(v)) c.ceOi = v }
        while (c.pi < c.pe.length && c.pe[c.pi][0] <= t[i]) { const v = c.pe[c.pi++][1].oi; if (Number.isFinite(v)) c.peOi = v }
      }
      const { resistance, support } = oiWalls(cursors.map((c) => ({ strike: c.k, ceOi: c.ceOi ?? 0, peOi: c.peOi ?? 0 })), spotBars[i].c)
      walls.push({ resistance: resistance?.strike ?? null, support: support?.strike ?? null })
    }
  }

  // GEX (standard sign) - each minute from readings up to it (gex.js).
  const spotForOptions = spotBars.map((b) => ({ time: b.t, close: b.c }))
  const gexByMinute = new Map(gexDay(run?.cePoints, run?.pePoints, spotForOptions, { expiry: run?.optionExpiry ?? null, flips: false }).map((m) => [m.time, m]))
  const gex = t.map((ms) => {
    const m = gexByMinute.get(ms)
    return m ? { net: m.net, callWall: m.callWall, putWall: m.putWall } : null
  })

  // The Auto ATM straddle against its VWAP, its decay-only line and the synthetic futures (straddle.js).
  const read = straddleRead(run?.cePoints, run?.pePoints, spotForOptions, { expiry: run?.optionExpiry ?? null })
  const straddleByMinute = new Map((read?.series ?? []).map((p) => [p.time, p]))
  const straddle = t.map((ms) => {
    const p = straddleByMinute.get(ms)
    return p ? { value: p.value, vwap: p.vwap, decay: p.decay, forward: p.forward } : null
  })

  // The Initial Balance (09:15 - 10:14), on the price series.
  let ibHigh = -Infinity, ibLow = Infinity, ibDone = null
  for (let i = 0; i < n; i++) {
    const b = priceBars[i]
    const m = istMinute(t[i])
    if (m <= IB_LAST) { ibHigh = Math.max(ibHigh, b.h); ibLow = Math.min(ibLow, b.l); if (m === IB_LAST) ibDone = i }
  }

  return {
    ok: true, date, underlying: u, step, n, t, atm, oi, tot, breaks, hp, walls, gex, straddle, ceCum, peCum, netCum, oiTf,
    spot: { o: spotBars.map((b) => b.o), h: spotBars.map((b) => b.h), l: spotBars.map((b) => b.l), c: spotBars.map((b) => b.c) },
    price: { o: priceBars.map((b) => b.o), h: priceBars.map((b) => b.h), l: priceBars.map((b) => b.l), c: priceBars.map((b) => b.c) },
    priceSource: useFutures ? 'futures' : 'spot', vwap: Array.from(vwap),
    straddleWidth: read?.day?.width ?? null,
    ib: ibDone == null ? null : { high: ibHigh, low: ibLow, done: ibDone },
    prevVp: previousProfile(prevProfile, date),
    ce: packBars(ceLegs, t), pe: packBars(peLegs, t),
    expiry, isExpiry: expiry === date,
  }
}

/** The previous trading day's volume profile (`/api/oi-replay/{u}/previous-day-volume-profile` - the levels OI Replay's
 *  entry charts draw, of the index's spot): { date, poc, vah, val, hvn, lvn } (its first HVN / LVN), or null when there is
 *  none or it is not a day BEFORE `date`. Fixed all day - known before the session opens. */
function previousProfile(p, date) {
  if (!p?.success) return null
  const day = String(p.profileDate ?? '').slice(0, 10)
  if (!day || !(day < date)) return null
  const num = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null)
  return { date: day, poc: num(p.poc), vah: num(p.vah), val: num(p.val), hvn: num(p.hvn?.[0]), lvn: num(p.lvn?.[0]) }
}

// ---- The timeframe ----------------------------------------------------------------------------------------------------
// The strategies read a day on candles of the chosen timeframe, from 09:15: a candle's OHLC from its minutes, every other
// feature (OI, walls, GEX, straddle, VWAP) as at the END of its last minute, the OI totals' breaks / 🎯 from
// that timeframe's own buckets, each at the candle it became known in. A signal on a candle is known at its close - its
// last minute's end - so the trade enters at that minute's option close and is managed on the 1-minute bars from the next
// minute (`at` maps a candle to its last minute). Timeframe 1 is the day itself.

const fitTimeframe = (tf) => { const m = Math.round(Number(tf) || 1); return TIMEFRAMES.includes(m) ? m : 1 }
/** A window given in minutes, in candles of the day's timeframe (at least one). */
const span = (d, minutes) => Math.max(1, Math.round(minutes / (d.tf ?? 1)))

/** The prepared day `d` read on `tf`-minute candles (kept on the day, worked out once a timeframe). */
export function timeframeView(d, tf = 1) {
  const m = fitTimeframe(tf)
  if (!d?.ok || m === 1) return d
  if (!d.views) Object.defineProperty(d, 'views', { value: new Map(), enumerable: false })
  const kept = d.views.get(m)
  if (kept) return kept
  const first = []
  const last = []
  const candleOf = new Int32Array(d.n)
  let bucket = null
  for (let i = 0; i < d.n; i++) {
    const b = Math.floor((istMinute(d.t[i]) - SESSION_FIRST) / m)
    if (b !== bucket) { first.push(i); last.push(i); bucket = b } else last[last.length - 1] = i
    candleOf[i] = first.length - 1
  }
  const pick = (list) => last.map((i) => (list ? list[i] : NaN))
  const candles = (ohlc) => {
    const o = [], h = [], l = [], c = []
    for (let k = 0; k < first.length; k++) {
      let hi = -Infinity, lo = Infinity
      for (let i = first[k]; i <= last[k]; i++) { hi = Math.max(hi, ohlc.h[i]); lo = Math.min(lo, ohlc.l[i]) }
      o.push(ohlc.o[first[k]]); h.push(hi); l.push(lo); c.push(ohlc.c[last[k]])
    }
    return { o, h, l, c }
  }
  const reads = d.oiTf?.[m] ?? { breaks: d.breaks, hp: d.hp, ceCum: d.ceCum, peCum: d.peCum, netCum: d.netCum }
  const toCandles = (events) => events.map((e) => ({ ...e, i: candleOf[e.i] }))
  const view = {
    ...d, tf: m, n: first.length, at: Int32Array.from(last),
    t: pick(d.t), atm: pick(d.atm), oi: pick(d.oi), tot: pick(d.tot), walls: pick(d.walls), gex: pick(d.gex), straddle: pick(d.straddle),
    vwap: pick(d.vwap), ceCum: pick(reads.ceCum), peCum: pick(reads.peCum), netCum: pick(reads.netCum),
    spot: candles(d.spot), price: candles(d.price),
    breaks: toCandles(reads.breaks), hp: toCandles(reads.hp),
    ib: d.ib ? { ...d.ib, done: candleOf[d.ib.done] } : null,
  }
  d.views.set(m, view)
  return view
}

// ---- The rule ---------------------------------------------------------------------------------------------------------
// ONE strategy, built on the page as LINES: each line a condition (an indicator and what it says), with its own number
// where one makes sense (a threshold %, `param`) and its own look-back for what happened "in the last N min" (crossed,
// turned, broke, near, a 🎯, spot's move - `windowed`), joined to the line before by AND or OR. AND binds tighter than OR:
// "A AND B OR C AND D" = (A AND B) OR (C AND D). A signal where the whole rule BECOMES true at a candle's close - then the
// action (buy / sell the call / put). The MIRROR (optional) is the same rule with every line's opposite (above <-> below,
// support <-> resistance, rising <-> falling; a value with no side - GEX regime, the straddle, "inside", "stable" - stays)
// and the opposite trade. A cross / turn / break must still hold now (a failed one does not count). Everything is read
// from the candles up to i (no look-ahead).

const fmtL = (v) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) / 1e5).toFixed(1)}L`
const fmtP = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—')
const finite = (v) => Number.isFinite(v)

// Some k in the last `w` candles (i - w < k <= i, k >= 1) where f(k) holds.
function inWindow(i, w, f) {
  for (let k = i; k > i - w && k >= 1; k--) if (f(k)) return k
  return -1
}
// `x` (a function of the candle) crossed from <= 0 to > 0 (up) / >= 0 to < 0 (down) in the window, and is still there.
function crossed(x, i, w, up) {
  const now = x(i)
  if (!finite(now) || (up ? !(now > 0) : !(now < 0))) return false
  return inWindow(i, w, (k) => { const a = x(k - 1), b = x(k); return finite(a) && finite(b) && (up ? a <= 0 && b > 0 : a >= 0 && b < 0) }) >= 0
}
// A level known at the candle before (`level(k - 1)`) closed through by `c` in the window - up or down - and still through.
function brokeLevel(c, level, i, w, up) {
  const k = inWindow(i, w, (k) => { const v = level(k - 1); return v != null && finite(v) && (up ? c[k - 1] <= v && c[k] > v : c[k - 1] >= v && c[k] < v) })
  if (k < 0) return false
  const v = level(k - 1)
  return up ? c[i] > v : c[i] < v
}
// A cumulative line's move over the window against `tolPct` % of its range so far: rising (1) / falling (-1) / stable (0).
function lineMove(series, i, w, tolPct) {
  const now = series[i], back = series[Math.max(0, i - w)]
  if (!finite(now) || !finite(back)) return null
  let lo = Infinity, hi = -Infinity
  for (let k = 0; k <= i; k++) if (finite(series[k])) { lo = Math.min(lo, series[k]); hi = Math.max(hi, series[k]) }
  const tol = (tolPct / 100) * (hi - lo)
  const move = now - back
  return move > tol ? 1 : move < -tol ? -1 : 0
}
// An option of a dropdown: its value, label, the mirror's value, and what it takes - `windowed` (looks back over the
// line's minutes), `param` (a number: { label, unit, default, min, max, step }).
const opt = (value, label, opposite = value, more = {}) => ({ value, label, opposite, ...more })
const W = { windowed: true }
const pctParam = (label, def, max = 100, step = 1) => ({ label, unit: '%', default: def, min: 0, max, step })
const LEAD = { param: pctParam('by ≥', 0) }
const NEAR = (def) => ({ windowed: true, param: pctParam('within', def, 2, 0.01) })
const TOL = { windowed: true, param: pctParam('tolerance', 10) }
const MOVE = { windowed: true, param: pctParam('by', 0.1, 5, 0.05) }
const OVER = { param: pctParam('by ≥', 0, 5, 0.05) }
const TOTAL_MOVE = { windowed: true, param: pctParam('by', 0.2, 20, 0.05) }
// How far one Total OI line is over the other, in % of the lower one (PE 4.4 cr over CE 4 cr = 10%); 0 = any lead.
const TOTAL_LEAD = { param: pctParam('by ≥', 0, 100, 0.5) }
const totalLeadPct = (x) => { const lo = x ? Math.min(x.ce, x.pe) : 0; return lo > 0 ? (Math.abs(x.pe - x.ce) / lo) * 100 : NaN }

const fmtLakh = (v) => `${(v / 1e5).toFixed(1)}L`

// Total CE / PE OI (chain-wide, OI Replay's "Total OI" and its lookback table): its move over the window as a % of where
// it was - increased / decreased by at least the number, flat when it moved less than that.
function totalCondition(side, name, meaning) {
  return {
    id: side === 'ce' ? 'totalCe' : 'totalPe', group: 'OI', name,
    options: [
      opt('rising', `Increased (${meaning.up})`, 'falling', TOTAL_MOVE), opt('falling', `Decreased (${meaning.down})`, 'rising', TOTAL_MOVE),
      opt('flat', 'Flat (moved less than)', 'flat', TOTAL_MOVE),
    ],
    test: (d, i, v, w, p) => {
      const now = d.tot?.[i]?.[side], back = d.tot?.[Math.max(0, i - w)]?.[side]
      if (!(now > 0) || !(back > 0)) return false
      const move = (now - back) / back
      const need = p / 100
      return v === 'rising' ? move > 0 && move >= need : v === 'falling' ? move < 0 && -move >= need : v === 'flat' ? Math.abs(move) < need : false
    },
    show: (d, i) => `total ${side.toUpperCase()} OI ${finite(d.tot?.[i]?.[side]) ? fmtLakh(d.tot[i][side]) : '—'}`,
  }
}

const CUM_LINES = { ce: { key: 'ceCum', name: 'CE' }, pe: { key: 'peCum', name: 'PE' }, net: { key: 'netCum', name: 'Net (CE − PE)' } }
function cumCondition(line, group, meaning) {
  const { key, name } = CUM_LINES[line]
  return {
    id: `cum${line[0].toUpperCase()}${line.slice(1)}`, group, name: `${name} cumulative Δ`,
    options: [
      opt('positive', 'Positive (above 0)', 'negative'), opt('negative', 'Negative (below 0)', 'positive'),
      opt('turnedPositive', 'Turned −ve → +ve', 'turnedNegative', W), opt('turnedNegative', 'Turned +ve → −ve', 'turnedPositive', W),
      opt('rising', `Rising (${meaning.up})`, 'falling', TOL), opt('falling', `Falling (${meaning.down})`, 'rising', TOL),
      opt('stable', 'Stable (moved under the tolerance of its range)', 'stable', TOL),
      opt('brokeResistance', 'Broke its resistance', 'brokeSupport', W), opt('brokeSupport', 'Broke its support', 'brokeResistance', W),
    ],
    test: (d, i, v, w, p) => {
      const series = d[key]
      if (!series) return false
      const x = (k) => series[k]
      switch (v) {
        case 'positive': return series[i] > 0
        case 'negative': return series[i] < 0
        case 'turnedPositive': return crossed(x, i, w, true)
        case 'turnedNegative': return crossed(x, i, w, false)
        case 'rising': return lineMove(series, i, w, p) === 1
        case 'falling': return lineMove(series, i, w, p) === -1
        case 'stable': return lineMove(series, i, w, p) === 0
        case 'brokeResistance': case 'brokeSupport': {
          const up = v === 'brokeResistance'
          return d.breaks.some((b) => b.line === line && b.up === up && b.i <= i && b.i > i - w)
        }
        default: return false
      }
    },
    show: (d, i) => `${name} cum Δ ${finite(d[key]?.[i]) ? fmtL(d[key][i]) : '—'}`,
  }
}

// A level of the PREVIOUS day's volume profile - fixed all day, known before the session opens, read on spot (that
// profile is spot's).
function levelCondition({ id, group, name, short, level }) {
  const L = (d, k) => { const x = k >= 0 ? level(d, k) : null; return Number.isFinite(x) ? x : null }
  return {
    id, group, name,
    options: [
      opt('above', 'Price above it', 'below', OVER), opt('below', 'Price below it', 'above', OVER),
      opt('crossedAbove', 'Crossed above it', 'crossedBelow', W), opt('crossedBelow', 'Crossed below it', 'crossedAbove', W),
      opt('heldAbove', 'Touched it, closed back above (support held)', 'heldBelow', NEAR(0.05)),
      opt('heldBelow', 'Touched it, closed back below (resistance held)', 'heldAbove', NEAR(0.05)),
      opt('near', 'Near it', 'near', NEAR(0.05)),
    ],
    test: (d, i, v, w, p) => {
      const bars = d.spot
      const c = bars.c
      const x = L(d, i)
      const by = (p / 100) * (x ?? 0)
      switch (v) {
        case 'above': return x != null && c[i] > x && c[i] - x >= by
        case 'below': return x != null && c[i] < x && x - c[i] >= by
        case 'crossedAbove': return brokeLevel(c, (k) => L(d, k), i, w, true)
        case 'crossedBelow': return brokeLevel(c, (k) => L(d, k), i, w, false)
        case 'heldAbove': case 'heldBelow': {
          const up = v === 'heldAbove'
          const k = inWindow(i, w, (k) => {
            const lv = L(d, k - 1)
            return lv != null && (up ? bars.l[k] <= lv * (1 + p / 100) && c[k] > lv : bars.h[k] >= lv * (1 - p / 100) && c[k] < lv)
          })
          if (k < 0) return false
          const lv = L(d, k - 1)
          return up ? c[i] > lv : c[i] < lv
        }
        case 'near': return inWindow(i, w, (k) => { const lv = L(d, k - 1) ?? L(d, k); return lv != null && bars.l[k] <= lv * (1 + p / 100) && bars.h[k] >= lv * (1 - p / 100) }) >= 0
        default: return false
      }
    },
    show: (d, i) => `${short} ${fmtP(L(d, i))}`,
  }
}
const prevLevel = (id, name, short, key) => levelCondition({ id, group: 'PrevProfile', name, short: `prev ${short}`, level: (d) => d.prevVp?.[key] })

/** The conditions a rule is built from - each with its dropdown's options (`opposite`: the mirror's; `windowed`,
 *  `param`: what the line takes). `test(d, i, value, windowCandles, param)`. */
export const RULE_CONDITIONS = [
  {
    id: 'oiOpen', group: 'OI', name: 'OI since open (chain-wide)',
    options: [
      opt('peAhead', 'PE added > CE added (put writing ahead)', 'ceAhead', LEAD), opt('ceAhead', 'CE added > PE added (call writing ahead)', 'peAhead', LEAD),
      opt('peCross', 'PE crossed above CE', 'ceCross', W), opt('ceCross', 'CE crossed above PE', 'peCross', W),
    ],
    test: (d, i, v, w, p) => {
      const gap = (k) => d.oi[k].pe - d.oi[k].ce
      const lead = () => { const { ce, pe } = d.oi[i]; const size = Math.abs(ce) + Math.abs(pe); return size > 0 ? Math.abs(pe - ce) / size >= p / 100 : false }
      switch (v) {
        case 'peAhead': return gap(i) > 0 && lead()
        case 'ceAhead': return gap(i) < 0 && lead()
        case 'peCross': return crossed(gap, i, w, true)
        case 'ceCross': return crossed(gap, i, w, false)
        default: return false
      }
    },
    show: (d, i) => `OI since open CE ${fmtL(d.oi[i].ce)} · PE ${fmtL(d.oi[i].pe)}`,
  },
  totalCondition('ce', 'Total CE OI (chain-wide)', { up: 'call writing - bearish', down: 'calls unwinding - bullish' }),
  totalCondition('pe', 'Total PE OI (chain-wide)', { up: 'put writing - bullish', down: 'puts unwinding - bearish' }),
  {
    // The Total OI chart's two lines - total CE OI and total PE OI: which is above, and one crossing the other.
    id: 'totalOi', group: 'OI', name: 'Total OI: CE vs PE (the Total OI chart)',
    // Each with "by ≥ %" (like OI since open's lead): the line ahead now, by at least that % of the other - a cross too.
    options: [
      opt('peAbove', 'PE above CE (more put OI - bullish)', 'ceAbove', TOTAL_LEAD), opt('ceAbove', 'CE above PE (more call OI - bearish)', 'peAbove', TOTAL_LEAD),
      opt('peCross', 'PE crossed above CE', 'ceCross', { ...W, ...TOTAL_LEAD }), opt('ceCross', 'CE crossed above PE', 'peCross', { ...W, ...TOTAL_LEAD }),
    ],
    test: (d, i, v, w, p) => {
      const gap = (k) => { const x = d.tot?.[k]; return x && x.ce > 0 && x.pe > 0 ? x.pe - x.ce : NaN }
      const lead = () => totalLeadPct(d.tot?.[i]) >= (p ?? 0) - 1e-9
      switch (v) {
        case 'peAbove': return gap(i) > 0 && lead()
        case 'ceAbove': return gap(i) < 0 && lead()
        case 'peCross': return crossed(gap, i, w, true) && lead()
        case 'ceCross': return crossed(gap, i, w, false) && lead()
        default: return false
      }
    },
    show: (d, i) => {
      const x = d.tot?.[i]
      if (!x) return 'total OI —'
      const ahead = totalLeadPct(x)
      return `total CE OI ${fmtLakh(x.ce)} · PE ${fmtLakh(x.pe)}${Number.isFinite(ahead) && ahead > 0 ? ` (${x.pe > x.ce ? 'PE' : 'CE'} +${ahead.toFixed(1)}%)` : ''}`
    },
  },
  cumCondition('ce', 'OI', { up: 'call writing - bearish', down: 'calls unwinding - bullish' }),
  cumCondition('pe', 'OI', { up: 'put writing - bullish', down: 'puts unwinding - bearish' }),
  cumCondition('net', 'OI', { up: 'call writers gaining - bearish', down: 'put writers gaining - bullish' }),
  {
    id: 'hp', group: 'OI', name: '🎯 High probability',
    options: [opt('bullish', 'Bullish 🎯', 'bearish', W), opt('bearish', 'Bearish 🎯', 'bullish', W)],
    test: (d, i, v, w) => d.hp.some((h) => h.dir === (v === 'bullish' ? 1 : -1) && h.i <= i && h.i > i - w),
    show: () => '🎯',
  },
  {
    id: 'oiWalls', group: 'OI', name: 'OI S-R walls (spot chart)',
    options: [
      opt('nearSupport', 'Near the OI support', 'nearResistance', NEAR(0.05)), opt('nearResistance', 'Near the OI resistance', 'nearSupport', NEAR(0.05)),
      opt('brokeResistance', 'Broke above the OI resistance', 'brokeSupport', W), opt('brokeSupport', 'Broke below the OI support', 'brokeResistance', W),
    ],
    test: (d, i, v, w, p) => {
      const wall = (k, side) => d.walls[k]?.[side] ?? null
      switch (v) {
        case 'nearSupport': return inWindow(i, w, (k) => { const s = wall(k - 1, 'support'); return s != null && d.spot.l[k] <= s * (1 + p / 100) }) >= 0
        case 'nearResistance': return inWindow(i, w, (k) => { const r = wall(k - 1, 'resistance'); return r != null && d.spot.h[k] >= r * (1 - p / 100) }) >= 0
        case 'brokeResistance': return brokeLevel(d.spot.c, (k) => wall(k, 'resistance'), i, w, true)
        case 'brokeSupport': return brokeLevel(d.spot.c, (k) => wall(k, 'support'), i, w, false)
        default: return false
      }
    },
    show: (d, i) => `OI support ${d.walls[i]?.support ?? '—'} · resistance ${d.walls[i]?.resistance ?? '—'}`,
  },
  {
    id: 'gexRegime', group: 'GEX', name: 'GEX regime',
    options: [
      opt('long', 'Positive - dealers long gamma (moves damped)'), opt('short', 'Negative - dealers short gamma (moves run)'),
      opt('turnedShort', 'Turned negative', 'turnedShort', W), opt('turnedLong', 'Turned positive', 'turnedLong', W),
    ],
    test: (d, i, v, w) => {
      const net = (k) => d.gex[k]?.net ?? NaN
      switch (v) {
        case 'long': return net(i) >= 0
        case 'short': return net(i) < 0
        case 'turnedShort': return crossed(net, i, w, false)
        case 'turnedLong': return crossed(net, i, w, true)
        default: return false
      }
    },
    show: (d, i) => `net GEX ${finite(d.gex[i]?.net) ? (d.gex[i].net / 1e9).toFixed(2) + ' bn' : '—'}`,
  },
  {
    id: 'gexLevel', group: 'GEX', name: 'GEX walls',
    options: [
      opt('nearPutWall', 'Near the put wall (support)', 'nearCallWall', NEAR(0.15)), opt('nearCallWall', 'Near the call wall (resistance)', 'nearPutWall', NEAR(0.15)),
      opt('brokeCallWall', 'Broke above the call wall', 'brokePutWall', W), opt('brokePutWall', 'Broke below the put wall', 'brokeCallWall', W),
    ],
    test: (d, i, v, w, p) => {
      const lvl = (k, side) => d.gex[k]?.[side] ?? null
      switch (v) {
        case 'nearPutWall': return inWindow(i, w, (k) => { const x = lvl(k - 1, 'putWall'); return x != null && d.spot.l[k] <= x * (1 + p / 100) }) >= 0
        case 'nearCallWall': return inWindow(i, w, (k) => { const x = lvl(k - 1, 'callWall'); return x != null && d.spot.h[k] >= x * (1 - p / 100) }) >= 0
        case 'brokeCallWall': return brokeLevel(d.spot.c, (k) => lvl(k, 'callWall'), i, w, true)
        case 'brokePutWall': return brokeLevel(d.spot.c, (k) => lvl(k, 'putWall'), i, w, false)
        default: return false
      }
    },
    show: (d, i) => `GEX put wall ${d.gex[i]?.putWall ?? '—'} · call wall ${d.gex[i]?.callWall ?? '—'}`,
  },
  {
    id: 'vwap', group: 'Price', name: 'Price vs VWAP',
    options: [
      opt('above', 'Price above VWAP', 'below', OVER), opt('below', 'Price below VWAP', 'above', OVER),
      opt('crossedAbove', 'Crossed above VWAP', 'crossedBelow', W), opt('crossedBelow', 'Crossed below VWAP', 'crossedAbove', W),
    ],
    test: (d, i, v, w, p) => {
      const gap = (k) => d.price.c[k] - d.vwap[k]
      const far = () => Math.abs(gap(i)) >= (p / 100) * d.vwap[i]
      switch (v) {
        case 'above': return gap(i) > 0 && far()
        case 'below': return gap(i) < 0 && far()
        case 'crossedAbove': return crossed(gap, i, w, true)
        case 'crossedBelow': return crossed(gap, i, w, false)
        default: return false
      }
    },
    show: (d, i) => `price ${fmtP(d.price.c[i])} · VWAP ${fmtP(d.vwap[i])}`,
  },
  {
    id: 'spotMove', group: 'Price', name: 'Spot move',
    options: [opt('rising', 'Rising', 'falling', MOVE), opt('falling', 'Falling', 'rising', MOVE), opt('sideways', 'Sideways (moved less than)', 'sideways', MOVE)],
    test: (d, i, v, w, p) => {
      const c = d.spot.c, back = c[Math.max(0, i - w)]
      const move = (c[i] - back) / back
      const need = p / 100
      return v === 'rising' ? move > 0 && move >= need : v === 'falling' ? move < 0 && -move >= need : v === 'sideways' ? Math.abs(move) < need : false
    },
    show: (d, i) => `spot ${fmtP(d.spot.c[i])}`,
  },
  {
    id: 'straddle', group: 'Straddle', name: 'ATM straddle',
    options: [
      opt('aboveVwap', 'Above its VWAP (premium bought)', 'aboveVwap', OVER), opt('belowVwap', 'Below its VWAP (premium sold)', 'belowVwap', OVER),
      opt('aboveDecay', 'Above the decay-only line (IV up)'), opt('belowDecay', 'Below the decay-only line (IV down)'),
      opt('crossedAbove', 'Crossed above its VWAP', 'crossedAbove', W), opt('crossedBelow', 'Crossed below its VWAP', 'crossedBelow', W),
    ],
    test: (d, i, v, w, p) => {
      const s = d.straddle[i]
      const gap = (k) => (d.straddle[k] ? d.straddle[k].value - d.straddle[k].vwap : NaN)
      const far = () => s != null && Math.abs(gap(i)) >= (p / 100) * s.vwap
      switch (v) {
        case 'aboveVwap': return gap(i) > 0 && far()
        case 'belowVwap': return gap(i) < 0 && far()
        case 'aboveDecay': return s != null && finite(s.decay) && s.value > s.decay
        case 'belowDecay': return s != null && finite(s.decay) && s.value < s.decay
        case 'crossedAbove': return crossed(gap, i, w, true)
        case 'crossedBelow': return crossed(gap, i, w, false)
        default: return false
      }
    },
    show: (d, i) => `straddle ${fmtP(d.straddle[i]?.value)} · its VWAP ${fmtP(d.straddle[i]?.vwap)}`,
  },
  {
    id: 'ib', group: 'Profile', name: 'Initial Balance (09:15 - 10:14)',
    options: [opt('aboveHigh', 'Price above the IB high (after 10:15)', 'belowLow'), opt('inside', 'Price inside the IB (after 10:15)'), opt('belowLow', 'Price below the IB low (after 10:15)', 'aboveHigh')],
    test: (d, i, v) => {
      if (!d.ib || i <= d.ib.done) return false
      const c = d.price.c[i]
      return v === 'aboveHigh' ? c > d.ib.high : v === 'belowLow' ? c < d.ib.low : v === 'inside' ? c >= d.ib.low && c <= d.ib.high : false
    },
    show: (d) => (d.ib ? `IB ${fmtP(d.ib.low)} - ${fmtP(d.ib.high)}` : 'IB —'),
  },
  prevLevel('prevPoc', "Previous day's POC", 'POC', 'poc'),
  prevLevel('prevHvn', "Previous day's HVN", 'HVN', 'hvn'),
  prevLevel('prevLvn', "Previous day's LVN", 'LVN', 'lvn'),
  prevLevel('prevVah', "Previous day's VAH", 'VAH', 'vah'),
  prevLevel('prevVal', "Previous day's VAL", 'VAL', 'val'),
  {
    id: 'valueArea', group: 'PrevProfile', name: "Previous day's value area",
    options: [opt('aboveVah', 'Price above its VAH', 'belowVal'), opt('inside', 'Price inside it'), opt('belowVal', 'Price below its VAL', 'aboveVah')],
    test: (d, i, v) => {
      const x = d.prevVp, c = d.spot.c[i]
      if (!x || x.vah == null || x.val == null) return false
      return v === 'aboveVah' ? c > x.vah : v === 'belowVal' ? c < x.val : v === 'inside' ? c >= x.val && c <= x.vah : false
    },
    show: (d) => `prev VAL ${fmtP(d.prevVp?.val)} · VAH ${fmtP(d.prevVp?.vah)}`,
  },
]
// Lines saved while the volume profile levels were today's developing ones (POC / HVN / LVN): read as the previous
// day's same level - the levels are the previous day's now, on request.
const RENAMED = { poc: 'prevPoc', vpHvn: 'prevHvn', vpLvn: 'prevLvn' }
const CONDITION = Object.fromEntries(RULE_CONDITIONS.map((c) => [c.id, c]))
const optionOf = (id, value) => CONDITION[id]?.options.find((o) => o.value === value) ?? null

/** The trades a rule can make, and the mirror's. */
export const RULE_ACTIONS = [
  { value: 'buyCE', label: 'Buy CE', dir: 1, mode: 'buy', opposite: 'buyPE' },
  { value: 'buyPE', label: 'Buy PE', dir: -1, mode: 'buy', opposite: 'buyCE' },
  { value: 'sellPE', label: 'Sell PE', dir: 1, mode: 'sell', opposite: 'sellCE' },
  { value: 'sellCE', label: 'Sell CE', dir: -1, mode: 'sell', opposite: 'sellPE' },
]
const ACTION = Object.fromEntries(RULE_ACTIONS.map((a) => [a.value, a]))
export const WINDOW_CHOICES = [1, 3, 5, 10, 15, 30]
export const DEFAULT_WINDOW = 5

/** A line made whole: a known condition and value, its number within its range (else the default), a window offered,
 *  AND / OR. Null when the condition / value is not known. */
export function cleanLine(line) {
  const id = RENAMED[line?.id] ?? line?.id
  const o = optionOf(id, line?.value)
  if (!o) return null
  const out = { id, value: line.value, join: line.join === 'or' ? 'or' : 'and' }
  if (o.param) {
    const v = Number(line.param)
    out.param = line.param != null && line.param !== '' && Number.isFinite(v) ? Math.min(o.param.max, Math.max(o.param.min, v)) : o.param.default
  }
  if (o.windowed) out.windowMin = WINDOW_CHOICES.includes(line.windowMin) ? line.windowMin : DEFAULT_WINDOW
  return out
}

/** A rule made whole: { lines, action, mirror, logic, tree }. The page builds it as a TREE of groups (`tree` - Match ALL /
 *  ANY, NOT, conditions and groups inside, `cleanTree`): when there is one, the lines (in the tree's order) and the logic
 *  over their numbers are worked out from it (`ruleFromTree`). Without one - a rule saved before - from `lines` with their
 *  AND / OR or the typed `logic` (the lines by number with AND / OR / NOT and brackets, `parseLogic`), or the earlier form
 *  { conditions: { [id]: value }, windowMin } (every condition ANDed); its tree is worked out from them (`treeFromRule`). */
export function normalizeRule(rule, fallback = BACKTEST_DEFAULTS.rule) {
  if (!rule || typeof rule !== 'object') return normalizeRule(fallback, null)
  const action = ACTION[rule.action] ? rule.action : (fallback ? fallback.action : null)
  const mirror = typeof rule.mirror === 'boolean' ? rule.mirror : Boolean(fallback?.mirror)
  if (rule.tree && typeof rule.tree === 'object') {
    const tree = cleanTree(rule.tree)
    return { ...ruleFromTree(tree), action, mirror, tree }
  }
  const raw = Array.isArray(rule.lines) ? rule.lines
    : rule.conditions && typeof rule.conditions === 'object'
      ? Object.entries(rule.conditions).map(([id, value]) => ({ id: RENAMED[id] ?? id, value, join: 'and', windowMin: rule.windowMin }))
        .sort((a, b) => RULE_CONDITIONS.findIndex((c) => c.id === a.id) - RULE_CONDITIONS.findIndex((c) => c.id === b.id))
      : null
  if (!raw && fallback) return normalizeRule(fallback, null)
  const lines = (raw ?? []).map(cleanLine).filter(Boolean)
  const logic = typeof rule.logic === 'string' ? rule.logic.slice(0, MAX_LOGIC_LENGTH) : ''
  return { lines, action, mirror, logic, tree: treeFromRule({ lines, logic }) }
}

// ---- The rule as a TREE of groups (the page's builder - dropdowns, no typing) -----------------------------------------
// A group: { op: 'and' | 'or' (Match ALL / ANY), not: true / false, items: [{ line } | { group }] } - groups inside groups
// are the brackets: (1 AND 2) OR (3 AND (4 AND 5)) is ANY of [ALL of [1, 2], ALL of [3, ALL of [4, 5]]]. The engine still
// reads lines + logic: the tree gives them (`ruleFromTree`), and a rule without a tree gives its tree (`treeFromRule`).

export const MAX_GROUP_DEPTH = 5
const emptyGroup = (op = 'and') => ({ op, not: false, items: [] })

/** A tree made whole: ops 'and' / 'or', each condition a known line (`cleanLine`), groups at most MAX_GROUP_DEPTH deep. */
export function cleanTree(tree, depth = 0) {
  const items = []
  for (const it of Array.isArray(tree?.items) ? tree.items : []) {
    if (it?.line) {
      const line = cleanLine({ ...it.line, join: 'and' })
      if (line) items.push({ line })
    } else if (it?.group && depth < MAX_GROUP_DEPTH) items.push({ group: cleanTree(it.group, depth + 1) })
  }
  return { op: tree?.op === 'or' ? 'or' : 'and', not: Boolean(tree?.not), items }
}

/** The tree as the engine reads it: { lines } in the tree's order (numbered 1, 2, … as the page shows them) and the logic
 *  over those numbers - a group of more than one part in brackets, NOT before it; an empty group is left out. */
export function ruleFromTree(tree) {
  const lines = []
  const text = (g, top) => {
    const parts = []
    for (const it of g.items) {
      if (it.line) { lines.push(it.line); parts.push(String(lines.length)) } else {
        const t = text(it.group, false)
        if (t) parts.push(t)
      }
    }
    if (!parts.length) return ''
    const body = parts.join(` ${g.op.toUpperCase()} `)
    if (g.not) return parts.length > 1 ? `NOT (${body})` : `NOT ${body}`
    return parts.length > 1 && !top ? `(${body})` : body
  }
  return { lines, logic: text(cleanTree(tree), true) }
}

/** A rule's tree from its lines and logic: the typed logic's own structure (same-op chains as one group), else the lines'
 *  AND / OR (AND first: each run of AND-ed lines a group, ANY of them). Lines the logic leaves out are not in it. */
export function treeFromRule({ lines = [], logic = '' } = {}) {
  const parsed = String(logic ?? '').trim() ? parseLogic(logic, lines.length) : null
  const leaf = (l) => ({ line: { ...l, join: 'and' } })
  if (parsed?.ok) {
    const toItem = (node) => {
      if (node.line != null) return leaf(lines[node.line - 1])
      if (node.op === 'not') {
        const inner = toItem(node.a)
        const g = inner.group && !inner.group.not ? inner.group : { op: 'and', items: [inner] }
        return { group: { ...g, not: true } }
      }
      const items = []
      const collect = (n) => { if (n.op === node.op) { collect(n.a); collect(n.b) } else items.push(toItem(n)) }
      collect(node)
      return { group: { op: node.op, not: false, items } }
    }
    const root = toItem(parsed.tree)
    return root.group ?? { ...emptyGroup(), items: [root] }
  }
  const groups = orGroups(lines)
  if (groups.length <= 1) return { ...emptyGroup(), items: lines.map(leaf) }
  return { ...emptyGroup('or'), items: groups.map((g) => (g.length === 1 ? leaf(g[0]) : { group: { ...emptyGroup(), items: g.map(leaf) } })) }
}

// ---- Custom logic: the lines by number, AND / OR / NOT, brackets -----------------------------------------------------
// "(1 AND 2) OR (3 AND (4 OR 5))" - any nesting. NOT binds tightest, then AND, then OR (as everywhere): "1 OR 2 AND 3" is
// "1 OR (2 AND 3)". Words in any case, or & | !. With logic set the lines' own AND / OR are not used; empty, they are.

export const MAX_LOGIC_LENGTH = 300
const LOGIC_TOKEN = /\s*(?:(\d+)|(\()|(\))|(and(?![a-z])|&&|&)|(or(?![a-z])|\|\||\|)|(not(?![a-z])|!))/iy

/** Reads `text` against `n` lines: { ok: true, tree, used: Set of line numbers } or { ok: false, error } (in words). A tree
 *  node is { line } (1-based), { op: 'not', a } or { op: 'and' | 'or', a, b }. */
export function parseLogic(text, n) {
  const src = String(text ?? '')
  const tokens = []
  let pos = 0
  while (pos < src.length && !/^\s*$/.test(src.slice(pos))) {
    LOGIC_TOKEN.lastIndex = pos
    const m = LOGIC_TOKEN.exec(src)
    if (!m) return { ok: false, error: `cannot read "${src.slice(pos).trim().slice(0, 12)}" - use line numbers, AND, OR, NOT and brackets` }
    pos = LOGIC_TOKEN.lastIndex
    tokens.push(m[1] ? { t: 'num', v: Number(m[1]) } : m[2] ? { t: '(' } : m[3] ? { t: ')' } : m[4] ? { t: 'and' } : m[5] ? { t: 'or' } : { t: 'not' })
  }
  if (!tokens.length) return { ok: false, error: 'empty' }
  const used = new Set()
  let k = 0
  const word = (tok) => (tok.t === 'num' ? String(tok.v) : tok.t.length > 1 ? tok.t.toUpperCase() : tok.t)
  function factor() {
    const tok = tokens[k++]
    if (!tok) throw new Error('it ends too early - a line number or "(" is missing at the end')
    if (tok.t === 'not') return { op: 'not', a: factor() }
    if (tok.t === '(') {
      const e = expr()
      if (tokens[k]?.t !== ')') throw new Error('a ")" is missing')
      k++
      return e
    }
    if (tok.t === 'num') {
      if (tok.v < 1 || tok.v > n) throw new Error(`there is no line ${tok.v} (the lines are 1${n > 1 ? ` - ${n}` : ''})`)
      used.add(tok.v)
      return { line: tok.v }
    }
    throw new Error(`"${word(tok)}" where a line number or "(" should be`)
  }
  function term() {
    let left = factor()
    while (tokens[k]?.t === 'and') { k++; left = { op: 'and', a: left, b: factor() } }
    return left
  }
  function expr() {
    let left = term()
    while (tokens[k]?.t === 'or') { k++; left = { op: 'or', a: left, b: term() } }
    return left
  }
  try {
    const tree = expr()
    if (k < tokens.length) {
      const tok = tokens[k]
      throw new Error(tok.t === ')' ? 'a ")" with no "(" before it' : `an AND / OR is missing before "${word(tok)}"`)
    }
    return { ok: true, tree, used }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** A logic tree in words, with the brackets it needs (and an AND inside an OR bracketed - easier to read); `leaf(no)` says
 *  a line (its number by default). */
export function logicText(tree, leaf = String) {
  const rank = { or: 1, and: 2, not: 3 }
  const show = (node, parent) => {
    if (node.line != null) return leaf(node.line)
    if (node.op === 'not') return `NOT ${show(node.a, 3)}`
    const inner = `${show(node.a, rank[node.op])} ${node.op.toUpperCase()} ${show(node.b, rank[node.op])}`
    return rank[node.op] < parent || (node.op === 'and' && parent === 1) ? `(${inner})` : inner
  }
  return show(tree, 0)
}

/** Whether the tree holds, `line(no)` saying whether line no (1-based) holds. */
export function evalLogic(tree, line) {
  if (tree.line != null) return line(tree.line)
  if (tree.op === 'not') return !evalLogic(tree.a, line)
  return tree.op === 'and' ? evalLogic(tree.a, line) && evalLogic(tree.b, line) : evalLogic(tree.a, line) || evalLogic(tree.b, line)
}

/** The logic once line `k` (1-based) of `n` is removed: that line taken out (its AND / OR with it), the lines after it
 *  renumbered. Logic that does not read is left as it is. */
export function logicWithoutLine(text, n, k) {
  const parsed = parseLogic(text, n)
  if (!parsed.ok) return String(text ?? '')
  const drop = (node) => {
    if (node.line != null) return node.line === k ? null : { line: node.line > k ? node.line - 1 : node.line }
    if (node.op === 'not') { const a = drop(node.a); return a ? { op: 'not', a } : null }
    const a = drop(node.a), b = drop(node.b)
    return a && b ? { op: node.op, a, b } : a ?? b
  }
  const tree = drop(parsed.tree)
  return tree ? logicText(tree) : ''
}

/** The rule's logic tree, or null to use the lines' own AND / OR; { error } when the logic does not read. */
export function ruleLogic(rule) {
  const text = String(rule?.logic ?? '').trim()
  if (!text) return null
  const parsed = parseLogic(text, rule?.lines?.length ?? 0)
  return parsed.ok ? parsed.tree : { error: parsed.error }
}

/** The mirror's lines - each line's opposite value (numbers, windows and joins kept). */
export const mirrorLines = (lines) => lines.map((l) => ({ ...l, value: optionOf(l.id, l.value)?.opposite ?? l.value }))
/** Whether the mirror would be the rule itself (no line has a side). */
export const mirrorIsSame = (lines) => lines.every((l) => optionOf(l.id, l.value)?.opposite === l.value)

/** One line in words: "Price vs VWAP: Price above VWAP by ≥ 0.1% (last 5 min)". */
export function lineText(line) {
  const c = CONDITION[line.id], o = optionOf(line.id, line.value)
  if (!c || !o) return ''
  const num = o.param && line.param > 0 ? ` ${o.param.label} ${line.param}${o.param.unit}` : ''
  const win = o.windowed ? ` (last ${line.windowMin ?? DEFAULT_WINDOW} min)` : ''
  return `${c.name}: ${o.label}${num}${win}`
}
// The lines as OR groups of AND-ed lines: a line joined by OR starts a new group.
function orGroups(lines) {
  const groups = []
  for (const l of lines) {
    if (!groups.length || l.join === 'or') groups.push([l]); else groups.at(-1).push(l)
  }
  return groups
}
/** The rule in words: "Buy CE when (A AND B) OR C" - with `logic` (a valid one), its numbers and each line by number. */
export function ruleText(lines, action, logic = '') {
  const groups = orGroups(lines)
  if (!groups.length) return `${ACTION[action]?.label ?? action} when (no condition picked)`
  const parsed = String(logic ?? '').trim() ? parseLogic(logic, lines.length) : null
  if (parsed?.ok) return `${ACTION[action]?.label ?? action} when ${logicText(parsed.tree, (no) => lineText(lines[no - 1]))}`
  const many = groups.length > 1
  const text = groups.map((g) => { const t = g.map(lineText).join(' AND '); return many && g.length > 1 ? `(${t})` : t }).join(' OR ')
  return `${ACTION[action]?.label ?? action} when ${text}`
}

const lineHolds = (d, i, l) => CONDITION[l.id].test(d, i, l.value, span(d, l.windowMin ?? DEFAULT_WINDOW), l.param ?? 0)
// Does the rule hold at candle i: its logic tree (`tree`), else any OR group whose lines all hold.
function ruleHolds(d, i, lines, groups, tree) {
  if (tree) return evalLogic(tree, (no) => lineHolds(d, i, lines[no - 1]))
  return groups.some((g) => g.every((l) => lineHolds(d, i, l)))
}

/**
 * The rule's signals on a day (read on its candles - `timeframeView`): `rule` = { lines, action, mirror, logic } (or the
 * earlier { conditions } form - `normalizeRule`); with `logic` the lines are combined by it (the mirror by the same logic on
 * its lines), and logic that does not read signals nothing. A signal on the candle where the rule BECOMES true (it then has to stop holding
 * before it signals again) - and, with the mirror on, where the mirrored rule becomes true (its opposite trade). A mirror
 * that would be the rule itself is left out. `openAt`: the candle entries open on (09:30) - a rule that became true before it
 * and still holds there signals on it (else a condition true from the open, e.g. total PE OI above CE, never traded at all).
 * Returns [{ i, side: 'rule' | 'mirror', action, why }].
 */
export function ruleSignals(d, rule, { openAt = null } = {}) {
  const r = normalizeRule(rule, null)
  if (!r.lines.length || !ACTION[r.action]) return []
  const tree = ruleLogic(r)
  if (tree?.error) return []
  const sides = [{ side: 'rule', lines: r.lines, action: r.action }]
  if (r.mirror && !mirrorIsSame(r.lines)) sides.push({ side: 'mirror', lines: mirrorLines(r.lines), action: ACTION[r.action].opposite })
  const out = []
  for (const s of sides) {
    const groups = orGroups(s.lines)
    let was = false
    for (let i = 0; i < d.n; i++) {
      const now = ruleHolds(d, i, s.lines, groups, tree)
      // Entries open at `openAt`: a rule already holding then signals there - it became true before entries were allowed.
      if (i === openAt) was = false
      if (now && !was) {
        const shown = [...new Set(s.lines.map((l) => CONDITION[l.id].show(d, i)))].join(' · ')
        out.push({ i, side: s.side, action: s.action, why: `${ACTION[s.action].label}${s.side === 'mirror' ? ' (mirror)' : ''}: ${shown}` })
      }
      was = now
    }
  }
  return out.sort((a, b) => a.i - b.i)
}

// ---- Trades ---------------------------------------------------------------------------------------------------------

export const BACKTEST_DEFAULTS = {
  moneyness: 0, slPct: 30, targetPct: 50, levelUnit: 'pct', trailGap: 0, trailStart: 0, timeStopMin: 0, maxTradesPerDay: 2, cooldownMin: 10,
  lots: 1, entryFrom: '09:30', lastEntry: '14:45', squareOff: '15:10', charges: true, timeframe: 1,
  // On the options' EXPIRY DAY: trade as the rule says ('rule'), or always BUY / always SELL ('buy' / 'sell') - the
  // signal's direction kept (a bullish one buys the call or sells the put).
  expiryDay: 'rule',
  // The rule the page opens with: put writing ahead since the open AND price over VWAP - buy the call; the mirror (call
  // writing ahead AND price under VWAP) buys the put.
  rule: { tree: { op: 'and', not: false, items: [{ line: { id: 'oiOpen', value: 'peAhead', param: 0 } }, { line: { id: 'vwap', value: 'above', param: 0 } }] }, action: 'buyCE', mirror: true },
}

/** What to do on the options' expiry day (`expiryDay`) - overriding the rule's buy / sell there, the direction kept. */
export const EXPIRY_DAY_CHOICES = [
  { value: 'rule', label: 'As the rule' },
  { value: 'buy', label: 'Buy options' },
  { value: 'sell', label: 'Sell options' },
]
const EXPIRY_MODES = new Set(['buy', 'sell'])

/** The option a signal trades: BUY the call (put) for a bullish (bearish) signal, or SELL the put (call). `moneyness`:
 *  0 ATM, 1 one strike in the money, -1 one out of the money. */
export function optionFor(dir, mode, atm, step, moneyness = 0) {
  const side = mode === 'sell' ? (dir > 0 ? 'PE' : 'CE') : (dir > 0 ? 'CE' : 'PE')
  // In the money: a call below spot, a put above it.
  const shift = (side === 'CE' ? -1 : 1) * moneyness * step
  return { side, strike: atm + shift, action: mode === 'sell' ? 'SELL' : 'BUY' }
}

const barAt = (packed, i) => {
  if (!packed) return null
  const o = packed[i * 4]
  return Number.isFinite(o) ? { o, h: packed[i * 4 + 1], l: packed[i * 4 + 2], c: packed[i * 4 + 3] } : null
}
// The option's close at minute i, else its last within STALE_MINUTES.
function premiumAt(packed, i) {
  for (let k = i; k >= 0 && k >= i - STALE_MINUTES; k--) {
    const b = barAt(packed, k)
    if (b) return b.c
  }
  return null
}

/** The level units: % of the entry premium, or premium points. */
export const LEVEL_UNITS = ['pct', 'pts']

/**
 * One trade, entered at minute `i`'s close of the option and managed from minute i + 1 on its 1-minute bars. `slPct` /
 * `targetPct` / `trailGap` / `trailStart` are in `levelUnit` - 'pct' (% of the entry premium) or 'pts' (premium points);
 * 0 = none. The stop before the target in the same bar; a bar opening through the stop fills at its open. The TRAILING
 * stop (the paper panel's - `optionTrailLevel`): `trailGap` behind the best premium reached (a bought option's highest
 * high, a sold one's lowest low), once the trade is `trailStart` in profit; it moves after each completed bar - a bar is
 * judged with the trail it had before it - and only tightens; the tighter of it and the fixed stop is the stop.
 */
export function simulateTrade(d, i, option, { slPct, targetPct, levelUnit = 'pct', trailGap = 0, trailStart = 0, timeStopMin = 0, squareOff = '15:10' }) {
  const packed = (option.side === 'CE' ? d.ce : d.pe).get(option.strike)
  const entry = premiumAt(packed, i)
  if (!(entry > 0)) return null
  const short = option.action === 'SELL'
  const size = (v) => (v > 0 ? (levelUnit === 'pts' ? v : (entry * v) / 100) : 0)
  const slPts = size(slPct), targetPts = size(targetPct), gap = size(trailGap), start = size(trailStart)
  const fixed = slPts > 0 ? (short ? entry + slPts : entry - slPts) : null
  const target = targetPts > 0 ? (short ? entry - targetPts : entry + targetPts) : null
  const off = clockMinute(squareOff) ?? 15 * 60 + 10
  let last = entry, exit = null, best = entry, trail = null
  for (let j = i + 1; j < d.n; j++) {
    const b = barAt(packed, j)
    const minute = istMinute(d.t[j])
    if (b) {
      const stop = tighterStop(option.action, fixed, trail)
      const trailing = stop != null && trail != null && stop === trail && stop !== fixed
      const name = trailing ? 'Trailing stop' : 'Stop'
      if (stop != null && (short ? b.o >= stop : b.o <= stop)) exit = { j, price: b.o, reason: `${name} (opened through it)` }
      else if (stop != null && (short ? b.h >= stop : b.l <= stop)) exit = { j, price: stop, reason: name }
      else if (target != null && (short ? b.l <= target : b.h >= target)) exit = { j, price: target, reason: 'Target' }
      last = b.c
      // After the bar: the best premium so far and the trail from it (never looser than the one it had).
      best = short ? Math.min(best, b.l) : Math.max(best, b.h)
      if (gap > 0) trail = tighterStop(option.action, trail, optionTrailLevel(option.action, entry, best, start, gap))
    }
    if (!exit && timeStopMin > 0 && d.t[j] - d.t[i] >= timeStopMin * MIN) exit = { j, price: last, reason: `Time stop ${timeStopMin} min` }
    if (!exit && minute >= off) exit = { j, price: last, reason: `${squareOff} square-off` }
    if (exit) break
  }
  if (!exit) exit = { j: d.n - 1, price: last, reason: 'Day end' }
  const points = short ? entry - exit.price : exit.price - entry
  return { entryIndex: i, exitIndex: exit.j, entry, exit: exit.price, exitReason: exit.reason, points, stop: fixed, target, trail }
}

/**
 * The rule's signals and trades for one prepared day under the settings (BACKTEST_DEFAULTS + `settings`: `rule`,
 * `lotSize`, `chargesCfg`, `timeframe` - the candles the rule reads, `timeframeView`). One trade at a time (the rule and
 * its mirror together), `cooldownMin` after an exit, at most `maxTradesPerDay`, entries only from `entryFrom` to
 * `lastEntry`. On the options' expiry day (`d.isExpiry`) `expiryDay` 'buy' / 'sell' overrides the rule's buy / sell (the
 * signal's direction kept: bullish buys the call or sells the put). Returns `{ trades, signals }` - every trade `{ date,
 * strategy ('rule' | 'mirror'), dir, why, side, strike, action, expiryDay, overridden, entryTime, exitTime, entry, exit,
 * exitReason, points, gross, charges, net, holdMin }`; every signal
 * `{ strategy, time, dir, why, taken, skipped }`.
 */
export function simulateDay(d, settings = {}) {
  const s = { ...BACKTEST_DEFAULTS, ...settings }
  const from = clockMinute(s.entryFrom) ?? 9 * 60 + 30
  const lastEntry = clockMinute(s.lastEntry) ?? 14 * 60 + 45
  const lotSize = s.lotSize ?? 1
  const trades = []
  const signals = []
  if (!d?.ok) return { trades, signals }
  // The rule reads the day on the timeframe's candles; a signal's candle -> its last minute, where the trade enters.
  const view = timeframeView(d, s.timeframe)
  const minuteOfSignal = (k) => (view.at ? view.at[k] : k)
  let busyUntil = -1
  let count = 0
  // The first candle whose close is in the entry window: a rule already holding then signals on it.
  let openAt = 0
  while (openAt < view.n && istMinute(view.t[openAt]) < from) openAt++
  // The expiry day's own choice overrides the rule's buy / sell (the signal's direction kept).
  const expiryMode = d.isExpiry && EXPIRY_MODES.has(s.expiryDay) ? s.expiryDay : null
  for (const sig of ruleSignals(view, s.rule, { openAt })) {
    const i = minuteOfSignal(sig.i)
    const { dir, mode: ruleMode } = ACTION[sig.action]
    const mode = expiryMode ?? ruleMode
    const overridden = mode !== ruleMode
    const why = overridden ? `Expiry day - ${mode === 'sell' ? 'selling' : 'buying'} instead · ${sig.why}` : sig.why
    const minute = istMinute(d.t[i])
    const row = { strategy: sig.side, time: d.t[i], dir, why, taken: false, skipped: null }
    signals.push(row)
    if (minute < from || minute > lastEntry) { row.skipped = `outside ${s.entryFrom} - ${s.lastEntry}`; continue }
    if (i <= busyUntil) { row.skipped = 'a trade still open, or cooling down'; continue }
    if (count >= s.maxTradesPerDay) { row.skipped = `${s.maxTradesPerDay} trades already today`; continue }
    const option = optionFor(dir, mode, d.atm[i], d.step, s.moneyness)
    const trade = simulateTrade(d, i, option, s)
    if (!trade) { row.skipped = `no premium for ${option.strike} ${option.side}`; continue }
    row.taken = true
    count++
    busyUntil = trade.exitIndex + Math.max(0, Math.round(s.cooldownMin))
    const qty = { lots: s.lots, lotSize }
    const money = tradeCharges({ action: option.action, premium: trade.entry, current: trade.exit, ...qty }, s.chargesCfg)
    const gross = trade.points * s.lots * lotSize
    trades.push({
      date: d.date, strategy: sig.side, dir, why, ...option, expiryDay: Boolean(d.isExpiry), overridden,
      entryTime: d.t[trade.entryIndex], exitTime: d.t[trade.exitIndex], entry: trade.entry, exit: trade.exit, exitReason: trade.exitReason,
      points: trade.points, gross, charges: s.charges && money ? money.charges : 0, net: s.charges && money ? money.net : gross,
      holdMin: Math.round((d.t[trade.exitIndex] - d.t[trade.entryIndex]) / MIN),
    })
  }
  return { trades, signals }
}

/** The whole run, day by day in date order: { trades, signals }. */
export function simulateRun(days, settings = {}) {
  const list = [...(days ?? [])].filter((d) => d?.ok).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const trades = []
  const signals = []
  for (const d of list) {
    const out = simulateDay(d, settings)
    trades.push(...out.trades)
    signals.push(...out.signals)
  }
  return { trades, signals }
}

// ---- The report -----------------------------------------------------------------------------------------------------

export const MAX_BACKTEST_DAYS = 60

/** The days a backtest runs: the weekdays from `from` to `to` ('YYYY-MM-DD'), before `today`, at most `max` (the latest
 *  kept). A holiday is in the list - the server says it has no data and the day is shown as not run. */
export function backtestDays(from, to, today, max = MAX_BACKTEST_DAYS) {
  const out = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out
  for (let ms = start; ms <= end; ms += DAY) {
    const d = new Date(ms)
    const key = d.toISOString().slice(0, 10)
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && (!today || key < today)) out.push(key)
  }
  return out.slice(-max)
}

/** How a list of trades did: { trades, wins, losses, winRate, points, gross, charges, net, avgWin, avgLoss, profitFactor,
 *  expectancy, maxDrawdown, best, worst, days, winningDays, avgHoldMin } (rupees; drawdown on the running net, trade by
 *  trade in time order). */
export function summarize(trades) {
  const list = [...(trades ?? [])].sort((a, b) => a.entryTime - b.entryTime)
  const wins = list.filter((t) => t.net > 0)
  const losses = list.filter((t) => t.net <= 0)
  const sum = (xs, k) => xs.reduce((a, t) => a + t[k], 0)
  const winSum = sum(wins, 'net')
  const lossSum = sum(losses, 'net')
  let run = 0, peak = 0, maxDrawdown = 0
  for (const t of list) { run += t.net; peak = Math.max(peak, run); maxDrawdown = Math.max(maxDrawdown, peak - run) }
  const byDay = new Map()
  for (const t of list) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.net)
  return {
    trades: list.length, wins: wins.length, losses: losses.length,
    winRate: list.length ? (wins.length / list.length) * 100 : null,
    points: sum(list, 'points'), gross: sum(list, 'gross'), charges: sum(list, 'charges'), net: sum(list, 'net'),
    avgWin: wins.length ? winSum / wins.length : null, avgLoss: losses.length ? lossSum / losses.length : null,
    profitFactor: lossSum < 0 ? winSum / -lossSum : wins.length ? Infinity : null,
    expectancy: list.length ? sum(list, 'net') / list.length : null,
    maxDrawdown,
    best: list.length ? Math.max(...list.map((t) => t.net)) : null, worst: list.length ? Math.min(...list.map((t) => t.net)) : null,
    days: byDay.size, winningDays: [...byDay.values()].filter((v) => v > 0).length,
    avgHoldMin: list.length ? sum(list, 'holdMin') / list.length : null,
  }
}

/** The trades as CSV text (one row a trade). */
export function tradesCsv(trades) {
  const name = { rule: 'Rule', mirror: 'Mirror' }
  const time = (ms) => hhmm(istMinute(ms))
  const cell = (v) => {
    const text = v == null ? '' : String(v)
    const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['date', 'rule', 'signal', 'action', 'option', 'entry time', 'entry', 'exit time', 'exit', 'exit reason', 'points', 'gross', 'charges', 'net', 'expiry day', 'why']
  const rows = trades.map((t) => [
    t.date, name[t.strategy] ?? t.strategy, t.dir > 0 ? 'bullish' : 'bearish', t.action, `${t.strike} ${t.side}`, time(t.entryTime), t.entry.toFixed(2),
    time(t.exitTime), t.exit.toFixed(2), t.exitReason, t.points.toFixed(2), t.gross.toFixed(0), t.charges.toFixed(0), t.net.toFixed(0),
    t.expiryDay ? (t.overridden ? 'yes - overridden' : 'yes') : '', t.why,
  ])
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\n')
}
