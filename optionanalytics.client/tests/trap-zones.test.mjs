// Trapped / squeeze zones (trapZones.js): clusters, their role against price, the open rule, the crossings, no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositeProfile, compositeZones, dayRead, openRuleDay, openingRead, positionProfile, readZones, zoneCrossings, zoneKind, zoneScaleRange, ZONE_REACH_RANGE, spotFeedRead, SPOT_STALE_MS, oiLevels, oiRowsOf } from '../src/trapZones.js'

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
  assert.match(boxes[0].label, /^Floor 100–110 \(before\) · OI\+Net\/CDV$/)
  assert.match(boxes[1].label, /^Ceiling 120–125 \(today\) · Fut$/)
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

test('levels by profile: each profile on its own - its strongest bullish / bearish cluster even where the others cancel it', async () => {
  const { profileLevels, cdvLevels } = await import('../src/trapZones.js')
  // CDV buying 100 - 110 and OBV selling at the very same rows (equal - the composite cancels there), OI puts written at 130.
  const p = compositeProfile([
    { id: 'cdv', rows: [{ price: 100, delta: 40 }, { price: 105, delta: 40 }, { price: 150, delta: -20 }] },
    { id: 'obv', rows: [{ price: 100, delta: -40 }, { price: 105, delta: -40 }] },
    { id: 'oi', rows: [{ price: 130, delta: -300 }], bullishNegative: true },
  ], 5)
  assert.deepEqual(compositeZones(p, 5).filter((z) => z.low < 110).map((z) => z.low), [])   // cancelled in the zones...
  const lv = profileLevels(p.rows, p.used, 5, 120)
  assert.deepEqual(lv.map((x) => x.id), ['oi', 'cdv', 'obv'])
  const of = (id) => lv.find((x) => x.id === id)
  // ...but each profile still shows its own: CDV's buyers 100 - 110 a floor under 120, OBV's sellers there trapped shorts.
  assert.deepEqual([of('cdv').bull.low, of('cdv').bull.high, of('cdv').bull.kind], [100, 110, 'support'])
  assert.deepEqual([of('obv').bear.low, of('obv').bear.high, of('obv').bear.kind], [100, 110, 'trappedShorts'])
  assert.deepEqual([of('cdv').bear.low, of('cdv').bear.kind], [150, 'resistance'])
  assert.deepEqual([of('oi').bull.low, of('oi').bull.level, of('oi').bull.kind], [130, 132.5, 'trappedLongs'])   // puts written above price
  assert.equal(of('oi').bear, null)
  // The CDV's own levels = the biggest CDV support / resistance worked out from the flow itself.
  const m = (low, ce, pe) => ({ t: 0, low, high: low, ce, pe, ceVol: 1, peVol: 1 })
  const items = [m(100, 60, 0), m(105, 20, 0), m(150, 0, 15), m(155, 0, 40)]
  const pp = positionProfile({ options: [{ items, oi: [] }], rowSize: 5 })
  const own = profileLevels(pp.rows, pp.used, 5, 120).find((x) => x.id === 'cdv')
  const direct = cdvLevels([items], 5)
  assert.deepEqual([own.bull.low, own.bull.high, own.bull.level], [direct.support.low, direct.support.high, direct.support.level])
  assert.deepEqual([own.bear.low, own.bear.high, own.bear.level], [direct.resistance.low, direct.resistance.high, direct.resistance.level])
})

test('the ladder\'s profile strips: every profile\'s own part a row, in its lane, on the scale', async () => {
  const { ladderLayout } = await import('../src/trapZones.js')
  const p = compositeProfile([
    { id: 'cdv', rows: [{ price: 25000, delta: 10 }, { price: 25005, delta: 0.2 }, { price: 27000, delta: 5 }] },
    { id: 'oi', rows: [{ price: 25000, delta: 100 }], bullishNegative: true },
  ], 5)
  const L = ladderLayout({ zones: [], price: 25010, rows: { prev: p.rows, today: [] }, rowSize: 5 })
  // CDV +1 and OI −1 at 25000; CDV's 2% row left out (under 5%); 27000 off the scale.
  assert.deepEqual(L.strips.map((x) => [x.lane, x.id, x.price, x.value]), [['prev', 'cdv', 25000, 1], ['prev', 'oi', 25000, -1]])
  assert.ok(L.strips[0].height > 0)
  assert.deepEqual(ladderLayout({ zones: [], price: 25010 }).strips, [])
})

