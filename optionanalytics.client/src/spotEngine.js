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

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : Date.parse(t))
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440)
const SIDE_BAR = 0.003 // a side's OI really rising / falling: 0.3% of its OI in 15 minutes (as the filters)

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

/** Where the fast EMA last crossed to the trade's side of the slow one and has stayed there to the last candle: the index of that
 *  candle (the one that closed with the fast on the trade's side after the one before had it on the other), or null. */
export function emaCrossIndex(closes, fast, slow, dir) {
  const f = emaSeries(closes, fast)
  const sl = emaSeries(closes, slow)
  const n = closes.length
  if (!(slow > fast) || n < 2 || f[n - 1] == null || sl[n - 1] == null) return null
  const side = (i) => (f[i] != null && sl[i] != null ? dir * (f[i] - sl[i]) > 0 : null)
  if (!side(n - 1)) return null
  let i = n - 1
  while (i > 0 && side(i - 1)) i--
  return i > 0 && side(i - 1) === false ? i : null
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

/** Every setup of every spot strategy at `nowMs` - none at the moment (every spot strategy was removed on request). A strategy's rule goes
 *  here: read what it needs (spotBlocks gives the predefined parameter blocks it lists), push its setups, then
 *  `applyTradeFilter(setup, strategyFilters(id, filters?.[id]))` on each. */
export function evaluateSpotStrategies() {
  return []
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
