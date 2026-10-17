// The SPOT + OPTIONS strategies: they trade the index price itself - the 1-minute spot candles - read against the
// option chain's OI (the S/R OI walls, CE and PE rising or falling, delta and since the open, the day type) and its
// premiums (the ATM straddle, the ATM call / put against the spot's new high / low) - #114 has them all at once, the
// Strategy lab's OI filters as its own rules. No
// futures, no footprint, tape or order book: spot has none. Entry = the last finished spot minute's close,
// stop / target in spot points; the options each setup carries (BUY / SELL at the ATM strike) are priced from the
// OI replay like the futures strategies'. No look-ahead: a setup at clock T uses only spot minutes and OI points
// that had FINISHED by T (the replay context is built with live: false).
//
// Measured by the Strategy tuning ("Spot + options only", scanSpotDay -> strategyTuning.js) and run live by the server
// scanner (scanner-runner/indexScanner.mjs scanSpot): once each finished minute, on the server's own spot candles, with
// the same evaluateSpotStrategies - a tuned spot setting applied to an index trades there (paper, or live when the index
// is Live today and the strategy is on its live list; the server watches its index stop on the spot price). The Order
// Flow page's scanner does not run them.

import { pocIndexOf, valueAreaOf } from './orderFlowMath.js'
import {
  SPOT_STRATEGIES, SQUARE_OFF, applyTradeFilter, dayTypeAt, oiChange, oiOf, optionOiRead, optionTradesFor, oiRows, premiumAt, sideOiChanges, strategyFilters,
  valueAt, wallOiChanges, wallsAhead, wallsAt,
} from './strategyEngine.js'

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : Date.parse(t))
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440)
const FIRST_ENTRY = 9 * 60 + 30
const LAST_ENTRY = 14 * 60 + 45
const SIDE_BAR = 0.003 // a side's OI really rising / falling: 0.3% of its OI in 15 minutes (as the filters)
const WALL_BAR = 0.005 // a wall's OI really growing / shrinking: 0.5% in 15 minutes
const WRITING_BAR = 0.02 // fresh writing at a strike: its OI up 2% in 15 minutes (a hot cell of the OI heatmap)
const COVERING_BAR = 0.01 // the other side covering: its OI near the price down 1% in 15 minutes
const FLIP_BAR = 0.002 // a since-open lead worth reading: 0.2% of the chain's OI
const LADDER_RATIO = 1.3 // support (or resistance) this much bigger than the other side, in the 3 strikes each side
const LADDER_RISE = 0.1 // ... and that lead grown 10% in 15 minutes
const STRADDLE_FALL = 0.005 // the ATM straddle decaying: down 0.5% in 10 minutes (same strike)
const OI_LEAN = 0.2 // the whole chain's OI lean (since the open / on the window) counts as with / against at this (as the filters)
const CUM_SIDE_BAR = 0.01 // a side's OI really added / shed since the open: 1% of it (as the filters)
const BY_ID = Object.fromEntries(SPOT_STRATEGIES.map((s) => [s.id, s]))

/** Spot candles as the engine reads them: { t (start, ms), time, open, high, low, close }. */
export const spotBarsOf = (candles) => (candles ?? []).map((c) => ({ t: msOf(c.time), time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
  .filter((b) => b.close > 0 && b.high >= b.low).sort((a, b) => a.t - b.t)

/** What a side pair (CE, PE OI change as a fraction) says for a trade `dir`: PE rising and CE falling are the two
 *  bullish sides - +2 both with the trade ... -2 both against. */
export function sideScore(dir, ce, pe, bar = SIDE_BAR) {
  if (!Number.isFinite(ce) || !Number.isFinite(pe)) return null
  const st = (x) => (x >= bar ? 1 : x <= -bar ? -1 : 0)
  return dir * (st(pe) - st(ce))
}

const avgRange = (bars, n = 14) => {
  const last = bars.slice(-n)
  return last.length ? last.reduce((s, b) => s + (b.high - b.low), 0) / last.length : 0
}

// ---- #115's three indicators: EMA, RSI and VWAP (and nothing else) ----
/** EMA of `values`, aligned with them: null until `period` values, then seeded with their simple average. */
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null)
  if (values.length < period) return out
  let e = values.slice(0, period).reduce((a, v) => a + v, 0) / period
  out[period - 1] = e
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e }
  return out
}
/** Wilder's RSI of `closes`, aligned with them: null until `period` changes are in. */
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null)
  if (closes.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d }
  gain /= period
  loss /= period
  const rsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss))
  out[period] = rsi()
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = rsi()
  }
  return out
}
/** The session's VWAP at each finished minute. The index has no traded volume (neither has its spot feed), so each
 *  minute weighs the same: the running average of the typical price (high + low + close) / 3 - time-weighted. */
export function vwapSeries(bars) {
  let sum = 0
  return bars.map((b, i) => { sum += (b.high + b.low + b.close) / 3; return sum / (i + 1) })
}
/** The opening: the 09:15 - 09:29 minutes as three 5-minute candles and their range - null until all 15 are in. drive:
 *  +1 when 2+ of the three closed up and the third closed above the first's open (a drive up), -1 the mirror, else 0. */
export function openingOf(bars) {
  const first = bars.filter((b) => { const m = istMinute(b.t); return m >= 555 && m < 570 })
  if (first.length < 15) return null
  const candle = (xs) => ({ open: xs[0].open, close: xs.at(-1).close, high: Math.max(...xs.map((b) => b.high)), low: Math.min(...xs.map((b) => b.low)) })
  const candles = [0, 5, 10].map((i) => candle(first.slice(i, i + 5)))
  const ups = candles.filter((c) => c.close > c.open).length
  const downs = candles.filter((c) => c.close < c.open).length
  const drive = ups >= 2 && candles[2].close > candles[0].open ? 1 : downs >= 2 && candles[2].close < candles[0].open ? -1 : 0
  return { candles, high: Math.max(...candles.map((c) => c.high)), low: Math.min(...candles.map((c) => c.low)), ups, downs, drive }
}
/** The previous trading day's high, low and close from its 1-minute spot bars (GET /api/oi-replay/{index}/previous-day-
 *  volume-profile - its `bars`; only their high / low / close are read, never a volume profile). Null without bars. */
export function prevDayOf(result) {
  const bars = (result?.bars ?? []).filter((b) => b.high > 0 && b.low > 0 && b.close > 0)
  if (!bars.length) return null
  return { date: result.profileDate ?? null, high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: bars.at(-1).close }
}
const ADAPTIVE_LEAN = 0.15 // #115: the whole chain's OI added since the open leans this much to call it one-sided
const ADAPTIVE_BALANCE = [0.8, 1.25] // ... support OI (PE, 3 strikes under) / resistance OI (CE, 3 over) in this band = balanced

// Our OWN spot profile (#111 - #113 read it): built here from the day's spot candles - no server profile, no futures. Spot
// has no traded volume, so each finished minute counts once - time at price, a TPO profile - spread evenly over the rows
// (a tenth of the strike step) its high - low covers. Only minutes that finished PROFILE_LAG or more before the clock are
// in it (the area price is in now is not a node or a thin area yet), and it needs PROFILE_MIN_BARS of them.
export const PROFILE_LAG = 15
export const PROFILE_MIN_BARS = 45
const NODE_SHARE = 0.3 // a volume node: a peak of the smoothed profile with 30% of the POC's time or more
const NODE_MERGE = 0.5 // two peaks with no dip under half the smaller between them are one node
const LVN_DEPTH = 0.2 // a thin area: a dip to 20% of the smaller node beside it or less ...
const LVN_EDGE = 0.25 // ... widened over the rows under a quarter of it

