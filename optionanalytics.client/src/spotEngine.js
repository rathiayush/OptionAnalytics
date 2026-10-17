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
  SPOT_STRATEGIES, SQUARE_OFF, applyTradeFilter, dayTypeAt, optionOiRead, optionTradesFor, oiRows, sideOiChanges, strategyFilters,
  valueAt, wallOiChanges, wallsAhead, wallsAt,
} from './strategyEngine.js'

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : Date.parse(t))
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440)
const FIRST_ENTRY = 9 * 60 + 30
const LAST_ENTRY = 14 * 60 + 45
const SIDE_BAR = 0.003 // a side's OI really rising / falling: 0.3% of its OI in 15 minutes (as the filters)
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

/** Whether a fast / slow EMA pair is with a trade: 'state' - the fast is on the trade's side of the slow (a trend already
 *  under way counts); 'cross' - it crossed to that side within the last `crossBars` candles; 'off' - not asked.
 *  `sign` is +1 for a series that should rise with the trade, -1 for one that should fall. */
export function emaAgrees(closes, fast, slow, mode, crossBars, sign) {
  if (mode === 'off') return { ok: true, fast: null, slow: null }
  const f = emaSeries(closes, fast)
  const sl = emaSeries(closes, slow)
  const n = closes.length
  if (!(slow > fast) || n === 0 || f[n - 1] == null || sl[n - 1] == null) return { ok: false, fast: null, slow: null }
  const diff = (i) => sign * (f[i] - sl[i])
  let ok = diff(n - 1) > 0
  if (ok && mode === 'cross') {
    ok = false
    for (let i = Math.max(0, n - 1 - crossBars); i < n - 1; i++) if (f[i] != null && sl[i] != null && diff(i) <= 0) { ok = true; break }
  }
  return { ok, fast: f[n - 1], slow: sl[n - 1] }
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
  return { date: result.profileDate ?? null, high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: bars.at(-1).close, closes: bars.map((b) => b.close) }
}

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
 * The predefined parameter blocks (PARAM_BLOCKS in strategyEngine.js) evaluated for a spot strategy: the strategy lists the
 * `blocks` it has and hands over its filter values `f`; `exits` - the index stop / target in ATR (a block not listed keeps the
 * defaults, 1.5 / 3 ATR).
 */
export function spotBlocks({ blocks = [], f, atr }) {
  const has = (b) => blocks.includes(b)
  return { exits: { stopPts: (has('exits') ? f.stopAtr : 1.5) * atr, targetPts: (has('exits') ? f.targetAtr : 3) * atr } }
}

/**
 * Every spot setup whose rules pass at `nowMs` (a whole minute). `bars` - the FINISHED spot minutes up to it (spotBarsOf,
 * start + 1 minute <= nowMs), `oi` - buildOiContext(run, expiry, { live: false }), `filters` - { [id]: overrides }. #111 -
 * #113 also read the day's own spot profile, built from those bars (spotProfile).
 * Setups have the futures setups' shape (id, name, side, t, entry, stop, target, timeStopMs, options, oiCtx, checks).
 */
