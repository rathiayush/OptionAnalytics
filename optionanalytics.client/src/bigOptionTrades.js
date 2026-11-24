// BIG OPTION TRADES from ATM ± N (asked for - "is there any way that we can identify big trades on option buy combining the data from
// ATM ± 10? see how we can create a component"; OI Replay's "Big option trades" card).
//
// WHAT CAN BE KNOWN. Dhan sends no time & sales for options - only 1-minute bars (OHLC, volume, OI) per strike. So a "big trade" here is
// a BIG MINUTE at a strike, never one print: the strike's volume that minute against what that same strike usually trades. Each is then
// read with what the bar says about who was pushing (where the close sits in the range, the move from the minute before) and what OI did:
//   price up + OI up   = LONG BUILD-UP     (buyers opened new positions)
//   price down + OI up = SHORT BUILD-UP    (writers opened)
//   price up + OI down = SHORT COVERING    (writers closing)
//   price down + OI down = LONG UNWINDING  (buyers closing)
// no OI reading = just "bought" / "sold". Direction for the INDEX: a call bought / put written is bullish, a put bought / call written
// bearish (a build-up counts 1, a covering / unwinding / unknown-OI read 0.5).
//
// COMBINING THE STRIKES: only strikes within ATM ± N of THAT minute's ATM (the spot's nearest strike, as the page's other reads) count,
// and the strikes are added up - what the money did in the last N minutes by kind (calls bought, puts bought, calls written, puts
// written - rupees = premium x volume), a net lean, and a SWEEP: the same kind and direction at `sweepStrikes` or more strikes inside
// `sweepMinutes` minutes - one decision spread over the chain, which no single strike's volume shows.
//
// Every reading uses only the bars up to its own minute (the strike's typical volume = the median of ITS earlier bars; the ATM from that
// minute's spot) - a cut at any clock equals the whole day's up to it (tests/big-option-trades.test.mjs). A read - it places nothing and
// feeds no strategy or alert.
import { barProxyDelta, spotLookup } from './optionFlow.js'

const MIN = 60_000
const minuteOf = (t) => Math.floor(new Date(t).getTime() / MIN) * MIN

export const BIG_DEFAULTS = {
  strikesEach: 10,   // ATM ± this many strikes
  multiple: 4,       // a minute at least this many times the strike's typical volume
  minLots: 20,       // and at least this many lots (a thin strike's 4x of nothing is not big)
  history: 20,       // the strike's typical volume = the median of its last this many bars with volume
  minHistory: 5,     // none before it has this many bars
  lookback: 15,      // the summary reads the last N minutes
  sweepStrikes: 3,
  sweepMinutes: 3,
}

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

function median(values) {
  const v = [...values].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Each strike's bars by minute (the larger volume where a minute came twice, the last OI seen), per option side. */
function seriesOf(points, isCall) {
  const bySeries = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !Number.isFinite(p.price)) continue
    const t = minuteOf(p.time)
    if (!Number.isFinite(t)) continue
    let s = bySeries.get(p.strike)
    if (!s) bySeries.set(p.strike, s = new Map())
    const bar = { t, strike: p.strike, isCall, close: p.price, open: p.open ?? p.price, high: p.high ?? p.price, low: p.low ?? p.price, volume: p.volume ?? 0, oi: Number.isFinite(p.oi) ? p.oi : null }
    const earlier = s.get(t)
    s.set(t, earlier ? { ...bar, volume: Math.max(bar.volume, earlier.volume), oi: bar.oi ?? earlier.oi } : bar)
  }
  return [...bySeries.entries()].map(([strike, m]) => ({ strike, bars: [...m.values()].sort((a, b) => a.t - b.t) }))
}

function strikeStep(strikes) {
  const s = [...new Set(strikes)].sort((a, b) => a - b)
  let step = Infinity
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > 0) step = Math.min(step, s[i] - s[i - 1])
  return Number.isFinite(step) ? step : 50
}

