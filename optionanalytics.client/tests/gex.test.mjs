// OI Replay's GEX (gex.js): Black-Scholes gamma, the time to expiry implied from the ATM straddle, GEX per strike =
// gamma x the dealers' OI x S^2 x 1%, the standard and the OI build-up signs, the gamma flip, the walls - and nothing
// after the minute read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bsGamma, bsStraddle, gexAgreement, gexDay, gexProfile, gexUpTo, impliedVol, impliedYears, netGexAt, parityForward } from '../src/gex.js'

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
function day({ minutes = 30, spot = () => 25000, ceOi = () => 1e6, peOi = () => 1e6, iv = () => 12, ivField = iv, price = null, years = () => YEARS, strikes = STRIKES }) {
  const ce = [], pe = [], spots = []
  for (let m = 0; m < minutes; m++) {
    const time = new Date(OPEN + m * MIN).toISOString()
    const S = spot(m)
    spots.push({ time: OPEN + m * MIN, close: S })
    for (const k of strikes) {
      const c = call(S, k, iv(m) / 100, years(m))
      const p = c - (S - k)
      ce.push({ time, strike: k, price: price?.('ce', k, m) ?? c, openInterest: ceOi(k, m), impliedVolatility: ivField(m) })
      pe.push({ time, strike: k, price: price?.('pe', k, m) ?? p, openInterest: peOi(k, m), impliedVolatility: ivField(m) })
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
  // The 25100 call's dealers' OI under the build-up sign, against its OI as the standard sign counts it - the same day,
  // so the same gamma: the ratio is the dealers' OI over the OI.
  const ratio = ({ minutes, ceOi, premium }) => {
    const d = day({ minutes, ceOi: (k, m) => (k === 25100 ? ceOi(m) : 1e6), price: (side, k, m) => (side === 'ce' && k === 25100 ? premium(m) : null) })
    const of = (sign) => gexDay(d.ce, d.pe, d.spots, { sign }).at(-1).strikes.find((r) => r.strike === 25100).call
    return of('buildup') / of('standard')
  }
  // OI 1M, then +2M a minute for 4 minutes (9M). Written - the premium falling: 1M standard + 8M = +9M, all the dealers'.
  assert.ok(close(ratio({ minutes: 5, ceOi: (m) => 1e6 + 2e6 * m, premium: (m) => 60 - m }), 9 / 9, 1e-9))
  // Bought - the premium rising: 1M - 8M = -7M - the dealers are short it.
  assert.ok(close(ratio({ minutes: 5, ceOi: (m) => 1e6 + 2e6 * m, premium: (m) => 60 + m }), -7 / 9, 1e-9))
  // OI taken off (5M, -1M a minute for 2 minutes: 3M) while the premium rises - writers buying back: the dealers' long
  // goes with it (5M - 2M = 3M) ...
  assert.ok(close(ratio({ minutes: 3, ceOi: (m) => 5e6 - 1e6 * m, premium: (m) => 60 + m }), 3 / 3, 1e-9))
  // ... while the premium falls - holders selling back to the dealers: the dealers' short goes (5M + 2M = 7M).
  assert.ok(close(ratio({ minutes: 3, ceOi: (m) => 5e6 - 1e6 * m, premium: (m) => 60 - m }), 7 / 3, 1e-9))
  // The first reading keeps the standard sign: the minute it starts, build-up == standard.
  const d = day({ minutes: 1, ceOi: (k) => (k === 25100 ? 5e6 : 1e6) })
  const [std] = gexDay(d.ce, d.pe, d.spots)
  const [bu] = gexDay(d.ce, d.pe, d.spots, { sign: 'buildup' })
  assert.ok(close(std.net, bu.net, 1e-6))
})

test('with the expiry date, the time to expiry runs to 15:30 IST on that day; the IV from the premiums absorbs a wrong one', () => {
  const d = day({ minutes: 3 })
  const [m] = gexDay(d.ce, d.pe, d.spots, { expiry: '2026-10-22' })
  // 09:15 on Tuesday 20 Oct to 15:30 on Thursday 22 Oct: 2 days 6 h 15 min.
  assert.equal(m.yearsFrom, 'expiry')
  assert.ok(close(m.years * 365, 2 + 6.25 / 24, 1e-9))
  assert.ok(close(m.impliedYears * 365, 3, 1e-4)) // the chain was priced at 3 days - the check says so
  // The chain was priced at IV 12% and 3 days: the IV worked out from the premiums over the 2.26 days to the expiry date is
  // higher, so that sigma x sqrt(T) - all gamma depends on - is the market's. A time to expiry a day off changes no gamma.
  assert.ok(close(m.atmIv, 0.12 * Math.sqrt(3 / (2 + 6.25 / 24)), 1e-6))
  const row = m.strikes.find((r) => r.strike === 25100)
  assert.ok(close(row.call, bsGamma(25000, 25100, 0.12, YEARS) * 1e6 * 25000 * 25000 * 0.01, 1))
  // A minute later, a minute less.
  const [, next] = gexDay(d.ce, d.pe, d.spots, { expiry: '2026-10-22' })
  assert.ok(close((m.years - next.years) * 365 * 24 * 60, 1, 1e-6))
  // Past the expiry (or none): implied from the straddle.
  const [past] = gexDay(d.ce, d.pe, d.spots, { expiry: '2026-10-19' })
  assert.equal(past.yearsFrom, 'straddle')
  assert.ok(close(past.years * 365, 3, 1e-4))
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

test('the IV is the premium\'s, not Dhan\'s field: an odd premium takes the ATM IV, Dhan\'s IV only where no premium gives one', () => {
  // No expiry date and no Dhan IV for the ATM: no time to expiry yet - the minute is left out until there is one.
  const d = day({ minutes: 3, ivField: (m) => (m === 0 ? 0 : 12) })
  assert.deepEqual(gexDay(d.ce, d.pe, d.spots).map((m) => m.time), [OPEN + MIN, OPEN + 2 * MIN])
  // With the expiry date, the premiums give the IV - Dhan's IV field is not needed at all.
  assert.equal(gexDay(d.ce, d.pe, d.spots, { expiry: '2026-10-23' }).length, 3)
  const unit = 25000 * 25000 * 0.01
  // Dhan's IV field wrong everywhere (here 90%): no effect - the premiums say 12%.
  const wrong = day({ minutes: 1, ivField: () => 90 })
  const [w] = gexDay(wrong.ce, wrong.pe, wrong.spots, { expiry: '2026-10-23' })
  const [right] = gexDay(day({ minutes: 1 }).ce, day({ minutes: 1 }).pe, day({ minutes: 1 }).spots, { expiry: '2026-10-23' })
  assert.ok(close(w.net, right.net, Math.abs(right.net) * 1e-9))
  // A stale print: the 25400 call (the leg out of the money there) at forty times its premium - an IV over twice the ATM
  // one - so the strike takes the ATM IV.
  const premium = 40 * call(25000, 25400, 0.12, YEARS)
  const stale = day({ minutes: 1, price: (side, k) => (side === 'ce' && k === 25400 ? premium : null) })
  const [st] = gexDay(stale.ce, stale.pe, stale.spots)
  assert.ok(impliedVol(premium, st.forward, 25400, st.years, true) > 2 * st.atmIv)
  const row = st.strikes.find((r) => r.strike === 25400)
  assert.ok(close(row.call, bsGamma(25000, 25400, st.atmIv, st.years) * 1e6 * unit, 1))
  // No premium gives an IV - the 24600 put (out of the money there) not traded, the call below its 400 intrinsic - so
  // Dhan's IV for the strike (15%) is the fallback.
  assert.equal(impliedVol(300, 25000, 24600, YEARS, true), null)
  const none = day({ minutes: 1 })
  none.pe.find((p) => p.strike === 24600).price = 0
  Object.assign(none.ce.find((p) => p.strike === 24600), { price: 300, impliedVolatility: 15 })
  const [n] = gexDay(none.ce, none.pe, none.spots)
  const r600 = n.strikes.find((r) => r.strike === 24600)
  assert.equal(r600.put, null)
  assert.ok(close(r600.call, bsGamma(25000, 24600, 0.15, n.years, n.forward) * 1e6 * unit, 1))
})

test('the two signs side by side: agree on a regime, or say they do not', () => {
  assert.deepEqual(gexAgreement({ net: 5 }, { net: 1 }), { standard: 'positive', buildup: 'positive', agree: true, regime: 'positive' })
  assert.deepEqual(gexAgreement({ net: -5 }, { net: -1 }), { standard: 'negative', buildup: 'negative', agree: true, regime: 'negative' })
  assert.deepEqual(gexAgreement({ net: 5 }, { net: -1 }), { standard: 'positive', buildup: 'negative', agree: false, regime: null })
  assert.deepEqual(gexAgreement(undefined, { net: 1 }), { standard: null, buildup: 'positive', agree: false, regime: null })
  // On a day: OI written all day (premiums falling) - both signs positive; bought all day - they part.
  const run = (dir) => {
    const d = day({ minutes: 20, ceOi: (k, m) => 1e6 + 4e5 * m, peOi: (k, m) => 1e6 + 4e5 * m, price: (side, k, m) => 40 + 80 * Math.exp(-(((k - 25000) / 150) ** 2)) + dir * m })
    return gexAgreement(gexDay(d.ce, d.pe, d.spots).at(-1), gexDay(d.ce, d.pe, d.spots, { sign: 'buildup' }).at(-1))
  }
  assert.equal(run(-1).buildup, 'positive')
  assert.equal(run(+1).buildup, 'negative')
})

test('the call wall is at or above spot, the put wall at or below - a big call OI under spot is no resistance', () => {
  // The biggest call OI sits at 24800 (under spot), the biggest put OI at 25200 (over it).
  const d = day({ ceOi: (k) => (k === 24800 ? 9e6 : k === 25150 ? 3e6 : 1e6), peOi: (k) => (k === 25200 ? 9e6 : k === 24850 ? 3e6 : 1e6) })
  const [m] = gexDay(d.ce, d.pe, d.spots)
  assert.ok(m.callWall >= m.spot, `call wall ${m.callWall}`)
  assert.ok(m.putWall <= m.spot, `put wall ${m.putWall}`)
  assert.equal(m.callWall, 25150)
  assert.equal(m.putWall, 24850)
  // The max gamma strike may be anywhere - the most call + put gamma x OI.
  const weight = (k) => bsGamma(25000, k, 0.12, m.years) * ((k === 24800 ? 9e6 : k === 25150 ? 3e6 : 1e6) + (k === 25200 ? 9e6 : k === 24850 ? 3e6 : 1e6))
  assert.equal(m.maxGamma, [...STRIKES].sort((a, b) => weight(b) - weight(a))[0])
})

test('a wall moves only to a strike with 10% more gamma x OI - two strikes about level no longer swap it every minute', () => {
  // 25150 and 25200 calls carry the same gamma x OI, then each minute one is 3% ahead of the other, turn about.
  const g = (k) => bsGamma(25000, k, 0.12, YEARS)
  const base = 2e7
  const oi = (k, m) => {
    if (k === 25150) return base * (m % 2 ? 1.03 : 0.97)
    if (k === 25200) return base * (g(25150) / g(25200)) * (m % 2 ? 0.97 : 1.03) * (m >= 12 ? 1.3 : 1)
    return 1e6
  }
  const d = day({ minutes: 20, ceOi: oi })
  const walls = gexDay(d.ce, d.pe, d.spots).map((m) => m.callWall)
  // The first minute's leader holds it through the swaps...
  assert.ok(walls.slice(0, 12).every((w) => w === walls[0]), walls.join(' '))
  // ...until 25200 is clearly ahead (+30%) - then it moves, at once.
  assert.equal(walls[12], 25200)
  assert.ok(walls.slice(12).every((w) => w === 25200))
  // Without the 10% rule it would have swapped every minute: the raw leader alternates.
  const leaders = Array.from({ length: 12 }, (_, m) => (g(25150) * oi(25150, m) > g(25200) * oi(25200, m) ? 25150 : 25200))
  assert.ok(new Set(leaders).size === 2)
})

test('spot through the call wall rolls it on to the next strike above at once', () => {
  const d = day({ minutes: 10, spot: (m) => (m < 5 ? 25000 : 25180), ceOi: (k) => (k === 25150 ? 2e7 : k === 25300 ? 1.2e7 : 1e6) })
  const minutes = gexDay(d.ce, d.pe, d.spots)
  assert.equal(minutes[4].callWall, 25150)
  assert.ok(minutes[5].callWall > 25180, `rolled to ${minutes[5].callWall}`)
  assert.equal(minutes[5].callWall, 25300)
})

test('the flip stays inside the strikes loaded - a crossing only past them is no flip', () => {
  // Three strikes only: puts heavy at 24950, calls at 25050. Inside 24950 - 25050 the net stays negative; it turns positive
  // only past 25050, where strikes not loaded would weigh in.
  const strikes = [24950, 25000, 25050]
  const d = day({ minutes: 1, strikes, ceOi: (k) => (k === 25050 ? 8e6 : 1e5), peOi: (k) => (k === 24950 ? 9e6 : 1e5) })
  const [m] = gexDay(d.ce, d.pe, d.spots)
  assert.deepEqual(m.band, [24950, 25050])
  const profile = gexProfile(m)
  assert.ok(profile.every((p) => p.net < 0), 'negative across the strikes loaded')
  assert.ok(netGexAt(m.options, 25400, m.years) > 0, 'positive well past them')
  assert.equal(m.flip, null)
})

test('the GEX profile crosses zero at the flip; a flip near the edge of the strikes loaded is marked rough', () => {
  const d = day({ ceOi: (k) => (k >= 25100 ? 6e6 : 5e5), peOi: (k) => (k <= 24900 ? 6e6 : 5e5) })
  const [m] = gexDay(d.ce, d.pe, d.spots)
  const profile = gexProfile(m)
  assert.equal(profile.length, 81)
  assert.equal(profile[0].price, 24500)
  assert.equal(profile.at(-1).price, 25500)
  const i = profile.findIndex((p, j) => j > 0 && Math.sign(p.net) !== Math.sign(profile[j - 1].net) && Math.abs(p.price - m.flip) < 50)
  assert.ok(i > 0 && m.flip >= profile[i - 1].price && m.flip <= profile[i].price, `flip ${m.flip}`)
  assert.equal(m.flipEdge, false)
  // Only three strikes loaded: any flip among them sits within a 1-sigma move of their edge - rough.
  const narrow = day({ minutes: 1, strikes: [24950, 25000, 25050], ceOi: (k) => (k === 25050 ? 9.3e6 : 1e5), peOi: (k) => (k === 24950 ? 9e6 : 1e5) })
  const [e] = gexDay(narrow.ce, narrow.pe, narrow.spots)
  assert.ok(e.flip != null && e.flip > 24950 && e.flip < 25050, `flip ${e.flip}`)
  assert.equal(e.flipEdge, true)
})


test('spot wiggling across a big strike does not swap the walls; a clear break past it does', () => {
  // A big strike at 25000 (calls and puts); spot 25000 +/- 8 - inside the quarter-step (12.5) dead zone - then 25040.
  const ceOi = (k) => (k === 25000 ? 2e7 : k === 25150 ? 6e6 : 1e6)
  const peOi = (k) => (k === 25000 ? 2e7 : k === 24850 ? 6e6 : 1e6)
  const d = day({ minutes: 16, spot: (m) => (m < 10 ? 25000 + (m % 2 ? 8 : -8) : 25040), ceOi, peOi })
  const minutes = gexDay(d.ce, d.pe, d.spots)
  // At the money the big strike is the magnet, not a wall - and the walls hold while spot wiggles.
  for (const m of minutes.slice(0, 10)) {
    assert.equal(m.maxGamma, 25000)
    assert.equal(m.callWall, 25150)
    assert.equal(m.putWall, 24850)
  }
  // Spot clear above it (25040): 25000 is now support - the put wall - and the call wall holds.
  for (const m of minutes.slice(10)) {
    assert.equal(m.putWall, 25000)
    assert.equal(m.callWall, 25150)
  }
})

test('flips: false leaves only the flip out - the net and the levels are the same', () => {
  const d = day({ minutes: 8, spot: (m) => 25000 + 10 * m, ceOi: (k) => (k >= 25100 ? 6e6 : 5e5), peOi: (k) => (k <= 24900 ? 6e6 : 5e5) })
  const full = gexDay(d.ce, d.pe, d.spots, { sign: 'buildup' })
  const lean = gexDay(d.ce, d.pe, d.spots, { sign: 'buildup', flips: false })
  assert.ok(full.some((m) => m.flip != null))
  assert.ok(lean.every((m) => m.flip == null && m.flipEdge === false))
  assert.deepEqual(lean.map((m) => [m.net, m.callWall, m.putWall, m.maxGamma]), full.map((m) => [m.net, m.callWall, m.putWall, m.maxGamma]))
})

test('the forward comes from put-call parity at the strikes nearest spot, and gamma is centred on it', () => {
  // BANKNIFTY-like, 14 days out, carry 6.5%: the forward is spot x e^(rT) - about 136 points above spot.
  const S = 54600, T = 14 / 365, F = S * Math.exp(0.065 * T), sigma = 0.13
  const strikes = Array.from({ length: 21 }, (_, i) => 53600 + 100 * i)
  const time = new Date(OPEN).toISOString()
  const ce = [], pe = []
  for (const k of strikes) {
    const c = call(F, k, sigma, T)   // on the forward, undiscounted (Black-76)
    ce.push({ time, strike: k, price: c, openInterest: k === 55000 ? 3e6 : 6e5, impliedVolatility: 13 })
    pe.push({ time, strike: k, price: c - (F - k), openInterest: k === 54000 ? 3.2e6 : 6e5, impliedVolatility: 13 })
  }
  const [m] = gexDay(ce, pe, [{ time: OPEN, close: S }], { expiry: '2026-11-03' })
  assert.ok(close(m.forward, F, 1e-6), `forward ${m.forward} vs ${F}`)
  assert.ok(close(m.carry, F / S, 1e-9))
  // Every strike's gamma is Black-Scholes on that forward, at the IV its premium gives (13% - priced on the expiry's T).
  const unit = S * S * 0.01
  for (const r of m.strikes) {
    const g = bsGamma(S, r.strike, sigma, T, F)
    // The time to the expiry date differs from the 14 days priced; the IV from the premium makes up for it exactly.
    const gExpiry = bsGamma(S, r.strike, sigma * Math.sqrt(T / m.years), m.years, F)
    assert.ok(close(g, gExpiry, Math.abs(g) * 1e-6))
    assert.ok(close(r.call, g * r.ceOi * unit, Math.abs(r.call) * 1e-6 + 1))
  }
  // Centred on the forward, not spot: gamma at 54700 (64 below the forward) beats 54600 (spot, 136 below).
  assert.ok(bsGamma(S, 54700, sigma, T, F) > bsGamma(S, 54600, sigma, T, F))
  assert.ok(bsGamma(S, 54700, sigma, T) < bsGamma(S, 54600, sigma, T)) // the old, carry-less centring had it the other way
})

test('parityForward: the middle of the three nearest strikes; spot when there is none or it is more than 2% off', () => {
  const pairs = [
    { strike: 25000, call: 120, put: 100 },   // 25020
    { strike: 25050, call: 95, put: 120 },    // 25025
    { strike: 24950, call: 160, put: 70 },    // 25040 - a stale print
    { strike: 25500, call: 5, put: 400 },     // far: not used
  ]
  assert.equal(parityForward(pairs, 25010), 25025)
  assert.equal(parityForward([], 25010), 25010)
  assert.equal(parityForward([{ strike: 25000, call: 900, put: 10 }], 25010), 25010) // 25890 - over 2% off
  assert.equal(parityForward([{ strike: 25000, call: 120, put: 100 }, { strike: 25050, call: 95, put: 120 }], 25010), 25022.5)
})

