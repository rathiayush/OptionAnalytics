// OI Replay's VOLATILITY SKEW (asked for - "add volatility skew as well in OI Replay if you think it will give some edge").
// The skew is how much more the market pays for downside protection (puts) than for upside (calls), read the way the
// option desks quote it:
//
//  - the SMILE: each strike's implied volatility from its own premium - the OUT-OF-THE-MONEY leg (a put below the forward,
//    a call above it - the liquid side, as the vol surfaces are built), Black-76 on the forward from put-call parity, the
//    time to 15:30 IST on the expiry day (gex.js' own `impliedVol` / `parityForward`, so the GEX card and this agree); an
//    IV outside 0.5 - 2x the ATM IV (a stale print) is left out, not replaced;
//  - ATM IV: at the forward itself, interpolated on the smile between the two strikes around it (no jump when the ATM
//    strike changes);
//  - 25-DELTA RISK REVERSAL (RR25) = the IV at the call with delta 0.25 minus the IV at the put with delta -0.25 (each
//    interpolated on the smile by delta), in vol points. An index's is usually NEGATIVE (puts richer). FALLING = puts
//    getting bid against calls (fear / protection buying); RISING = calls bid / puts offered (fear coming out, or a chase);
//  - 25-DELTA BUTTERFLY (BF25) = the average of the two 25-delta IVs less the ATM IV: how much the wings are priced over
//    the middle (tail risk).
//
// Every minute reads only the readings up to it (a leg's last reading within 5 minutes), so a minute's numbers never change
// and a day cut at the replay clock equals the whole day's up to it. It feeds no strategy, alert or order.

import { impliedVol, impliedYears, parityForward } from './gex.js'

const MIN = 60_000
const STALE_MINUTES = 5
const YEAR_MS = 365 * 86_400_000
const IV_BAND = [0.5, 2]

const minuteOf = (t) => Math.floor(new Date(t).getTime() / MIN) * MIN
const ivFraction = (iv) => (iv > 3 ? iv / 100 : iv)

function cdf(x) {
  // Abramowitz - Stegun 7.1.26 on erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/** Black-76 delta of a call (put = call - 1) at strike K on the forward F, sigma (fraction a year), T years. */
export function callDelta(F, K, sigma, T) {
  const v = sigma * Math.sqrt(T)
  if (!(v > 0) || !(F > 0) || !(K > 0)) return null
  return cdf((Math.log(F / K) + (v * v) / 2) / v)
}

// Each strike's readings, one a minute (a later point of the same minute is the newer reading), in time order.
function legs(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !(p.price > 0)) continue
    const t = minuteOf(p.time)
    if (!Number.isFinite(t)) continue
    let minutes = byStrike.get(p.strike)
    if (!minutes) byStrike.set(p.strike, minutes = new Map())
    const prev = minutes.get(t)
    minutes.set(t, { t, price: p.price, iv: p.impliedVolatility > 0 ? p.impliedVolatility : prev?.iv ?? null })
  }
  const out = new Map()
  for (const [strike, minutes] of byStrike) out.set(strike, [...minutes.values()].sort((a, b) => a.t - b.t))
  return out
}

function readingAt(rows, t) {
  if (!rows?.length) return null
  let lo = 0, hi = rows.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].t <= t) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (found < 0) return null
  return t - rows[found].t <= STALE_MINUTES * MIN ? rows[found] : null
}

// The IV at `target` delta, interpolated between the two smile points around it (`points` [{ delta, iv }]); null when the
// smile does not reach it.
function ivAtDelta(points, target) {
  const sorted = [...points].sort((a, b) => a.delta - b.delta)
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i]
    if (a.delta <= target && b.delta >= target) {
      if (b.delta === a.delta) return (a.iv + b.iv) / 2
      return a.iv + ((target - a.delta) / (b.delta - a.delta)) * (b.iv - a.iv)
    }
  }
  return null
}

