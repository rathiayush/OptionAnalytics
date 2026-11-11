// ABSORPTION AND EXHAUSTION BY OI ON SPOT (asked for - "can we also have absorption and exhaustion by OI on spot? On OI
// Replay, when this checkbox is ticked show, otherwise hide ... I should be able to select the timeframe on which it will
// identify"): the spot chart's candles of the picked timeframe read against the option OI built near the money in each of
// them - Wyckoff's effort vs result, with the OPTION WRITERS' OI as the effort.
//
//   ABSORPTION - heavy OI written on one side while price makes no progress: the writers soak up the other side's push.
//     Bullish: PE OI added near ATM >= `heavy` x a typical candle's OI change, more than the CE added, and the candle's body
//     (close - open) within `smallBody` x a typical candle's range - put writers absorbing the selling (support).
//     Bearish: the mirror - CE OI written into a candle that goes nowhere (call writers absorbing the buying: resistance).
//   EXHAUSTION - price runs to a new extreme with no fresh OI behind it: a move carried by covering runs out of fuel.
//     Bearish (at a high): a new high of the last `lookback` candles while no puts are written near ATM (PE change <= 0)
//     and the band's OI falls by >= `dryUp` x a typical change (positions closing - short covering, not new longs).
//     Bullish (at a low): a new low of the last `lookback` candles, no calls written, the band's OI falling.
//
// "Near ATM" = the strikes within `band` steps of the candle's close (the same strikes at both ends of the candle, so a
// strike moving into the band adds nothing by itself); a strike's OI at a candle's end = its last reading before the
// candle's end. "Typical" = the average over the candles BEFORE this one (the OI change: the larger side's |change|; the
// range: high - low), at least `minPrior` of them - so the first candles of the day read nothing. Only COMPLETED candles
// are read (live, the forming minute is left out), each from readings up to its own end: nothing after the clock, and a
// candle's read never changes as the day goes on (`tests/oi-absorption.test.mjs`). It is a read on the chart - it feeds no
// strategy and raises no alert.

const IST_SECONDS = 5.5 * 3600
const msOfChart = (t) => (t - IST_SECONDS) * 1000
const msOf = (p) => p.ms ?? new Date(p.time).getTime()

export const ABSORPTION_TIMEFRAMES = [1, 3, 5, 15]
export const ABSORPTION_DEFAULTS = { band: 2, heavy: 2, smallBody: 0.5, lookback: 10, dryUp: 0.5, minPrior: 5 }

/** The complete candles of `minutes` from 1-minute spot bars (chart seconds), the forming minute left out when live: a
 *  candle is complete once a bar at or after its last minute is in. Each with `lastBar` - the time of its last 1-minute
 *  bar (where a chart of any timeframe can mark it). */
export function completeCandles(spotBars, minutes, { live = false } = {}) {
  const bars = live ? (spotBars ?? []).slice(0, -1) : (spotBars ?? [])
  if (!bars.length) return []
  const size = Math.max(1, minutes) * 60
  const out = []
  for (const b of bars) {
    const t = Math.floor(b.time / size) * size
    const last = out[out.length - 1]
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.lastBar = b.time
    } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, lastBar: b.time })
  }
  const lastBarTime = bars[bars.length - 1].time
  return out.filter((c) => lastBarTime >= c.time + size - 60)
}

// Each strike's readings as [ms, oi] in time order, readings up to the clock.
function readings(byStrike, asOfMs) {
  const out = new Map()
  for (const [strike, points] of byStrike ?? []) {
    const list = []
    for (const p of points ?? []) {
      const ms = msOf(p)
      if (!Number.isFinite(p.openInterest) || (asOfMs != null && ms > asOfMs)) continue
      list.push([ms, p.openInterest])
    }
    list.sort((a, b) => a[0] - b[0])
    if (list.length) out.set(strike, list)
  }
  return out
}

// The OI of every strike at each candle's end (Map strike -> array by candle index; undefined before its first reading).
function oiAtEnds(read, ends) {
  const out = new Map()
  for (const [strike, list] of read) {
    const at = new Array(ends.length)
    let i = -1
    for (let k = 0; k < ends.length; k++) {
      while (i + 1 < list.length && list[i + 1][0] < ends[k]) i++
      if (i >= 0) at[k] = list[i][1]
    }
    out.set(strike, at)
  }
  return out
}

