// The option OBV profile and the futures delta profile as Signal backtest conditions (OI Replay's CDV / OBV profile and
// futures delta profile cards): minute by minute = the profile built from the minutes up to the clock, read on the right
// price, loaded with the order flow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { deltaProfileLevels, futuresDeltaProfileOf, futuresDeltaSteps, optionDeltaAt, optionDeltaProfileOf, optionDeltaSteps } from '../src/deltaProfile.js'
import { RULE_CONDITIONS, cleanLine, futuresDaysNeeded, mirrorLines, orderFlowNeeded, prepareDay } from '../src/signalBacktest.js'
import { FLOW_DELTA, FLOW_PROFILE, orderFlowUrl } from '../src/orderFlowFeatures.js'
import { attachOrderFlow } from '../src/signalBacktestJob.js'

const MIN = 60_000
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)
const option = (id, value) => cond(id).options.find((o) => o.value === value)
const holds = (d, id, value, i, { w = 5, p } = {}) => {
  const o = option(id, value)
  return cond(id).test(d, i, value, w, p ?? o.param?.default ?? 0, undefined, o.param3?.default, o.param4?.default)
}
let seed = 11
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const { run: base } = syntheticDay()
const withBars = (list) => list.map((p) => ({ ...p, open: p.price * (1 + (rnd() - 0.5) * 0.02), high: p.price * (1 + 0.005 + rnd() * 0.03), low: p.price * (1 - 0.005 - rnd() * 0.03), volume: Math.round(200 + rnd() * 3000) }))
const RUN = { ...base, cePoints: withBars(base.cePoints), pePoints: withBars(base.pePoints) }
const rule = (lines) => ({ tree: { op: 'and', items: lines.map((line) => ({ line })) }, action: 'buyCE', mirror: true })

test('the OBV profile minute by minute = the OBV profile of the minutes up to the clock; its conditions read it', () => {
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  assert.ok(d.ok && d.odm.some((m) => m.ceObv !== 0))
  const read = optionDeltaSteps([], d.odm, { rowSize: 5, metric: 'obv' })
  for (const k of [10, 120, d.odm.length - 1]) {
    const t = d.odm[k].t
    const profile = optionDeltaProfileOf([d.odm.filter((m) => m.t <= t)], { rowSize: 5, metric: 'obv' })
    const at = optionDeltaAt(read, t)
    assert.deepEqual(at.levels, deltaProfileLevels(profile))
    assert.ok(Math.abs(at.delta - profile.delta) < 1e-6)
  }
  // netPositive / netNegative follow the OBV net at the candle - one of the two at each candle with a net.
  let pos = 0, neg = 0
  for (let i = 30; i < d.n; i += 25) {
    const net = optionDeltaProfileOf([d.odm.filter((m) => m.t <= d.t[i])], { rowSize: 5, metric: 'obv' }).delta
    assert.equal(holds(d, 'obpDelta', 'netPositive', i), net > 0, `candle ${i}`)
    assert.equal(holds(d, 'obpDelta', 'netNegative', i), net < 0, `candle ${i}`)
    if (net > 0) pos++; else if (net < 0) neg++
  }
  assert.ok(pos + neg > 0)
  assert.deepEqual(mirrorLines([cleanLine({ id: 'obpBuy', value: 'above' })]).map((l) => [l.id, l.value]), [['obpSell', 'below']])
})

// Footprint bars on the futures: each minute's buy / sell at a few prices around its close.
function footprint(d) {
  return d.t.map((t, i) => {
    const c = d.price.c[i]
    const levels = [-2, -1, 0, 1, 2].map((k) => ({ price: Math.round(c) + k, buy: 10 + ((i * 7 + k * 3) % 13), sell: 10 + ((i * 5 - k * 2 + 26) % 11) }))
    return { time: t, open: d.price.o[i], high: d.price.h[i], low: d.price.l[i], close: c, volume: levels.reduce((s, l) => s + l.buy + l.sell, 0), levels }
  })
}

