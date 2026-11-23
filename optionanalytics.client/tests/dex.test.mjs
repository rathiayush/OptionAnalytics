// OI Replay's DEALER HEDGING (DEX) card (dex.js): the dealers' delta from the day's GEX minutes - the index they must buy /
// sell for a 1% move, a vol point of IV (vanna) and time passing (charm), the DEX flip - checked against Black-76 worked out
// directly, the GEX it must agree with, the signs, and no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gexDay } from '../src/gex.js'
import { CRORE, dealerDelta, dexAt, dexDay, dexProfile, dexRead, dexStrikes, dexUpTo, dexWalls, optionDelta } from '../src/dex.js'

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

// A day priced with Black-76 at a flat 12% IV; OI by strike (`oi(k, isCall, m)`).
function chain({ minutes = 60, spot = () => 25000, oi = () => 1e6 }) {
  const ce = [], pe = [], spots = []
  for (let m = 0; m < minutes; m++) {
    const t = T0 + m * MIN
    const F = spot(m)
    const T = YEARS0 - (m * MIN) / (365 * 86_400_000)
    spots.push({ time: t, close: F })
    for (let k = 24500; k <= 25500; k += 50) {
      const time = new Date(t).toISOString()
      ce.push({ time, strike: k, price: black76(F, k, 0.12, T, true), openInterest: oi(k, true, m) })
      pe.push({ time, strike: k, price: black76(F, k, 0.12, T, false), openInterest: oi(k, false, m) })
    }
  }
  return { ce, pe, spots }
}

test('a delta is the slope of the DISCOUNTED Black-76 price to spot (the carry cancels the discount); the dealers\' delta adds OI x delta', () => {
  const S = 25000, K = 25200, sigma = 0.13, T = 30 / 365, carry = Math.exp(0.065 * 30 / 365)
  for (const call of [true, false]) {
    const h = 0.5
    const price = (s) => black76(s * carry, K, sigma, T, call) / carry   // e^-rT x Black-76 on the forward
    const slope = (price(S + h) - price(S - h)) / (2 * h)
    assert.ok(Math.abs(optionDelta(call, S, K, sigma, T, carry) - slope) < 1e-3, `${call} ${optionDelta(call, S, K, sigma, T, carry)} vs ${slope}`)
  }
  // At expiry: the intrinsic step.
  assert.equal(optionDelta(true, 25000, 24900, 0.12, 0), 1)
  assert.equal(optionDelta(false, 25000, 24900, 0.12, 0), 0)
  const options = [{ strike: 25000, call: true, sigma: 0.12, dealerOi: 1000 }, { strike: 25000, call: false, sigma: 0.12, dealerOi: -500 }, { strike: 25000, sigma: 0.12, dealerOi: 9e9 }]
  const d = dealerDelta(options, 25000, { years: T })
  assert.ok(Math.abs(d - (1000 * optionDelta(true, 25000, 25000, 0.12, T) - 500 * optionDelta(false, 25000, 25000, 0.12, T))) < 1e-9, 'an option with no call flag is left out')
})

test('the standard sign: dealers lean against moves - a 1% rally = selling, a fall = buying, about the net GEX; no flip', () => {
  const d = chain({ oi: (k, isCall) => (isCall ? 2e6 : 1e6) })
  const gex = gexDay(d.ce, d.pe, d.spots, { expiry: EXPIRY })
  const day = dexDay(gex)
  assert.equal(day.length, gex.length)
  const m = day[0], g = gex[0]
  assert.ok(g.net > 0)
  assert.ok(m.up < 0 && m.down > 0, `up ${m.up} down ${m.down}`)
  // The average of the two moves is the gamma slope's: within a few % of the net GEX (rupees per 1% move).
  assert.ok(Math.abs((m.down - m.up) / 2 - g.net) < 0.05 * g.net, `${(m.down - m.up) / 2} vs ${g.net}`)
  // Long every call, short every put: both long delta - the book never crosses zero.
  assert.ok(m.net > 0)
  assert.equal(m.flip, null)
  assert.match(dexRead(m).find((r) => r.key === 'move').text, /AGAINST moves/)
  // Each flow worked out directly.
  const opts = { years: g.years, carry: g.carry }
  const base = dealerDelta(g.options, g.spot, opts)
  assert.ok(Math.abs(m.vanna - -(dealerDelta(g.options, g.spot, { ...opts, volShift: -0.01 }) - base) * g.spot) < 1)
  assert.ok(Math.abs(m.charmHour - -(dealerDelta(g.options, g.spot, { ...opts, dt: 1 / (365 * 24) }) - base) * g.spot) < 1)
  assert.equal(m.minutesToClose, 375)
  // At 15:30 there is nothing left to decay to the close.
  assert.equal(dexAt({ ...g, time: Date.parse('2026-11-16T15:30:00+05:30') }).charmClose, 0)
})

