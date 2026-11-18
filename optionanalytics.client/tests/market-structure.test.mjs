// The Spot structure page's engine (marketStructure.js): swings, internal / external BOS and CHoCH, sweeps, equal highs /
// lows, order blocks, fair value gaps, premium / discount, S/R zones, trendlines, chart patterns and the top-down read -
// each on a chart built for it, and nothing read from bars after the one it is shown on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeStructure, pivots, zigzag, fairValueGaps, equalLevels, srZones, trendlines, chartPatterns, topDownRead, activeLevels, atrSeries } from '../src/marketStructure.js'

const T0 = Date.parse('2026-11-02T03:45:00Z')
// Candles walking straight from turning point to turning point ([index, price]): each closes on the line, its range 0.1
// past its open / close - so every turning point is a clean pivot.
function path(points) {
  const bars = []
  let prev = points[0][1]
  for (let s = 1; s < points.length; s++) {
    const [i0, p0] = points[s - 1]
    const [i1, p1] = points[s]
    for (let j = s === 1 ? i0 : i0 + 1; j <= i1; j++) {
      const close = p0 + ((p1 - p0) * (j - i0)) / (i1 - i0)
      const open = j === 0 ? close : prev
      bars.push({ time: T0 + j * 60_000, open, close, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1 })
      prev = close
    }
  }
  return bars
}
// Higher highs and higher lows (110 / 104, 116 / 108, 122), then a fall through the last higher low (108).
const UPTREND_THEN_TURN = [[0, 100], [10, 110], [20, 104], [30, 116], [40, 108], [50, 122], [65, 100]]

test('pivots are known len bars after them; the zigzag alternates', () => {
  const bars = path(UPTREND_THEN_TURN)
  const p = pivots(bars, 5)
  assert.deepEqual(p.filter((x) => x.type === 'high').map((x) => [x.index, Math.round(x.price), x.confirmedAt]), [[10, 110, 15], [30, 116, 35], [50, 122, 55]])
  assert.deepEqual(p.filter((x) => x.type === 'low').map((x) => [x.index, Math.round(x.price)]), [[20, 104], [40, 108]])
  const zz = zigzag(p)
  for (let i = 1; i < zz.length; i++) assert.notEqual(zz[i].type, zz[i - 1].type)
})

test('external structure: BOS with the trend, CHoCH against it, HH / HL labels', () => {
  const a = analyzeStructure(path(UPTREND_THEN_TURN), { swingLen: 5, internalLen: 2, trendLen: 3 })
  const ev = a.swing.events.map((e) => `${e.kind} ${e.dir}`)
  assert.deepEqual(ev, ['BOS bullish', 'BOS bullish', 'CHoCH bearish'])
  const choch = a.swing.events[2]
  assert.equal(Math.round(choch.level), 108)
  assert.equal(choch.index, 60) // the first close under 107.9: 122 falling 22 over 15 bars, 10 bars down
  assert.deepEqual(a.swing.swings.filter((s) => s.type === 'high').map((s) => s.label), [null, 'HH', 'HH'])
  assert.deepEqual(a.swing.swings.filter((s) => s.type === 'low').map((s) => s.label), [null, 'HL'])
  assert.equal(a.bias.swing, 'bearish')
  // The bearish break: the high it started from must hold (strong), the low reached is the target (weak).
  assert.equal(a.strongWeak.strong.type, 'high')
  assert.equal(Math.round(a.strongWeak.strong.price), 122)
  // The order block of the first bullish BOS: the lowest candle between the broken high and the break.
  const ob = a.orderBlocks.find((b) => b.scope === 'swing' && b.dir === 'bullish')
  assert.equal(ob.index, 20)
})

