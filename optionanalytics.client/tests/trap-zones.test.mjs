// Trapped / squeeze zones (trapZones.js): clusters, their role against price, the open rule, the crossings, no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositeProfile, compositeZones, dayRead, openRuleDay, openingRead, positionProfile, readZones, zoneCrossings, zoneKind } from '../src/trapZones.js'

const T0 = Date.UTC(2026, 10, 16, 3, 45)  // 09:15 IST
const MIN = 60_000

test('the composite profile: each profile scaled to its own largest row, bullish positive (OI negated), added row by row', () => {
  const p = compositeProfile([
    { id: 'cdv', rows: [{ price: 100, delta: 50 }, { price: 105, delta: 100 }, { price: 120, delta: -25 }] },
    { id: 'oi', rows: [{ price: 105, delta: -2000 }, { price: 120, delta: 1000 }], bullishNegative: true },
    { id: 'obv', rows: [{ price: 100, delta: 0 }] },   // no non-zero row: not used
  ], 5)
  assert.deepEqual(p.used, ['oi', 'cdv'])
  assert.deepEqual(p.rows.map((r) => [r.price, r.total]), [[100, 0.5], [105, 2], [120, -0.75]])
  assert.deepEqual(p.rows[1].parts, { cdv: 1, oi: 1 })
  // The futures moved to spot by the basis, onto the nearest row.
  const f = compositeProfile([{ id: 'fut', rows: [{ price: 25090, delta: 10 }], shift: 87.4 }], 5)
  assert.deepEqual(f.rows.map((r) => r.price), [25005])
})

test('composite zones: agreeing profiles add, disagreeing cancel, a zone is its core, its profiles named', () => {
  // CDV bullish 100 - 115, OI puts written 105 - 110 (bullish); OBV bearish over the same rows, weaker.
  const p = compositeProfile([
    { id: 'cdv', rows: [{ price: 100, delta: 10 }, { price: 105, delta: 40 }, { price: 110, delta: 40 }, { price: 115, delta: 10 }, { price: 140, delta: -30 }] },
    { id: 'oi', rows: [{ price: 105, delta: -500 }, { price: 110, delta: -400 }] , bullishNegative: true },
    { id: 'obv', rows: [{ price: 105, delta: -5 }, { price: 110, delta: -5 }, { price: 140, delta: -20 }] },
  ], 5)
  const z = compositeZones(p, 5)
  assert.deepEqual(z.map((x) => [x.low, x.high, x.bullish]), [[105, 115, true], [140, 145, false]])
  assert.deepEqual(z[0].sources, ['oi', 'cdv'])   // OBV pushes the other way there
  assert.deepEqual(z[0].against, ['obv'])
  assert.equal(z[0].score, 1.75)                  // the peak row: CDV 1 + OI 1 − OBV 0.25
  assert.deepEqual(z[1].sources, ['cdv', 'obv'])
  // Two equal profiles opposite each other leave nothing.
  const flat = compositeProfile([{ id: 'cdv', rows: [{ price: 100, delta: 5 }] }, { id: 'obv', rows: [{ price: 100, delta: -5 }] }], 5)
  assert.deepEqual(compositeZones(flat, 5), [])
  // A neutral row (under 10% of the largest) ends a zone; a small run under 20% of the largest zone is dropped.
  const split = compositeProfile([{ id: 'cdv', rows: [{ price: 100, delta: 100 }, { price: 105, delta: 5 }, { price: 110, delta: 60 }, { price: 200, delta: 10 }] }], 5)
  assert.deepEqual(compositeZones(split, 5).map((x) => [x.low, x.high]), [[100, 105], [110, 115]])
})