test('charm and vanna signs: dealers long out-of-the-money calls BUY as time passes and as IV falls; short them, SELL', () => {
  const S = 25000
  const minute = (sign) => ({
    time: T0, spot: S, years: YEARS0, carry: 1, atmIv: 0.12, band: [25000, 25500],
    options: [25200, 25300, 25400].map((strike) => ({ strike, call: true, sigma: 0.12, dealerOi: sign * 1e6 })),
  })
  const long = dexAt(minute(1)), short = dexAt(minute(-1))
  assert.ok(long.charmClose > 0 && long.charmHour > 0 && long.vanna > 0, JSON.stringify(long))
  assert.ok(short.charmClose < 0 && short.vanna < 0)
  assert.ok(long.charmClose > long.charmHour, 'more decays by the close than in an hour')
  const read = dexRead(long)
  assert.match(read.find((r) => r.key === 'charm').text, /BUY|buying/)
  assert.match(read.find((r) => r.key === 'vanna').text, /BUY|buying/)
  assert.notEqual(read.find((r) => r.key === 'vanna').tone, 'bear')
  assert.equal(dexRead(null).length, 0)
})

test('the DEX flip: where the dealers\' delta crosses zero - short calls above, short puts below cross at the money', () => {
  const minute = {
    time: T0, spot: 25040, years: YEARS0, carry: 1, atmIv: 0.12, band: [24500, 25500],
    options: [],
  }
  for (let k = 24500; k <= 25500; k += 50) {
    minute.options.push({ strike: k, call: true, sigma: 0.12, dealerOi: -1e6 })
    minute.options.push({ strike: k, call: false, sigma: 0.12, dealerOi: -1e6 })
  }
  const m = dexAt(minute)
  assert.ok(m.flip != null && Math.abs(m.flip - 25000) < 60, `flip ${m.flip}`)
  assert.ok(Math.abs(dealerDelta(minute.options, m.flip, { years: YEARS0 })) < 0.02 * Math.abs(dealerDelta(minute.options, 25400, { years: YEARS0 })))
  // Short gamma: they chase moves.
  assert.ok(m.up > 0 && m.down < 0)
  assert.match(dexRead(m).find((r) => r.key === 'move').text, /CHASE/)
  // The profile crosses zero there.
  const profile = dexProfile(minute)
  assert.ok(profile.length === 81 && profile[0].net > 0 && profile.at(-1).net < 0)
  assert.equal(dexAt(minute, { flips: false }).flip, null)
})

test('no look-ahead: the day cut at any clock = the whole day up to it, under the build-up sign too', () => {
  const d = chain({ minutes: 50, spot: (m) => 25000 + m * 4, oi: (k, isCall, m) => (isCall ? 2e6 : 1e6) + (isCall && k > 25100 ? m * 2e4 : 0) + (!isCall && k < 24900 ? m * 1e4 : 0) })
  for (const sign of ['standard', 'buildup']) {
    const whole = dexDay(gexDay(d.ce, d.pe, d.spots, { expiry: EXPIRY, sign }))
    for (const cut of [5, 25, 45]) {
      const until = T0 + cut * MIN
      const part = dexDay(gexDay(d.ce.filter((p) => Date.parse(p.time) <= until), d.pe.filter((p) => Date.parse(p.time) <= until), d.spots.filter((s) => s.time <= until), { expiry: EXPIRY, sign }))
      assert.deepEqual(part, dexUpTo(whole, until), `${sign} @${cut}`)
    }
    assert.equal(dexUpTo(whole, null), whole)
  }
  // Rupees: a crore read at the scale the card shows.
  assert.ok(Math.abs(dexDay(gexDay(d.ce, d.pe, d.spots, { expiry: EXPIRY }))[0].up) / CRORE > 0.01)
})

test('DEX by strike: each strike\'s calls + puts in rupees, expiries summed; the strikes add up to the net', () => {
  const options = [
    { strike: 25000, call: true, sigma: 0.12, dealerOi: 1e5 }, { strike: 25000, call: false, sigma: 0.12, dealerOi: -2e5 },
    { strike: 25100, call: true, sigma: 0.12, dealerOi: 3e5 }, { strike: 25100, call: true, sigma: 0.12, dealerOi: 1e5, years: YEARS0 * 3 },
  ]
  const rows = dexStrikes(options, 25040, { years: YEARS0 })
  assert.deepEqual(rows.map((r) => r.strike), [25000, 25100])
  const d = (call, K, oi, T = YEARS0) => oi * optionDelta(call, 25040, K, 0.12, T) * 25040
  assert.ok(Math.abs(rows[0].call - d(true, 25000, 1e5)) < 1e-6)
  assert.ok(Math.abs(rows[0].put - d(false, 25000, -2e5)) < 1e-6)
  assert.ok(Math.abs(rows[1].call - (d(true, 25100, 3e5) + d(true, 25100, 1e5, YEARS0 * 3))) < 1e-6, 'the other expiry at its own time')
  const total = rows.reduce((a, r) => a + r.net, 0)
  assert.ok(Math.abs(total - dealerDelta(options, 25040, { years: YEARS0 }) * 25040) < 1e-6)
})

