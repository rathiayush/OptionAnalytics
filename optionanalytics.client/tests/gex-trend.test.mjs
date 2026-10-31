// OI Replay's GEX smart detection (gexTrend.js): the net GEX and spot over the last `window` minutes matched to the
// trader's truth table - every row, the pairs the table has no row for, the near-zero band, the window, and nothing after
// the minute read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GEX_TREND_TABLE, gexTrend, gexTrendDay, grossGex } from '../src/gexTrend.js'
import { gexDay } from '../src/gex.js'

const MIN = 60_000
const OPEN = Date.parse('2026-10-20T09:15:00+05:30')
const CR = 1e7

// Minutes from (net, spot) pairs a minute apart; gross GEX 1000 Cr unless given.
const series = (points, gross = 1000 * CR) => points.map(([net, spot], i) => ({
  time: OPEN + i * MIN, net: net * CR, spot, calls: gross / 2, puts: -gross / 2,
}))
// A straight line from `a` to `b` over `n` + 1 minutes.
const line = (n, [netA, spotA], [netB, spotB]) => Array.from({ length: n + 1 }, (_, i) => [netA + ((netB - netA) * i) / n, spotA + ((spotB - spotA) * i) / n])

test('every row of the table: the GEX and price behaviour over the window give the trader\'s read', () => {
  const cases = [
    [[-300, 25000], [200, 24900], 'Potential stabilisation, bearish pressure still active'],
    [[-300, 25000], [200, 25100], 'Potential bullish transition'],
    [[200, 25000], [400, 24900], 'Potential stabilisation, but bearish acceptance possible'],
    [[200, 25000], [400, 25100], 'Potentially stable bullish trend'],
    [[300, 25000], [-200, 24900], 'Potential downside acceleration'],
    [[300, 25000], [-200, 25100], 'Potential upside acceleration'],
    [[-200, 25000], [-400, 24900], 'Strong bearish gamma regime'],
    [[-200, 25000], [-400, 25100], 'Strong bullish gamma regime'],
    [[150, 25000], [30, 25005], 'Possible low-gamma / transitional environment'],
  ]
  for (const [from, to, read] of cases) {
    const t = gexTrend(series(line(15, from, to)), { window: 15 })
    assert.equal(t.read, read, `${from} -> ${to}`)
    assert.ok(t.row && GEX_TREND_TABLE.includes(t.row))
  }
  assert.equal(new Set(cases.map((c) => c[2])).size, GEX_TREND_TABLE.length)
})

test('a pair the table has no row for is named, with no read made up', () => {
  const shrinking = gexTrend(series(line(15, [400, 25000], [200, 25100])), { window: 15 })
  assert.equal(shrinking.gex, 'posShrinking')
  assert.equal(shrinking.price, 'rising')
  assert.equal(shrinking.row, null)
  assert.equal(shrinking.read, null)
  const sidewaysCross = gexTrend(series(line(15, [-300, 25000], [200, 25005])), { window: 15 })
  assert.equal(sidewaysCross.gexLabel, 'Negative → Positive')
  assert.equal(sidewaysCross.priceLabel, 'Sideways')
  assert.equal(sidewaysCross.row, null)
  const steady = gexTrend(series(line(15, [-300, 25000], [-310, 24900])), { window: 15 })
  assert.equal(steady.gex, 'negSteady')
})

test('near zero is within 10% of the gross GEX; a wiggle across zero from inside that band is no change of sign', () => {
  // Gross 1000 Cr: the band is 100 Cr.
  const wiggle = gexTrend(series(line(15, [-60, 25000], [80, 25000])), { window: 15 })
  assert.equal(wiggle.gex, 'nearZero')
  const out = gexTrend(series(line(15, [-60, 25000], [180, 25000])), { window: 15 })
  assert.equal(out.gex, 'posGrowing')
  const cross = gexTrend(series(line(15, [-160, 25000], [40, 25000])), { window: 15 })
  assert.equal(cross.gex, 'negToPos')
  // The gross is every strike's call and put counted positive.
  assert.equal(grossGex({ strikes: [{ call: 5, put: -3 }, { call: -2, put: null }] }), 10)
})

test('increasing = 10% of its size away from zero; less is steady; price moves of 0.1% of spot', () => {
  assert.equal(gexTrend(series(line(15, [-500, 25000], [-540, 25000])), { window: 15 }).gex, 'negSteady')
  assert.equal(gexTrend(series(line(15, [-500, 25000], [-560, 25000])), { window: 15 }).gex, 'negGrowing')
  assert.equal(gexTrend(series(line(15, [-500, 25000], [-440, 25000])), { window: 15 }).gex, 'negShrinking')
  assert.equal(gexTrend(series(line(15, [300, 25000], [300, 25024])), { window: 15 }).price, 'sideways')
  assert.equal(gexTrend(series(line(15, [300, 25000], [300, 25026])), { window: 15 }).price, 'rising')
  assert.equal(gexTrend(series(line(15, [300, 25000], [300, 24974])), { window: 15 }).price, 'falling')
})

