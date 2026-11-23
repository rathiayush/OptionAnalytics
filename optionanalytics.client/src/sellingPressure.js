// SELLING PRESSURE AT THE LOWS (and buying pressure at the highs) - the Order Flow page's "Pressure at the lows" card
// (asked for - "compare selling pressure relative to total traded volume, then compare the price response, and when the
// subsequent low has weaker normalised selling pressure and claims back the previous low, interest is on the buying side").
//
// Effort vs result (Wyckoff) read from the futures' own aggressor volume:
//   - NORMALISED SELLING PRESSURE of a push into a swing low = the aggressor SELL volume of the leg / ALL the volume traded
//     in it (0 - 1) - the share of the trading that was sellers hitting bids, so a busy and a quiet leg compare;
//   - PRICE RESPONSE = how far the leg fell (points from its high to the low) and how far per unit sold;
//   - BUYING INTEREST (bullish) = a LATER swing low at or under the one before (within a tenth of a usual candle) pushed
//     by WEAKER normalised selling (`weaker` share points less), and price then CLOSES back above the earlier low (it
//     "claims it back") within `reclaimWithin` candles - the sellers could not keep the new low. SELLING INTEREST
//     (bearish) is the mirror at the highs: a later high at or over the one before on weaker normalised BUYING, then a
//     close back under the earlier high.
// Each signal is CONFIRMED once a later candle closes past the swing between the two lows (highs), FAILED once one trades
// past the later low (high) - the first of them, never changed after.
//
// NO LOOK-AHEAD: a swing is a candle whose low is under the `pivot` candles before it and not over the `pivot` after it,
// known only `pivot` candles later; a signal is dated the candle where the swing is known AND the earlier low is
// claimed back. Only COMPLETED candles count (live, the forming one is left out). A cut at any clock = the whole day's up
// to it. Pure - a read; it feeds no strategy, alert or order.

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

export const PRESSURE_TIMEFRAMES = [1, 3, 5, 15]
export const PRESSURE_DEFAULTS = {
  minutes: 5,
  pivot: 2,          // candles each side of a swing
  weaker: 0.05,      // the later push's pressure at least 5 share points under the earlier one's
  reclaimWithin: 6,  // candles after the later swing to claim the earlier one back
  maxApart: 40,      // candles between the two swings at most
  equalShare: 0.1,   // "at or under": within a tenth of a usual candle's range
}

/** The futures' minute bars ([{ time, open, high, low, close, buy, sell, estimated }]) as `minutes`-minute candles from
 *  their buckets, only those COMPLETED by `clockMs` (null = all). */
export function pressureCandles(minuteBars, minutes = PRESSURE_DEFAULTS.minutes, clockMs = null) {
  const size = Math.max(1, Math.round(minutes)) * MIN
  const out = []
  for (const b of minuteBars ?? []) {
    const ms = msOf(b?.time)
    if (!Number.isFinite(ms) || !(b.open > 0) || !(b.high >= b.low)) continue
    const start = Math.floor(ms / size) * size
    let c = out.at(-1)
    if (!c || c.time !== start) out.push(c = { time: start, open: b.open, high: b.high, low: b.low, close: b.close, buy: 0, sell: 0, estimated: false })
    c.high = Math.max(c.high, b.high)
    c.low = Math.min(c.low, b.low)
    c.close = b.close
    c.buy += b.buy ?? 0
    c.sell += b.sell ?? 0
    if (b.estimated) c.estimated = true
  }
  return clockMs == null ? out : out.filter((c) => c.time + size <= clockMs)
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0
}

/** The swing lows / highs of `candles`: [{ kind: 'low' | 'high', index, price, knownAt }] in the order they are KNOWN. */
export function pressureSwings(candles, pivot = PRESSURE_DEFAULTS.pivot) {
  const out = []
  for (let i = pivot; i + pivot < candles.length; i++) {
    const c = candles[i]
    let low = true, high = true
    for (let k = 1; k <= pivot; k++) {
      if (!(c.low < candles[i - k].low) || c.low > candles[i + k].low) low = false
      if (!(c.high > candles[i - k].high) || c.high < candles[i + k].high) high = false
    }
    if (low) out.push({ kind: 'low', index: i, price: c.low, knownAt: i + pivot })
    if (high) out.push({ kind: 'high', index: i, price: c.high, knownAt: i + pivot })
  }
  return out.sort((a, b) => a.knownAt - b.knownAt || a.index - b.index)
}

/** The push into a swing: from the opposite extreme since the swing of the same kind before (or the day's start) to it.
 *  { from, pressure (the side's aggressor share of all the volume), side, total, move (points), perUnit (points per unit
 *  of the side's volume) }. */