test('the futures are left out when they are not there or cannot be put on spot', () => {
  const items = [{ t: T0, low: 24990, high: 25000, ce: 10, pe: 2, ceObv: 10, peObv: 2 }]
  const none = positionProfile({ options: [{ items, oi: [] }], futures: [], basis: null, rowSize: 5 })
  assert.equal(none.futures, 'none')
  assert.ok(!none.used.includes('fut'))
  const bars = [{ time: T0, levels: [{ price: 25080, buy: 50, sell: 10 }], close: 25082 }]
  assert.equal(positionProfile({ options: [{ items, oi: [] }], futures: [bars], basis: null, rowSize: 5 }).futures, 'noBasis')
  const used = positionProfile({ options: [{ items, oi: [] }], futures: [bars], basis: 80, rowSize: 5 })
  assert.equal(used.futures, 'used')
  assert.ok(used.used.includes('fut'))
})

test('a zone\'s role against price: floor, trapped longs, ceiling, trapped shorts, inside', () => {
  const bull = { bullish: true, low: 100, high: 110 }, bear = { bullish: false, low: 100, high: 110 }
  assert.equal(zoneKind(bull, 120), 'support')
  assert.equal(zoneKind(bull, 90), 'trappedLongs')
  assert.equal(zoneKind(bear, 90), 'resistance')
  assert.equal(zoneKind(bear, 120), 'trappedShorts')
  assert.equal(zoneKind(bear, 105), 'insideBear')
  const r = readZones([{ ...bull, score: 1 }, { bullish: false, low: 140, high: 150, score: 1 }], 112)
  assert.equal(r.zones[0].kind, 'support')
  assert.ok(r.lean > 0)   // the floor is nearer than the ceiling
})

// A day: spot opens at 25000; puts written in the rows under it, then price rises.
function spotDay(n, path) { return Array.from({ length: n }, (_, k) => { const c = path(k); return { time: T0 + k * MIN, open: k ? path(k - 1) : c, high: c + 2, low: c - 2, close: c } }) }

test('the open rule: puts written below the open and price above it = bullish, held 3 minutes; the mirror', () => {
  const spot = spotDay(20, (k) => (k < 5 ? 24990 - k : 24990 + (k - 4) * 5))
  const oi = spot.slice(0, 6).map((b) => ({ t: b.time, low: b.low, high: b.high, ce: 10, pe: 400 }))
  const r = openRuleDay({ oi, spot, open: spot[0].open, rowSize: 5 })
  assert.equal(r.state, 'bull')
  assert.ok(r.below < 0)
  // On only once it held 3 minutes after the close went over the open.
  const firstAbove = spot.findIndex((b) => b.close > spot[0].open)
  assert.equal(r.since, spot[firstAbove].time)
  // A cut before that minute + 2 = not on yet: nothing read from later minutes.
  const cut = openRuleDay({ oi, spot: spot.slice(0, firstAbove + 2), open: spot[0].open, rowSize: 5 })
  assert.equal(cut.state, null)
  // Mirror: calls written above, price below.
  const down = spotDay(20, (k) => (k < 5 ? 25010 + k : 25010 - (k - 4) * 5))
  const oiDown = down.slice(0, 6).map((b) => ({ t: b.time, low: b.low, high: b.high, ce: 400, pe: 10 }))
  assert.equal(openRuleDay({ oi: oiDown, spot: down, open: down[0].open, rowSize: 5 }).state, 'bear')
})

test('crossings of the previous zones: a ceiling closed above = short squeeze, back inside = failed', () => {
  const zone = { bullish: false, low: 25020, high: 25030 }
  const spot = spotDay(12, (k) => [25010, 25015, 25025, 25035, 25040, 25028, 25045, 25050, 25050, 25050, 25050, 25050][k])
  const e = zoneCrossings([zone], spot)
  assert.deepEqual(e.map((x) => [x.type, (x.t - T0) / MIN]), [['shortSqueeze', 3], ['failedUp', 5], ['shortSqueeze', 6]])
})