test('the window: nothing before its first full span; then from the minute that many minutes back', () => {
  const minutes = series(line(30, [-300, 25000], [300, 25100]))
  const early = gexTrend(minutes.slice(0, 10), { window: 15 })
  assert.equal(early.warming, true)
  assert.equal(early.needFrom, OPEN + 15 * MIN)
  const t = gexTrend(minutes, { window: 15 })
  assert.equal(t.from, OPEN + 15 * MIN)
  assert.equal(t.to, OPEN + 30 * MIN)
  // Over the last 15 minutes the net only grew (it crossed zero at minute 15): positive increasing, not the change of sign.
  assert.equal(t.gex, 'posGrowing')
  // The whole half hour: the change of sign.
  assert.equal(gexTrend(minutes, { window: 30 }).gex, 'negToPos')
  // A gap: the window starts at the last minute at or before its span.
  const gappy = minutes.filter((m, i) => i < 10 || i > 18)
  assert.equal(gexTrend(gappy, { window: 15 }).from, OPEN + 9 * MIN)
  assert.equal(gexTrend(null), null)
})

test('nothing after the minute read: each minute\'s detection is the same with the later minutes added', () => {
  const minutes = series([...line(20, [-300, 25000], [250, 25150]), ...line(20, [250, 25150], [-200, 24950]).slice(1)])
  const all = gexTrendDay(minutes, { window: 10 })
  for (let i = 0; i < minutes.length; i++) {
    assert.deepEqual(gexTrendDay(minutes.slice(0, i + 1), { window: 10 })[i], all[i], `minute ${i}`)
  }
})

test('since: the first minute of the run of the same pair up to now', () => {
  // Flat for 20 minutes (positive, steady, sideways), then GEX and spot climb for 10.
  const minutes = series([...Array.from({ length: 21 }, () => [300, 25000]), ...line(10, [300, 25000], [700, 25150]).slice(1)])
  const t = gexTrend(minutes, { window: 5 })
  assert.equal(t.read, 'Potentially stable bullish trend')
  const day = gexTrendDay(minutes, { window: 5 })
  const firstBull = day.findIndex((d) => d?.row?.read === 'Potentially stable bullish trend')
  assert.equal(t.since, minutes[firstBull].time)
  assert.ok(day.slice(firstBull).every((d) => d.row?.read === 'Potentially stable bullish trend'))
  // Before it the pair had no row in the table (steady and sideways): no earlier read.
  assert.equal(t.previous, null)
})

test('previous: the read from the table before the one now, with its run - the trend so far', () => {
  // GEX deepens below zero while spot falls for 15 minutes, then climbs back above zero as spot recovers.
  const minutes = series([...line(15, [-200, 25000], [-500, 24850]), ...line(15, [-500, 24850], [200, 24950]).slice(1)])
  const t = gexTrend(minutes, { window: 10 })
  assert.equal(t.read, 'Potential bullish transition')
  assert.equal(t.previous.read, 'Strong bearish gamma regime')
  const day = gexTrendDay(minutes, { window: 10 })
  const bearish = day.map((d, i) => (d?.row?.read === 'Strong bearish gamma regime' ? i : -1)).filter((i) => i >= 0)
  assert.equal(t.previous.since, minutes[bearish[0]].time)
  assert.equal(t.previous.until, minutes[bearish.at(-1)].time)
  assert.ok(t.previous.until < t.since)
  // The path: every read from the table so far, in order, ending with the one now.
  const reads = t.path.map((run) => run.read)
  assert.equal(reads.at(-1), 'Potential bullish transition')
  assert.ok(reads.indexOf('Strong bearish gamma regime') < reads.indexOf('Potential bullish transition'))
  assert.ok(t.path.every((run, i) => run.since <= run.until && (i === 0 || t.path[i - 1].until < run.since)))
  assert.equal(t.path.at(-1).since, t.since)
})

test('on gexDay\'s minutes: call OI building over put OI while spot rises reads as a bullish transition', () => {
  const STRIKES = Array.from({ length: 21 }, (_, i) => 24500 + 50 * i)
  const phi = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
  const cdf = (x) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x))
    const tail = phi(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    return x >= 0 ? 1 - tail : tail
  }
  const callPrice = (S, K, s, T) => { const v = s * Math.sqrt(T); const d1 = (Math.log(S / K) + v * v / 2) / v; return S * cdf(d1) - K * cdf(d1 - v) }
  const ce = [], pe = [], spots = []
  for (let m = 0; m <= 30; m++) {
    const time = new Date(OPEN + m * MIN).toISOString()
    const S = 24950 + (100 * m) / 30
    spots.push({ time: OPEN + m * MIN, close: S })
    for (const k of STRIKES) {
      const c = callPrice(S, k, 0.12, 3 / 365)
      ce.push({ time, strike: k, price: c, openInterest: 5e5 + 1e5 * m, impliedVolatility: 12 })
      pe.push({ time, strike: k, price: c - (S - k), openInterest: 2e6, impliedVolatility: 12 })
    }
  }
  const minutes = gexDay(ce, pe, spots)
  assert.ok(minutes[0].net < 0 && minutes.at(-1).net > 0)
  const t = gexTrend(minutes, { window: 30 })
  assert.equal(t.gex, 'negToPos')
  assert.equal(t.price, 'rising')
  assert.equal(t.read, 'Potential bullish transition')
})