export function legInto(candles, swing, prevIndex = -1) {
  const low = swing.kind === 'low'
  let from = Math.max(0, prevIndex + 1)
  for (let k = from; k <= swing.index; k++) if (low ? candles[k].high > candles[from].high : candles[k].low < candles[from].low) from = k
  let buy = 0, sell = 0
  for (let k = from; k <= swing.index; k++) { buy += candles[k].buy; sell += candles[k].sell }
  const total = buy + sell
  const side = low ? sell : buy
  const move = low ? candles[from].high - swing.price : swing.price - candles[from].low
  return { from, total, side, pressure: total > 0 ? side / total : null, move, perUnit: side > 0 ? move / side : null }
}

/**
 * The read of a day: `candles` (pressureCandles') -> { swings: [{ ...swing, leg }], signals: [...], usualRange }. Each
 * signal { kind: 'buying' | 'selling', at (candle index it is known at), time, first / second (the two swings with their
 * legs), level (the earlier swing's price - claimed back), drop (share points weaker), status 'pending' | 'confirmed' |
 * 'failed', statusAt, text }.
 */
export function pressureRead(candles, options = {}) {
  const o = { ...PRESSURE_DEFAULTS, ...options }
  const list = candles ?? []
  const usualRange = median(list.map((c) => c.high - c.low))
  const tol = o.equalShare * usualRange
  const swings = []
  const last = { low: null, high: null }
  for (const s of pressureSwings(list, o.pivot)) {
    const prev = last[s.kind]
    const withLeg = { ...s, leg: legInto(list, s, prev?.index ?? -1) }
    swings.push(withLeg)
    last[s.kind] = withLeg
  }
  const signals = []
  const byKind = { low: swings.filter((s) => s.kind === 'low'), high: swings.filter((s) => s.kind === 'high') }
  for (const kind of ['low', 'high']) {
    const low = kind === 'low'
    const xs = byKind[kind]
    for (let n = 1; n < xs.length; n++) {
      const a = xs[n - 1], b = xs[n]
      if (b.index - a.index > o.maxApart) continue
      const reached = low ? b.price <= a.price + tol : b.price >= a.price - tol
      const pa = a.leg.pressure, pb = b.leg.pressure
      if (!reached || pa == null || pb == null || !(pa - pb >= o.weaker)) continue
      // The earlier swing claimed back: the first candle after the later swing closing past it, within the window.
      let k = -1
      for (let j = b.index + 1; j < list.length && j <= b.index + o.reclaimWithin; j++) {
        if (low ? list[j].close > a.price : list[j].close < a.price) { k = j; break }
      }
      if (k < 0) continue
      const at = Math.max(k, b.knownAt)
      if (at >= list.length) continue
      // Confirmed past the swing between the two (the bounce high / the pullback low), failed past the later extreme.
      let pivotLevel = low ? -Infinity : Infinity
      for (let j = a.index + 1; j < b.index; j++) pivotLevel = low ? Math.max(pivotLevel, list[j].high) : Math.min(pivotLevel, list[j].low)
      if (!Number.isFinite(pivotLevel)) pivotLevel = low ? list[a.index].high : list[a.index].low
      let status = 'pending', statusAt = null
      for (let j = at + 1; j < list.length; j++) {
        if (low ? list[j].low < b.price : list[j].high > b.price) { status = 'failed'; statusAt = j; break }
        if (low ? list[j].close > pivotLevel : list[j].close < pivotLevel) { status = 'confirmed'; statusAt = j; break }
      }
      const drop = pa - pb
      const pct = (x) => `${Math.round(x * 100)}%`
      const word = low ? 'selling' : 'buying'
      const under = low ? a.price - b.price : b.price - a.price
      const respA = a.leg.perUnit, respB = b.leg.perUnit
      const response = respA != null && respB != null && respA > 0 ? respB / respA : null
      const text = `${low ? 'BUYING' : 'SELLING'} INTEREST - the ${low ? 'later low' : 'later high'} ${low ? 'pushed' : 'lifted'} by weaker ${word}: `
        + `${pct(pb)} of the volume (was ${pct(pa)}), ${under > 0 ? `${round(under)} pts ${low ? 'under' : 'over'}` : 'level with'} the earlier ${kind} ${round(a.price)}, `
        + `${low ? 'which was claimed back' : 'and price fell back under it'}${response != null ? ` · price moved ${round(response, 2)}x as far per unit of ${word}` : ''}`
      signals.push({
        kind: low ? 'buying' : 'selling', at, time: list[at].time, first: a, second: b, level: a.price, pivotLevel, drop, response,
        status, statusAt, text,
      })
    }
  }
  signals.sort((x, y) => x.at - y.at)
  return { swings, signals, usualRange }
}

function round(v, digits = 1) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