test('the futures delta profile minute by minute = futuresDeltaProfileOf of the bars up to the clock; read on the futures price', () => {
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  const bars = footprint(d)
  const past = [bars.map((b) => ({ ...b, time: b.time - 86_400_000, levels: b.levels.map((l) => ({ ...l, price: l.price - 40 })), close: b.close - 40, open: b.open - 40, high: b.high - 40, low: b.low - 40 }))]
  const read = futuresDeltaSteps(past, bars, { rowSize: 5 })
  for (const k of [0, 50, bars.length - 1]) {
    const profile = futuresDeltaProfileOf([...past, bars.slice(0, k + 1)], { rowSize: 5 })
    const at = optionDeltaAt(read, bars[k].time)
    assert.deepEqual(at.levels, deltaProfileLevels(profile), `minute ${k}`)
    assert.ok(Math.abs(at.delta - profile.delta) < 1e-6 && Math.abs(at.volume - profile.volume) < 1e-6)
    for (const r of profile.rows.slice(0, 6)) assert.ok(Math.abs(at.rowDelta(r.price + 1) - r.delta) < 1e-6)
  }
  // The conditions: only with the futures' bars on the day, and read against the futures' price.
  const i = 200
  assert.equal(holds(d, 'fdpDelta', 'netPositive', i), false)                                  // no fdm: never
  const withFut = Object.assign(Object.create(Object.getPrototypeOf(d)), d, { fdm: bars })
  const net = futuresDeltaProfileOf([bars.slice(0, i + 1)], { rowSize: 5 }).delta
  assert.equal(holds(withFut, 'fdpDelta', 'netPositive', i), withFut.priceSource === 'futures' && net > 0)
  const poc = deltaProfileLevels(futuresDeltaProfileOf([bars.slice(0, i + 1)], { rowSize: 5 })).poc
  if (withFut.priceSource === 'futures') assert.equal(holds(withFut, 'fdpPoc', 'above', i), withFut.price.c[i] > poc)
  const spotOnly = { ...withFut, priceSource: 'spot' }
  assert.equal(holds(spotOnly, 'fdpPoc', 'above', i) || holds(spotOnly, 'fdpPoc', 'below', i), false)  // no futures price: never
})

test('a rule with the futures delta profile asks the order flow by price and the days before; the loader puts the bars on the day', async () => {
  assert.equal(orderFlowNeeded(rule([{ id: 'fdpPoc', value: 'above' }])), FLOW_PROFILE)
  assert.equal(orderFlowNeeded(rule([{ id: 'futDelta', value: 'buyers' }])), FLOW_DELTA)
  assert.equal(futuresDaysNeeded(rule([{ id: 'fdpPoc', value: 'above' }])), 0)
  assert.equal(futuresDaysNeeded(rule([{ id: 'fdpPoc', value: 'above', param3: 3, param4: 1 }])), 3)
  assert.match(orderFlowUrl('NIFTY', '2026-10-05', FLOW_PROFILE), /rowSize=1&minTradeLots=100000&heatmapColumns=50&backfillBars=true$/)
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  const t0 = d.t[0]
  const body = { source: 'live', meta: { lotSize: 75 }, rowSize: 1, bars: [0, 1, 2].map((k) => ({ time: new Date(t0 + k * MIN).toISOString(), open: 1, high: 2, low: 1, close: 2, buy: 75, sell: 0, levels: [{ price: 25000, buy: 75, sell: 0 }] })) }
  const fake = async () => ({ ok: true, status: 200, json: async () => body })
  assert.deepEqual(await attachOrderFlow(d, 'NIFTY', FLOW_PROFILE, { fetch: fake, asOfMs: t0 + 2 * MIN }), { ok: true })
  assert.equal(d.fdm.length, 2)                                                                 // the minute at the clock not completed
  assert.equal(d.fdm[0].levels[0].buy, 1)                                                        // in lots
})

test('the OI (CE − PE) profile minute by minute = oiProfileOf of the minutes up to the clock; puts written = bullish', async () => {
  const { oiNetSteps } = await import('../src/deltaProfile.js')
  const { oiProfileOf } = await import('../src/oiProfile.js')
  const { deltaDaysNeeded } = await import('../src/signalBacktest.js')
  // Spot moving through a few rows; calls written up top, puts written low.
  const T = Date.UTC(2026, 9, 5, 3, 45)
  const minutes = Array.from({ length: 30 }, (_, k) => ({ t: T + k * MIN, low: 25000 + k * 2, high: 25003 + k * 2, ce: k > 20 ? 500 : 50, pe: k < 10 ? 800 : 40 }))
  const read = oiNetSteps([], minutes, { rowSize: 5 })
  for (const k of [5, 15, 29]) {
    const at = optionDeltaAt(read, minutes[k].t)
    const p = oiProfileOf([minutes.slice(0, k + 1)], { rowSize: 5 })
    assert.ok(Math.abs(at.delta + p.delta) < 1e-6)                 // oiProfileOf's delta is PE − CE: the opposite sign
    for (const r of p.rows.slice(0, 5)) assert.ok(Math.abs(at.rowDelta(r.price + 1) - (r.ce - r.pe)) < 1e-6)
  }
  const early = optionDeltaAt(read, minutes[9].t)
  assert.ok(early.delta < 0 && early.levels.floor > 0 && early.levels.ceiling == null)   // puts written: a floor, bullish
  // The conditions on a prepared day: never without the day's OI minutes; read once there.
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  assert.ok(Array.isArray(d.oim))
  const i = 150
  const net = optionDeltaAt(oiNetSteps([], d.oim.filter((m) => m.t <= d.t[i]), { rowSize: 5 }), d.t[i])?.delta ?? 0
  assert.equal(holds(d, 'oipDelta', 'netBullish', i), net < 0)
  assert.equal(holds(d, 'oipDelta', 'netBearish', i), net > 0)
  assert.deepEqual(mirrorLines([cleanLine({ id: 'oipFloor', value: 'above' })]).map((l) => [l.id, l.value]), [['oipCeiling', 'below']])
  assert.equal(deltaDaysNeeded(rule([{ id: 'oipFloor', value: 'above', param3: 2, param4: 1 }])), 2)  // the days before come with odmPast
})