test('internal structure breaks inside the swings; an internal break on the swing break is the swing one', () => {
  // A small pullback inside the leg up - too short for a swing pivot: 104 -> 108 -> 106.5 -> 116.
  const bars = path([[0, 100], [10, 110], [20, 104], [23, 108], [25, 106.5], [33, 116], [43, 108], [53, 122], [70, 100]])
  const a = analyzeStructure(bars, { swingLen: 5, internalLen: 2, trendLen: 3 })
  assert.ok(a.internal.events.length > 0)
  const swingKeys = new Set(a.swing.events.map((e) => `${e.dir}|${e.level}|${e.index}`))
  for (const e of a.internal.events) assert.ok(!swingKeys.has(`${e.dir}|${e.level}|${e.index}`))
  assert.ok(a.internal.events.some((e) => e.dir === 'bullish' && Math.round(e.level) === 108 && e.index === 27))
  assert.ok(!a.swing.events.some((e) => Math.round(e.level) === 108 && e.dir === 'bullish'))
})

test('nothing is read from later bars: a cut chart has exactly the breaks, swings and blocks of the whole one up to the cut', () => {
  const bars = path([[0, 100], [10, 110], [20, 104], [24, 109], [27, 107], [36, 116], [46, 108], [56, 122], [66, 112], [80, 100], [92, 111], [100, 103], [115, 125]])
  const opts = { swingLen: 5, internalLen: 2, trendLen: 3 }
  const whole = analyzeStructure(bars, opts)
  for (const cut of [30, 47, 66, 90, 108]) {
    const part = analyzeStructure(bars.slice(0, cut), opts)
    const key = (e) => `${e.scope}|${e.kind}|${e.dir}|${e.level}|${e.fromIndex}|${e.index}`
    assert.deepEqual(part.events.map(key), whole.events.filter((e) => e.index < cut).map(key), `cut at ${cut}`)
    assert.deepEqual(part.swings.map((s) => `${s.scope}|${s.index}|${s.label}`), whole.swings.filter((s) => s.confirmedAt < cut).map((s) => `${s.scope}|${s.index}|${s.label}`))
    assert.deepEqual(part.orderBlocks.map((b) => [b.index, b.top, b.bottom]), whole.orderBlocks.filter((b) => b.createdAt < cut).map((b) => [b.index, b.top, b.bottom]))
  }
})

test('a sweep: a wick past the swing high that closes back under', () => {
  const bars = path([[0, 100], [10, 110], [20, 104], [30, 108]])
  bars.push({ time: T0 + 31 * 60_000, open: 108, high: 111, low: 107.5, close: 108.5 })  // wick over 110.1, close back under
  bars.push(...path([[31, 108.5], [40, 105]]).slice(1).map((b, i) => ({ ...b, time: T0 + (32 + i) * 60_000 })))
  const a = analyzeStructure(bars, { swingLen: 5, internalLen: 2, trendLen: 3 })
  const sweep = a.sweeps.find((s) => s.dir === 'bearish')
  assert.ok(sweep)
  assert.equal(sweep.index, 31)
  assert.equal(a.swing.events.filter((e) => e.dir === 'bullish').length, 0) // closed back under: no BOS
})

test('fair value gaps: a gap between candle 1 and 3, filled when price trades back across it', () => {
  const bars = [
    { open: 100, high: 101, low: 99, close: 100.5 },
    { open: 100.5, high: 104, low: 100.4, close: 103.8 },
    { open: 103.8, high: 105, low: 102, close: 104.5 },  // low 102 > the first's high 101: a 1-point gap
    { open: 104.5, high: 105.5, low: 103, close: 105 },
    { open: 105, high: 105.2, low: 100.8, close: 101 },  // trades back under 101: filled
  ]
  const gaps = fairValueGaps(bars, () => 0.5)
  assert.equal(gaps.length, 1)
  assert.deepEqual([gaps[0].dir, gaps[0].bottom, gaps[0].top, gaps[0].index, gaps[0].filledAt], ['bullish', 101, 102, 2, 4])
  assert.equal(fairValueGaps(bars, () => 1.5).length, 0) // smaller than asked
})

