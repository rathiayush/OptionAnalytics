// OI Replay's GEX (gex.js): Black-Scholes gamma, the time to expiry implied from the ATM straddle, GEX per strike =
// gamma x the dealers' OI x S^2 x 1%, the standard and the OI build-up signs, the gamma flip, the walls - and nothing
// after the minute read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bsGamma, bsStraddle, gexDay, gexUpTo, impliedYears, netGexAt } from '../src/gex.js'

const MIN = 60_000
const OPEN = Date.parse('2026-10-20T09:15:00+05:30')
const at = (hhmm) => Date.parse(`2026-10-20T${hhmm}:00+05:30`)
const STRIKES = Array.from({ length: 21 }, (_, i) => 24500 + 50 * i)
const YEARS = 3 / 365
const close = (a, b, tol) => Math.abs(a - b) <= tol

const phi = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const tail = phi(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - tail : tail
}
const call = (S, K, s, T) => { const v = s * Math.sqrt(T); const d1 = (Math.log(S / K) + v * v / 2) / v; return S * cdf(d1) - K * cdf(d1 - v) }

// A chain minute by minute, priced by Black-Scholes at IV 12% and 3 days to expiry: spot(m), each strike's OI ceOi(k, m)
// / peOi(k, m), the premium as priced (or price(side, k, m) when given).
function day({ minutes = 30, spot = () => 25000, ceOi = () => 1e6, peOi = () => 1e6, iv = () => 12, price = null, years = () => YEARS }) {
  const ce = [], pe = [], spots = []
  for (let m = 0; m < minutes; m++) {
    const time = new Date(OPEN + m * MIN).toISOString()
    const S = spot(m)
    spots.push({ time: OPEN + m * MIN, close: S })
    for (const k of STRIKES) {
      const c = call(S, k, iv(m) / 100, years(m))
      const p = c - (S - k)
      ce.push({ time, strike: k, price: price?.('ce', k, m) ?? c, openInterest: ceOi(k, m), impliedVolatility: iv(m) })
      pe.push({ time, strike: k, price: price?.('pe', k, m) ?? p, openInterest: peOi(k, m), impliedVolatility: iv(m) })
    }
  }
  return { ce, pe, spots }
}

test('gamma is the change of delta per point; the straddle and the time to expiry it implies agree', () => {
  const S = 25000, K = 25100, s = 0.12
  const delta = (x) => cdf((Math.log(x / K) + s * s * YEARS / 2) / (s * Math.sqrt(YEARS)))
  assert.ok(close(bsGamma(S, K, s, YEARS), (delta(S + 1) - delta(S - 1)) / 2, 1e-7))
  assert.equal(bsGamma(S, K, s, 0), 0)
  // The straddle priced at 3 days gives back 3 days.
  const straddle = bsStraddle(S, 25000, s, YEARS)
  assert.ok(close(impliedYears(straddle, S, 25000, s) * 365, 3, 1e-6))
  assert.equal(impliedYears(50, S, 25100, s), null) // below the 100 points the 25100 put is worth at expiry
})

test('GEX of a strike = gamma x OI x S^2 x 1%, calls + and puts - (standard); the net adds them up', () => {
  const d = day({ ceOi: (k) => (k === 25100 ? 3e6 : 1e6), peOi: (k) => (k === 24900 ? 2e6 : 1e6) })
  const [first] = gexDay(d.ce, d.pe, d.spots)
  assert.equal(first.time, OPEN)
  assert.equal(first.atm, 25000)
  assert.ok(close(first.atmIv, 0.12, 1e-12))
  assert.ok(close(first.years * 365, 3, 1e-4)) // implied from the ATM straddle - no expiry date needed
  const row = first.strikes.find((r) => r.strike === 25100)
  const unit = 25000 * 25000 * 0.01
  assert.ok(close(row.call, bsGamma(25000, 25100, 0.12, first.years) * 3e6 * unit, 1))
  assert.ok(close(row.put, -bsGamma(25000, 25100, 0.12, first.years) * 1e6 * unit, 1))
  assert.ok(row.call > 0 && row.put < 0)
  assert.ok(close(first.net, first.strikes.reduce((a, r) => a + r.net, 0), 1))
  assert.ok(close(first.net, first.calls + first.puts, 1e-6))
  // Strikes high to low.
  assert.deepEqual(first.strikes.map((r) => r.strike), [...STRIKES].reverse())
})

test('the walls are the most call / put gamma x OI, the max gamma strike the most of both', () => {
  const d = day({ ceOi: (k) => (k === 25200 ? 8e6 : 1e6), peOi: (k) => (k === 24800 ? 9e6 : k === 24950 ? 4e6 : 1e6) })
  const [m] = gexDay(d.ce, d.pe, d.spots)
  assert.equal(m.callWall, 25200)
  assert.equal(m.putWall, 24800)
  // 24800's put has the most OI but sits 200 away; 24950 is near the money - gamma x OI decides.
  const weight = (k) => bsGamma(25000, k, 0.12, m.years) * ((k === 25200 ? 8e6 : 1e6) + (k === 24800 ? 9e6 : k === 24950 ? 4e6 : 1e6))
  const best = [...STRIKES].sort((a, b) => weight(b) - weight(a))[0]
  assert.equal(m.maxGamma, best)
})

