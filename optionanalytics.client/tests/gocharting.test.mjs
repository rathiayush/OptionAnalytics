// GoCharting's per-bar order flow (its Lipi alert's webhook): matched to our bars, scaled to our units, and -
// with "Delta from GoCharting" - read by the strategies in place of our bar delta / cumulative delta, with no
// look-ahead and only while it has every recent bar.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { goChartingByBar, goChartingScale, withGoChartingDelta } from '../src/goCharting.js'
import { scanTick, completedBars, MIN } from '../src/scannerCore.js'
import { day } from './synthetic-day.mjs'

const T = Date.parse('2026-10-09T04:30:00Z') // 10:00 IST
const gcBar = (m, delta, extra = {}) => ({ underlying: 'NIFTY', time: T + m * MIN, delta, buyVolume: 100 + Math.max(0, delta), sellVolume: 100 + Math.max(0, -delta), volume: 200 + Math.abs(delta), cvd: null, ...extra })

test('scale: 1 when GoCharting counts what we count, the lot size when it counts lots', () => {
  const ours = [0, 1, 2].map((m) => ({ time: new Date(T + m * MIN).toISOString(), volume: 6500 }))
  assert.equal(goChartingScale(ours, [0, 1, 2].map((m) => ({ time: T + m * MIN, volume: 6400 })), 65), 1)
  assert.equal(goChartingScale(ours, [0, 1, 2].map((m) => ({ time: T + m * MIN, volume: 101 })), 65), 65)
  assert.equal(goChartingScale(ours, [], 65), 1)
})

test('by bar: a 3-minute bar sums its three GoCharting minutes; an incomplete one is left out', () => {
  const bars = [{ time: T }, { time: T + 3 * MIN }]
  const gc = [gcBar(0, 10, { cvd: 10 }), gcBar(1, -4, { cvd: 6 }), gcBar(2, 5, { cvd: 11 }), gcBar(3, 1, { cvd: 12 })]
  const out = goChartingByBar(bars, gc, 3, 2)
  assert.deepEqual(out.get(T), { buy: 2 * (110 + 100 + 105), sell: 2 * (100 + 104 + 100), delta: 22, cvd: 22, volume: 2 * (210 + 204 + 205), minutes: 3 })
  assert.equal(out.has(T + 3 * MIN), false)
})

test('the strategies read GoCharting\'s delta only while it has every recent bar, never a minute not yet finished', () => {
  const bars = Array.from({ length: 25 }, (_, m) => ({ time: new Date(T + m * MIN).toISOString(), delta: 50, cvd: 50 * (m + 1), stacked: [{ side: 'buy' }] }))
  const nowMs = T + 25 * MIN + 10_000
  const full = Array.from({ length: 26 }, (_, m) => gcBar(m, -7, { cvd: -7 * (m + 1) }))
  const used = withGoChartingDelta(bars, full, nowMs)
  assert.equal(used.used, true)
  assert.equal(used.bars.at(-1).delta, -7)
  assert.equal(used.bars.at(-1).cvd, -7 * 25)
  assert.deepEqual(used.bars.at(-1).stacked, [{ side: 'buy' }], 'per-price reads stay ours')
  assert.equal(used.bars.length, 25)
  // A gap in the last 20 bars: ours, untouched.
  const gap = withGoChartingDelta(bars, full.filter((g) => g.time !== T + 20 * MIN), nowMs)
  assert.equal(gap.used, false)
  assert.equal(gap.bars, bars)
  // The running minute's GoCharting bar is not read (it is not finished at nowMs).
  const early = withGoChartingDelta(bars, full, T + 24 * MIN + 30_000)
  assert.equal(early.used, false, 'bar 24 is in our list but its minute has not finished at 10:24:30')
  // Without GoCharting's own CVD, its deltas are added up.
  const noCvd = withGoChartingDelta(bars, full.map((g) => ({ ...g, cvd: null })), nowMs, { scale: 2 })
  assert.equal(noCvd.bars.at(-1).cvd, -14 * 25)
})

test('scanTick: GoCharting\'s delta when given (and the setups say so); without it, exactly as before', () => {
  const { minuteBars, prints, oi, path, T915, at } = day()
  const viewAt = (t) => ({
    meta: { lastPrice: path[Math.floor((t - T915) / MIN)] }, minuteBars: minuteBars.filter((b) => Date.parse(b.time) <= t),
    book: { bids: [{ price: 1, quantity: 500 }], asks: [{ price: 2, quantity: 500 }] }, sweeps: [], icebergs: [], heatmap: [],
  })
  // GoCharting agreeing with ours: same setups as without it.
  const same = minuteBars.map((b) => ({ time: Date.parse(b.time), delta: b.buy - b.sell, cvd: null, volume: b.buy + b.sell }))
  const memA = { fired: [] }
  const memB = { fired: [] }
  let sawGc = false
  for (let t = at(15); t <= at(300); t += 60_000) {
    const base = { nowMs: t, view: viewAt(t), tapePrints: prints.filter((x) => x.time <= t), liquidity: [], pullStack: [], oi, estimated: false, lotSize: 75, largeLots: 10, rowSize: 1, filters: {}, trail: null }
    const a = scanTick(base, memA)
    const b = scanTick({ ...base, goCharting: { bars: same, scale: 1 } }, memB)
    if (!a) { assert.equal(b, null); continue }
    assert.equal(a.deltaSource, 'own')
    if (b.deltaSource === 'gocharting') sawGc = true
    assert.deepEqual(b.fresh.map((s) => `${s.id}:${s.side}:${s.t}`), a.fresh.map((s) => `${s.id}:${s.side}:${s.t}`))
    if (b.deltaSource === 'gocharting') for (const s of b.fresh) assert.match(s.checks['Order flow'], /GoCharting/)
    memA.fired = a.fired
    memB.fired = b.fired
  }
  assert.ok(sawGc)
  // Its bars really are what the strategies read: completed bars, its delta.
  const own = completedBars(minuteBars, at(100), 1, 75, false)
  const flipped = same.map((g) => ({ ...g, delta: -g.delta }))
  const r = withGoChartingDelta(own, flipped, at(100))
  assert.equal(r.bars.at(-1).delta, -own.at(-1).delta)
})
