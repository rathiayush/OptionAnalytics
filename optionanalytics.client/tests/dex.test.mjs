// OI Replay's DEALER HEDGING (DEX) card (dex.js): the dealers' delta from the day's GEX minutes - the index they must buy /
// sell for a 1% move, a vol point of IV (vanna) and time passing (charm), the DEX flip - checked against Black-76 worked out
// directly, the GEX it must agree with, the signs, and no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gexDay } from '../src/gex.js'
import { CRORE, dealerDelta, dexAt, dexDay, dexProfile, dexRead, dexUpTo, optionDelta } from '../src/dex.js'

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

test('a delta is the slope of the Black-76 price to spot (carry included); the dealers\' delta adds OI x delta', () => {
  const S = 25000, K = 25200, sigma = 0.13, T = 5 / 365, carry = 1.002
  for (const call of [true, false]) {
    const h = 0.5
    const slope = (black76((S + h) * carry, K, sigma, T, call) - black76((S - h) * carry, K, sigma, T, call)) / (2 * h)
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
  assert.match(dexRead(m)[0].text, /AGAINST moves/)
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
  assert.match(dexRead(m)[0].text, /CHASE/)
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