test('the first version, to compare: each profile\'s own clusters joined where they overlap - nothing cancels', async () => {
  const { unionZones } = await import('../src/trapZones.js')
  // CDV buying 100 - 110 and OBV selling there, equal (the combined zones cancel); OI puts written 105 - 115 (bullish).
  const p = compositeProfile([
    { id: 'cdv', rows: [{ price: 100, delta: 40 }, { price: 105, delta: 40 }, { price: 150, delta: -20 }] },
    { id: 'obv', rows: [{ price: 100, delta: -40 }, { price: 105, delta: -40 }] },
    { id: 'oi', rows: [{ price: 105, delta: -300 }, { price: 110, delta: -300 }], bullishNegative: true },
  ], 5)
  const u = unionZones(p, 5)
  // A bullish zone 100 - 115 (CDV's 100 - 110 joined with OI's 105 - 115) AND a bearish one on the same prices (OBV's).
  const bull = u.find((z) => z.bullish && z.low === 100), bear = u.find((z) => !z.bullish && z.low === 100)
  assert.deepEqual([bull.high, bull.sources, bull.score], [115, ['oi', 'cdv'], 2])
  assert.deepEqual([bear.high, bear.sources, bear.score], [110, ['obv'], 1])
  assert.deepEqual(bull.against, [])
  assert.ok(u.some((z) => !z.bullish && z.low === 150))   // CDV's own selling at 150, a quarter of its largest cluster (0.5 of 2) - kept
  // The combined zones on the same rows: the CDV / OBV clash is gone, only the OI's floor is left there.
  const c = compositeZones(p, 5)
  assert.ok(!c.some((z) => !z.bullish && z.low <= 105 && z.high >= 105))
  // The mode goes through every read.
  const items = [{ t: 0, low: 100, high: 100, ce: 50, pe: 0, ceObv: 0, peObv: 50, ceVol: 1, peVol: 1 }]
  const asUnion = positionProfile({ options: [{ items, oi: [] }], rowSize: 5, mode: 'union' })
  assert.deepEqual(asUnion.zones.map((z) => [z.bullish, z.low]).sort(), [[false, 100], [true, 100]])
  assert.deepEqual(positionProfile({ options: [{ items, oi: [] }], rowSize: 5 }).zones, [])   // combined: they cancel
  const spot = spotDay(10, (k) => 120 + k)
  const prev = { date: 'x', items, oi: [], candles: spot }
  assert.equal(openingRead({ prevOptions: [prev], rowSize: 5, mode: 'union' }).zones.length, 2)
  assert.equal(dayRead({ opening: { zones: [] }, options: items.map((m) => ({ ...m, t: T0 })), spot, rowSize: 5, mode: 'union' }).zones.filter((z) => z.from === 'today').length, 2)
})