test('opening read from the session before and the day read up to the clock (no look-ahead)', () => {
  const prevSpot = spotDay(30, (k) => 24900 + k * 5)
  const prevOi = prevSpot.map((b, k) => ({ t: b.time, low: b.low, high: b.high, ce: k > 20 ? 300 : 5, pe: k < 8 ? 300 : 5 }))
  const prev = { date: '2026-11-13', items: [], oi: prevOi, candles: prevSpot }
  const opening = openingRead({ prevOptions: [prev], prevFutures: [], rowSize: 5 })
  assert.equal(opening.close, prevSpot.at(-1).close)
  assert.ok(opening.zones.some((z) => z.bullish && z.kind === 'support'))      // puts written low in the day: a floor under the close
  assert.ok(opening.zones.some((z) => !z.bullish))                               // calls written late: sellers' cluster
  const spot = spotDay(40, (k) => 25050 + k * 3)
  const oi = spot.slice(0, 10).map((b) => ({ t: b.time, low: b.low - 60, high: b.low - 50, ce: 5, pe: 300 }))
  const whole = dayRead({ opening, oi, spot, rowSize: 5 })
  assert.ok(whole.score > 0 && /bullish/i.test(whole.verdict))
  // A cut at minute 20 = the day read from minutes 0 - 20 alone.
  const cut = dayRead({ opening, oi: oi.filter((m) => m.t <= spot[20].time), spot: spot.slice(0, 21), rowSize: 5 })
  assert.equal(cut.price, spot[20].close)
  assert.deepEqual(cut.crossings.filter((c) => c.t > spot[20].time), [])
})

test('day bias from the open, support / resistance split, the day re-read every 5 minutes with no look-ahead', async () => {
  const { openingBias, supportResistance, dayTimeline } = await import('../src/trapZones.js')
  // Puts written early, calls written at the top, then the close falls back under the calls.
  const prevSpot = spotDay(30, (k) => (k < 25 ? 24900 + k * 5 : 25020 - (k - 24) * 10))
  const prevOi = prevSpot.map((b, k) => ({ t: b.time, low: b.low, high: b.high, ce: k > 20 && k < 25 ? 300 : 5, pe: k < 8 ? 300 : 5 }))
  const prev = { date: '2026-11-13', items: [], oi: prevOi, candles: prevSpot }
  const opening = openingRead({ prevOptions: [prev], prevFutures: [], rowSize: 5 })
  const sellers = opening.zones.find((z) => !z.bullish)
  assert.equal(sellers.kind, 'resistance')
  // Opened above the sellers' zone the close was inside / under: they are trapped from the open (+1).
  const gapUp = openingBias({ opening, prevOptions: [prev], open: sellers.high + 30 })
  assert.ok(gapUp.reasons.some((r) => /trapped from the open/.test(r)))
  const pre = openingBias({ opening, prevOptions: [prev], open: null })
  assert.equal(pre.open, null)
  assert.ok(gapUp.score > pre.score)
  const { support, resistance } = supportResistance(readZones(opening.zones, opening.close).zones)
  assert.ok(support.every((z) => ['support', 'trappedShorts', 'insideBull'].includes(z.kind)))
  assert.ok(resistance.every((z) => ['resistance', 'trappedLongs', 'insideBear'].includes(z.kind)))
  // The day: puts written under the price early, then a rise through the sellers' zone.
  const spot = spotDay(60, (k) => sellers.low - 20 + k * 2)
  const oi = spot.map((b, k) => ({ t: b.time, low: b.low - 20, high: b.low - 10, ce: 5, pe: k < 30 ? 300 : 5 }))
  const whole = dayTimeline({ opening, oi, spot, rowSize: 5 })
  assert.ok(whole.length > 0)
  assert.ok(whole.some((e) => e.type === 'newZone' || e.type === 'roleChange' || e.type === 'verdict'))
  // A cut at minute 34 = the whole day's events up to its last full step, nothing later.
  const cut = dayTimeline({ opening, oi: oi.filter((m) => m.t <= spot[34].time), spot: spot.slice(0, 35), rowSize: 5 })
  assert.deepEqual(cut, whole.filter((e) => e.t <= spot[34].time))
})