test('equal highs: two pivots within the tolerance; taken / swept by a later bar', () => {
  const bars = path([[0, 100], [8, 110], [16, 104], [24, 110.05], [32, 103], [40, 112]])
  const piv = pivots(bars, 3)
  const eq = equalLevels(bars, piv, () => 0.2)
  const eqh = eq.find((q) => q.type === 'EQH')
  assert.ok(eqh)
  assert.equal(eqh.createdAt, 27)
  assert.ok(eqh.takenAt > 27)
  assert.equal(eqh.swept, false) // closed through it on the way up
  assert.equal(equalLevels(bars, piv, () => 0.01).filter((q) => q.type === 'EQH').length, 0)
})

test('support / resistance zones need two turns and are named by where price is', () => {
  const piv = [
    { index: 1, price: 100, type: 'low' }, { index: 5, price: 100.3, type: 'low' }, { index: 9, price: 99.8, type: 'low' },
    { index: 3, price: 110, type: 'high' }, { index: 7, price: 110.2, type: 'high' }, { index: 11, price: 120, type: 'high' },
  ]
  const zones = srZones(piv, 0.6, 105)
  assert.equal(zones.length, 2) // 120 turned once
  const sup = zones.find((z) => z.role === 'support')
  const res = zones.find((z) => z.role === 'resistance')
  assert.deepEqual([sup.touches, sup.low, sup.high, sup.lastIndex], [3, 99.8, 100.3, 9])
  assert.deepEqual([res.touches, res.low, res.high], [2, 110, 110.2])
})

test('trendlines: rising lows that held are support; a close under it breaks it', () => {
  // Lows at 100, 104, 108 on one line (rising 0.4 a bar), then a drop through it.
  const bars = path([[0, 100], [5, 106], [10, 102], [15, 110], [20, 104], [25, 114], [30, 106], [35, 118], [48, 100]])
  const piv = pivots(bars, 3)
  const lines = trendlines(bars, piv, 0.3)
  const sup = lines.find((l) => l.kind === 'support')
  assert.ok(sup)
  assert.ok(sup.touches >= 3)
  assert.ok(sup.brokenAt > 35)
  // Cut before the drop: the same line, unbroken.
  const cut = trendlines(bars.slice(0, 38), pivots(bars.slice(0, 38), 3), 0.3).find((l) => l.kind === 'support')
  assert.equal(cut.brokenAt, null)
  assert.deepEqual([cut.a.index, cut.b.index], [sup.a.index, sup.b.index])
})

const atrOf = (bars) => { const a = atrSeries(bars); return (i) => a[Math.max(0, Math.min(bars.length - 1, i))] }

test('double top: two highs level, a trough between, confirmed by a close under the trough', () => {
  const bars = path([[0, 100], [10, 120], [20, 110], [30, 120.3], [45, 104]])
  const pats = chartPatterns(bars, zigzag(pivots(bars, 3)), atrOf(bars))
  const dt = pats.find((p) => p.name === 'Double top')
  assert.ok(dt)
  assert.equal(dt.side, 'bearish')
  assert.equal(dt.status, 'confirmed')
  assert.ok(dt.at > 30)
  // Before the neckline goes: forming.
  const early = chartPatterns(bars.slice(0, 36), zigzag(pivots(bars.slice(0, 36), 3)), atrOf(bars.slice(0, 36))).find((p) => p.name === 'Double top')
  assert.equal(early.status, 'forming')
})

test('double bottom and inverse head & shoulders are the mirror', () => {
  const db = path([[0, 120], [10, 100], [20, 110], [30, 99.8], [45, 118]])
  assert.equal(chartPatterns(db, zigzag(pivots(db, 3)), atrOf(db)).find((p) => p.name === 'Double bottom')?.status, 'confirmed')
  const ihs = path([[0, 125], [10, 105], [18, 115], [28, 96], [38, 115.5], [46, 105.5], [60, 124]])
  const p = chartPatterns(ihs, zigzag(pivots(ihs, 3)), atrOf(ihs)).find((x) => x.name === 'Inverse head & shoulders')
  assert.ok(p)
  assert.equal(p.side, 'bullish')
  assert.equal(p.status, 'confirmed')
})