/**
 * The day's own spot profile from `bars` (spotBarsOf - the FINISHED minutes up to the clock; the last PROFILE_LAG are
 * left out) and the strike `step`: { row, minutes, upTo, poc, vah, val, nodes (the high-time peaks, low to high - the POC
 * among them), lvns: [{ low, high, mid, lvn }] (the thin areas BETWEEN two nodes, low to high) }, else null.
 */
export function spotProfile(bars, step) {
  const used = (bars ?? []).slice(0, Math.max(0, (bars?.length ?? 0) - PROFILE_LAG))
  if (used.length < PROFILE_MIN_BARS || !(step > 0)) return null
  const row = step / 10
  const at = (p) => Math.round(p / row)
  let lo = Infinity
  let hi = -Infinity
  for (const b of used) { lo = Math.min(lo, at(b.low)); hi = Math.max(hi, at(b.high)) }
  if (!(hi >= lo) || hi - lo > 4000) return null
  const counts = new Array(hi - lo + 1).fill(0)
  for (const b of used) {
    const a = at(b.low) - lo
    const z = at(b.high) - lo
    for (let i = a; i <= z; i++) counts[i] += 1 / (z - a + 1)
  }
  const price = (i) => +((lo + i) * row).toFixed(2)
  // Smoothed over two rows each side (1-2-3-2-1), so a node is an area, not one row.
  const s = counts.map((_, i) => [1, 2, 3, 2, 1].reduce((sum, w, k) => sum + w * (counts[i + k - 2] ?? 0), 0) / 9)
  const pocI = pocIndexOf(s)
  const { lo: vaLo, hi: vaHi } = valueAreaOf(counts, pocI)
  // The nodes: the peaks (the middle of a flat top) with 30%+ of the POC's time; two with no real dip between them are one
  // (the higher kept).
  let peaks = []
  for (let i = 0; i < s.length;) {
    let j = i
    while (j + 1 < s.length && Math.abs(s[j + 1] - s[i]) < 1e-9) j++
    if ((i === 0 || s[i - 1] < s[i]) && (j === s.length - 1 || s[j + 1] < s[i]) && s[i] >= NODE_SHARE * s[pocI]) peaks.push(Math.floor((i + j) / 2))
    i = j + 1
  }
  if (!peaks.includes(pocI)) peaks = [...peaks, pocI].sort((a, b) => a - b)
  const dipBetween = (a, b) => { let m = a + 1; for (let i = a + 1; i < b; i++) if (s[i] < s[m]) m = i; return m }
  for (let merged = true; merged && peaks.length > 1;) {
    merged = false
    for (let j = 1; j < peaks.length; j++) {
      const [a, b] = [peaks[j - 1], peaks[j]]
      if (b - a < 2 || s[dipBetween(a, b)] > NODE_MERGE * Math.min(s[a], s[b])) {
        const drop = a === pocI ? b : b === pocI ? a : s[a] >= s[b] ? b : a
        peaks = peaks.filter((x) => x !== drop)
        merged = true
        break
      }
    }
  }
  const lvns = []
  for (let j = 1; j < peaks.length; j++) {
    const [a, b] = [peaks[j - 1], peaks[j]]
    const ref = Math.min(s[a], s[b])
    const m = dipBetween(a, b)
    if (s[m] > LVN_DEPTH * ref) continue
    let l = m
    let r = m
    while (l - 1 > a && s[l - 1] <= LVN_EDGE * ref) l--
    while (r + 1 < b && s[r + 1] <= LVN_EDGE * ref) r++
    const low = +(price(l) - row / 2).toFixed(2)
    const high = +(price(r) + row / 2).toFixed(2)
    lvns.push({ low, high, mid: +((low + high) / 2).toFixed(2), lvn: price(m) })
  }
  return { row, minutes: used.length, upTo: used.at(-1).t + MIN, poc: price(pocI), vah: price(vaHi), val: price(vaLo), nodes: peaks.map(price), lvns }
}

/**
 * Every spot setup whose rules pass at `nowMs` (a whole minute). `bars` - the FINISHED spot minutes up to it (spotBarsOf,
 * start + 1 minute <= nowMs), `oi` - buildOiContext(run, expiry, { live: false }), `filters` - { [id]: overrides }. #111 -
 * #113 also read the day's own spot profile, built from those bars (spotProfile).
 * Setups have the futures setups' shape (id, name, side, t, entry, stop, target, timeStopMs, options, oiCtx, checks).
 */