test('the CDV profile: Net / CE / PE sides minute by minute = the card profile of that side; the mirror swaps CE <-> PE', () => {
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  const sideTest = (id, value, i, side) => { const o = option(id, value); return cond(id).test(d, i, value, 5, o.param.default, side, 1, 0) }
  for (const [code, side] of [[0, 'net'], [1, 'ce'], [2, 'pe']]) {
    const read = optionDeltaSteps([], d.odm, { rowSize: 5, side })
    for (let i = 30; i < d.n; i += 40) {
      const profile = optionDeltaProfileOf([d.odm.filter((m) => m.t <= d.t[i])], { rowSize: 5, side })
      const at = optionDeltaAt(read, d.t[i])
      assert.deepEqual(at.levels, deltaProfileLevels(profile), `${side} candle ${i}`)
      assert.ok(Math.abs(at.delta - profile.delta) < 1e-6)
      assert.equal(sideTest('cdpDelta', 'netPositive', i, code), profile.delta > 0 && profile.delta >= (option('cdpDelta', 'netPositive').param.default / 100) * profile.volume, `${side} ${i} ${profile.delta} ${profile.volume} ${at.delta} ${at.volume}`)
      const lv = deltaProfileLevels(profile)?.buy
      assert.equal(sideTest('cdpBuy', 'above', i, code), Number.isFinite(lv) && d.spot.c[i] > lv, `${side} ${i} ${lv} ${d.spot.c[i]}`)
    }
  }
  // Net is the option delta profile's own net (the CDV); CE / PE are that side alone.
  const i = 150
  assert.equal(sideTest('cdpDelta', 'netPositive', i, 0), holds(d, 'odpDelta', 'netPositive', i))
  const m = (l) => mirrorLines([cleanLine(l)]).map((x) => [x.id, x.value, x.param2])
  assert.deepEqual(m({ id: 'cdpBuy', value: 'above', param2: 0 }), [['cdpSell', 'below', 0]])
  assert.deepEqual(m({ id: 'cdpBuy', value: 'above', param2: 1 }), [['cdpBuy', 'below', 2]])
  assert.deepEqual(m({ id: 'cdpDelta', value: 'buying', param2: 1 }), [['cdpDelta', 'buying', 2]])
  assert.deepEqual(m({ id: 'obpDelta', value: 'netPositive', param2: 2 }), [['obpDelta', 'netPositive', 1]])
  assert.equal(cleanLine({ id: 'cdpDelta', value: 'buying' }).param2, 0)
})

