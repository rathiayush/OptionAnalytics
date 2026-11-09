// OI totals by moneyness (oiMoneyness.js): each strike's OI change x its option delta, the delta read off the chain's own
// premiums - the forward by put-call parity, the move from the straddle - at each bucket's end, nothing after the clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bsStraddle, cdf } from '../src/gex.js'
import { bucketKey, bucketPricing, moneynessDelta, straddleMove, weightByMoneyness } from '../src/oiMoneyness.js'
import { buildOiTotalsRows } from '../src/oiTotalsHeatmap.js'

const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const MIN = 60_000
const call = (F, K, s) => { const d1 = (Math.log(F / K) + s * s / 2) / s; return F * cdf(d1) - K * cdf(d1 - s) }
const put = (F, K, s) => call(F, K, s) - (F - K)
const STRIKES = Array.from({ length: 21 }, (_, i) => 24500 + i * 50)
// A chain priced at forward F(m) and move s(m) each minute, OI from oi(strike, m, isCall).
function chain(minutes, F, s, oi = () => 1e6) {
  const ce = new Map(), pe = new Map()
  for (const k of STRIKES) { ce.set(k, []); pe.set(k, []) }
  for (let m = 0; m < minutes; m++) {
    const ms = T915 + m * MIN
    for (const k of STRIKES) {
      ce.get(k).push({ time: new Date(ms).toISOString(), ms, strike: k, price: call(F(m), k, s(m)), openInterest: oi(k, m, true) })
      pe.get(k).push({ time: new Date(ms).toISOString(), ms, strike: k, price: put(F(m), k, s(m)), openInterest: oi(k, m, false) })
    }
  }
  return { ce, pe }
}

test('the delta weight: a call N(d1), a put N(−d1) - about half at the money, near 1 in the money, near 0 far out; 1/2 unpriced', () => {
  const F = 25000, s = 0.01
  assert.ok(Math.abs(moneynessDelta(F, 25000, s, true) - 0.5) < 0.01 && Math.abs(moneynessDelta(F, 25000, s, false) - 0.5) < 0.01)
  for (const K of [24500, 24900, 25000, 25150, 25500]) assert.ok(Math.abs(moneynessDelta(F, K, s, true) + moneynessDelta(F, K, s, false) - 1) < 1e-12, `call + put = 1 at ${K}`)
  assert.ok(moneynessDelta(F, 24500, s, true) > 0.97 && moneynessDelta(F, 25500, s, true) < 0.03, 'a 2% move with a 1% priced move')
  assert.ok(moneynessDelta(F, 25500, s, false) > 0.97 && moneynessDelta(F, 24500, s, false) < 0.03)
  // Falls as the strike rises (a call), rises (a put).
  for (let k = 1; k < STRIKES.length; k++) {
    assert.ok(moneynessDelta(F, STRIKES[k], s, true) < moneynessDelta(F, STRIKES[k - 1], s, true))
    assert.ok(moneynessDelta(F, STRIKES[k], s, false) > moneynessDelta(F, STRIKES[k - 1], s, false))
  }
  assert.equal(moneynessDelta(F, 25000, null, true), 0.5)
  assert.equal(moneynessDelta(0, 25000, 0.01, false), 0.5)
})

test('the priced move is the straddle inverted: s back from a straddle at any strike near the money', () => {
  for (const [F, K, s] of [[25000, 25000, 0.01], [25010, 25000, 0.004], [24980, 25050, 0.025], [56000, 56100, 0.015]]) {
    assert.ok(Math.abs(straddleMove(bsStraddle(F, K, s, 1), F, K) - s) < 1e-9, `${F} ${K} ${s}`)
  }
  assert.equal(straddleMove(0, 25000, 25000), null)
  assert.equal(straddleMove(5, 25000, 24000), null)   // under its intrinsic value: no move fits
})

test('each bucket\'s forward and move come back from the chain\'s premiums: the closest call / put pair, its parity and straddle', () => {
  const F = (m) => 25010 + m * 3, s = (m) => 0.01 - m * 0.0001
  const { ce, pe } = chain(20, F, s)
  const pricing = bucketPricing(ce, pe, STRIKES, null, 1)
  assert.equal(pricing.size, 20)
  for (let m = 0; m < 20; m++) {
    const p = pricing.get(bucketKey(T915 + m * MIN, 1))
    assert.ok(Math.abs(p.F - F(m)) < 1e-6, `forward at ${m}`)
    assert.ok(Math.abs(p.s - s(m)) < 1e-6, `move at ${m}`)
    assert.ok(Math.abs(p.K - F(m)) <= 25, `the pair nearest the forward at ${m}`)
  }
  // 5-minute buckets: each read at its last minute.
  const five = bucketPricing(ce, pe, STRIKES, null, 5)
  assert.equal(five.size, 4)
  assert.ok(Math.abs(five.get(bucketKey(T915 + 5 * MIN, 5)).F - F(9)) < 1e-6)
  // Nothing after the clock: cut at minute 12, every bucket up to it the same, none after; the forming 5-min bucket reads
  // its minutes so far.
  const cut = T915 + 12 * MIN
  const part = bucketPricing(ce, pe, STRIKES, cut, 1)
  assert.equal(part.size, 13)
  for (const [t, v] of part) assert.deepEqual(v, pricing.get(t))
  assert.ok(Math.abs(bucketPricing(ce, pe, STRIKES, cut, 5).get(bucketKey(T915 + 10 * MIN, 5)).F - F(12)) < 1e-6)
})