export function evaluateSpotStrategies({ nowMs, bars, oi, filters = {}, prevDay = null }) {
  if (!oi || bars.length < 15) return []
  const minute = istMinute(nowMs)
  if (minute < FIRST_ENTRY || minute > LAST_ENTRY) return []
  const last = bars.at(-1)
  const prev = bars.at(-2)
  const spotNow = last.close
  const rows = oiRows(oi, nowMs)
  if (!rows.length || !(valueAt(oi.spot, nowMs)?.close > 0)) return []
  const atr = Math.max(avgRange(bars), spotNow * 0.0004)
  const read = optionOiRead(oi, spotNow, nowMs, 15)
  if (!read) return []
  const { support, resistance } = wallsAt(oi, rows, spotNow)
  const ahead = wallsAhead(oi, rows, spotNow)
  const sides = sideOiChanges(read, false) // ceD, peD
  const cum = sideOiChanges(read, true) // ceC, peC
  let regimeMemo
  const regime = () => (regimeMemo ??= dayTypeAt(oi, bars, nowMs))
  const out = []

  const ctx = () => ({
    flow: read.lean, cum: read.leanOpen, futOiPct: null, futPricePct: null,
    ...wallOiChanges(oi, ahead, nowMs, 15), ...sides, ...cum, dayType: regime()?.type ?? null,
    byWindow: Object.fromEntries([1, 3, 5].map((m) => {
      const r = optionOiRead(oi, spotNow, nowMs, m)
      return [m, { flow: r?.lean ?? null, futOiPct: null, futPricePct: null, ...wallOiChanges(oi, ahead, nowMs, m), ...sideOiChanges(r, false) }]
    })),
    support, resistance, spot: spotNow, ...ahead,
  })
  const push = (id, dir, stopPts, targetPts, timeStopMin, checks, extra = null) => {
    if (!(stopPts > 0) || !(targetPts > 0)) return
    out.push({
      ...extra,
      id, name: BY_ID[id].name, side: dir > 0 ? 'LONG' : 'SHORT', t: nowMs, entry: spotNow,
      stop: spotNow - dir * stopPts, target: spotNow + dir * targetPts,
      timeStopMs: Math.min(nowMs + timeStopMin * MIN, nowMs + (SQUARE_OFF - minute) * MIN),
      estimated: false, spot: true, options: optionTradesFor(oi, dir, spotNow, nowMs), oiCtx: ctx(), checks,
    })
  }
  const pct = (v) => (v == null ? 'no read' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`)

  for (const dir of [1, -1]) {
    const wall = dir > 0 ? resistance : support // the call wall above a long / the put wall below a short
    const wallChg = wall == null ? null : wallOiChanges(oi, dir > 0 ? { resistanceAhead: wall, supportAhead: null } : { resistanceAhead: null, supportAhead: wall }, nowMs, 15)[dir > 0 ? 'resChg' : 'supChg']
    const score = sideScore(dir, sides.ceD, sides.peD)

    // 1. Wall break: the price closes through the wall it was under, the wall's writers are leaving, the two sides
    //    are not against the trade.
    if (wall != null && prev && dir * (prev.close - wall) <= 0 && dir * (spotNow - wall) > 0.15 * atr && wallChg != null && wallChg <= -WALL_BAR && score != null && score >= 0) {
      const stopPts = Math.max(1.2 * atr, Math.abs(spotNow - wall) + 0.8 * atr)
      push('spotWallBreak', dir, stopPts, 2 * stopPts, 45, {
        OI: `closed ${Math.abs(spotNow - wall).toFixed(1)} pts ${dir > 0 ? 'above' : 'below'} the ${dir > 0 ? 'call' : 'put'} wall ${wall}; its OI ${pct(wallChg)} in 15m; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)}`,
      })
    }

    // 2. Wall holds: the price touched the wall the trade leans on (a put wall below a long, a call wall above a short)
    //    and closed back off it on a rejection candle, and that wall's OI is GROWING.
    const rejection = dir > 0 ? last.close > last.open : last.close < last.open
    const holdWall = dir > 0 ? support : resistance
    const holdChg = holdWall == null ? null : wallOiChanges(oi, dir > 0 ? { resistanceAhead: null, supportAhead: holdWall } : { resistanceAhead: holdWall, supportAhead: null }, nowMs, 15)[dir > 0 ? 'supChg' : 'resChg']
    const touchedHold = holdWall != null && (dir > 0 ? last.low <= holdWall + 0.001 * spotNow && last.close > holdWall : last.high >= holdWall - 0.001 * spotNow && last.close < holdWall)
    if (touchedHold && rejection && holdChg != null && holdChg >= WALL_BAR && score != null && score >= 0) {
      const stopPts = Math.max(1.2 * atr, Math.abs(spotNow - holdWall) + 0.8 * atr)
      push('spotWallHold', dir, stopPts, 1.5 * stopPts, 30, {
        OI: `rejected at the ${dir > 0 ? 'put' : 'call'} wall ${holdWall}; its OI ${pct(holdChg)} in 15m (growing); CE ${pct(sides.ceD)} / PE ${pct(sides.peD)}`,
      })
    }

    // 3. Sides with the move: CE and PE both back the trade now (PE rising and CE falling for a long) and since the
    //    open, and the price breaks out of its last 10 minutes.
    const cumScore = sideScore(dir, cum.ceC, cum.peC, 0.01)
    const recent = bars.slice(-11, -1)
    const broke = recent.length === 10 && (dir > 0 ? spotNow > Math.max(...recent.map((b) => b.high)) : spotNow < Math.min(...recent.map((b) => b.low)))
    if (broke && score === 2 && cumScore != null && cumScore >= 1) {
      push('spotSides', dir, 1.5 * atr, 3 * atr, 60, {
        OI: `broke the last 10 minutes' ${dir > 0 ? 'high' : 'low'}; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)} now, CE ${pct(cum.ceC)} / PE ${pct(cum.peC)} since the open`,
      })
    }

    // 4. Pullback to the day's average on a trending day: the session's average price (spot has no volume, so each
    //    minute counts the same), a pullback to it after a real run away from it, a candle turning back with the trend.
    const typical = bars.map((b) => (b.high + b.low + b.close) / 3)
    const avg = typical.reduce((s, v) => s + v, 0) / typical.length
    const ran = bars.slice(-60).reduce((m, b) => Math.max(m, dir * ((dir > 0 ? b.high : b.low) - avg)), -Infinity)
    const pulled = dir * ((dir > 0 ? last.low : last.high) - avg) <= 0.5 * atr && dir * (last.close - avg) > 0 && rejection
    if (pulled && ran >= 1.5 * atr && regime()?.type === (dir > 0 ? 'trend-up' : 'trend-down') && score != null && score >= 0) {
      const stopPts = Math.max(1.2 * atr, dir * (spotNow - ((dir > 0 ? Math.min(last.low, avg) : Math.max(last.high, avg)) - dir * 0.5 * atr)))
      push('spotAvgPullback', dir, stopPts, 2 * stopPts, 60, {
        OI: `${regime().label}; pulled back to the day's average ${avg.toFixed(1)} after a ${(ran).toFixed(1)} pt run; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)}`,
      })
    }
  }
  // 14. OI confluence - the option chain's reads all on the trade's side (the Strategy lab's OI filters, as rules), and a
  //     dip bought / a pop sold with it. For a long: since the open puts were written more than calls (the whole chain's
  //     net CE - PE, 0.2+ lean), on the last 15 minutes the chain is not against it; CE and PE each - at least one with it
  //     on the 15 minutes (PE rising or CE falling), neither against it since the open; the call wall in the way is not
  //     growing (no fresh writing above), it is at least the target away (room), and the day is not trending down. The
  //     price pulled back 1 ATR+ off its last 20 minutes' high in the last 6, and the last candle resumes up - closing
  //     above the one before's high. Stop past the pullback's low; target 2x the stop.
  for (const dir of [1, -1]) {
    const flowWith = Number.isFinite(read.leanOpen) && dir * read.leanOpen >= OI_LEAN
    const flowNotAgainst = Number.isFinite(read.lean) && dir * read.lean > -OI_LEAN
    const sidesNow = sideScore(dir, sides.ceD, sides.peD)
    const sidesOpen = sideScore(dir, cum.ceC, cum.peC, CUM_SIDE_BAR)
    if (!flowWith || !flowNotAgainst || !(sidesNow >= 1) || !(sidesOpen >= 0)) continue
    const day = regime()?.type ?? null
    if (day === (dir > 0 ? 'trend-down' : 'trend-up')) continue
    // The dip: the lowest low of the 6 minutes before the last (the highest high for a short), 1 ATR+ under the highest
    // high of the last 20 minutes BEFORE it - a real pullback, not the start of a steady climb.
    const swing = bars.slice(-21, -1)
    if (swing.length < 20 || !prev) continue
    const ext = (b) => (dir > 0 ? b.low : b.high)
    let j = swing.length - 6
    for (let i = j; i < swing.length; i++) if (dir * (ext(swing[i]) - ext(swing[j])) < 0) j = i
    const dipExt = ext(swing[j])
    const before = swing.slice(0, j)
    const peak = dir > 0 ? Math.max(...before.map((b) => b.high)) : Math.min(...before.map((b) => b.low))
    const pulled = before.length > 0 && dir * (peak - dipExt) >= atr
    const resumed = dir * (last.close - last.open) > 0 && dir * (last.close - (dir > 0 ? prev.high : prev.low)) > 0
    if (!pulled || !resumed) continue
    const stopPts = Math.max(1.2 * atr, dir * (spotNow - dipExt) + 0.3 * atr)
    const targetPts = 2 * stopPts
    // The wall in the way: the biggest call strike above a long (put strike below a short) - not growing, and far enough.
    const wallAhead = dir > 0 ? ahead.resistanceAhead : ahead.supportAhead
    const wallChg = wallAhead == null ? null : wallOiChanges(oi, ahead, nowMs, 15)[dir > 0 ? 'resChg' : 'supChg']
    if (wallChg != null && wallChg >= WALL_BAR) continue
    if (wallAhead != null && dir * (wallAhead - spotNow) < targetPts) continue
    push('spotOiConfluence', dir, stopPts, targetPts, 60, {
      OI: `since the open ${dir > 0 ? 'puts' : 'calls'} written over ${dir > 0 ? 'calls' : 'puts'} (lean ${pct(Math.abs(read.leanOpen))}), 15m lean ${pct(read.lean)}; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)} in 15m, CE ${pct(cum.ceC)} / PE ${pct(cum.peC)} since the open; ${wallAhead == null ? 'no wall in the way' : `the ${dir > 0 ? 'call' : 'put'} wall ${wallAhead} ${pct(wallChg)} in 15m, ${Math.abs(wallAhead - spotNow).toFixed(1)} pts away`}; day ${day ?? 'not typed yet'}`,
      Price: `${dir > 0 ? 'dipped' : 'popped'} ${Math.abs(peak - dipExt).toFixed(1)} pts off the last 20 minutes' ${dir > 0 ? 'high' : 'low'} and resumed - closed ${dir > 0 ? 'above' : 'below'} the last candle's ${dir > 0 ? 'high' : 'low'}`,
    })
  }

  // ---- the option chain, strike by strike (the OI heatmap and the S/R ladder) ----
  const step = oi.step
  const atmK = Math.round(spotNow / step) * step
  const near = rows.filter((r) => Math.abs(r.strike - atmK) <= 3 * step)
  const chgPct = (map, k, mins = 15) => {
    const then = oiOf(map, k, nowMs - mins * MIN)
    const d = oiChange(map, k, nowMs, mins)
    return then > 0 && d != null ? d / then : null
  }
  // Since the open: total CE added minus total PE added (> 0 = calls written more; < 0 = puts), as a share of the chain.
  const lead = (ms) => {
    const r = optionOiRead(oi, valueAt(oi.spot, ms)?.close ?? spotNow, ms, 15)
    return r && r.ceNow + r.peNow > 0 ? (r.ceOpen - r.peOpen) / (r.ceNow + r.peNow) : null
  }
  // The S/R ladder: the PE OI on the 3 strikes at / under the price against the CE OI on the 3 at / over it.
  const ladderAt = (ms) => {
    const below = rows.filter((r) => r.strike <= spotNow).slice(-3).map((r) => r.strike)
    const above = rows.filter((r) => r.strike >= spotNow).slice(0, 3).map((r) => r.strike)
    const sum = (map, ks) => ks.reduce((s, k) => s + (oiOf(map, k, ms) ?? 0), 0)
    const pe = sum(oi.pe, below)
    const ce = sum(oi.ce, above)
    return pe > 0 && ce > 0 ? pe / ce : null
  }
  const leadNow = lead(nowMs)
  const leadThen = lead(nowMs - 10 * MIN)
  const ladderNow = ladderAt(nowMs)
  const ladderThen = ladderAt(nowMs - 15 * MIN)

  for (const dir of [1, -1]) {
    const rejection = dir > 0 ? last.close > last.open : last.close < last.open
    // 5. Fresh writing (the OI heatmap): the strike near the money with the most fresh writing on the trade's side -
    //    puts for a long - sits at / under the price, added 2%+ in 15 minutes, while the other side's OI on the two
    //    strikes over the price (calls) is being covered; the price ticks on with it.
    const writeMap = dir > 0 ? oi.pe : oi.ce
    const coverMap = dir > 0 ? oi.ce : oi.pe
    const hottest = near.map((r) => ({ k: r.strike, chg: chgPct(writeMap, r.strike) })).filter((x) => x.chg != null).sort((a, b) => b.chg - a.chg)[0]
    const coverKs = (dir > 0 ? near.filter((r) => r.strike > spotNow) : near.filter((r) => r.strike < spotNow).reverse()).slice(0, 2).map((r) => r.strike)
    const coverNow = coverKs.reduce((s, k) => s + (oiOf(coverMap, k, nowMs) ?? 0), 0)
    const coverThen = coverKs.reduce((s, k) => s + (oiOf(coverMap, k, nowMs - 15 * MIN) ?? 0), 0)
    const covered = coverKs.length === 2 && coverThen > 0 ? (coverNow - coverThen) / coverThen : null
    if (hottest && hottest.chg >= WRITING_BAR && dir * (spotNow - hottest.k) >= 0 && covered != null && covered <= -COVERING_BAR && prev && dir * (spotNow - prev.close) > 0) {
      const stopPts = Math.max(1.2 * atr, Math.abs(spotNow - hottest.k) + 0.5 * atr)
      push('spotFreshWriting', dir, stopPts, 2 * stopPts, 45, {
        OI: `${dir > 0 ? 'puts' : 'calls'} written at ${hottest.k} (${pct(hottest.chg)} in 15m, the hottest strike near the money); ${dir > 0 ? 'calls' : 'puts'} at ${coverKs.join(' / ')} ${pct(covered)} (covering)`,
      })
    }

    // 6. Since-open flip: total PE added since the open has just overtaken total CE added (a long), or the reverse,
    //    within the last 10 minutes, by a lead worth reading; the price on the right side of the day's open.
    const dayOpen = bars[0].open
    if (leadNow != null && leadThen != null && dir * leadNow <= -FLIP_BAR && dir * leadThen >= 0 && dir * (spotNow - dayOpen) > 0) {
      push('spotCumFlip', dir, 1.5 * atr, 3 * atr, 60, {
        OI: `since the open ${dir > 0 ? 'puts' : 'calls'} added now lead ${dir > 0 ? 'calls' : 'puts'} by ${pct(Math.abs(leadNow))} of the chain (10 min ago ${pct(leadThen)}); spot ${dir > 0 ? 'above' : 'below'} the open ${dayOpen.toFixed(1)}`,
      })
    }

    // 7. S/R OI ladder: the OI holding the price up (puts on the 3 strikes under it) is 1.3x+ the OI capping it (calls
    //    on the 3 over it) and grew 10%+ relative to it in 15 minutes - for a long; the price in the lower half
    //    between the put wall and the call wall, a candle turning up. Target: the opposite wall.
    const ratio = ladderNow == null ? null : dir > 0 ? ladderNow : 1 / ladderNow
    const ratioThen = ladderThen == null ? null : dir > 0 ? ladderThen : 1 / ladderThen
    if (ratio != null && ratioThen != null && support != null && resistance != null && resistance > support
      && ratio >= LADDER_RATIO && ratio >= ratioThen * (1 + LADDER_RISE) && rejection
      && (dir > 0 ? spotNow - support <= (resistance - support) / 2 : resistance - spotNow <= (resistance - support) / 2)) {
      const stopPts = Math.max(1.2 * atr, Math.abs(spotNow - (dir > 0 ? support : resistance)) + 0.5 * atr)
      const targetPts = Math.abs((dir > 0 ? resistance : support) - spotNow) - 0.2 * atr
      if (targetPts >= 1.2 * stopPts) {
        push('spotLadder', dir, stopPts, targetPts, 60, {
          OI: `${dir > 0 ? 'support' : 'resistance'} OI ${ratio.toFixed(2)}x the other side (15 min ago ${ratioThen.toFixed(2)}x); between the put wall ${support} and the call wall ${resistance}`,
        })
      }
    }
  }

  // ---- the option premiums and the walls moving (#108 - #110) ----
  // Premiums are the replay's last traded prices, read like the OI: a point counts once its minute is over.
  const straddleAt = (k, ms) => {
    const ce = premiumAt(oi, 'CE', k, ms)
    const pe = premiumAt(oi, 'PE', k, ms)
    return ce != null && pe != null ? ce + pe : null
  }
  // The session's ATM straddle: each finished minute's ATM strike (from its close) priced at that minute's end.
  const straddles = bars.map((b) => straddleAt(Math.round(b.close / step) * step, b.t + MIN)).filter((v) => v != null)
  const straddleAvg = straddles.length >= 15 ? straddles.reduce((s, v) => s + v, 0) / straddles.length : null
  const straddleNow = straddleAt(atmK, nowMs)
  const straddleThen = straddleAt(atmK, nowMs - 10 * MIN) // the same strike 10 minutes ago
  const decaying = straddleAvg != null && straddleNow != null && straddleThen != null
    && straddleNow < straddleAvg && straddleNow <= straddleThen * (1 - STRADDLE_FALL)
  const atmCeChg = chgPct(oi.ce, atmK)
  const atmPeChg = chgPct(oi.pe, atmK)
  const atmWritten = atmCeChg != null && atmPeChg != null && atmCeChg >= WALL_BAR && atmPeChg >= WALL_BAR
  // The walls 15 minutes ago, read with the spot then.
  const spotThen = valueAt(oi.spot, nowMs - 15 * MIN)?.close
  const wallsThen = spotThen > 0 ? wallsAt(oi, oiRows(oi, nowMs - 15 * MIN), spotThen) : null
  const early = bars.slice(0, -10) // the session before the last 10 minutes (bars >= 15, so 5+ minutes)
  const last3 = bars.slice(-3)
  const last10 = bars.slice(-10)

  for (const dir of [1, -1]) {
    const rejection = dir > 0 ? last.close > last.open : last.close < last.open
    // 8. ATM straddle decay - the range regime: the ATM CE + PE premium is under its session average and down 0.5%+
    //    in 10 minutes while CE AND PE OI are both being written at the ATM strike (1-strike bar: +0.5% in 15m). The
    //    price runs to an edge - the put wall below for a long, the call wall above for a short - and turns back off
    //    it; faded toward the middle of the walls. Unlike #102 the wall's own OI need not grow: the regime does it.
    const edge = dir > 0 ? support : resistance
    const tol = 0.5 * step
    const atEdge = edge != null && (dir > 0 ? last.low <= edge + tol && spotNow > edge : last.high >= edge - tol && spotNow < edge)
    if (decaying && atmWritten && atEdge && rejection && support != null && resistance != null && resistance - support >= 2 * step) {
      const mid = (support + resistance) / 2
      const stopPts = Math.max(1.2 * atr, Math.abs(spotNow - edge) + 0.8 * atr)
      const targetPts = dir * (mid - spotNow)
      if (targetPts >= stopPts) {
        push('spotStraddleFade', dir, stopPts, targetPts, 45, {
          OI: `ATM ${atmK} straddle ${straddleNow.toFixed(1)} under the session average ${straddleAvg.toFixed(1)}, ${pct(straddleNow / straddleThen - 1)} in 10m; ATM CE ${pct(atmCeChg)} / PE ${pct(atmPeChg)} in 15m (both written); turned at the ${dir > 0 ? 'put' : 'call'} wall ${edge}, target the middle ${mid}`,
        })
      }
    }

    // 9. Writer migration: the biggest put wall (a long) steps UP one strike in 15 minutes - or the biggest call
    //    wall (a short) steps DOWN one - the new wall's OI grew 0.5%+ in 15m, the price followed half a strike or
    //    more, sits on the trade's side of the new wall (within 2 strikes) and the last candle goes with it.
    const wallNow = dir > 0 ? support : resistance
    const wallWas = wallsThen == null ? null : dir > 0 ? wallsThen.support : wallsThen.resistance
    const shifted = wallNow != null && wallWas != null && Math.abs(wallNow - wallWas - dir * step) < 1e-6
    const newWallChg = wallNow == null ? null : chgPct(dir > 0 ? oi.pe : oi.ce, wallNow)
    const off = wallNow == null ? null : dir * (spotNow - wallNow)
    if (shifted && newWallChg != null && newWallChg >= WALL_BAR && dir * (spotNow - spotThen) >= 0.5 * step
      && off > 0 && off <= 2 * step && rejection) {
      const stopPts = Math.max(1.2 * atr, off + 0.8 * atr)
      push('spotWallShift', dir, stopPts, 2 * stopPts, 45, {
        OI: `the ${dir > 0 ? 'put' : 'call'} wall moved ${wallWas} -> ${wallNow} in 15m (its OI ${pct(newWallChg)}); spot ${spotThen.toFixed(1)} -> ${spotNow.toFixed(1)}`,
      })
    }

    // 10. Premium divergence: the spot makes a new session high (a short) in the last 3 minutes, above the high set
    //    before the last 10, and closes at or above the close of that earlier high - but the ATM call's premium is
    //    NOT above what the same strike was at then (the calls are not paying for the new high), the call writers at
    //    ATM and the strike above are not covering (OI not falling in 15m) and the last candle turns down. Mirror
    //    for a new low, the ATM put's premium, the put writers at ATM and the strike below, a candle turning up.
    if (early.length >= 5) {
      const ext = (list) => (dir > 0 ? Math.min(...list.map((b) => b.low)) : Math.max(...list.map((b) => b.high)))
      const prior = early.reduce((a, b) => (dir > 0 ? (b.low < a.low ? b : a) : (b.high > a.high ? b : a)))
      const priorExt = dir > 0 ? prior.low : prior.high
      const newExt = ext(last3)
      const made = dir * (priorExt - newExt) > 0 && dir * (ext(last10) - newExt) >= 0
      const side = dir > 0 ? 'PE' : 'CE'
      const premNow = premiumAt(oi, side, atmK, nowMs)
      const premThen = premiumAt(oi, side, atmK, prior.t + MIN)
      const writersKs = [atmK, atmK - dir * step]
      const wMap = dir > 0 ? oi.pe : oi.ce
      const wNow = writersKs.map((k) => oiOf(wMap, k, nowMs))
      const wThen = writersKs.map((k) => oiOf(wMap, k, nowMs - 15 * MIN))
      const holding = wNow.every((v) => v != null) && wThen.every((v) => v > 0) ? wNow[0] + wNow[1] >= wThen[0] + wThen[1] : false
      if (made && dir * (prior.close - spotNow) >= 0 && premNow != null && premThen != null && premNow <= premThen && holding && rejection) {
        const stopPts = Math.max(1.2 * atr, dir * (spotNow - newExt) + 0.5 * atr)
        push('spotPremDiverge', dir, stopPts, 2 * stopPts, 45, {
          OI: `new session ${dir > 0 ? 'low' : 'high'} ${newExt.toFixed(1)} past ${priorExt.toFixed(1)}, but the ATM ${atmK} ${side} premium ${premNow.toFixed(1)} is not above its ${premThen.toFixed(1)} then; ${side} OI at ${writersKs.join(' / ')} not falling`,
        })
      }
    }
  }

  // ---- the day's own spot profile (#111 - #113) ----
  // Built here from the spot minutes that finished 15+ minutes ago (spotProfile - time at price; no server profile, no
  // futures): its thin areas between two nodes (LVNs: price passed there fast, it was not accepted) and its volume nodes -
  // the POC and the other high-time peaks - which price runs to across a thin area and where it can be refused.
  const profile = spotProfile(bars, step)
  const poc = profile?.poc ?? null
  const zones = profile?.lvns ?? []
  const nodes = profile?.nodes ?? []
  // The nearest node in the trade's direction at least `minAway` beyond `from`.
  const nodeAhead = (dir, from, minAway = 0) => nodes.filter((x) => dir * (x - from) > minAway).sort((a, b) => dir * (a - b))[0] ?? null
  const recent3 = bars.slice(-3)
  const lean = read.lean // > 0: puts written over calls near the money (support) - < 0: calls (resistance)
  const fmt = (v) => (+v.toFixed(1)).toString()
  // Where a trade is headed: the node, or 3x the stop when the node is farther (then it is only the direction).
  const aim = (node, room, stopPts) => (node == null ? 'no node ahead - 2x the stop' : room > 3 * stopPts ? `toward ${fmt(node)} (target 3x the stop)` : `${fmt(node)} (target)`)

  for (const dir of poc != null ? [1, -1] : []) {
    const score = sideScore(dir, sides.ceD, sides.peD)
    const notAgainst = score != null && score >= 0 && Number.isFinite(lean) && dir * lean >= 0
    const rejection = dir > 0 ? last.close > last.open : last.close < last.open
    const extreme = dir > 0 ? Math.min(...recent3.map((b) => b.low)) : Math.max(...recent3.map((b) => b.high))

    for (const z of zones) {
      // 11. LVN refused: price came to a thin area from at least 2 ATR away on the trade's side (from above for a long)
      //     in the last 30 minutes, reached into it in the last 3 minutes, never CLOSED past its middle (not accepted),
      //     and the last candle turns back out of it - a close beyond its near edge, 0.3 ATR off the touch. The option
      //     writers lean the trade's way (puts written under a long) and the two sides are not against it. Stop beyond
      //     the touch; target the volume node it came from (room 1.2R+, at most 3R).
      const near = dir > 0 ? z.high : z.low
      const came = bars.slice(-30, -3).some((b) => dir * (b.close - near) >= 2 * atr)
      const reached = dir * (extreme - near) <= 0
      const notAccepted = recent3.every((b) => dir * (b.close - z.mid) > 0)
      const turned = rejection && dir * (spotNow - near) > 0 && dir * (spotNow - extreme) >= 0.3 * atr
      if (came && reached && notAccepted && turned && notAgainst) {
        const stopPts = Math.max(1.2 * atr, dir * (spotNow - extreme) + 0.5 * atr)
        const node = nodeAhead(dir, spotNow, 0.25 * stopPts)
        const room = node != null ? dir * (node - spotNow) : null
        if (room == null || room >= 1.2 * stopPts) {
          push('spotLvnReject', dir, stopPts, Math.min(room ?? 2 * stopPts, 3 * stopPts), 45, {
            Profile: `refused at the LVN ${fmt(z.lvn)} of today's spot profile (thin ${fmt(z.low)} - ${fmt(z.high)}; touched ${fmt(extreme)}, came from ${dir > 0 ? 'above' : 'below'}); back to the volume node it came from: ${aim(node, room, stopPts)}`,
            OI: `writers lean ${dir > 0 ? 'PUT' : 'CALL'} ${pct(Math.abs(lean))} near the money; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)} in 15m`,
          })
        }
      }

      // 12. LVN filled fast: price was outside a thin area in the last 5 minutes (below it for a long) and runs into it
      //     fast - the last candle with the trade, a body of 1 ATR+, 1.5 ATR+ covered in those minutes, closing inside the
      //     area 0.5 ATR+ past its near edge. Thin areas are crossed quickly: target the next node beyond it (the POC where
      //     it is the next - it can be refused there, so the trade is banked at it), room 1.2R+, at most 3R. The two sides
      //     not against it, and no GROWING OI wall in the way before the node. Stop back outside the area's near edge.
      const edgeIn = dir > 0 ? z.low : z.high
      const before = bars.slice(-6, -1)
      const wasOutside = before.some((b) => dir * (b.close - edgeIn) < 0)
      const startPx = dir > 0 ? Math.min(...before.map((b) => b.low)) : Math.max(...before.map((b) => b.high))
      const inside = dir * (spotNow - edgeIn) >= 0.5 * atr && dir * (spotNow - (dir > 0 ? z.high : z.low)) <= 0
      const fast = dir * (spotNow - startPx) >= 1.5 * atr && dir * (last.close - last.open) >= atr && inside
      if (wasOutside && fast && score != null && score >= 0) {
        const stopPts = Math.max(1.2 * atr, dir * (spotNow - edgeIn) + 0.5 * atr)
        const node = nodeAhead(dir, dir > 0 ? z.high : z.low)
        const room = node != null ? dir * (node - spotNow) : null
        const wall = dir > 0 ? resistance : support
        const wallChg = wall == null ? null : wallOiChanges(oi, dir > 0 ? { resistanceAhead: wall, supportAhead: null } : { resistanceAhead: null, supportAhead: wall }, nowMs, 15)[dir > 0 ? 'resChg' : 'supChg']
        const wallInWay = wall != null && room != null && dir * (wall - spotNow) > 0 && dir * (wall - node) < 0 && wallChg != null && wallChg >= WALL_BAR
        if (room != null && room >= 1.2 * stopPts && !wallInWay) {
          push('spotLvnFill', dir, stopPts, Math.min(room, 3 * stopPts), 30, {
            Profile: `filling the LVN ${fmt(z.lvn)} of today's spot profile (thin ${fmt(z.low)} - ${fmt(z.high)}) fast: ${fmt(dir * (spotNow - startPx))} pts in 5 min, ${fmt(dir * (spotNow - edgeIn))} into it; across to the next node ${aim(node, room, stopPts)}${node === poc ? ' - the POC: it can be refused there' : ''}`,
            OI: `CE ${pct(sides.ceD)} / PE ${pct(sides.peD)} in 15m${wall != null ? `; the ${dir > 0 ? 'call' : 'put'} wall ${wall} OI ${pct(wallChg)}` : ''}`,
          })
        }
      }
    }

    // 13. POC rejection after a fast run: price ran at the day's own POC from 2 ATR+ away in the last 15 minutes (up
    //     into it for a short), reached it in the last 3 minutes without a close past it (not accepted), and the last
    //     candle turns back, 0.3 ATR off the touch. The writers at the POC strike are holding there (calls at the strike
    //     over the POC for a short: OI not falling in 15m) and the two sides are not against it. Stop beyond the touch;
    //     target back toward where it came from - the next volume node, room 1.2R+, at most 3R (2R with none).
    if (poc != null) {
      const band = Math.max(0.15 * atr, spotNow * 0.0001)
      // Came from the trade's side, 2 ATR+ away (from below for a short - it ran UP into the POC), in the last 15 minutes.
      const ranIn = bars.slice(-15, -3).some((b) => dir * (b.close - poc) >= 2 * atr)
      const touched = dir > 0 ? extreme <= poc + band : extreme >= poc - band
      const heldOff = recent3.every((b) => dir * (b.close - poc) >= -band)
      const writerK = dir > 0 ? Math.floor(poc / step) * step : Math.ceil(poc / step) * step
      const writersChg = chgPct(dir > 0 ? oi.pe : oi.ce, writerK)
      const turned = rejection && dir * (spotNow - extreme) >= 0.3 * atr && dir * (spotNow - poc) > -band
      if (ranIn && touched && heldOff && turned && writersChg != null && writersChg >= 0 && score != null && score >= 0) {
        const stopPts = Math.max(1.2 * atr, dir * (spotNow - extreme) + 0.5 * atr)
        const node = nodeAhead(dir, spotNow, 0.25 * stopPts)
        const room = node != null ? dir * (node - spotNow) : null
        if (room == null || room >= 1.2 * stopPts) {
          push('spotPocReject', dir, stopPts, Math.min(room ?? 2 * stopPts, 3 * stopPts), 45, {
            Profile: `refused at today's spot POC ${fmt(poc)} after a fast run ${dir < 0 ? 'up' : 'down'} into it (touched ${fmt(extreme)}); back the way it came: ${aim(node, room, stopPts)}`,
            OI: `${dir > 0 ? 'puts' : 'calls'} at ${writerK} ${pct(writersChg)} in 15m (holding); CE ${pct(sides.ceD)} / PE ${pct(sides.peD)}`,
          })
        }
      }
    }
  }

  // 15. ADAPTIVE - read the day, then play it. Everything from finished minutes and OI points only.
  //   The day: the opening (09:15 - 09:29 as three 5-minute candles: their range and whether they drove one way), the
  //   price against that range, the session VWAP and EMA 9 / 21; the option chain - the total CE vs PE added since the
  //   open (the whole chain's lean), CE / PE at ATM +/- 2 strikes on 15 minutes, the support (PE) vs resistance (CE) OI on
  //   the 3 strikes each side (balanced = a range), the walls' writers growing or leaving; RSI for stretch and momentum;
  //   the previous day's high / low for a liquidity sweep.
  //   - TREND (BUY the option): the opening range broken with the price beyond VWAP and EMA 9 over 21 (under, short), the
  //     opening candles not against it, writers on the trade's side since the open, RSI with it but not exhausted; 2+ of:
  //     ATM +/- 2 CE / PE with it, the wall ahead's writers leaving, the S/R OI in its favour, the option to buy above its
  //     own EMA 9 (its buyers already in). Entered on the range break or on a pullback to EMA 9 that resumes.
  //   - RANGE (SELL the option): the OI not one-sided since the open, support and resistance OI balanced, neither wall's
  //     writers leaving, the price crossing VWAP back and forth; it fades the wall it touched - RSI stretched and turning,
  //     a candle back off the wall, room back to VWAP (the target).
  //   - SWEEP (BUY the turn): the previous day's high (low) taken out for the first time today in the last 10 minutes and
  //     the price back under (over) it, RSI rolling over from a high (up from a low), back across EMA 9, the OI defending
  //     the level or ATM +/- 2 turning with the trade.
  //   At most 5 signals a day (maxPerDay - the cooldown layer counts them, the same live and in the tuning).
  if (bars.length >= 22) {
    const minuteNow = istMinute(nowMs)
    const closes = bars.map((b) => b.close)
    const ema9s = emaSeries(closes, 9)
    const ema21s = emaSeries(closes, 21)
    const rsis = rsiSeries(closes, 14)
    const vwaps = vwapSeries(bars)
    const ema9 = ema9s.at(-1)
    const ema21 = ema21s.at(-1)
    const rsi = rsis.at(-1)
    const rsiPrev = rsis.at(-2)
    const vwap = vwaps.at(-1)
    const opening = openingOf(bars)
    const nearRead = optionOiRead(oi, spotNow, nowMs, 15, 2)
    const nearSides = sideOiChanges(nearRead, false)
    const atWalls = wallOiChanges(oi, { resistanceAhead: resistance, supportAhead: support }, nowMs, 15) // the walls the price sits between
    const aheadWalls = wallOiChanges(oi, ahead, nowMs, 15)
    const ladder = ladderAt(nowMs)
    const leanOpen = Number.isFinite(read.leanOpen) ? read.leanOpen : null
    const balanced = ladder != null && ladder >= ADAPTIVE_BALANCE[0] && ladder <= ADAPTIVE_BALANCE[1]
    // How often the price crossed VWAP in the last hour (each minute's close against that minute's VWAP).
    let crosses = 0
    for (let i = Math.max(1, bars.length - 60); i < bars.length; i++) if (Math.sign(closes[i] - vwaps[i]) * Math.sign(closes[i - 1] - vwaps[i - 1]) < 0) crosses++
    const f1 = (v) => (v == null ? '-' : Number(v).toFixed(1))
    const dayLine = (type) => `${type}; opening ${opening ? `${f1(opening.low)}-${f1(opening.high)}, 5-min candles ${opening.ups} up / ${opening.downs} down${opening.drive ? ` (a drive ${opening.drive > 0 ? 'up' : 'down'})` : ''}` : 'not complete'}; VWAP ${f1(vwap)} (crossed ${crosses}x in the last hour)${prevDay ? `; yesterday ${f1(prevDay.low)}-${f1(prevDay.high)}, close ${f1(prevDay.close)}` : ''}`
    const oiLine = () => `since the open CE ${pct(read.ceNow > 0 ? read.ceOpen / read.ceNow : null)} / PE ${pct(read.peNow > 0 ? read.peOpen / read.peNow : null)} (lean ${leanOpen == null ? '-' : leanOpen.toFixed(2)}); ATM +/- 2 on 15m CE ${pct(nearSides.ceD)} / PE ${pct(nearSides.peD)}; S/R OI ${ladder == null ? '-' : `${ladder.toFixed(2)}x`}${balanced ? ' (balanced)' : ''}; put wall ${support ?? '-'} ${pct(atWalls.supChg)} / call wall ${resistance ?? '-'} ${pct(atWalls.resChg)} on 15m`
    const indLine = () => `EMA 9 ${f1(ema9)} / 21 ${f1(ema21)}; RSI ${rsi == null ? '-' : rsi.toFixed(1)}; VWAP ${f1(vwap)}`
    const lastIsWith = (dir) => (dir > 0 ? last.close > last.open : last.close < last.open)
    // The option a trend trade buys (the call for a long), at the ATM strike: its last 20 minutes' premiums, read like the
    // OI (each at its minute's end), against their own EMA 9.
    const premiumWith = (dir) => {
      const side = dir > 0 ? 'CE' : 'PE'
      const xs = bars.slice(-20).map((b) => premiumAt(oi, side, atmK, b.t + MIN)).filter((v) => v != null)
      const e = emaSeries(xs, 9).at(-1)
      return xs.length >= 12 && e != null ? { now: xs.at(-1), ema: e, above: xs.at(-1) > e } : null
    }

    if (ema9 != null && ema21 != null && rsi != null && rsiPrev != null && opening) {
      for (const dir of [1, -1]) {
        // ---- TREND: buy the option ----
        const orEdge = dir > 0 ? opening.high : opening.low
        const beyondOr = dir * (spotNow - orEdge) > 0.1 * atr
        const trendDay = beyondOr && dir * (spotNow - vwap) > 0 && dir * (ema9 - ema21) > 0
        const writersWith = leanOpen != null && dir * leanOpen >= ADAPTIVE_LEAN
        const rsiMomentum = dir > 0 ? rsi >= 52 && rsi <= 75 : rsi >= 25 && rsi <= 48
        const brokeNow = prev && dir * (prev.close - orEdge) <= 0.1 * atr && beyondOr
        const touchedEma = bars.slice(-6, -1).some((b, i) => { const e = ema9s[bars.length - 6 + i]; return e != null && (dir > 0 ? b.low <= e : b.high >= e) })
        const resumed = prev && lastIsWith(dir) && dir * (spotNow - (dir > 0 ? prev.high : prev.low)) > 0
        const trigger = brokeNow ? 'broke the opening range' : touchedEma && resumed ? 'pulled back to EMA 9 and resumed' : null
        if (minuteNow <= 13 * 60 + 30 && trendDay && opening.drive !== -dir && writersWith && rsiMomentum && trigger) {
          const prem = premiumWith(dir)
          const confirm = [
            sideScore(dir, nearSides.ceD, nearSides.peD) >= 1 ? 'ATM +/- 2 CE / PE with it' : null,
            (dir > 0 ? aheadWalls.resChg : aheadWalls.supChg) != null && (dir > 0 ? aheadWalls.resChg : aheadWalls.supChg) <= -WALL_BAR ? `the ${dir > 0 ? 'call' : 'put'} wall ahead's writers leaving` : null,
            ladder != null && (dir > 0 ? ladder >= 1.15 : ladder <= 1 / 1.15) ? `${dir > 0 ? 'support' : 'resistance'} OI outweighs the other side` : null,
            prem?.above ? `the ATM ${dir > 0 ? 'call' : 'put'} above its EMA 9 (${f1(prem.now)} vs ${f1(prem.ema)})` : null,
          ].filter(Boolean)
          if (confirm.length >= 2) {
            const swing = dir > 0 ? Math.min(...bars.slice(-6).map((b) => b.low)) : Math.max(...bars.slice(-6).map((b) => b.high))
            const stopPts = Math.min(3 * atr, Math.max(1.0 * atr, dir * (spotNow - swing) + 0.3 * atr))
            push('spotAdaptive', dir, stopPts, 2 * stopPts, 60, {
              Day: dayLine(dir > 0 ? 'TREND up' : 'TREND down'), OI: oiLine(), Indicators: indLine(),
              Plan: `BUY the ${dir > 0 ? 'call' : 'put'} - ${trigger}; ${confirm.join(', ')}`,
            }, { optLeg: 'buy', mode: 'trend' })
          }
        }

        // ---- RANGE: sell the option at the wall it fades ----
        const wall = dir > 0 ? support : resistance // the wall a long bounces off - the put wall under the price
        const rangeDay = leanOpen != null && Math.abs(leanOpen) < ADAPTIVE_LEAN && balanced
          && atWalls.supChg != null && atWalls.resChg != null && atWalls.supChg > -WALL_BAR && atWalls.resChg > -WALL_BAR && crosses >= 2
        if (minuteNow >= 10 * 60 && minuteNow <= 14 * 60 + 15 && rangeDay && wall != null) {
          const touched = bars.slice(-3).some((b) => (dir > 0 ? b.low <= wall + 0.35 * atr : b.high >= wall - 0.35 * atr)) && dir * (spotNow - wall) > 0
          const stretched = (dir > 0 ? Math.min(...rsis.slice(-4)) <= 35 : Math.max(...rsis.slice(-4)) >= 65) && dir * (rsi - rsiPrev) > 0
          const room = dir * (vwap - spotNow)
          const stopPts = Math.max(1.0 * atr, dir * (spotNow - wall) + 0.5 * atr)
          if (touched && stretched && lastIsWith(dir) && room >= 0.6 * atr && room >= 0.8 * stopPts && sideScore(dir, nearSides.ceD, nearSides.peD) >= 0) {
            push('spotAdaptive', dir, stopPts, room, 45, {
              Day: dayLine('RANGE'), OI: oiLine(), Indicators: indLine(),
              Plan: `SELL the ${dir > 0 ? 'put' : 'call'} - faded the ${dir > 0 ? 'put' : 'call'} wall ${wall} with RSI ${dir > 0 ? 'up from' : 'down from'} ${dir > 0 ? 'oversold' : 'overbought'}; target VWAP ${f1(vwap)}`,
            }, { optLeg: 'sell', mode: 'range' })
          }
        }

        // ---- SWEEP of the previous day's high / low: buy the turn ----
        // dir is the trade: a SHORT after yesterday's high was swept, a LONG after its low was.
        const level = prevDay ? (dir < 0 ? prevDay.high : prevDay.low) : null
        if (level != null && minuteNow <= 14 * 60) {
          const lastTen = bars.slice(-10)
          const before = bars.slice(0, -10)
          const swept = lastTen.some((b) => (dir < 0 ? b.high >= level + 0.05 * atr : b.low <= level - 0.05 * atr))
          const firstTime = before.length > 0 && before.every((b) => (dir < 0 ? b.high < level : b.low > level))
          const back = dir * (spotNow - level) >= 0.1 * atr && lastIsWith(dir)
          const rsiTen = rsis.slice(-10).filter((v) => v != null)
          const rsiTurned = rsiTen.length > 0 && (dir < 0 ? Math.max(...rsiTen) >= 62 && rsi <= Math.max(...rsiTen) - 8 : Math.min(...rsiTen) <= 38 && rsi >= Math.min(...rsiTen) + 8)
          const pastEma = dir * (spotNow - ema9) > 0
          const defended = (dir < 0 ? atWalls.resChg : atWalls.supChg) != null && (dir < 0 ? atWalls.resChg : atWalls.supChg) >= WALL_BAR
          const nearWith = sideScore(dir, nearSides.ceD, nearSides.peD) >= 1
          const notAgainst = leanOpen == null || dir * leanOpen > -0.2
          if (swept && firstTime && back && rsiTurned && pastEma && (defended || nearWith) && notAgainst) {
            const extreme = dir < 0 ? Math.max(...lastTen.map((b) => b.high)) : Math.min(...lastTen.map((b) => b.low))
            const stopPts = Math.max(1.0 * atr, Math.abs(extreme - spotNow) + 0.3 * atr)
            const toVwap = dir * (vwap - spotNow)
            push('spotAdaptive', dir, stopPts, Math.min(3 * stopPts, Math.max(2 * stopPts, toVwap)), 60, {
              Day: dayLine(`SWEEP of yesterday's ${dir < 0 ? 'high' : 'low'} ${f1(level)}`), OI: oiLine(), Indicators: indLine(),
              Plan: `BUY the ${dir > 0 ? 'call' : 'put'} - took yesterday's ${dir < 0 ? 'high' : 'low'} out to ${f1(extreme)} and came back; ${defended ? `the ${dir < 0 ? 'call' : 'put'} wall's writers adding` : 'ATM +/- 2 CE / PE turning with it'}; RSI ${dir < 0 ? 'rolled over' : 'turned up'}, back ${dir < 0 ? 'under' : 'over'} EMA 9`,
            }, { optLeg: 'buy', mode: 'sweep' })
          }
        }
      }
    }
  }

  // The trade filters (sides, entry window, stop / target size, time stop, trailing, OI filters) - defaults change nothing.
  return out.map((s) => applyTradeFilter(s, strategyFilters(s.id, filters?.[s.id]))).filter(Boolean)
}

/**
 * Every spot setup of every minute of a day (from 15 minutes after the first candle): `bars` - spotBarsOf the day's
 * 1-minute candles, `oi` - the replay context (live: false). The tuning dedupes after its own filters, like the futures'.
 */
export function scanSpotDay({ bars, oi, filters = {}, until = null, prevDay = null }) {
  if (!bars?.length || !oi) return []
  const found = []
  const first = bars[0].t + 15 * MIN
  const end = (until ?? bars.at(-1).t + MIN)
  let done = 0 // bars finished by the clock
  for (let clock = first; clock <= end; clock += MIN) {
    while (done < bars.length && bars[done].t + MIN <= clock) done++
    found.push(...evaluateSpotStrategies({ nowMs: clock, bars: bars.slice(0, done), oi, filters, prevDay }))
  }
  return found
}