test('head & shoulders: the head over both shoulders, confirmed under the neckline', () => {
  const bars = path([[0, 95], [10, 115], [18, 105], [28, 124], [38, 104.5], [46, 114.5], [60, 96]])
  const p = chartPatterns(bars, zigzag(pivots(bars, 3)), atrOf(bars)).find((x) => x.name === 'Head & shoulders')
  assert.ok(p)
  assert.equal(p.status, 'confirmed')
  assert.ok(p.target < 105)
})

test('triangles and wedges by the slopes of the last two highs and lows', () => {
  const asc = path([[0, 100], [8, 120], [16, 104], [24, 120.2], [32, 110], [40, 120.1], [48, 132]])
  const a = chartPatterns(asc, zigzag(pivots(asc, 3)), atrOf(asc))[0]
  assert.equal(a.name, 'Ascending triangle')
  assert.equal(a.status, 'confirmed')
  assert.equal(a.breakout, 'up')
  const fw = path([[0, 130], [8, 110], [16, 124], [24, 104], [32, 116], [40, 100], [48, 109], [60, 122]])
  const w = chartPatterns(fw, zigzag(pivots(fw, 3)), atrOf(fw)).find((p) => p.name === 'Falling wedge')
  assert.ok(w)
  assert.equal(w.side, 'bullish')
})

test('the dealing range: premium / discount of the last swing high and low', () => {
  const a = analyzeStructure(path(UPTREND_THEN_TURN), { swingLen: 5, internalLen: 2, trendLen: 3 })
  assert.ok(a.range)
  assert.ok(a.range.top >= 122)
  assert.equal(a.range.zone, 'discount') // closed at 100, at the bottom of the range
  const act = activeLevels(a)
  assert.ok(Array.isArray(act.support) && Array.isArray(act.orderBlocks))
})

test('the top-down read: aligned, a pullback, against', () => {
  const mk = (swing, internal, events = [], zone = 'equilibrium') => ({ n: 10, bias: { swing, internal, lastSwing: null }, events, range: { zone, pos: 0.5, top: 2, bottom: 1 } })
  assert.match(topDownRead(mk('bullish', 'bullish'), mk('bullish', 'bullish')).verdict, /ALIGNED BULLISH/)
  assert.equal(topDownRead(mk('bullish', 'bullish', [], 'discount'), mk('bullish', 'bullish')).side, 'bullish')
  assert.match(topDownRead(mk('bullish', 'bullish', [], 'discount'), mk('bullish', 'bullish')).verdict, /discount/)
  const pull = topDownRead(mk('bullish', 'bullish'), mk('bullish', 'bearish', [{ kind: 'CHoCH', dir: 'bearish', scope: 'internal', level: 1 }]))
  assert.match(pull.verdict, /PULLBACK/)
  assert.equal(pull.side, 'neutral')
  assert.match(topDownRead(mk('bearish', 'bearish'), mk('bearish', 'bearish')).verdict, /ALIGNED BEARISH/)
  assert.equal(topDownRead(null, mk('bullish', 'bullish')).verdict, 'Not enough candles')
})

// What the page draws (structureShapes.js): every layer from the analysis, nothing for a layer that is off, numbers only.
import { structureShapes, STRUCTURE_LAYERS, DEFAULT_LAYERS, DENSITY, DEFAULT_DENSITY, clears, lowerThan, TIMEFRAMES, HISTORY_CHOICES } from '../src/structureShapes.js'