test('the gamma flip is the spot where the net GEX crosses zero, nearest spot; none when it does not cross nearby', () => {
  // Heavy puts below, heavy calls above: net negative low, positive high - it crosses in between.
  const d = day({ ceOi: (k) => (k >= 25100 ? 6e6 : 5e5), peOi: (k) => (k <= 24900 ? 6e6 : 5e5) })
  const [m] = gexDay(d.ce, d.pe, d.spots)
  assert.ok(m.flip > 24900 && m.flip < 25100, `flip ${m.flip}`)
  const options = []
  for (const k of STRIKES) {
    options.push({ strike: k, sigma: 0.12, dealerOi: k >= 25100 ? 6e6 : 5e5 })
    options.push({ strike: k, sigma: 0.12, dealerOi: -(k <= 24900 ? 6e6 : 5e5) })
  }
  const scale = Math.abs(netGexAt(options, 25300, m.years))
  assert.ok(Math.abs(netGexAt(options, m.flip, m.years)) < scale * 0.02)
  assert.ok(netGexAt(options, m.flip - 30, m.years) < 0 && netGexAt(options, m.flip + 30, m.years) > 0)
  // All calls: positive everywhere - no flip.
  const calm = day({ peOi: () => 0 })
  assert.equal(gexDay(calm.ce, calm.pe, calm.spots)[0].flip, null)
})

test('OI build-up sign: OI written (premium falling) adds to the dealers, OI bought (premium rising) takes from them', () => {
  // 25100 call: OI 1M, then +2M each minute; its premium falls (writers) or rises (buyers) with it.
  const run = (dir) => {
    const d = day({
      minutes: 5,
      ceOi: (k, m) => (k === 25100 ? 1e6 + 2e6 * m : 1e6),
      price: (side, k, m) => (side === 'ce' && k === 25100 ? 60 + dir * m : null),
    })
    return gexDay(d.ce, d.pe, d.spots, { sign: 'buildup' })
  }
  const written = run(-1).at(-1).strikes.find((r) => r.strike === 25100)
  const bought = run(+1).at(-1).strikes.find((r) => r.strike === 25100)
  const g = (m) => bsGamma(25000, 25100, 0.12, m.years) * 25000 * 25000 * 0.01
  const last = run(-1).at(-1)
  // Written: 1M (standard +) + 8M added by writers = +9M. Bought: 1M - 8M = -7M.
  assert.ok(close(written.call, g(last) * 9e6, 1))
  assert.ok(close(bought.call, g(run(+1).at(-1)) * -7e6, 1))
  // The first reading keeps the standard sign: the minute it starts, build-up == standard.
  const d = day({ minutes: 1, ceOi: (k) => (k === 25100 ? 5e6 : 1e6) })
  const [std] = gexDay(d.ce, d.pe, d.spots)
  const [bu] = gexDay(d.ce, d.pe, d.spots, { sign: 'buildup' })
  assert.ok(close(std.net, bu.net, 1e-6))
  // OI taken off while the premium rises (writers buying back) takes from the dealers' long.
  const cover = day({ minutes: 3, ceOi: (k, m) => (k === 25100 ? 5e6 - 1e6 * m : 1e6), price: (side, k, m) => (side === 'ce' && k === 25100 ? 60 + m : null) })
  const covered = gexDay(cover.ce, cover.pe, cover.spots, { sign: 'buildup' }).at(-1).strikes.find((r) => r.strike === 25100)
  assert.ok(close(covered.call, g(last) * (5e6 - 2e6), 1)) // 5M standard, 2M covered
})

test('nothing after the minute read is used; the replay clock picks the minutes', () => {
  const d = day({ minutes: 40, spot: (m) => 25000 + 4 * m, ceOi: (k, m) => 1e6 + 1e4 * m })
  const all = gexDay(d.ce, d.pe, d.spots, { sign: 'buildup' })
  const cutAt = at('09:35')
  const cut = gexDay(
    d.ce.filter((p) => Date.parse(p.time) <= cutAt), d.pe.filter((p) => Date.parse(p.time) <= cutAt), d.spots.filter((b) => b.time <= cutAt), { sign: 'buildup' },
  )
  const upTo = gexUpTo(all, cutAt + 30_000)
  assert.equal(upTo.at(-1).time, cutAt)
  assert.deepEqual(upTo, cut)
  assert.deepEqual(gexUpTo(all, 0), [])
  assert.equal(gexUpTo(all, null).length, 40)
})

test('a minute with no IV for the ATM is left out until there is one; a strike with an odd IV uses the ATM IV', () => {
  const d = day({ minutes: 3, iv: (m) => (m === 0 ? 0 : 12) })
  const minutes = gexDay(d.ce, d.pe, d.spots)
  assert.deepEqual(minutes.map((m) => m.time), [OPEN + MIN, OPEN + 2 * MIN])
  // 25400's call quoted at IV 90 (a stale or odd print): its gamma is worked out at the ATM IV.
  const odd = day({ minutes: 1 })
  odd.ce.find((p) => p.strike === 25400).impliedVolatility = 90
  const [m] = gexDay(odd.ce, odd.pe, odd.spots)
  const row = m.strikes.find((r) => r.strike === 25400)
  assert.ok(close(row.call, bsGamma(25000, 25400, 0.12, m.years) * 1e6 * 25000 * 25000 * 0.01, 1))
})
