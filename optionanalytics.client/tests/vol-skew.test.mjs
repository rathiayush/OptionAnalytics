// OI Replay's volatility skew (volSkew.js): a chain priced with Black-76 from a KNOWN smile is read back - the ATM IV, the
// 25-delta put / call IVs, RR25 and BF25 - the reads against price, no look-ahead, and stale prints left out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callDelta, skewDay, skewRead, skewUpTo } from '../src/volSkew.js'

const MIN = 60_000
const T0 = Date.parse('2026-11-16T09:15:00+05:30')
const EXPIRY = '2026-11-18'
const YEARS0 = (Date.parse(`${EXPIRY}T15:30:00+05:30`) - T0) / (365 * 86_400_000)

function cdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}
const black76 = (F, K, sigma, T, isCall) => {
  const v = sigma * Math.sqrt(T)
  const d1 = (Math.log(F / K) + v * v / 2) / v
  const call = F * cdf(d1) - K * cdf(d1 - v)
  return isCall ? call : call - (F - K)
}

// A day: spot / forward path, the smile as a function of the minute: iv(K, F, m) in fractions.
function chain({ minutes = 90, spot = () => 25000, smile }) {
  const ce = [], pe = [], spots = []
  for (let m = 0; m < minutes; m++) {
    const t = T0 + m * MIN
    const F = spot(m)
    const T = YEARS0 - (m * MIN) / (365 * 86_400_000)
    spots.push({ time: t, close: F })
    for (let k = 24000; k <= 26000; k += 50) {
      const iv = smile(k, F, m)
      const time = new Date(t).toISOString()
      ce.push({ time, strike: k, price: black76(F, k, iv, T, true) })
      pe.push({ time, strike: k, price: black76(F, k, iv, T, false) })
    }
  }
  return { ce, pe, spots }
}

// A put skew: IV rises 0.4 vol points a 1% below the forward, falls the same above it.
const skewed = (base, slope) => (k, F) => base + slope * ((F - k) / F) * 100 / 100

test('a smile priced with Black-76 is read back: ATM IV, the 25-delta IVs, RR25 negative for a put skew, BF25', () => {
  const d = chain({ smile: skewed(0.12, 0.4) })
  const day = skewDay(d.ce, d.pe, d.spots, { expiry: EXPIRY })
  assert.equal(day.length, 90)
  const m = day[0]
  assert.ok(Math.abs(m.atmIv - 12) < 0.05, `ATM IV ${m.atmIv}`)
  // The 25-delta strikes, from the smile itself: the put's IV over the ATM's, the call's under it, by the slope.
  const putStrike = m.smile.filter((s) => s.side === 'put').sort((a, b) => Math.abs(a.delta + 0.25) - Math.abs(b.delta + 0.25))[0]
  const callStrike = m.smile.filter((s) => s.side === 'call').sort((a, b) => Math.abs(a.delta - 0.25) - Math.abs(b.delta - 0.25))[0]
  const expectPut = (0.12 + 0.4 * ((25000 - putStrike.strike) / 25000)) * 100
  const expectCall = (0.12 + 0.4 * ((25000 - callStrike.strike) / 25000)) * 100
  assert.ok(Math.abs(m.put25 - expectPut) < 0.3, `put25 ${m.put25} vs ${expectPut}`)
  assert.ok(Math.abs(m.call25 - expectCall) < 0.3, `call25 ${m.call25} vs ${expectCall}`)
  assert.ok(m.rr25 < -0.5, `RR25 ${m.rr25}`)
  assert.ok(Math.abs(m.rr25 - (m.call25 - m.put25)) < 1e-9)
  assert.ok(Math.abs(m.bf25 - ((m.call25 + m.put25) / 2 - m.atmIv)) < 1e-9)
  // A flat smile: RR25 and BF25 about 0.
  const flat = skewDay(...Object.values(chain({ smile: () => 0.12 })), { expiry: EXPIRY })[0]
  assert.ok(Math.abs(flat.rr25) < 0.05 && Math.abs(flat.bf25) < 0.05, `flat ${flat.rr25} ${flat.bf25}`)
  // Each smile point's delta is the Black-76 delta at its own IV.
  const p = m.smile[0]
  const cd = callDelta(m.forward, p.strike, p.iv / 100, m.years)
  assert.ok(Math.abs(p.delta - (p.side === 'call' ? cd : cd - 1)) < 1e-12)
})