test('the shapes: each layer only when on, the higher TF\'s levels laid across the lower chart, no NaN anywhere', () => {
  const bars = path([[0, 100], [10, 120], [20, 110], [30, 120.3], [45, 104], [55, 114], [65, 98], [80, 125]])
  const a = analyzeStructure(bars, { swingLen: 5, internalLen: 2, trendLen: 3 })
  assert.deepEqual(structureShapes(a, []), [])
  const all = structureShapes(a, DEFAULT_LAYERS, { htf: a })
  assert.ok(all.length > 10)
  for (const s of all) {
    for (const k of ['i1', 'i2', 'p1', 'p2', 'top', 'bottom', 'i', 'p']) if (s[k] != null) assert.ok(Number.isFinite(s[k]), `${s.kind} ${k}`)
  }
  assert.ok(structureShapes(a, ['swing']).every((s) => s.kind === 'seg' && /BOS|CHoCH/.test(s.label)))
  assert.ok(structureShapes(a, ['htf'], { htf: a }).some((s) => /HTF/.test(s.label ?? '')))
  assert.equal(structureShapes(a, ['htf']).length, 0) // no higher TF given
  // Internal breaks: only the newest few labelled.
  const internals = structureShapes(a, ['internal'], { maxInternalLabels: 1 })
  assert.ok(internals.filter((s) => s.label).length <= 1)
  assert.equal(STRUCTURE_LAYERS.length, DEFAULT_LAYERS.length)
})

test('the lower timeframe stays under the higher one; every timeframe has its history choices', () => {
  assert.equal(lowerThan(60, 5), 5)
  assert.equal(lowerThan(60, 240), 15)
  assert.equal(lowerThan(1440, 1440), 240)
  assert.equal(lowerThan(3, 5), 1)
  for (const t of TIMEFRAMES) assert.ok(HISTORY_CHOICES[t.value]?.length >= 1)
})

test('Detail: Clean draws far fewer marks than Everything, and every shape carries a priority', () => {
  const bars = path([[0, 100], [10, 120], [20, 110], [30, 120.3], [45, 104], [55, 114], [65, 98], [80, 125], [95, 108], [115, 130]])
  const a = analyzeStructure(bars, { swingLen: 5, internalLen: 2, trendLen: 3 })
  const count = (d) => structureShapes(a, DEFAULT_LAYERS, { htf: a, density: d })
  const clean = count('clean')
  const all = count('all')
  assert.ok(clean.length < all.length, `clean ${clean.length} < all ${all.length}`)
  // Clean labels far less: the chart reads at a glance.
  assert.ok(clean.filter((s) => s.label || s.text).length < all.filter((s) => s.label || s.text).length)
  // Clean leaves the premium / discount SHADING off (two blocks that coloured the whole chart) but keeps the line.
  assert.equal(clean.filter((s) => s.label === 'Premium' || s.label === 'Discount').length, 0)
  assert.ok(all.some((s) => s.label === 'Premium'))
  assert.ok(clean.some((s) => s.label === 'Equilibrium'))
  assert.equal(count('nonsense').length, count(DEFAULT_DENSITY).length)   // an unknown choice reads as the default
  // No internal break is ever labelled in Clean; the external ones always are.
  assert.equal(clean.filter((s) => /^i-/.test(s.label ?? '')).length, 0)
  assert.ok(clean.some((s) => s.label === 'BOS' || s.label === 'CHoCH'))
  for (const s of all) if (s.label || s.text) assert.ok(typeof s.pri === 'number' || s.label === 'neckline', `no priority: ${s.label ?? s.text}`)
  assert.deepEqual(Object.keys(DENSITY), ['clean', 'normal', 'all'])
})

test('labels are placed only where they clear the ones already placed', () => {
  const taken = [{ x: 10, y: 10, w: 40, h: 12 }]
  assert.equal(clears(taken, { x: 10, y: 10, w: 40, h: 12 }, 0), false)   // the same spot
  assert.equal(clears(taken, { x: 45, y: 14, w: 40, h: 12 }, 0), false)   // overlapping
  assert.equal(clears(taken, { x: 52, y: 10, w: 40, h: 12 }, 0), true)    // clear to the right
  assert.equal(clears(taken, { x: 52, y: 10, w: 40, h: 12 }, 4), false)   // ... but not with a 4 px gap wanted
  assert.equal(clears(taken, { x: 10, y: 24, w: 40, h: 12 }, 0), true)    // clear below
  assert.equal(clears([], { x: 0, y: 0, w: 10, h: 10 }), true)
})