test('zones drawn on spot: a box each in its role\'s colour, before dashed / today solid, each layer can be hidden', async () => {
  const { zoneBoxes, ZONE_KINDS } = await import('../src/trapZones.js')
  const zones = [
    { from: 'prev', bullish: true, low: 100, high: 110, kind: 'support', score: 1.5, sources: ['oi', 'cdv'] },
    { from: 'today', bullish: false, low: 120, high: 125, kind: 'resistance', score: 0.5, sources: ['fut'] },
  ]
  const boxes = zoneBoxes(zones)
  assert.deepEqual(boxes.map((b) => [b.low, b.high, b.dashed]), [[100, 110, true], [120, 125, false]])
  assert.match(boxes[0].label, /^Floor \(before\) · OI\+Net\/CDV$/)
  assert.match(boxes[1].label, /^Ceiling \(today\) · Fut$/)
  assert.equal(boxes[0].labelColor, ZONE_KINDS.support.color)
  assert.deepEqual(zoneBoxes(zones, { showPrev: false }).map((b) => b.low), [120])
  assert.deepEqual(zoneBoxes(zones, { showToday: false }).map((b) => b.low), [100])
})

test('trade setups: floor bounce / ceiling rejection from the nearest zones, squeeze, open rule, failed squeeze', async () => {
  const { tradeSetups } = await import('../src/trapZones.js')
  const z = (o) => ({ from: 'prev', score: 1, sources: ['oi'], ...o })
  const day = {
    price: 25010, open: 24990, score: 2, openRule: { state: 'bull' }, crossings: [], liveSqueeze: null,
    zones: [
      z({ bullish: true, low: 24990, high: 25005, kind: 'support', distance: -0.02 }),
      z({ bullish: false, low: 25060, high: 25080, kind: 'resistance', distance: 0.2 }),
      z({ bullish: false, low: 25120, high: 25140, kind: 'resistance', distance: 0.44 }),
      z({ bullish: true, low: 24900, high: 24920, kind: 'support', distance: -0.36 }),
    ],
  }
  const s = tradeSetups({ day, rowSize: 5 })
  const floor = s.find((x) => x.id === 'floorBounce')
  assert.equal(floor.side, 'long')
  assert.equal(floor.status, 'ready')                // price just over the floor's top
  assert.equal(floor.entry, 25005)
  assert.equal(floor.stop, 24977.5)                   // under the zone by max(row, 0.05% of price) = 12.505
  assert.deepEqual(floor.targets, [25060, 25120])
  assert.equal(floor.rr, 2)                           // 55 to the first target / 27.5 risk
  assert.equal(floor.aligned, true)
  const ceil = s.find((x) => x.id === 'ceilingReject')
  assert.equal(ceil.side, 'short')
  assert.equal(ceil.status, 'watch')
  assert.deepEqual(ceil.targets, [25005, 24920])
  assert.equal(ceil.aligned, false)
  assert.ok(s.find((x) => x.id === 'openTrendLong'))
  // Ready and with the read come first.
  assert.equal(s[0].status, 'ready')
  // A squeeze still standing / a failed squeeze.
  const zone = { bullish: false, low: 25000, high: 25020 }
  const sq = tradeSetups({ day: { ...day, openRule: {}, price: 25030, liveSqueeze: { type: 'shortSqueeze', zone } }, rowSize: 5 })
  assert.equal(sq.find((x) => x.id === 'squeezeLong').entry, 25020)
  const failed = tradeSetups({ day: { ...day, openRule: {}, price: 25010, crossings: [{ t: 0, type: 'shortSqueeze', zone }, { t: 5 * 60_000, type: 'failedUp', zone }] }, rowSize: 5 })
  const f = failed.find((x) => x.id === 'failedSqueeze')
  assert.equal(f.side, 'short')
  assert.ok(f.stop > zone.high)
  assert.deepEqual(tradeSetups({ day: null }), [])
})

