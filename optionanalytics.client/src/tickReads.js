// The Tick Flow page's OWN reading of big option orders (TrueData) - the position (long build-up / short build-up / covering / unwinding), the bias for the
// index, the sweeps and the added-up summary. Written for this page alone: it shares nothing with the Dhan-based pages (TrueData and Dhan data
// are never mixed). Plain JS for the node tests.
const MIN = 60_000
const minuteOf = (t) => Math.floor(new Date(t).getTime() / MIN) * MIN

export const SWEEP_DEFAULTS = { sweepStrikes: 3, sweepMinutes: 3, lookback: 15 }

/** The read of one big minute: position and its bias for the index (+1 bullish, -1 bearish, halves for the weaker reads). */
export function readOf(isCall, side, oiChange) {
  let read
  if (side === 0) read = 'unclear'
  else if (!Number.isFinite(oiChange) || oiChange === 0) read = side > 0 ? 'bought' : 'sold'
  else if (side > 0) read = oiChange > 0 ? 'long build-up' : 'short covering'
  else read = oiChange > 0 ? 'short build-up' : 'long unwinding'
  const strength = { 'long build-up': 1, 'short build-up': 1, 'short covering': 0.5, 'long unwinding': 0.5, bought: 0.5, sold: 0.5, unclear: 0 }[read]
  // A call's long side is bullish, a put's bearish; writing / covering flips by the same rule: the sign of the option's own "long" is
  // + for a call, - for a put, and a read that is the long side's (bought, long build-up, short covering) takes it, the others take the opposite.
  const longSide = read === 'long build-up' || read === 'short covering' || read === 'bought'
  const bias = strength === 0 ? 0 : (isCall ? 1 : -1) * (longSide ? 1 : -1) * strength
  return { read, bias }
}


/** A SWEEP: the same type and direction (the bias's sign) at `strikes` or more different strikes within `minutes` of each other. */
export function markSweeps(events, strikes = SWEEP_DEFAULTS.sweepStrikes, minutes = SWEEP_DEFAULTS.sweepMinutes) {
  // Oldest first (they come so; a list that is not is read in order without being changed). Each event looks only at its neighbours within the
  // window on either side - not at every event of the day, which a busy tick stream (thousands) made a square of work on every poll.
  const sorted = events.every((e, i) => i === 0 || events[i - 1].t <= e.t) ? events : [...events].sort((a, b) => a.t - b.t)
  const reach = (minutes - 1) * MIN
  let from = 0
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]
    if (e.bias === 0) { e.sweep = false; continue }
    while (sorted[from].t < e.t - reach) from++
    const near = new Set()
    const sign = Math.sign(e.bias)
    for (let j = from; j < sorted.length && sorted[j].t <= e.t + reach; j++) {
      const f = sorted[j]
      if (f.type === e.type && Math.sign(f.bias) === sign) near.add(f.strike)
    }
    e.sweep = near.size >= strikes
  }
  return events
}

const KINDS = ['ceBought', 'peBought', 'ceWritten', 'peWritten']

/** Which of the four kinds an event is: the option's LONG side (bought, long build-up, short covering) or its short side (written ...). */
export function kindOf(e) {
  const long = e.read === 'long build-up' || e.read === 'short covering' || e.read === 'bought'
  const short = e.read === 'short build-up' || e.read === 'long unwinding' || e.read === 'sold'
  if (!long && !short) return null
  return `${e.type === 'CE' ? 'ce' : 'pe'}${long ? 'Bought' : 'Written'}`
}

/**
 * The last `lookback` minutes up to `nowMs` (the minute holding it, whole) added up: rupees and lots by kind, the bullish and bearish
 * money (value x |bias|), the NET lean ((bullish - bearish) / both) and its word, the sweeps and the biggest event.
 */
export function bigTradesSummary(events, nowMs, lookback = SWEEP_DEFAULTS.lookback) {
  const end = nowMs == null ? Infinity : minuteOf(nowMs)
  const from = end - (lookback - 1) * MIN
  const inside = (events ?? []).filter((e) => e.t >= from && e.t <= end)
  const kinds = Object.fromEntries(KINDS.map((k) => [k, { value: 0, lots: 0, qty: 0, count: 0 }]))
  let bull = 0
  let bear = 0
  let biggest = null
  let sweeps = 0
  for (const e of inside) {
    const k = kindOf(e)
    if (k) { kinds[k].value += e.value; kinds[k].lots += e.lots; kinds[k].qty += e.qty ?? 0; kinds[k].count++ }
    if (e.bias > 0) bull += e.value * e.bias
    else if (e.bias < 0) bear += e.value * -e.bias
    if (e.sweep) sweeps++
    if (!biggest || e.value > biggest.value) biggest = e
  }
  const total = bull + bear
  const net = total > 0 ? (bull - bear) / total : 0
  const lean = total === 0 ? 'none' : net >= 0.25 ? 'bullish' : net <= -0.25 ? 'bearish' : 'mixed'
  return { from, end, count: inside.length, kinds, bullValue: bull, bearValue: bear, net, lean, sweeps, biggest }
}
