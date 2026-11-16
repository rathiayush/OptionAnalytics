// The Component check page (componentCheck.js): every OI Replay card's reads turned into events from the day's run - no
// look-ahead (a day cut part way gives the same events up to the cut), the price after each (telegramSignals.js' reaction),
// the usual move, and the report's numbers and verdicts worked out by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARDS, baselineOf, componentReport, dayBaseline, dayEvents, dayOutcome, eventsCsv, loadComponentDay } from '../src/componentCheck.js'

const MIN = 60_000
const T0 = Date.parse('2026-11-10T09:15:00+05:30')
const EXPIRY = '2026-11-11'
const YEARS = (t) => (Date.parse(`${EXPIRY}T15:30:00+05:30`) - t) / (365 * 86_400_000)

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

// A whole session priced with Black-76: spot up, down, up; IV and the skew moving; OI building with the moves.
function run(minutes = 375) {
  const spot = [], ce = [], pe = []
  let s = 25000
  let seed = 11
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let m = 0; m < minutes; m++) {
    s += (m < 120 ? 1.4 : m < 250 ? -1.8 : 1.1) + (rnd() - 0.5) * 8
    const t = T0 + m * MIN
    const open = spot.at(-1)?.close ?? s
    spot.push({ time: new Date(t).toISOString(), open, high: Math.max(open, s) + 3, low: Math.min(open, s) - 3, close: s, volume: 0 })
    const iv = 0.12 + (m > 120 && m < 250 ? 0.02 : 0) + 0.005 * Math.sin(m / 30)
    for (let k = 24500; k <= 25500; k += 50) {
      const skew = (0.3 + (m > 120 && m < 250 ? 0.3 : 0)) * ((s - k) / s)
      const sigma = Math.max(0.05, iv + skew)
      const time = new Date(t).toISOString()
      const dist = (k - s) / 50
      ce.push({ time, strike: k, price: Math.max(0.05, black76(s, k, sigma, YEARS(t), true)), openInterest: 3e6 + m * (dist > 0 ? 9000 : 2500) + (m > 120 && m < 250 && dist > 0 ? m * 6000 : 0), volume: 1000 })
      pe.push({ time, strike: k, price: Math.max(0.05, black76(s, k, sigma, YEARS(t), false)), openInterest: 3e6 + m * (dist < 0 ? 9000 : 2500) + (m > 250 && dist < 0 ? m * 6000 : 0), volume: 1000 })
    }
  }
  return { success: true, date: '2026-11-10', underlying: 'NIFTY', step: 50, optionExpiry: EXPIRY, spotCandlesOneMinute: spot, cePoints: ce, pePoints: pe, futuresBars: [] }
}

const cut = (r, minutes) => {
  const until = T0 + (minutes - 1) * MIN
  const keep = (p) => Date.parse(p.time) <= until
  return { ...r, spotCandlesOneMinute: r.spotCandlesOneMinute.filter(keep), cePoints: r.cePoints.filter(keep), pePoints: r.pePoints.filter(keep) }
}

test('a day\'s reads as events: several cards fire, each event known at the end of its minute, in time order', () => {
  const d = dayEvents(run())
  assert.equal(d.ok, true)
  const cards = new Set(d.events.map((e) => e.card))
  for (const id of ['straddleTrend', 'gexRegime', 'skew', 'oiBreak']) assert.ok(cards.has(id), `${id} fired (${[...cards]})`)
  for (const e of d.events) {
    assert.equal(e.at, e.time + MIN)
    assert.ok(CARDS.some((c) => c.id === e.card))
    assert.ok(e.kind === 'dir' ? (e.dir === 1 || e.dir === -1) : (e.expect === 'bigger' || e.expect === 'smaller'), JSON.stringify(e))
  }
  assert.deepEqual(d.events.map((e) => e.time), [...d.events.map((e) => e.time)].sort((a, b) => a - b))
  assert.equal(dayEvents({ ...run(), cePoints: [] }).ok, false)
  assert.equal(dayEvents(cut(run(), 20)).ok, false)
})