test('the highest Total (OI − Net) and its outliers: the delta card\'s third column, read from the composite rows', async () => {
  const { totalOutliers, OUTLIER_Z } = await import('../src/trapZones.js')
  // The card's Total at a row = OI − (oiMax / netMax) x net; here OI CE − PE and the net flow on 8 rows.
  const oiRows = [100, 105, 110, 115, 120, 125, 130, 135].map((price, k) => ({ price, delta: [-20, 10, -15, 12, -900, 8, -10, 600][k] }))
  const netRows = [100, 105, 110, 115, 120, 125, 130, 135].map((price, k) => ({ price, delta: [2, -1, 1, -2, 40, 1, -1, -50][k] }))
  const p = compositeProfile([{ id: 'oi', rows: oiRows, bullishNegative: true }, { id: 'cdv', rows: netRows }], 5)
  const t = totalOutliers(p.rows, p.used, 5, 128)
  // The card's own Total, row by row (negative = bullish), and ours = minus it over the OI's largest row.
  const oiMax = 900, netMax = 50
  const card = oiRows.map((r, k) => r.delta - (oiMax / netMax) * netRows[k].delta)
  const ours = p.rows.map((r) => (r.parts.oi ?? 0) + (r.parts.cdv ?? 0))
  ours.forEach((x, k) => assert.ok(Math.abs(x - (-card[k] / oiMax)) < 1e-9))
  // The highest bullish row: 120 (puts written AND calls bought there) - an outlier, a floor under 128.
  assert.deepEqual([t.bull.low, t.bull.level, t.bull.outlier, t.bull.kind], [120, 122.5, true, 'support'])
  assert.ok(t.bull.times > 10)
  // The highest bearish row: 135 (calls written AND selling) - an outlier, a ceiling over 128.
  assert.deepEqual([t.bear.low, t.bear.outlier, t.bear.kind], [135, true, 'resistance'])
  assert.deepEqual(t.outliers.map((o) => o.low), [120, 135])
  assert.equal(OUTLIER_Z, 3)
  // Adjacent outlier rows of one side are ONE band, at its peak row.
  const wide = compositeProfile([
    { id: 'oi', rows: [100, 105, 110, 115, 120, 125, 130, 135, 140, 145].map((price, k) => ({ price, delta: [-5, 4, -6, 5, -800, -900, 3, -4, 6, -5][k] })), bullishNegative: true },
    { id: 'cdv', rows: [100, 105, 110, 115, 120, 125, 130, 135, 140, 145].map((price) => ({ price, delta: 1 })) },
  ], 5)
  const w = totalOutliers(wide.rows, wide.used, 5, 160)
  assert.deepEqual(w.outliers.map((o) => [o.low, o.high, o.level]), [[120, 130, 127.5]])
  // A flat profile: a highest row, but no outlier.
  const flat = compositeProfile([
    { id: 'oi', rows: [100, 105, 110].map((price) => ({ price, delta: -10 })), bullishNegative: true },
    { id: 'cdv', rows: [100, 105, 110].map((price) => ({ price, delta: 1 })) },
  ], 5)
  const f = totalOutliers(flat.rows, flat.used, 5, 120)
  assert.equal(f.bull.outlier, false)
  assert.deepEqual(f.outliers, [])
  // Without both the OI and the flow there is no Total.
  assert.equal(totalOutliers(p.rows, ['oi'], 5, 128), null)
})

test('the spot chart\'s price scale: the candles, widened to the zones just off them but never by more than the reach - a far band cannot flatten the live candle', () => {
  // The candles 64250 - 64350 (100 points) at a price of 64300: the reach is the larger of 75 points and 0.25% of the price (160).
  const reach = Math.max(100 * ZONE_REACH_RANGE, 64300 * 0.0025)
  assert.equal(reach, 160.75)
  // No zones: exactly the candles.
  assert.deepEqual(zoneScaleRange(64250, 64350, [], 64300), { min: 64250, max: 64350 })
  // A zone touching the candles' range only inside it adds nothing; one a little under adds its lower part.
  assert.deepEqual(zoneScaleRange(64250, 64350, [{ low: 64260, high: 64300 }], 64300), { min: 64250, max: 64350 })
  assert.deepEqual(zoneScaleRange(64250, 64350, [{ low: 64190, high: 64240 }], 64300), { min: 64190, max: 64350 })
  // A band running far under (the day before's floor, 1.5% away) is taken only as far as the reach...
  const far = zoneScaleRange(64250, 64350, [{ low: 63000, high: 64200 }], 64300)
  assert.equal(far.max, 64350)
  assert.equal(far.min, 64250 - reach)
  // ...so the candles keep at least a third of the height whatever the zones are (the old scale gave them a few pixels).
  assert.ok((64350 - 64250) / (far.max - far.min) > 0.25)
  // A zone wholly beyond the reach is left out; both sides at once.
  assert.deepEqual(zoneScaleRange(64250, 64350, [{ low: 62000, high: 62100 }, { low: 66000, high: 66100 }], 64300), { min: 64250, max: 64350 })
  const both = zoneScaleRange(64250, 64350, [{ low: 64000, high: 64200 }, { low: 64400, high: 65000 }], 64300)
  assert.deepEqual(both, { min: 64250 - reach, max: 64350 + reach })
  // A wide day's range: the reach follows it (75% of the range), a tiny range: the price's 0.25%.
  assert.equal(zoneScaleRange(100, 200, [{ low: 0, high: 1000 }], 150).min, 25)
  assert.equal(zoneScaleRange(64300, 64300, [{ low: 0, high: 70000 }], 64300).max, 64300 + 64300 * 0.0025)
  // Junk in, nothing out; zones with no numbers ignored.
  assert.equal(zoneScaleRange(NaN, 1), null)
  assert.equal(zoneScaleRange(5, 1), null)
  assert.deepEqual(zoneScaleRange(10, 20, [{ low: null, high: 5 }, null, undefined], 15), { min: 10, max: 20 })
})