test('DEX walls: the most |dealer delta| above / below spot and of all; held unless 10% beaten; a quarter-step dead zone', () => {
  const rows = (vals) => Object.entries(vals).map(([k, net]) => ({ strike: Number(k), call: 0, put: 0, net }))
  const book = rows({ 24900: 5, 24950: -9, 25000: 20, 25050: 3, 25100: -12, 25150: 7 })
  assert.deepEqual(dexWalls(book, 25020), { resistance: 25100, support: 25000, max: 25000 })
  // Spot within a quarter step of 25000 (12.5): neither above nor below - the walls step past it.
  assert.deepEqual(dexWalls(book, 25005), { resistance: 25100, support: 24950, max: 25000 })
  // A new leader only 5% bigger does not take over a held wall; 15% does.
  const close = rows({ 24900: 5, 24950: -9, 25000: 20, 25050: 3, 25100: -12, 25150: 12.6 })
  assert.equal(dexWalls(close, 25020, { resistance: 25100 }).resistance, 25100)
  const beaten = rows({ 24900: 5, 24950: -9, 25000: 20, 25050: 3, 25100: -12, 25150: 13.9 })
  assert.equal(dexWalls(beaten, 25020, { resistance: 25100 }).resistance, 25150)
  // A held support is kept until spot is a quarter step through it.
  assert.equal(dexWalls(book, 24995, { support: 25000 }).support, 25000)
  assert.equal(dexWalls(book, 24985, { support: 25000 }).support, 24950)
  assert.deepEqual(dexWalls([], 25000), { resistance: null, support: null, max: null })
})

test('the day carries its walls minute to minute; a cut equals the whole day up to it', () => {
  const d = chain({ minutes: 30, spot: (m) => 25000 + m * 6, oi: (k, isCall, m) => (isCall ? 2e6 : 1e6) + (k === 25200 && isCall ? m * 5e4 : 0) })
  const whole = dexDay(gexDay(d.ce, d.pe, d.spots, { expiry: EXPIRY, sign: 'buildup' }))
  assert.ok(whole.every((m) => m.strikes.length > 0 && 'resistance' in m.walls))
  assert.ok(whole.some((m) => m.walls.resistance != null && m.walls.resistance > m.spot))
  assert.ok(whole.every((m) => m.walls.support == null || m.walls.support < m.spot + 12.5))
  const until = T0 + 15 * MIN
  const part = dexDay(gexDay(d.ce.filter((p) => Date.parse(p.time) <= until), d.pe.filter((p) => Date.parse(p.time) <= until), d.spots.filter((s) => s.time <= until), { expiry: EXPIRY, sign: 'buildup' }))
  assert.deepEqual(part, dexUpTo(whole, until))
})

test('the published DEX (Standard): dealers short every option - calls −, puts +, offsetting; the flows stay on the GEX book', () => {
  // Calls heavy above the money, puts heavy below - as a real chain.
  const d = chain({ oi: (k, isCall) => (isCall ? (k >= 25000 ? 3e6 : 0.5e6) : (k <= 25000 ? 3e6 : 0.5e6)) })
  const gex = gexDay(d.ce, d.pe, d.spots, { expiry: EXPIRY })
  const g = gex[0]
  const market = dexAt(g, { positions: 'market' })
  const dealer = dexAt(g, { positions: 'dealer' })
  // Each strike = -(call OI x call delta + put OI x put delta) x spot: a call-heavy strike negative, a put-heavy one positive.
  for (const row of market.strikes) {
    const want = -g.options.filter((o) => o.strike === row.strike)
      .reduce((t, o) => t + o.oi * optionDelta(o.call, g.spot, o.strike, o.sigma, o.years, o.carry), 0) * g.spot
    assert.ok(Math.abs(row.net - want) < 1, `${row.strike}`)
  }
  assert.ok(market.strikes.find((r) => r.strike === 25100).net < 0, 'call-heavy strike negative')
  assert.ok(market.strikes.find((r) => r.strike === 24900).net > 0, 'put-heavy strike positive')
  assert.ok(market.strikes.find((r) => r.strike === 25100).call < 0 && market.strikes.find((r) => r.strike === 24900).put > 0)
  // The old book (dealers long calls, short puts) had every strike positive and no flip; this one crosses zero near the money.
  assert.ok(dealer.strikes.every((r) => r.net >= 0))
  assert.equal(dealer.flip, null)
  assert.ok(market.flip != null && Math.abs(market.flip - 25000) < 300, `flip ${market.flip}`)
  const profile = dexProfile(g, 80, 'market')
  assert.ok(profile[0].net > 0 && profile.at(-1).net < 0, 'put-heavy below = long delta, call-heavy above = short')
  // The hedging flows are the GEX book's under both.
  for (const k of ['up', 'down', 'vanna', 'charmHour', 'charmClose']) assert.equal(market[k], dealer[k], k)
  assert.equal(market.positions, 'market')
  assert.match(dexRead(market).find((r) => r.key === 'net').text, market.net > 0 ? /LONG/ : /SHORT/)
  // The day under the market book: every minute's net = its strikes' sum.
  for (const m of dexDay(gex, { positions: 'market' })) {
    assert.ok(Math.abs(m.strikes.reduce((t, r) => t + r.net, 0) - m.net) < 1e-3 * Math.max(1, Math.abs(m.net)))
  }
})