test('the read: puts bid while price falls = fear confirms; puts cheapened while it falls = selling exhausting; flat = steady', () => {
  const falling = (m) => 25000 - m * 3
  // The put skew steepening through the day (fear) vs flattening (protection sold).
  const steeper = chain({ spot: falling, smile: (k, F, m) => 0.12 + (0.3 + m * 0.01) * ((F - k) / F) })
  const easing = chain({ spot: falling, smile: (k, F, m) => 0.12 + Math.max(0, 1.2 - m * 0.012) * ((F - k) / F) })
  const r1 = skewRead(skewDay(steeper.ce, steeper.pe, steeper.spots, { expiry: EXPIRY }), { window: 30 })
  assert.equal(r1.row.key, 'fearConfirms')
  assert.ok(r1.rrChange < 0 && r1.priceChangePct < 0)
  const r2 = skewRead(skewDay(easing.ce, easing.pe, easing.spots, { expiry: EXPIRY }), { window: 30 })
  assert.equal(r2.row.key, 'putsFade')
  const still = chain({ smile: skewed(0.12, 0.4) })
  assert.equal(skewRead(skewDay(still.ce, still.pe, still.spots, { expiry: EXPIRY })).row.key, 'steady')
  // A rally with puts bid: hedged.
  const rally = chain({ spot: (m) => 25000 + m * 3, smile: (k, F, m) => 0.12 + (0.3 + m * 0.01) * ((F - k) / F) })
  assert.equal(skewRead(skewDay(rally.ce, rally.pe, rally.spots, { expiry: EXPIRY })).row.key, 'hedgedRally')
  assert.equal(skewRead([]), null)
})

test('no look-ahead: a cut at any clock = the whole day up to it; a stale strike leaves the smile; no expiry = the time implied from Dhan\'s ATM IV', () => {
  const d = chain({ spot: (m) => 25000 - m * 2, smile: (k, F, m) => 0.12 + (0.3 + m * 0.005) * ((F - k) / F) })
  const whole = skewDay(d.ce, d.pe, d.spots, { expiry: EXPIRY })
  for (const cut of [10, 45, 80]) {
    const until = T0 + cut * MIN
    const part = skewDay(d.ce.filter((p) => Date.parse(p.time) <= until), d.pe.filter((p) => Date.parse(p.time) <= until), d.spots.filter((s) => s.time <= until), { expiry: EXPIRY })
    assert.deepEqual(part, skewUpTo(whole, until))
  }
  // A put strike priced at twice the ATM IV and more (a stale print) is left out.
  const bad = { ...d, pe: d.pe.map((p) => (p.strike === 24600 ? { ...p, price: p.price + 400 } : p)) }
  assert.ok(!skewDay(bad.ce, bad.pe, bad.spots, { expiry: EXPIRY })[0].smile.some((s) => s.strike === 24600))
  // No expiry date: the time to expiry from Dhan's ATM IV on the points - the same ATM IV read back.
  const withIv = { ...d, ce: d.ce.map((p) => ({ ...p, impliedVolatility: 12 })), pe: d.pe.map((p) => ({ ...p, impliedVolatility: 12 })) }
  const noExpiry = skewDay(withIv.ce, withIv.pe, withIv.spots)[0]
  assert.ok(Math.abs(noExpiry.atmIv - 12) < 0.2, `implied ${noExpiry.atmIv}`)
})

test('the ATM IV is read AT THE FORWARD - no jump when the ATM strike changes on a skewed smile', () => {
  // Spot drifting through two strikes on a steep put skew: the ATM IV follows the smile at the forward smoothly.
  const d = chain({ minutes: 60, spot: (m) => 25000 - m * 2, smile: skewed(0.12, 0.6) })
  const day = skewDay(d.ce, d.pe, d.spots, { expiry: EXPIRY })
  const steps = day.slice(1).map((m, i) => Math.abs(m.atmIv - day[i].atmIv))
  assert.ok(Math.max(...steps) < 0.05, `largest minute-to-minute ATM IV step ${Math.max(...steps)}`)
  // And it is the smile's IV at the forward: base + slope x (F - F) / F = the base.
  assert.ok(day.every((m) => Math.abs(m.atmIv - 12) < 0.1), 'ATM IV at the forward = 12')
})