test('the basis is read at the same minute: the last futures close against the spot close of that minute', async () => {
  const { basisOf } = await import('../src/trapZones.js')
  const spot = [0, 1, 2, 3].map((k) => ({ time: T0 + k * MIN, close: 25000 + k * 10 }))
  // The futures' last bar is at minute 1 (its feed behind): basis = 25100 − 25010, not − 25030 (the spot's last close).
  assert.equal(basisOf([{ time: T0, close: 25095 }, { time: new Date(T0 + MIN).toISOString(), close: 25100 }], spot), 90)
  assert.equal(basisOf([{ time: T0 + 20 * MIN, close: 25100 }], spot), null)   // no spot within 5 min before it
  assert.equal(basisOf([], spot), null)
})

test('the biggest CDV support / resistance: the strongest buying and selling clusters, the level at the busiest row', async () => {
  const { cdvLevels } = await import('../src/trapZones.js')
  const m = (low, high, ce, pe) => ({ t: T0, low, high, ce, pe, ceVol: 1, peVol: 1 })
  // Buying 100 - 110 (60 + 20), a smaller buying run at 130, selling 150 - 160.
  const lv = cdvLevels([[m(100, 100, 60, 0), m(105, 105, 20, 0), m(130, 130, 30, 0), m(150, 150, 0, 15), m(155, 155, 0, 40)]], 5)
  assert.deepEqual([lv.support.low, lv.support.high, lv.support.level, lv.support.sum], [100, 110, 102.5, 80])
  assert.deepEqual([lv.resistance.low, lv.resistance.high, lv.resistance.level, lv.resistance.sum], [150, 160, 157.5, -55])
  assert.equal(lv.net, 110 - 55)
  assert.deepEqual(cdvLevels([[]], 5), { support: null, resistance: null, net: 0 })
})

test('the best zone: strength, agreement, both reads building it, a CDV level in it, nearness; starred on the chart', async () => {
  const { bestZones, zoneBoxes, tradeSetups } = await import('../src/trapZones.js')
  const zones = [
    { from: 'today', bullish: true, low: 24990, high: 25000, kind: 'support', distance: -0.04, score: 0.6, sources: ['cdv'], against: [] },
    { from: 'today', bullish: true, low: 24940, high: 24960, kind: 'support', distance: -0.2, score: 1.5, sources: ['oi', 'cdv', 'obv'], against: [] },
    { from: 'prev', bullish: true, low: 24945, high: 24965, kind: 'support', distance: -0.18, score: 1, sources: ['oi'], against: [] },
    { from: 'today', bullish: false, low: 25060, high: 25080, kind: 'resistance', distance: 0.24, score: 1, sources: ['cdv'], against: ['oi'] },
  ]
  const cdv = { prev: { support: { low: 24950, high: 24955 } }, today: null }
  const b = bestZones({ zones, cdv })
  // The strong agreeing zone both reads built, with yesterday's CDV support in it, beats the weak one at price.
  assert.equal(b.support.zone, zones[1])
  assert.ok(b.support.reasons.some((r) => /3 profiles agree/.test(r)) && b.support.reasons.some((r) => /both built/.test(r)) && b.support.reasons.some((r) => /CDV support/.test(r)))
  assert.equal(b.resistance.zone, zones[3])
  assert.equal(b.best, b.support)
  // Starred boxes first, even with their layer hidden.
  const boxes = zoneBoxes(zones, { showToday: false, best: b })
  assert.match(boxes[0].label, /^★ BEST SUPPORT/)
  assert.match(boxes[1].label, /^★ BEST RESISTANCE/)
  assert.equal(boxes[0].lineWidth, 2)
  assert.deepEqual(boxes.slice(2).map((x) => x.low), [24945])   // the rest: only the 'before' layer
  // The bounce trades the best support, not the weak nearest one.
  const day = { price: 25010, open: 25000, score: 0, openRule: { state: null }, crossings: [], liveSqueeze: null, zones }
  assert.equal(tradeSetups({ day, rowSize: 5, best: b }).find((x) => x.id === 'floorBounce').stop, Math.round((24940 - 12.505) * 100) / 100)
  assert.equal(tradeSetups({ day, rowSize: 5 }).find((x) => x.id === 'floorBounce').stop, Math.round((24990 - 12.505) * 100) / 100)
})