// The smile's IV at `strike`, linear between the two points around it; null outside the smile.
function ivAtStrike(smile, strike) {
  const sorted = [...smile].sort((a, b) => a.strike - b.strike)
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i]
    if (a.strike <= strike && b.strike >= strike) return b.strike === a.strike ? a.iv : a.iv + ((strike - a.strike) / (b.strike - a.strike)) * (b.iv - a.iv)
  }
  return null
}

/**
 * The day's skew minute by minute: `cePoints` / `pePoints` (the run's option points - time, strike, price, impliedVolatility),
 * `spotBars` ([{ time, close }] a minute), `expiry` ('YYYY-MM-DD' - the options' expiry; none = the time implied from the ATM
 * straddle at Dhan's ATM IV, as the GEX card does). Each minute: { time, spot, forward, years, atm, atmIv, put25, call25,
 * rr25, bf25, smile: [{ strike, iv, delta, side }] } - IVs as percentages; a minute with no ATM or no time to expiry is left
 * out, a 25-delta point the smile does not reach is null.
 */
export function skewDay(cePoints, pePoints, spotBars, { expiry = null } = {}) {
  const ce = legs(cePoints), pe = legs(pePoints)
  const strikes = [...new Set([...ce.keys(), ...pe.keys()])].sort((a, b) => a - b)
  const expiryMs = expiry ? Date.parse(`${String(expiry).slice(0, 10)}T15:30:00+05:30`) : null
  const spots = (spotBars ?? []).filter((b) => b && b.close > 0)
    .map((b) => ({ t: minuteOf(typeof b.time === 'number' && b.time < 1e11 ? b.time * 1000 : b.time), spot: b.close }))
    .filter((b) => Number.isFinite(b.t)).sort((a, b) => a.t - b.t)
  let implied = null
  const minutes = []
  for (const { t, spot } of spots) {
    if (minutes.length && minutes.at(-1).time === t) minutes.pop()
    const readings = strikes.map((strike) => ({ strike, c: readingAt(ce.get(strike), t), p: readingAt(pe.get(strike), t) }))
    const both = readings.filter((r) => r.c && r.p)
    if (!both.length) continue
    const forward = parityForward(both.map((r) => ({ strike: r.strike, call: r.c.price, put: r.p.price })), spot)
    const atmRow = [...both].sort((a, b) => Math.abs(a.strike - forward) - Math.abs(b.strike - forward) || a.strike - b.strike)[0]
    const dhanIvs = [atmRow.c.iv, atmRow.p.iv].filter((v) => v > 0).map(ivFraction)
    if (dhanIvs.length) implied = impliedYears(atmRow.c.price + atmRow.p.price, forward, atmRow.strike, dhanIvs.reduce((a, b) => a + b, 0) / dhanIvs.length) ?? implied
    const years = Number.isFinite(expiryMs) && expiryMs > t ? (expiryMs - t) / YEAR_MS : implied
    if (!(years > 0)) continue
    // The ATM IV: the straddle's own legs at the ATM strike, averaged (the OTM leg alone is a coin flip at the money).
    const atmIvs = [impliedVol(atmRow.c.price, forward, atmRow.strike, years, true), impliedVol(atmRow.p.price, forward, atmRow.strike, years, false)].filter((v) => v > 0)
    if (!atmIvs.length) continue
    const atmIv = atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length
    const smile = []
    for (const { strike, c, p } of readings) {
      const call = strike >= forward
      const leg = call ? c : p
      if (!leg) continue
      const iv = impliedVol(leg.price, forward, strike, years, call)
      if (!(iv > 0) || iv < IV_BAND[0] * atmIv || iv > IV_BAND[1] * atmIv) continue
      const cd = callDelta(forward, strike, iv, years)
      if (cd == null) continue
      smile.push({ strike, iv: iv * 100, delta: call ? cd : cd - 1, side: call ? 'call' : 'put' })
    }
    const call25 = ivAtDelta(smile.filter((s) => s.side === 'call'), 0.25)
    const put25 = ivAtDelta(smile.filter((s) => s.side === 'put'), -0.25)
    // The ATM IV AT THE FORWARD, interpolated between the smile's two strikes around it, as the desks quote it - read at
    // the nearest strike it jumped each time the ATM strike changed (a skewed smile has a different IV at every strike);
    // the ATM strike's own straddle IV when the smile does not straddle the forward.
    const atm = (ivAtStrike(smile, forward) ?? atmIv * 100)
    minutes.push({
      time: t, spot, forward, years, atm: atmRow.strike, atmIv: atm, put25, call25,
      rr25: call25 != null && put25 != null ? call25 - put25 : null,
      bf25: call25 != null && put25 != null ? (call25 + put25) / 2 - atm : null,
      smile,
    })
  }
  return minutes
}