test('a minute a strike did not trade carries its last premium; before any pair is priced there is no pricing', () => {
  const { ce, pe } = chain(6, () => 25000, () => 0.01)
  // The puts only from minute 3: nothing priced before it.
  for (const k of STRIKES) pe.set(k, pe.get(k).filter((p) => p.ms >= T915 + 3 * MIN))
  const pricing = bucketPricing(ce, pe, STRIKES, null, 1)
  assert.equal(pricing.has(bucketKey(T915, 1)), false)
  assert.ok(pricing.has(bucketKey(T915 + 3 * MIN, 1)))
  // The calls stop at minute 4: minute 5 keeps their last premiums - the same forward / move.
  for (const k of STRIKES) ce.set(k, ce.get(k).filter((p) => p.ms <= T915 + 4 * MIN))
  const carried = bucketPricing(ce, pe, STRIKES, null, 1)
  assert.deepEqual(carried.get(bucketKey(T915 + 5 * MIN, 1)), carried.get(bucketKey(T915 + 4 * MIN, 1)))
})

test('weighted: each strike\'s change x its delta at the bucket (1/2 unpriced), the input untouched - OI written far out counts little', () => {
  const t = bucketKey(T915 + 5 * MIN, 1)
  const pricing = new Map([[t, { F: 25000, s: 0.01, K: 25000 }]])
  const change = new Map([[25000, new Map([[t, 1000]])], [25500, new Map([[t, 1000]])], [24500, new Map([[t, 1000], [t + 60, 400]])]])
  const before = JSON.stringify([...change].map(([k, m]) => [k, [...m]]))
  const ce = weightByMoneyness(change, pricing, true)
  assert.equal(JSON.stringify([...change].map(([k, m]) => [k, [...m]])), before)
  assert.ok(Math.abs(ce.get(25000).get(t) - 1000 * moneynessDelta(25000, 25000, 0.01, true)) < 1e-9)
  assert.ok(ce.get(25500).get(t) < 30 && ce.get(24500).get(t) > 970)
  assert.equal(ce.get(24500).get(t + 60), 200)   // no pricing for that bucket: half
  // The Net on a day of call writing far out of the money and put writing at the money: plain, the two cancel; by
  // moneyness the put writing (bullish) leads.
  const callsFar = new Map([[25500, new Map([[t, 1000]])]])
  const putsAtm = new Map([[25000, new Map([[t, 1000]])]])
  const plain = buildOiTotalsRows(callsFar, putsAtm).rows.netCum.get(t)
  const weighted = buildOiTotalsRows(weightByMoneyness(callsFar, pricing, true), weightByMoneyness(putsAtm, pricing, false)).rows.netCum.get(t)
  assert.equal(plain, 0)
  assert.ok(weighted < -450, `net ${weighted}`)
})

test('the whole day by minute: the weighted totals of a cut part way equal the whole day\'s up to the cut', () => {
  const F = (m) => 25000 + 40 * Math.sin(m / 9), s = () => 0.009
  const { ce, pe } = chain(60, F, s, (k, m, isCall) => 1e6 + m * (isCall ? (k > 25100 ? 3000 : 500) : (k < 25000 ? 2500 : 700)))
  const changes = (byStrike, asOf) => {
    const out = new Map()
    for (const k of STRIKES) {
      const pts = byStrike.get(k).filter((p) => asOf == null || p.ms <= asOf)
      out.set(k, new Map(pts.slice(1).map((p, i) => [bucketKey(p.ms, 1), p.openInterest - pts[i].openInterest])))
    }
    return out
  }
  const rowsAt = (asOf) => {
    const pricing = bucketPricing(ce, pe, STRIKES, asOf, 1)
    return buildOiTotalsRows(weightByMoneyness(changes(ce, asOf), pricing, true), weightByMoneyness(changes(pe, asOf), pricing, false)).rows
  }
  const whole = rowsAt(null)
  const cut = rowsAt(T915 + 30 * MIN)
  for (const [t, v] of cut.netCum) assert.ok(Math.abs(v - whole.netCum.get(t)) < 1e-6, `net at ${t}`)
  assert.equal(cut.netCum.size, 30)
})