export function evaluateSpotStrategies({ nowMs, bars, oi, filters = {} }) {
  if (!oi || bars.length < 15) return []
  const minute = istMinute(nowMs)
  if (minute < FIRST_ENTRY || minute > LAST_ENTRY) return []
  const last = bars.at(-1)
  const spotNow = last.close
  const rows = oiRows(oi, nowMs)
  if (!rows.length || !(valueAt(oi.spot, nowMs)?.close > 0)) return []
  const atr = Math.max(avgRange(bars), spotNow * 0.0004)
  const read = optionOiRead(oi, spotNow, nowMs, 15)
  if (!read) return []
  const { support, resistance } = wallsAt(oi, rows, spotNow)
  const ahead = wallsAhead(oi, rows, spotNow)
  const sides = sideOiChanges(read, false)
  const cum = sideOiChanges(read, true)
  const out = []
  const ctx = () => ({
    flow: read.lean, cum: read.leanOpen, futOiPct: null, futPricePct: null,
    ...wallOiChanges(oi, ahead, nowMs, 15), ...sides, ...cum, dayType: dayTypeAt(oi, bars, nowMs)?.type ?? null,
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

  // 101. THE CE / PE CROSSOVER, THEN THE SPOT'S EMA ---------------------------------------------------------------------
  // (1) The ALERT: the since-open CE - PE lines cross on the 1-minute clock - the chain's CE - PE added since the open, as a share
  // of the chain: > 0 calls written more (bearish), < 0 puts - and (2) within `armMin` minutes the spot's `emaTf`-minute EMA fast / slow
  // cross the trade's way: the entry is taken when THAT candle closes. Along with it (3) the cumulative CE / PE change with the trade,
  // (4) the S / R OI near the ATM going the trade's way over the last `wallMin` minutes (puts added and calls leaving for a long) with a
  // big net difference between the sides, and (5) the strikes right round the ATM doing the same.
  const f = strategyFilters('spotFlip', filters?.spotFlip)
  const B = spotBlocks({ blocks: BY_ID.spotFlip.blocks, f, atr })
  const leadAt = (ms) => {
    const spot = valueAt(oi.spot, ms)?.close
    const r = spot > 0 ? optionOiRead(oi, spot, ms, 15) : null
    return r && r.ceNow + r.peNow > 0 ? (r.ceOpen - r.peOpen) / (r.ceNow + r.peNow) : null
  }
  // The spot in `emaTf`-minute candles from 09:15 (a candle counts once all its minutes are in).
  const sessionStart = Math.floor(nowMs / MIN) * MIN - (minute - (9 * 60 + 15)) * MIN
  const buckets = new Map()
  for (const b of bars) {
    if (b.t < sessionStart) continue
    const k = Math.floor((b.t - sessionStart) / (f.emaTf * MIN))
    buckets.set(k, [...(buckets.get(k) ?? []), b])
  }
  const candles = [...buckets.entries()].sort((a, b) => a[0] - b[0]).filter(([, xs]) => xs.length === f.emaTf).map(([, xs]) => xs)
  const closes = candles.map((xs) => xs.at(-1).close)
  // Entries are taken only at the close of a candle: this minute is the one that just finished it.
  const candleJustClosed = candles.length > 0 && candles.at(-1).at(-1).t + MIN === nowMs
  if (candleJustClosed) {
    const read = optionOiRead(oi, spotNow, nowMs, 15)
    const cum = sideOiChanges(read, true)
    const atmK = Math.round(spotNow / oi.step) * oi.step
    const sums = (ms, n) => {
      const rs = oiRows(oi, ms).filter((r) => Math.abs(r.strike - atmK) <= n * oi.step)
      return { pe: rs.reduce((s, r) => s + (r.peOi ?? 0), 0), ce: rs.reduce((s, r) => s + (r.ceOi ?? 0), 0) }
    }
    const thenMs = nowMs - f.wallMin * MIN
    const goes = (n, dir) => {
      const now = sums(nowMs, n)
      const then = sums(thenMs, n)
      const peChg = then.pe > 0 ? (now.pe - then.pe) / then.pe : null
      const ceChg = then.ce > 0 ? (now.ce - then.ce) / then.ce : null
      // The writers of the side that holds the trade add (puts for a long), the writers against it leave (calls for a long).
      return { now, peChg, ceChg, ok: peChg != null && ceChg != null && (dir > 0 ? peChg > 0 && ceChg < 0 : ceChg > 0 && peChg < 0) }
    }
    for (const dir of [1, -1]) {
      // (2) the spot's EMA crossing the trade's way on the candle that just closed (or - emaMode state - already that way)
      const e = emaAgrees(closes, f.emaFast, f.emaSlow, f.emaMode === 'state' ? 'state' : 'cross', 1, dir)
      if (!e.ok) continue
      // (1) the since-open CE - PE lines crossed to this side on the 1-minute clock within the last armMin minutes, and still are
      const leadNow = leadAt(nowMs)
      if (leadNow == null || !(dir * leadNow < 0)) continue
      let crossedAt = null
      let after = leadNow
      for (let k = 1; k <= f.armMin; k++) {
        const before = leadAt(nowMs - k * MIN)
        if (before == null) break
        if (dir * before >= 0) { crossedAt = nowMs - (k - 1) * MIN; break }
        after = before
      }
      if (crossedAt == null) continue
      // (3) the cumulative CE / PE change since the open (the OI heatmap) not against the trade (puts rising and / or calls falling are with it)
      const cumWith = sideScore(dir, cum.ceC, cum.peC)
      // Not against it (the default): the sides are not both moving the other way - or, asked so, with it; or not asked.
      if (f.cumDelta !== 'off' && (cumWith == null || cumWith < (f.cumDelta === 'with' ? 1 : 0))) continue
      // (3b) over the last `deltaMin` minutes, the whole chain's writers on the trade's side add and the other side leaves
      if (f.deltaMin > 0) {
        const d = sideOiChanges(optionOiRead(oi, spotNow, nowMs, f.deltaMin), false)
        const going = d.ceD != null && d.peD != null && (dir > 0 ? d.peD > 0 && d.ceD < 0 : d.ceD > 0 && d.peD < 0)
        if (!going) continue
      }
      // (4) the S / R OI near the ATM +/- nearStrikes going the trade's way, with a big net difference between the sides
      const wide = goes(f.nearStrikes, dir)
      const net = wide.now.pe + wide.now.ce > 0 ? (wide.now.pe - wide.now.ce) / (wide.now.pe + wide.now.ce) : 0
      if (!wide.ok || !(dir * net > 0) || dir * net < f.netMinPct / 100) continue
      // (5) the strikes right round the ATM too
      const tight = f.atmStrikes > 0 ? goes(f.atmStrikes, dir) : null
      if (tight && !tight.ok) continue
      push('spotFlip', dir, B.exits.stopPts, B.exits.targetPts, 330, {
        Alert: `since the open the CE - PE lines crossed at ${new Date(crossedAt - MIN + 330 * MIN).toISOString().slice(11, 16)} (${pct(after)} -> ${pct(leadNow)} of the chain: ${dir > 0 ? 'puts' : 'calls'} added lead)`,
        Trend: `${f.emaTf}-min EMA ${f.emaFast} ${e.fast.toFixed(1)} ${dir > 0 ? 'over' : 'under'} EMA ${f.emaSlow} ${e.slow.toFixed(1)}${f.emaMode === 'state' ? '' : ' - crossed on the candle that just closed'}`,
        Cumulative: `since the open CE ${pct(cum.ceC)} / PE ${pct(cum.peC)}`,
        Walls: `ATM +/- ${f.nearStrikes}: over ${f.wallMin} min PE ${pct(wide.peChg)} / CE ${pct(wide.ceChg)}; PE ${(wide.now.pe / 1e5).toFixed(1)}L vs CE ${(wide.now.ce / 1e5).toFixed(1)}L - ${dir > 0 ? 'support' : 'resistance'} heavier by ${(Math.abs(net) * 100).toFixed(0)}%`,
        ...(tight ? { 'Round the ATM': `ATM +/- ${f.atmStrikes}: PE ${pct(tight.peChg)} / CE ${pct(tight.ceChg)} over ${f.wallMin} min` } : {}),
      })
    }
  }

  // The trade filters (sides, entry window, stop / target size, time stop, trailing, OI filters) - defaults change nothing.
  return out.map((s) => applyTradeFilter(s, strategyFilters(s.id, filters?.[s.id]))).filter(Boolean)
}

/**
 * Every spot setup of every minute of a day (from 15 minutes after the first candle): `bars` - spotBarsOf the day's
 * 1-minute candles, `oi` - the replay context (live: false). The tuning dedupes after its own filters, like the futures'.
 */
export function scanSpotDay({ bars, oi, filters = {}, until = null, prevDay = null, underlying = null }) {
  if (!bars?.length || !oi) return []
  const found = []
  const first = bars[0].t + 15 * MIN
  const end = (until ?? bars.at(-1).t + MIN)
  let done = 0 // bars finished by the clock
  for (let clock = first; clock <= end; clock += MIN) {
    while (done < bars.length && bars[done].t + MIN <= clock) done++
    found.push(...evaluateSpotStrategies({ nowMs: clock, bars: bars.slice(0, done), oi, filters, prevDay, underlying }))
  }
  return found
}