/** The minutes up to the replay clock (`asOfMs` - the minute it is in counts; null = all). */
export function skewUpTo(minutes, asOfMs) {
  if (asOfMs == null) return minutes ?? []
  const clock = minuteOf(asOfMs)
  return (minutes ?? []).filter((m) => m.time <= clock)
}

// What a change of the risk reversal means against the price, as the desks read it (shown in the card's tooltip, the
// row matched lit). RR in vol points; the price by spot.
export const SKEW_READ_TABLE = [
  { key: 'fearConfirms', price: 'falling', rr: 'falling', read: 'Fear confirms the fall', detail: 'Puts are being bid against calls as price falls - protection demand is behind the move; the down move has conviction.' },
  { key: 'putsFade', price: 'falling', rr: 'rising', read: 'Selling may be exhausting', detail: 'Price falls but puts are getting CHEAPER against calls - nobody is paying up for protection; watch for a bounce.' },
  { key: 'callChase', price: 'rising', rr: 'rising', read: 'Calls chased into the rally', detail: 'Calls bid against puts as price rises - upside demand confirms it (a squeeze can follow).' },
  { key: 'hedgedRally', price: 'rising', rr: 'falling', read: 'Rally being hedged', detail: 'Price rises while puts get bid - the rally is not trusted; it is being hedged into.' },
  { key: 'fearBuilding', price: 'flat', rr: 'falling', read: 'Protection demand building', detail: 'Puts getting bid with price flat - downside risk being priced before it shows in price.' },
  { key: 'fearEasing', price: 'flat', rr: 'rising', read: 'Fear coming out', detail: 'Skew easing with price flat - protection being sold; a calm, range-friendly tape.' },
  { key: 'steady', price: 'any', rr: 'steady', read: 'Skew steady', detail: 'The risk reversal has not moved enough to say anything.' },
]

export const SKEW_DEFAULTS = { window: 30, rrMove: 0.3, priceMovePct: 0.1 }

/**
 * The read at the last minute of `minutes` over its last `window` minutes: the RR25 change (vol points, >= `rrMove` to
 * count) against spot's move (>= `priceMovePct` %), the row of SKEW_READ_TABLE it matches; with the ATM IV's change and
 * the changes since the first minute. Null with no RR25 to read.
 */
export function skewRead(minutes, { window = SKEW_DEFAULTS.window, rrMove = SKEW_DEFAULTS.rrMove, priceMovePct = SKEW_DEFAULTS.priceMovePct } = {}) {
  const read = (minutes ?? []).filter((m) => m.rr25 != null)
  if (!read.length) return null
  const now = read.at(-1)
  const start = [...read].reverse().find((m) => m.time <= now.time - window * MIN) ?? read[0]
  const first = read[0]
  const rrChange = now.rr25 - start.rr25
  const priceChangePct = ((now.spot - start.spot) / start.spot) * 100
  const price = priceChangePct >= priceMovePct ? 'rising' : priceChangePct <= -priceMovePct ? 'falling' : 'flat'
  const rr = rrChange >= rrMove ? 'rising' : rrChange <= -rrMove ? 'falling' : 'steady'
  const row = rr === 'steady' ? SKEW_READ_TABLE.at(-1) : SKEW_READ_TABLE.find((r) => r.price === price && r.rr === rr)
  return {
    row, price, rr, rrChange, priceChangePct, minutes: Math.round((now.time - start.time) / MIN), now, from: start,
    atmIvChange: now.atmIv - start.atmIv, rrSinceOpen: now.rr25 - first.rr25, atmIvSinceOpen: now.atmIv - first.atmIv, first,
  }
}