test('the spot readout: the last spot minute, and live inside the session a feed that stopped (over 2 min behind the clock) says so', () => {
  const bars = [{ time: T0, close: 100 }, { time: T0 + MIN, close: 101 }, { time: T0 + 2 * MIN, close: 102.5 }]
  // Live, the clock in the forming minute after the last bar: not behind.
  assert.deepEqual(spotFeedRead(bars, T0 + 2 * MIN + 30_000, { live: true }), { price: 102.5, minute: T0 + 2 * MIN, behindMs: 0, stale: false })
  // Two minutes after the last bar's end exactly: still ok; a second more: behind.
  assert.equal(spotFeedRead(bars, T0 + 3 * MIN + SPOT_STALE_MS, { live: true }).stale, false)
  const late = spotFeedRead(bars, T0 + 3 * MIN + SPOT_STALE_MS + 1_000, { live: true })
  assert.equal(late.stale, true)
  assert.equal(late.behindMs, SPOT_STALE_MS + 1_000)
  assert.equal(late.minute, T0 + 2 * MIN)
  // The user's case: the feed's last minute 09:23 and the clock at 09:31.
  assert.equal(spotFeedRead(bars, T0 + 16 * MIN, { live: true }).stale, true)
  // Never for a replayed day, outside the session, or with no clock.
  assert.equal(spotFeedRead(bars, T0 + 60 * MIN, { live: false }).stale, false)
  assert.equal(spotFeedRead(bars, T0 + 60 * MIN, { live: true, inSession: false }).stale, false)
  assert.equal(spotFeedRead(bars, null, { live: true }).stale, false)
  // A bar with no price is skipped for the last one with it; none = null.
  assert.equal(spotFeedRead([{ time: T0, close: 100 }, { time: T0 + MIN, close: 0 }], null).price, 100)
  assert.equal(spotFeedRead([], T0), null)
  assert.equal(spotFeedRead(undefined, T0), null)
})

test('the biggest OI (CE − PE) support / resistance: the strongest run of puts written = support, of calls written = resistance', () => {
  // Spot rows of 5: puts written at 100 - 110 (a floor), calls written at 130 - 135 (a ceiling), a thin call row at 115.
  const minutes = [
    { low: 100, high: 100, ce: 0, pe: 4000 },
    { low: 105, high: 105, ce: 500, pe: 9000 },   // the busiest put row
    { low: 115, high: 115, ce: 300, pe: 0 },
    { low: 130, high: 130, ce: 6000, pe: 0 },
    { low: 135, high: 135, ce: 2000, pe: 500 },
  ]
  const lv = oiLevels([minutes], 5)
  assert.deepEqual(lv.support, { low: 100, high: 110, level: 107.5, sum: -12500 })
  assert.deepEqual(lv.resistance, { low: 130, high: 140, level: 132.5, sum: 7500 })
  assert.equal(lv.net, 8800 - 13500)
  // The same rows the composite's OI profile reads (oiRowsOf), so its levels and the zones agree.
  assert.equal(oiRowsOf([minutes], 5).reduce((t, r) => t + r.delta, 0), lv.net)
  // Several sessions add up; a session with only calls written has no support; none = none.
  const two = oiLevels([minutes, [{ low: 130, high: 130, ce: 1000, pe: 0 }]], 5)
  assert.equal(two.resistance.sum, 8500)
  assert.equal(oiLevels([[{ low: 130, high: 130, ce: 1000, pe: 0 }]], 5).support, null)
  assert.deepEqual(oiLevels([], 5), { support: null, resistance: null, net: 0 })
  // A minute spanning two rows splits its OI between them (oiRowsOf), the run still one.
  const wide = oiLevels([[{ low: 100, high: 105, ce: 0, pe: 1000 }]], 5)
  assert.deepEqual([wide.support.low, wide.support.high, wide.support.sum], [100, 110, -1000])
})