test('no look-ahead: the day cut part way gives the same events up to the cut', () => {
  const whole = dayEvents(run()).events
  for (const minutes of [150, 260, 330]) {
    const part = dayEvents(cut(run(), minutes)).events
    const until = T0 + (minutes - 1) * MIN
    const strip = (list) => list.filter((e) => e.time <= until).map(({ card, read, kind, dir, expect, time }) => ({ card, read, kind, dir, expect, time }))
    assert.deepEqual(strip(part), strip(whole), `cut at ${minutes}`)
  }
})

test('the price after an event and the usual move, worked out by hand', () => {
  const bars = Array.from({ length: 120 }, (_, i) => ({ t: T0 + i * MIN, o: 100 + i, h: 100 + i + 1, l: 100 + i - 1, c: 100 + i }))
  const base = dayBaseline(bars)
  // Every 5-minute move is +5 on a price of 100 + i: the mean of 5 / (100 + i) over the minutes that have one.
  const expect5 = bars.slice(0, 115).reduce((a, b) => a + (5 / b.c) * 100, 0)
  assert.ok(Math.abs(base.abs[5][0] - expect5) < 1e-9 && base.abs[5][1] === 115)
  const b2 = baselineOf([{ ok: true, baseline: base }, { ok: true, baseline: base }, { ok: false }])
  assert.ok(Math.abs(b2.abs[5] - expect5 / 115) < 1e-12)
})

// Hand-made outcomes: a directional read right 3 times of 4, and a volatility read with big moves after it.
function outcome(date, events) {
  const baseline = { abs: { 5: [1, 10], 15: [2, 10], 30: [3, 10], 60: [4, 10] }, range: [5, 10] }   // usual 0.1 / 0.2 / 0.3 / 0.4 %, range 0.5 %
  return { ok: true, date, baseline, events }
}
const ev = (card, read, kind, side, m30, extra = {}) => ({
  card, read, kind, ...(kind === 'dir' ? { dir: side } : { expect: side }), time: T0, at: T0 + MIN, text: '',
  reaction: { base: 1000, moves: { 5: m30 / 3, 15: m30 / 2, 30: m30, 60: m30 }, best: 6, worst: 2, range: 8 }, ...extra,
})