test('the OI profile side: Net (CE − PE) / CE OI / PE OI - negative always bullish; the mirror swaps the side too', async () => {
  const { oiNetSteps } = await import('../src/deltaProfile.js')
  const minutes = [
    { t: 1, low: 100, high: 104, ce: 50, pe: 200 },   // puts written more - bullish row on Net and PE
    { t: 2, low: 110, high: 114, ce: -80, pe: 10 },   // calls unwound - bullish on CE
  ]
  const at = (side) => optionDeltaAt(oiNetSteps([], minutes, { rowSize: 5, side }), 2)
  assert.equal(at('net').delta, (50 - 80) - (200 + 10))
  assert.equal(at('ce').delta, -30)
  assert.equal(at('pe').delta, -210)
  assert.equal(at('net').volume, 250 + 90)
  assert.equal(at('ce').volume, 130)
  assert.equal(at('pe').volume, 210)
  assert.equal(at('ce').levels.floor, 112.5)          // the calls-unwound row
  assert.equal(at('ce').levels.ceiling, 102.5)        // calls written
  assert.equal(at('pe').levels.floor, 102.5)          // the most puts written
  assert.equal(at('pe').rowDelta(111), -10)
  assert.ok(at('net').rowDelta(101) < 0)
  // On a prepared day: each side's net read by the condition, and Net unchanged with no side.
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  const i = 200
  for (const [code, side] of [[0, 'net'], [1, 'ce'], [2, 'pe']]) {
    const net = optionDeltaAt(oiNetSteps([], d.oim.filter((m) => m.t <= d.t[i]), { rowSize: 5, side }), d.t[i])?.delta ?? 0
    assert.equal(cond('oipDelta').test(d, i, 'netBullish', 5, 0, code, 1, 0), net < 0, side)
    assert.equal(cond('oipDelta').test(d, i, 'netBearish', 5, 0, code, 1, 0), net > 0, side)
  }
  assert.equal(cond('oipDelta').test(d, i, 'netBullish', 5, 0, undefined, 1, 0), cond('oipDelta').test(d, i, 'netBullish', 5, 0, 0, 1, 0))
  const m = (l) => mirrorLines([cleanLine(l)]).map((x) => [x.id, x.value, x.param2])
  assert.deepEqual(m({ id: 'oipFloor', value: 'above', param2: 0 }), [['oipCeiling', 'below', 0]])
  assert.deepEqual(m({ id: 'oipFloor', value: 'above', param2: 1 }), [['oipCeiling', 'below', 2]])
  assert.deepEqual(m({ id: 'oipDelta', value: 'putsAt', param2: 2 }), [['oipDelta', 'callsAt', 1]])
})

test('profile clusters: the strongest green / red run of adjacent same-sign rows; the conditions read them; the mirror', async () => {
  const { deltaZones } = await import('../src/deltaProfile.js')
  const rows = [
    { price: 100, delta: 5 }, { price: 105, delta: 7 }, { price: 110, delta: 4 },   // green 100 - 115, 16
    { price: 115, delta: -2 },                                                        // red 115 - 120, -2
    { price: 125, delta: 30 },                                                        // a gap before it: its own run - green 30
    { price: 130, delta: -9 }, { price: 135, delta: -8 },                             // red 130 - 140, -17
  ]
  const z = deltaZones(rows, 5)
  assert.deepEqual([z.green.low, z.green.high, z.green.sum, z.green.rows], [125, 130, 30, 1])
  assert.deepEqual([z.red.low, z.red.high, z.red.sum, z.red.rows], [130, 140, -17, 2])
  const oi = deltaZones(rows, 5, { bullishNegative: true })
  assert.deepEqual([oi.green.low, oi.green.high], [130, 140])                       // OI: negative = bullish
  assert.deepEqual([oi.red.low, oi.red.high], [125, 130])
  assert.deepEqual(deltaZones([], 5), { green: null, red: null })

  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  const read = optionDeltaSteps([], d.odm, { rowSize: 5 })
  let checked = 0
  for (let i = 30; i < d.n; i += 20) {
    const zones = optionDeltaAt(read, d.t[i])?.zones
    const g = zones?.green, c = d.spot.c[i]
    const t = (v) => cond('odpZone').test(d, i, v, 5, 0, undefined, 1, 0)
    assert.equal(t('aboveGreen'), !!g && c > g.high, `candle ${i}`)
    assert.equal(t('belowGreen'), !!g && c < g.low)
    assert.equal(t('inGreen'), !!g && c >= g.low && c <= g.high)
    if (g) checked++
  }
  assert.ok(checked > 0)
  // Every profile group has its clusters.
  for (const id of ['odpZone', 'cdpZone', 'obpZone', 'oipZone', 'fdpZone']) assert.ok(cond(id), id)
  assert.equal(cond('fdpZone').test(d, 200, 'aboveGreen', 5, 0, undefined, 1, 0), false)   // no futures footprint: never
  const m = (l) => mirrorLines([cleanLine(l)]).map((x) => [x.id, x.value, x.param2])
  assert.deepEqual(m({ id: 'odpZone', value: 'aboveGreen' }), [['odpZone', 'belowRed', undefined]])
  assert.deepEqual(m({ id: 'cdpZone', value: 'heldAboveGreen', param2: 0 }), [['cdpZone', 'heldBelowRed', 0]])
  assert.deepEqual(m({ id: 'cdpZone', value: 'heldAboveGreen', param2: 1 }), [['cdpZone', 'heldBelowGreen', 2]])
  assert.deepEqual(m({ id: 'oipZone', value: 'crossedAboveRed', param2: 2 }), [['oipZone', 'crossedBelowGreen', 1]])
})
