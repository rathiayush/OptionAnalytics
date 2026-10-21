// Option CDV and OBV for a replayed day - the dashboard's two option-flow reads (CdvUnderlyingState on the server:
// SeedHistoricalDayStrike / BarProxyDelta for CDV, GetObvSeries for OBV), worked out from the day's own 1-minute
// option bars (the OI Replay run's cePoints / pePoints: each strike's open / high / low / close and volume) and the
// day's spot. The same formulas, so a past day reads like the dashboard reads today:
//
//  - weight: the sigmoid "auto delta" of the strike's moneyness at that minute's spot - a near-ATM contract counts for
//    close to its full volume, a far-OTM one barely (ComputeDeltaWeight);
//  - CDV: per strike and minute, buy minus sell volume estimated from where the close sits in the minute's range
//    ((close - low) - (high - close)) / (high - low) x volume (BarProxyDelta - candles carry no trade-by-trade side),
//    times the weight, summed across the side's strikes and run from the day's zero;
//  - OBV: per strike, a running sum of sign(close - previous close) x volume x weight; the strikes' running totals
//    summed at each minute (a strike with no bar that minute keeps its last total), the day rebased to its first
//    minute, then EMA(9)-smoothed (GetObvSeries).
//
// Every point uses only bars up to its own minute, so cutting the series at the replay clock never shows anything
// that had not happened yet. Live, the same works on today's bars plus each live minute (its volume from the rise of
// Dhan's cumulative day volume within the minute), recomputed as the ticks arrive.

const SMOOTH_LEN = 9

/** |delta| of a strike at `spot` - the server's ComputeDeltaWeight sigmoid. */
export function deltaWeight(strike, spot, isCall) {
  if (!(spot > 0)) return 0
  const moneyness = (strike - spot) / spot
  return isCall ? 1 / (1 + Math.exp(8.5 * moneyness)) : 1 / (1 + Math.exp(-8.5 * moneyness))
}

/** Buy minus sell volume of one 1-minute bar from where its close sits in its range (BarProxyDelta). */
export function barProxyDelta({ high, low, close, volume }) {
  const hl = high - low
  if (!(hl > 0.0001) || !(volume > 0)) return 0
  return (((close - low) - (high - close)) / hl) * volume
}

const minuteOf = (t) => Math.floor(new Date(t).getTime() / 60000) * 60000

/** EMA(len) the way Skender's GetEma seeds it (SMA of the first `len`), the raw value before that - as the server. */
export function smoothEma(values, len = SMOOTH_LEN) {
  const k = 2 / (len + 1)
  const out = []
  let ema = null
  let sum = 0
  values.forEach((v, i) => {
    if (i < len - 1) { sum += v; out.push(v); return }
    if (i === len - 1) { sum += v; ema = sum / len; out.push(ema); return }
    ema = v * k + ema * (1 - k)
    out.push(ema)
  })
  return out
}

// One bar per strike and minute. Live, the run's bars and the live minutes are passed together: a later point of the same
// strike and minute is the newer reading of it and replaces the earlier one, keeping the larger volume (the run's bar of
// the minute the page loaded in and that minute's live point each saw only part of it).
function bars(points) {
  const byKey = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !Number.isFinite(p.price)) continue
    const bar = {
      t: minuteOf(p.time), strike: p.strike, close: p.price,
      open: p.open ?? p.price, high: p.high ?? p.price, low: p.low ?? p.price, volume: p.volume ?? 0,
    }
    const key = `${bar.strike}|${bar.t}`
    const earlier = byKey.get(key)
    byKey.set(key, earlier ? { ...bar, volume: Math.max(bar.volume, earlier.volume) } : bar)
  }
  return [...byKey.values()]
}

function spotLookup(spotBars) {
  const byMinute = new Map()
  for (const b of spotBars ?? []) if (b && b.close > 0) byMinute.set(minuteOf(b.time), b.close)
  const minutes = [...byMinute.keys()].sort((a, b) => a - b)
  // The spot of a minute, else the last one before it (never a later one).
  return (t) => {
    if (byMinute.has(t)) return byMinute.get(t)
    let lo = 0, hi = minutes.length - 1, found = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (minutes[mid] <= t) { found = minutes[mid]; lo = mid + 1 } else hi = mid - 1
    }
    return found == null ? null : byMinute.get(found)
  }
}

function sideFlow(points, spotAt, isCall) {
  const all = bars(points).sort((a, b) => a.t - b.t || a.strike - b.strike)
  // CDV: increments per minute, run from zero.
  const cdvByMinute = new Map()
  // OBV: each strike's running total, carried at every minute of the side's timeline.
  const byStrike = new Map()
  for (const b of all) {
    const spot = spotAt(b.t)
    const w = spot ? deltaWeight(b.strike, spot, isCall) : 0
    cdvByMinute.set(b.t, (cdvByMinute.get(b.t) ?? 0) + barProxyDelta(b) * w)
    let s = byStrike.get(b.strike)
    if (!s) byStrike.set(b.strike, s = { prevClose: null, running: 0, byMinute: new Map() })
    if (s.prevClose != null) s.running += Math.sign(b.close - s.prevClose) * b.volume * w
    s.prevClose = b.close
    s.byMinute.set(b.t, s.running)
  }
  const timeline = [...cdvByMinute.keys()].sort((a, b) => a - b)

  let cdv = 0
  const cdvSeries = timeline.map((t) => ({ time: t, value: (cdv += cdvByMinute.get(t)) }))

  const lastKnown = new Map()
  const raw = timeline.map((t) => {
    let total = 0
    for (const [strike, s] of byStrike) {
      if (s.byMinute.has(t)) lastKnown.set(strike, s.byMinute.get(t))
      total += lastKnown.get(strike) ?? 0
    }
    return total
  })
  const base = raw[0] ?? 0
  const smoothed = smoothEma(raw.map((v) => v - base))
  const obvSeries = timeline.map((t, i) => ({ time: t, value: smoothed[i] }))
  return { cdv: cdvSeries, obv: obvSeries }
}

/** The day's option CDV and OBV, CE and PE: `{ ceCdv, peCdv, ceObv, peObv }`, each `[{ time (ms), value }]` one per
 *  minute that side had a bar. */
export function optionFlowSeries(cePoints, pePoints, spotBars) {
  const spotAt = spotLookup(spotBars)
  const ce = sideFlow(cePoints, spotAt, true)
  const pe = sideFlow(pePoints, spotAt, false)
  return { ceCdv: ce.cdv, peCdv: pe.cdv, ceObv: ce.obv, peObv: pe.obv }
}