test('the report: hit %, the move its way, the correlation and the verdict; volatility reads against usual', () => {
  const days = []
  for (let k = 0; k < 4; k++) {
    days.push(outcome(`2026-11-0${k + 2}`, [
      ev('oiBreak', 'PE broke resistance (bullish)', 'dir', 1, 6), ev('oiBreak', 'PE broke resistance (bullish)', 'dir', 1, 4), ev('oiBreak', 'PE broke resistance (bullish)', 'dir', 1, 2),
      ev('oiBreak', 'CE broke resistance (bearish)', 'dir', -1, 3),
      ev('gexRegime', 'Short gamma (net GEX −)', 'vol', 'bigger', 6), ev('gexRegime', 'Long gamma (net GEX +)', 'vol', 'smaller', 1),
    ]))
  }
  const r = componentReport(days, { horizon: 30 })
  assert.equal(r.days, 4)
  const oi = r.cards.find((c) => c.card === 'oiBreak')
  assert.equal(oi.events, 16)
  assert.equal(oi.hit30, 75)
  // The moves its way: +0.6, +0.4, +0.2, -0.3 (% of 1000) - averaged.
  assert.ok(Math.abs(oi.avgPct30 - (0.6 + 0.4 + 0.2 - 0.3) / 4) < 1e-12)
  assert.equal(oi.verdict.key, 'works')
  assert.equal(oi.reads.length, 2)
  assert.equal(oi.reads.find((x) => x.read.startsWith('CE')).verdict.key, 'few')
  assert.ok(oi.corr30 > 0)
  const gex = r.cards.find((c) => c.card === 'gexRegime')
  assert.equal(gex.kind, 'vol')
  const short = gex.reads.find((x) => x.expect === 'bigger')
  // |0.6 %| against the usual 0.3 % at 30 min = 2x.
  assert.ok(Math.abs(short.ratio30 - 2) < 1e-12)
  assert.equal(short.bigger30, 100)
  const long = gex.reads.find((x) => x.expect === 'smaller')
  assert.ok(Math.abs(long.ratio30 - 0.1 / 0.3) < 1e-12)
  // The card's row: the expectation told big from small - correlation +1.
  assert.ok(Math.abs(gex.corr30 - 1) < 1e-9)
  // 4 + 4 events: too few for a verdict.
  assert.equal(gex.verdict.key, 'few')
  assert.ok(Math.abs(short.rangeRatio - 0.8 / 0.5) < 1e-12)
  // A card with no events is listed, empty.
  assert.equal(r.cards.find((c) => c.card === 'dexCharm').events, 0)
  // An opposite read.
  const wrong = componentReport([outcome('2026-11-02', Array.from({ length: 12 }, () => ev('skew', 'Fear confirms the fall', 'dir', -1, 5)))])
  assert.equal(wrong.cards.find((c) => c.card === 'skew').verdict.key, 'opposite')
  const csv = eventsCsv(days)
  assert.equal(csv.split('\n').length, 1 + 24)
  assert.match(csv.split('\n')[1], /^2026-11-02,09:16,OI totals S\/R break,PE broke resistance \(bullish\),dir,bullish,1000,2,3,6,6,,,6,2,/)
})

test('a whole day through dayOutcome, and the loader: success, a server error worth a retry, a refusal', async () => {
  const o = dayOutcome(run(), { keepBars: true })
  assert.equal(o.ok, true)
  assert.ok(o.bars.length === 375 && o.events.length > 0 && o.events.every((e) => e.reaction == null || e.reaction.base > 0))
  assert.equal(dayOutcome(run()).bars, undefined)
  // The higher horizons: 90 / 120 min after an event of the morning - the close that many minutes later; an event too late
  // in the day for them has none there.
  const close = (ms) => o.bars.find((b) => b.t === ms)?.c
  const early = o.events.find((e) => e.reaction && e.at < T0 + 120 * MIN)
  for (const h of [90, 120]) assert.ok(Math.abs(early.reaction.moves[h] - (close(early.at - MIN + h * MIN) - early.reaction.base)) < 1e-9, `${h}m`)
  const late = o.events.find((e) => e.reaction && e.at > T0 + 300 * MIN)
  assert.ok(late && late.reaction.moves[90] === null && late.reaction.moves[120] === null && late.reaction.moves[5] != null)
  assert.ok(o.baseline.abs[120][1] > 0 && o.baseline.abs[120][1] < o.baseline.abs[90][1])
  const ok = await loadComponentDay('NIFTY', '2026-11-10', { fetch: async (url) => {
    assert.match(url, /^\/api\/oi-replay\/NIFTY\/run\?date=2026-11-10&timeframeMinutes=1&expiryFlag=WEEK$/)
    return { ok: true, status: 200, headers: { get: () => '0' }, json: async () => run() }
  } })
  assert.equal(ok.ok, true)
  assert.equal(ok.dhanCalls, 0)
  const busy = await loadComponentDay('NIFTY', '2026-11-10', { fetch: async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: 'busy' }) }) })
  assert.deepEqual([busy.ok, busy.retry, busy.reason], [false, true, 'busy'])
  const none = await loadComponentDay('NIFTY', '2026-11-08', { fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: false, error: 'no data for the day' }) }) })
  assert.deepEqual([none.ok, none.retry], [false, false])
  const down = await loadComponentDay('NIFTY', '2026-11-10', { fetch: async () => { throw new Error('network down') } })
  assert.deepEqual([down.ok, down.retry], [false, true])
})