const fmtL = (v) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) / 1e5).toFixed(1)}L`

/**
 * The absorption / exhaustion reads of a day so far: [{ time (the candle's start, chart seconds), lastBar (its last
 * 1-minute bar's time), kind 'absorption' | 'exhaustion', side 'bull' | 'bear', price (the candle's low for a bullish
 * read, high for a bearish one), dCe / dPe (the band's OI change in the candle), body, typOi, typRange, text }], oldest
 * first. `spotBars`: 1-minute bars (chart seconds) up to the clock; `ceByStrike` / `peByStrike`: Map strike -> OI points
 * (`openInterest`, `ms` / `time`); `asOfMs`: the clock (no reading after it is read); `live`: the last bar is still forming.
 */
export function oiAbsorptionEvents({ spotBars, ceByStrike, peByStrike, step, timeframe = 5, asOfMs = null, live = false, ...opts } = {}) {
  const o = { ...ABSORPTION_DEFAULTS, ...opts }
  if (!(step > 0)) return []
  const candles = completeCandles(spotBars, timeframe, { live })
  if (candles.length < 2) return []
  const size = Math.max(1, timeframe) * 60
  const ends = candles.map((c) => msOfChart(c.time + size))
  const ce = oiAtEnds(readings(ceByStrike, asOfMs), ends)
  const pe = oiAtEnds(readings(peByStrike, asOfMs), ends)
  const bandChange = (atEnds, k, atm) => {
    let sum = 0
    for (const [strike, at] of atEnds) {
      if (Math.abs(strike - atm) > o.band * step + 1e-9) continue
      if (at[k] != null && at[k - 1] != null) sum += at[k] - at[k - 1]
    }
    return sum
  }
  const events = []
  let oiSum = 0, oiCount = 0
  let rangeSum = candles[0].high - candles[0].low
  for (let k = 1; k < candles.length; k++) {
    const c = candles[k]
    const atm = Math.round(c.close / step) * step
    const dCe = bandChange(ce, k, atm)
    const dPe = bandChange(pe, k, atm)
    const typOi = oiCount ? oiSum / oiCount : 0
    const typRange = rangeSum / k
    if (oiCount >= o.minPrior && typOi > 0 && typRange > 0) {
      const body = c.close - c.open
      const small = Math.abs(body) <= o.smallBody * typRange
      const heavy = o.heavy * typOi
      const from = Math.max(0, k - o.lookback)
      let hi = -Infinity, lo = Infinity
      for (let j = from; j < k; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low) }
      const dry = dCe + dPe <= -o.dryUp * typOi
      const base = { time: c.time, lastBar: c.lastBar, dCe, dPe, body, typOi, typRange }
      const oi = `CE ${fmtL(dCe)}, PE ${fmtL(dPe)} at ATM ±${o.band}`
      if (small && dPe >= heavy && dPe > Math.max(0, dCe))
        events.push({ ...base, kind: 'absorption', side: 'bull', price: c.low, text: `Bullish absorption - puts written (${oi}) while spot held (body ${body.toFixed(1)} pts)` })
      if (small && dCe >= heavy && dCe > Math.max(0, dPe))
        events.push({ ...base, kind: 'absorption', side: 'bear', price: c.high, text: `Bearish absorption - calls written (${oi}) while spot held (body ${body.toFixed(1)} pts)` })
      if (c.high > hi && dPe <= 0 && dry)
        events.push({ ...base, kind: 'exhaustion', side: 'bear', price: c.high, text: `Bearish exhaustion - new ${o.lookback}-candle high on OI closing, no puts written (${oi})` })
      if (c.low < lo && dCe <= 0 && dry)
        events.push({ ...base, kind: 'exhaustion', side: 'bull', price: c.low, text: `Bullish exhaustion - new ${o.lookback}-candle low on OI closing, no calls written (${oi})` })
    }
    oiSum += Math.max(Math.abs(dCe), Math.abs(dPe))
    oiCount++
    rangeSum += c.high - c.low
  }
  return events
}

/** The chart markers of `events` on a chart of `chartMinutes` candles (lightweight-charts' createSeriesMarkers): each at
 *  the chart candle holding its candle's last minute - green ▲ under it for a bullish read, red ▼ over it for a bearish
 *  one; ABS / EXH. Sorted by time, as the markers plugin needs. */
export function absorptionMarkers(events, chartMinutes) {
  const size = Math.max(1, chartMinutes) * 60
  return (events ?? []).map((e) => ({
    time: Math.floor(e.lastBar / size) * size,
    position: e.side === 'bull' ? 'belowBar' : 'aboveBar',
    shape: e.side === 'bull' ? 'arrowUp' : 'arrowDown',
    color: e.side === 'bull' ? (e.kind === 'absorption' ? '#26a69a' : '#7cb342') : (e.kind === 'absorption' ? '#ef5350' : '#ff9800'),
    text: e.kind === 'absorption' ? 'ABS' : 'EXH',
  })).sort((a, b) => a.time - b.time)
}
