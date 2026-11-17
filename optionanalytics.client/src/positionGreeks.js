// The order panel's POSITION GREEKS (asked for - "position Greeks on the order panel": your open paper and live positions'
// net delta, gamma, theta and vega, the delta's NOTIONAL in rupees, a warning when the delta drifts past a limit you set,
// and what one more order would add before it is punched).
//
// Each leg is priced Black-76 on the spot (the forward when given - a weekly's carry is a few points), its IV worked out
// from its OWN premium (gex.js' impliedVol), to 15:30 IST on its expiry day (365-day years). Per unit, long:
//   delta = N(d1) (call) / N(d1) - 1 (put) - how many units of the index the option moves like;
//   gamma = how much that delta changes for one point of spot;
//   theta = the premium one calendar day later, everything else kept, less now (rupees a unit; long options lose);
//   vega  = the premium with the IV one vol point higher, less now.
// A leg x its signed quantity (+ bought, - sold; Dhan's net quantity), added up per index (points of different indices do
// not add): delta in units and in LOTS of the index, its NOTIONAL (delta x spot - the index exposure you really hold, what
// a cheap OTM option's lots hide), gamma as the change of that notional for a 1% move, theta in ₹ a day, vega in ₹ a vol
// point, and the P&L a +/- 1% move would make now (delta and gamma). A premium below its intrinsic value (no IV) or a leg at /
// past expiry counts as intrinsic: delta 1 / 0, the rest 0. A leg with no spot or expiry is listed as not worked out.
// A read for the trader - it places nothing. tests/position-greeks.test.mjs.

import { impliedVol } from './gex.js'

const YEAR_MS = 365 * 86_400_000
const DAY_YEARS = 1 / 365

function pdf(x) { return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI) }
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const tail = pdf(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - tail : tail
}

/** Black-76 (undiscounted) price on the forward `F`. */
export function black76(isCall, F, K, sigma, T) {
  if (!(T > 0 && sigma > 0)) return Math.max(0, isCall ? F - K : K - F)
  const v = sigma * Math.sqrt(T)
  const d1 = (Math.log(F / K) + v * v / 2) / v
  const call = F * cdf(d1) - K * cdf(d1 - v)
  return isCall ? call : call - (F - K)
}

/** Years from `atMs` to 15:30 IST on `expiry` ('YYYY-MM-DD'); null when unknown, 0 at / past it. */
export function yearsToExpiry(expiry, atMs) {
  if (!expiry || !Number.isFinite(atMs)) return null
  const end = Date.parse(`${String(expiry).slice(0, 10)}T15:30:00+05:30`)
  if (!Number.isFinite(end)) return null
  return Math.max(0, (end - atMs) / YEAR_MS)
}

/** One unit of a LONG option: { iv, delta, gamma, theta, vega, intrinsic }; null without a spot / expiry. */
export function legGreeks({ side, strike, spot, forward = null, expiry, mark }, atMs) {
  const isCall = side === 'CE'
  const S = spot
  const T = yearsToExpiry(expiry, atMs)
  if (!(S > 0) || !(strike > 0) || T == null) return null
  const F = forward > 0 ? forward : S
  const carry = F / S
  const iv = T > 0 ? impliedVol(mark, F, strike, T, isCall) : null
  if (iv == null) {
    const itm = isCall ? F > strike : F < strike
    return { iv: null, delta: itm ? (isCall ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, intrinsic: true }
  }
  const v = iv * Math.sqrt(T)
  const d1 = (Math.log(F / strike) + v * v / 2) / v
  const now = black76(isCall, F, strike, iv, T)
  return {
    iv,
    delta: carry * (isCall ? cdf(d1) : cdf(d1) - 1),
    gamma: (carry * carry * pdf(d1)) / (F * v),
    theta: black76(isCall, F, strike, iv, Math.max(0, T - DAY_YEARS)) - now,
    vega: black76(isCall, F, strike, iv + 0.01, T) - now,
    intrinsic: false,
  }
}

/**
 * The book's Greeks. `legs`: [{ id, label, underlying, side 'CE'|'PE', strike, units (signed: + long, - short), lotSize,
 * mark (the premium now), spot, forward?, expiry }]. Returns { rows, byIndex: [{ underlying, spot, lotSize, delta (units),
 * deltaLots, notional (₹), gammaPct (₹ of notional per +1%), theta (₹ a day), vega (₹ a vol point), pnlUp / pnlDown (₹ for
 * +/- 1%), legs, missing }], total: { notional, gross (|notional| summed over the indices), theta, vega, legs, missing } }.
 */
export function bookGreeks(legs, atMs) {
  const rows = []
  const by = new Map()
  for (const leg of legs ?? []) {
    if (!leg || !Number.isFinite(leg.units) || leg.units === 0) continue
    const g = legGreeks(leg, atMs)
    const row = { ...leg, greeks: g }
    rows.push(row)
    const u = leg.underlying
    if (!by.has(u)) by.set(u, { underlying: u, spot: leg.spot ?? null, lotSize: leg.lotSize ?? null, delta: 0, gamma: 0, theta: 0, vega: 0, legs: 0, missing: 0, intrinsic: 0 })
    const s = by.get(u)
    if (!g) { s.missing += 1; continue }
    s.legs += 1
    if (g.intrinsic) s.intrinsic += 1
    if (!(s.spot > 0)) s.spot = leg.spot
    if (!(s.lotSize > 0)) s.lotSize = leg.lotSize
    s.delta += g.delta * leg.units
    s.gamma += g.gamma * leg.units
    s.theta += g.theta * leg.units
    s.vega += g.vega * leg.units
  }
  const byIndex = [...by.values()].map((s) => {
    const move = s.spot > 0 ? s.spot * 0.01 : 0
    return {
      ...s,
      deltaLots: s.lotSize > 0 ? s.delta / s.lotSize : null,
      notional: s.delta * (s.spot ?? 0),
      gammaPct: s.gamma * move * (s.spot ?? 0),
      pnlUp: s.delta * move + 0.5 * s.gamma * move * move,
      pnlDown: -s.delta * move + 0.5 * s.gamma * move * move,
    }
  })
  const sum = (key) => byIndex.reduce((a, s) => a + (Number.isFinite(s[key]) ? s[key] : 0), 0)
  return {
    rows,
    byIndex,
    total: { notional: sum('notional'), gross: byIndex.reduce((a, s) => a + Math.abs(s.notional), 0), theta: sum('theta'), vega: sum('vega'), legs: sum('legs'), missing: sum('missing') },
  }
}

/** The indices whose net delta is past `limitLots` lots either way (0 / none = no limit). */
export function deltaBreaches(book, limitLots) {
  if (!(limitLots > 0) || !book) return []
  return book.byIndex.filter((s) => Number.isFinite(s.deltaLots) && Math.abs(s.deltaLots) > limitLots)
}

/** What one more order would do: the index's net delta before and after it, in lots, and whether it crosses the limit. */
export function orderDeltaChange(book, after, underlying, limitLots = 0) {
  const before = book?.byIndex.find((s) => s.underlying === underlying)
  const next = after?.byIndex.find((s) => s.underlying === underlying)
  if (!next || !Number.isFinite(next.deltaLots)) return null
  const was = before?.deltaLots ?? 0
  return {
    before: was,
    after: next.deltaLots,
    adds: next.deltaLots - was,
    notionalAdds: next.notional - (before?.notional ?? 0),
    breaches: limitLots > 0 && Math.abs(next.deltaLots) > limitLots && Math.abs(next.deltaLots) > Math.abs(was),
  }
}