/**
 * Every big option minute in ATM ± `strikesEach`, oldest first, up to `asOfMs` (the minute holding it counts whole, as the page's other
 * option reads; none = all). `dropForming` leaves out the newest minute (live: it is still trading, its volume partial).
 * Each: { t, strike, type 'CE'|'PE', lots, ratio, value (₹), movePct, oiChange, read, bias, side, atmDistance, sweep }.
 */
export function bigOptionTrades(cePoints, pePoints, spotBars, options = {}) {
  const o = { ...BIG_DEFAULTS, ...options }
  const lotSize = o.lotSize > 0 ? o.lotSize : 1
  const all = [...seriesOf(cePoints, true), ...seriesOf(pePoints, false)]
  if (!all.length) return []
  const spotAt = spotLookup(spotBars)
  const step = o.step > 0 ? o.step : strikeStep(all.map((s) => s.strike))
  let maxT = -Infinity
  for (const s of all) for (const b of s.bars) maxT = Math.max(maxT, b.t)
  let clock = o.asOfMs == null ? Infinity : minuteOf(o.asOfMs)
  if (o.dropForming) clock = Math.min(clock, maxT - MIN)

  const events = []
  for (const { strike, bars } of all) {
    const volumes = []   // the strike's earlier bars with volume, newest last
    let prevClose = null
    let prevOi = null
    for (const b of bars) {
      if (b.t > clock) break
      const spot = spotAt(b.t)
      const atm = spot > 0 ? Math.round(spot / step) * step : null
      const typical = volumes.length >= o.minHistory ? median(volumes.slice(-o.history)) : null
      const lots = b.volume / lotSize
      if (atm != null && typical > 0 && b.volume > 0 && Math.abs(strike - atm) <= o.strikesEach * step
        && b.volume / typical >= o.multiple && lots >= o.minLots) {
        const ref = prevClose ?? b.open
        const score = b.volume > 0 ? barProxyDelta(b) / b.volume : 0
        const dir = Math.sign(b.close - ref)
        const side = score > 0.2 ? 1 : score < -0.2 ? -1 : dir
        const oiChange = b.oi != null && prevOi != null ? b.oi - prevOi : null
        const { read, bias } = readOf(b.isCall, side, oiChange)
        events.push({
          t: b.t, strike, type: b.isCall ? 'CE' : 'PE', lots, ratio: b.volume / typical, value: b.close * b.volume,
          movePct: ref > 0 ? ((b.close - ref) / ref) * 100 : 0, oiChange, read, bias, side,
          atmDistance: Math.round((strike - atm) / step), sweep: false,
        })
      }
      if (b.volume > 0) volumes.push(b.volume)
      prevClose = b.close
      if (b.oi != null) prevOi = b.oi
    }
  }
  events.sort((a, b) => a.t - b.t || a.strike - b.strike)
  markSweeps(events, o.sweepStrikes, o.sweepMinutes)
  return events
}

/** A SWEEP: the same type and direction (the bias's sign) at `strikes` or more different strikes within `minutes` of each other. */
export function markSweeps(events, strikes = BIG_DEFAULTS.sweepStrikes, minutes = BIG_DEFAULTS.sweepMinutes) {
  for (const e of events) {
    if (e.bias === 0) continue
    const near = new Set()
    for (const f of events) {
      if (f.type === e.type && Math.sign(f.bias) === Math.sign(e.bias) && Math.abs(f.t - e.t) <= (minutes - 1) * MIN) near.add(f.strike)
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
export function bigTradesSummary(events, nowMs, lookback = BIG_DEFAULTS.lookback) {
  const end = nowMs == null ? Infinity : minuteOf(nowMs)
  const from = end - (lookback - 1) * MIN
  const inside = (events ?? []).filter((e) => e.t >= from && e.t <= end)
  const kinds = Object.fromEntries(KINDS.map((k) => [k, { value: 0, lots: 0, count: 0 }]))
  let bull = 0
  let bear = 0
  let biggest = null
  let sweeps = 0
  for (const e of inside) {
    const k = kindOf(e)
    if (k) { kinds[k].value += e.value; kinds[k].lots += e.lots; kinds[k].count++ }
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