test('the day\'s own zones count in full from its 30th minute, in proportion before', async () => {
  const { DAY_MATURE_MIN } = await import('../src/trapZones.js')
  const spot = spotDay(40, (k) => 25000 + k)
  const oi = spot.map((b) => ({ t: b.time, low: 24980, high: 24985, ce: 5, pe: 300 }))
  const at = (n) => dayRead({ opening: { zones: [] }, oi: oi.slice(0, n), spot: spot.slice(0, n), rowSize: 5 }).zones.filter((z) => z.from === 'today')
  const early = at(3), full = at(DAY_MATURE_MIN), late = at(40)
  assert.ok(early.length && full.length)
  assert.equal(early[0].score, Math.round(full[0].score * 3 / DAY_MATURE_MIN * 100) / 100)
  assert.equal(late[0].score, full[0].score)
})

test('the ladder to scale: previous / current day lanes, bands at their prices, labels never touching', async () => {
  const { ladderLayout } = await import('../src/trapZones.js')
  const z = (o) => ({ from: 'today', score: 1, sources: ['oi'], against: [], ...o })
  const zones = [
    z({ bullish: false, low: 25060, high: 25080, kind: 'resistance', from: 'prev' }),
    z({ bullish: true, low: 24950, high: 24970, kind: 'support' }),
    z({ bullish: false, low: 26000, high: 26020, kind: 'resistance' }),                    // off the scale: left out
    z({ bullish: false, low: 25150, high: 25155, kind: 'resistance', from: 'prev' }),      // two thin bands side by side:
    z({ bullish: false, low: 25145, high: 25150, kind: 'resistance', from: 'prev' }),      // the lower one's label has no room
  ]
  const marks = [{ price: 25008, label: 'Open', color: '#d9d9d9', dashed: true }, { price: 30000, label: 'far' }]
  const L = ladderLayout({ zones, price: 25010, marks, span: 0.01, height: 340, pad: 14, labelPx: 14 })
  assert.ok(Math.abs(L.lo - 24759.9) < 1e-6 && Math.abs(L.hi - 25260.1) < 1e-6)
  assert.deepEqual(L.bands.map((b) => [b.lane, b.zone.low]), [['prev', 25150], ['prev', 25145], ['prev', 25060], ['today', 24950]])
  const y = (v) => 14 + (L.hi - v) / (L.hi - L.lo) * (340 - 28)
  const r = L.bands.find((b) => b.zone.low === 25060)
  assert.ok(Math.abs(r.top - y(25080)) < 1e-9 && Math.abs(r.height - (y(25060) - y(25080))) < 1e-9)
  // Labels in a lane at least a label apart; the squeezed one is dropped, its band kept.
  const prevLabels = L.bands.filter((b) => b.lane === 'prev' && b.labelY != null).map((b) => b.labelY)
  for (let i = 1; i < prevLabels.length; i++) assert.ok(prevLabels[i] - prevLabels[i - 1] >= 14)
  assert.equal(L.bands.find((b) => b.zone.low === 25145).labelY, null)
  assert.ok(L.bands.find((b) => b.zone.low === 25060).labelY != null)
  // The price line always, the open beside it with its label pushed clear, the far mark left out.
  assert.deepEqual(L.lines.map((l) => l.label), ['Price', 'Open'])
  assert.ok(L.lines[1].labelY - L.lines[0].labelY >= 14)
  assert.ok(Math.abs(L.lines[0].y - y(25010)) < 1e-9)
  // Nice ticks across the scale.
  assert.ok(L.ticks.length >= 4 && L.ticks.every((t) => t.price % 50 === 0 || t.price % 100 === 0))
  assert.equal(ladderLayout({ zones, price: null }), null)
})
