// OI TOTALS BY MONEYNESS (asked for - "we are calculating net CE − PE; instead can we have moneyness and then calculate
// delta? When a checkbox is ticked moneyness is included, else the same as today"): the OI totals card's CE / PE / Net
// Δ and cumulative Δ with each strike's OI change WEIGHTED BY ITS OPTION DELTA - a call's N(d1), a put's N(−d1), 0 - 1 -
// so OI added at the money counts about half, in the money nearly all of it and far out of the money little: the
// delta-adjusted OI added (in contracts of delta). The delta is read off the chain's OWN PREMIUMS at the end of each
// bucket - no IV field, no expiry date: the forward by put-call parity at the strike whose call and put are closest
// (call − put = F − K), the move the options price (s = σ√T) from that strike's straddle (Black-76 - `bsStraddle`), and
// d1 = (ln(F / K) + s² / 2) / s. Only the CHANGE is weighted (each bucket's OI added x the strike's delta then): a bucket in
// which no OI changed adds nothing however far spot moved. A strike's premium carries on from its last reading; a bucket
// before any call / put pair is priced weighs 1/2 (the at-the-money delta). Nothing after the clock is read
// (`tests/oi-moneyness.test.mjs`). With Σ 3 expiries the deltas are the current expiry's (its premiums are the ones held).
import { bsStraddle, cdf } from './gex.js'

const IST_SECONDS = 5.5 * 3600
// The OI charts' bucket key for an epoch-ms time - buildOiChangeMatrix's own (toChartTime, then the bucket's start).
export function bucketKey(ms, minutes) {
  const t = Math.floor(ms / 1000) + IST_SECONDS
  if (!(minutes > 0)) return t
  const size = minutes * 60
  return Math.floor(t / size) * size
}
const msOf = (p) => p.ms ?? new Date(p.time).getTime()

/** The move the options price, s = σ√T: the s at which a straddle at `K` on the forward `F` costs `straddle`; null when
 *  none fits. */
export function straddleMove(straddle, F, K) {
  if (!(straddle > 0 && F > 0 && K > 0)) return null
  let lo = 1e-6, hi = 3
  if (straddle <= bsStraddle(F, K, lo, 1) || straddle >= bsStraddle(F, K, hi, 1)) return null
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (bsStraddle(F, K, mid, 1) < straddle) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/** An option's delta as a weight (0 - 1): a call's N(d1), a put's N(−d1); 1/2 without a price. */
export function moneynessDelta(F, K, s, isCall) {
  if (!(F > 0 && K > 0 && s > 0)) return 0.5
  const d1 = (Math.log(F / K) + (s * s) / 2) / s
  return isCall ? cdf(d1) : cdf(-d1)
}

// Each strike's last premium in each bucket (Map strike -> Map bucket -> price), readings up to the clock.
function lastPremiums(byStrike, strikes, asOfMs, minutes) {
  const out = new Map()
  for (const strike of strikes) {
    const byBucket = new Map()
    for (const p of byStrike?.get(strike) ?? []) {
      if (!(p.price > 0)) continue
      const ms = msOf(p)
      if (asOfMs != null && ms > asOfMs) continue
      byBucket.set(bucketKey(ms, minutes), p.price)
    }
    out.set(strike, byBucket)
  }
  return out
}

/** Each bucket's forward and priced move (Map bucket -> { F, s, K }) from the chain's premiums up to the clock - the
 *  strike whose call and put are closest, its parity forward and its straddle's move; a bucket with no pair priced keeps
 *  the last one. */
export function bucketPricing(ceByStrike, peByStrike, strikes, asOfMs, minutes) {
  const ce = lastPremiums(ceByStrike, strikes, asOfMs, minutes)
  const pe = lastPremiums(peByStrike, strikes, asOfMs, minutes)
  const buckets = new Set()
  for (const m of [...ce.values(), ...pe.values()]) for (const t of m.keys()) buckets.add(t)
  const call = new Map(), put = new Map()
  const out = new Map()
  let last = null
  for (const t of [...buckets].sort((a, b) => a - b)) {
    for (const k of strikes) {
      const c = ce.get(k)?.get(t), q = pe.get(k)?.get(t)
      if (c != null) call.set(k, c)
      if (q != null) put.set(k, q)
    }
    let best = null
    for (const k of strikes) {
      const c = call.get(k), q = put.get(k)
      if (!(c > 0 && q > 0)) continue
      const gap = Math.abs(c - q)
      if (!best || gap < best.gap) best = { k, c, q, gap }
    }
    if (best) {
      const F = best.k + best.c - best.q
      const s = straddleMove(best.c + best.q, F, best.k)
      if (F > 0 && s > 0) last = { F, s, K: best.k }
    }
    if (last) out.set(t, last)
  }
  return out
}

/** buildOiChangeMatrix's `perStrikeChange` (Map strike -> Map bucket -> OI change) with each change x that strike's delta
 *  at the bucket (`pricing` - bucketPricing; 1/2 where it has none) - a new map, the input untouched. */
export function weightByMoneyness(perStrikeChange, pricing, isCall) {
  const out = new Map()
  for (const [strike, byBucket] of perStrikeChange) {
    const weighted = new Map()
    for (const [t, v] of byBucket) {
      const p = pricing?.get(t)
      weighted.set(t, v * (p ? moneynessDelta(p.F, strike, p.s, isCall) : 0.5))
    }
    out.set(strike, weighted)
  }
  return out
}
