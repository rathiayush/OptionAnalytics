// The spot + options strategies #108-#110 (spotEngine.js) - the ATM straddle decaying (fade the wall back to the
// middle), writers migrating (the OI wall stepping one strike with the price) and a new high / low the ATM premium
// does not confirm - and ALL ten spot strategies at BANKNIFTY (~52,000, step 100) and SENSEX (~82,000, step 100)
// scale. Each fires on its rules - LONG and SHORT - and not when each key condition is missing; nothing after the
// clock is read. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPOT_STRATEGIES, buildOiContext } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, scanSpotDay, spotBarsOf } from '../src/spotEngine.js'
import { lvnRefusedLong, lvnRefusedShort, lvnFillLong, lvnFillShort, pocRejectShort, pocRejectLong } from './spot-profile-world.mjs'

const MIN = 60_000
const T = Date.parse('2026-10-09T03:45:00Z') // 09:15 IST
const iso = (m) => new Date(T + m * MIN).toISOString()
const NIFTY_STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
const ramp = (m) => Math.max(0, m - 74) // the last 15 minutes before the clock at minute 90

// Scales: a scenario is written at NIFTY (22,500, step 50) and mapped strike for strike onto the other index - a
// price p becomes base + (p - 22500) x step / 50, so every level sits the same number of strikes from the walls.
// Premiums move by the same factor (the percent rules read them the same way).
const NIFTY = { base: 22500, step: 50 }
const BANKNIFTY = { base: 52000, step: 100 }
const SENSEX = { base: 82000, step: 100 }

/** A day at `scale`: `candle(m)` a spot candle, `ce` / `pe` (k, m) the OI and `ceP` / `peP` (k, m) the premium,
 *  every one written in NIFTY terms (k a NIFTY strike). */
function world({ candle, ce, pe, ceP = () => 60, peP = () => 60, minutes = 91, scale = NIFTY }) {
  const f = scale.step / 50
  const px = (p) => scale.base + (p - 22500) * f
  const spot = Array.from({ length: minutes }, (_, m) => {
    const x = candle(m)
    return { time: iso(m), open: px(x.open), high: px(x.high), low: px(x.low), close: px(x.close) }
  })
  const points = (oiF, priceF) => spot.flatMap((_, m) => NIFTY_STRIKES.map((k) => ({ time: iso(m), strike: px(k), openInterest: Math.round(oiF(k, m)), price: priceF(k, m) * f })))
  const run = { success: true, date: '2026-10-09', step: scale.step, cePoints: points(ce, ceP), pePoints: points(pe, peP), futuresBars: [], spotCandlesOneMinute: spot }
  return { oi: buildOiContext(run, null, { live: false }), bars: spotBarsOf(spot), scale }
}
const at = (w, minute = 90) => {
  const nowMs = T + minute * MIN
  return evaluateSpotStrategies({ nowMs, bars: w.bars.filter((b) => b.t + MIN <= nowMs), oi: w.oi })
}
const fires = (w, id, side, minute = 90) => at(w, minute).some((s) => s.id === id && s.side === side)
const c = (open, close, pad = 3) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
const around = (level, last) => (m) => (m < 89 ? c(level + ((m % 4) - 1.5), level + (((m + 1) % 4) - 1.5)) : last)

test('thirteen spot strategies, numbered 101-113, ids unique', () => {
  assert.equal(SPOT_STRATEGIES.length, 13)
  assert.deepEqual(SPOT_STRATEGIES.map((s) => s.no), [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113])
  assert.equal(new Set(SPOT_STRATEGIES.map((s) => s.id)).size, 13)
})

// ---- #108 ATM straddle decay: fade the wall back to the middle ----
// The walls: puts 22400 (support), calls 22600 (resistance) - a 4-strike range, the middle 22500. The ATM strike's CE
// and PE OI both grow 1.5% in the last 15 minutes; the ATM premiums fall 0.2% a minute over those minutes (60 before).
const RANGE_CE = (k) => (k === 22600 ? 6e6 : 2e6)
const RANGE_PE = (k) => (k === 22400 ? 6e6 : 2e6)
const atmWrite = (atm, base, rate = 0.001) => (k, m) => base(k) * (k === atm ? 1 + rate * ramp(m) : 1)
const decay = (rate = 0.002) => (k, m) => 60 * (1 - rate * ramp(m))
const straddleShort = (o = {}) => world({ candle: around(22560, c(22588, 22581, 2)), ce: atmWrite(22600, RANGE_CE), pe: atmWrite(22600, RANGE_PE), ceP: decay(), peP: decay(), ...o })
const straddleLong = (o = {}) => world({ candle: around(22440, c(22412, 22419, 2)), ce: atmWrite(22400, RANGE_CE), pe: atmWrite(22400, RANGE_PE), ceP: decay(), peP: decay(), ...o })

test('#108 straddle fade: the ATM straddle decaying, both ATM sides written, a turn at the wall -> fade to the middle', () => {
  // SHORT: the last minute pokes to 22590 under the call wall 22600 and closes back down at 22581.
  const s = at(straddleShort()).find((x) => x.id === 'spotStraddleFade' && x.side === 'SHORT')
  assert.ok(s, 'fires SHORT at the call wall')
  assert.equal(s.entry, 22581)
  assert.equal(s.target, 22500, 'the target is the middle of the walls')
  assert.ok(s.stop > 22600, 'the stop is beyond the wall')
  assert.ok(!fires(straddleShort({ ceP: () => 60, peP: () => 60 }), 'spotStraddleFade', 'SHORT'), 'the straddle is not decaying')
  assert.ok(!fires(straddleShort({ ceP: decay(0.0002), peP: decay(0.0002) }), 'spotStraddleFade', 'SHORT'), 'the straddle only -0.2% in 10 minutes')
  assert.ok(!fires(straddleShort({ ce: RANGE_CE }), 'spotStraddleFade', 'SHORT'), 'the ATM calls are not being written')
  assert.ok(!fires(straddleShort({ pe: RANGE_PE }), 'spotStraddleFade', 'SHORT'), 'the ATM puts are not being written')
  assert.ok(!fires(straddleShort({ candle: around(22560, c(22581, 22588, 2)) }), 'spotStraddleFade', 'SHORT'), 'a bullish candle: no turn')
  assert.ok(!fires(straddleShort({ candle: around(22520, c(22548, 22541, 2)), ce: atmWrite(22550, RANGE_CE), pe: atmWrite(22550, RANGE_PE) }), 'spotStraddleFade', 'SHORT'), 'not at the edge')
  assert.ok(!fires(straddleShort({ pe: atmWrite(22600, (k) => (k === 22550 ? 6e6 : 2e6)) }), 'spotStraddleFade', 'SHORT'), 'the walls one strike apart: no middle to fade to')
  // LONG: the mirror at the put wall 22400.
  const l = at(straddleLong()).find((x) => x.id === 'spotStraddleFade' && x.side === 'LONG')
  assert.ok(l, 'fires LONG at the put wall')
  assert.equal(l.target, 22500)
  assert.ok(!fires(straddleLong({ ceP: () => 60, peP: () => 60 }), 'spotStraddleFade', 'LONG'))
  assert.ok(!fires(straddleLong({ ce: RANGE_CE }), 'spotStraddleFade', 'LONG'))
  assert.ok(!fires(straddleLong({ pe: RANGE_PE }), 'spotStraddleFade', 'LONG'))
  assert.ok(!fires(straddleLong({ candle: around(22440, c(22419, 22412, 2)) }), 'spotStraddleFade', 'LONG'))
})

// ---- #109 writer migration ----
// LONG: the put wall 22450 (6M) all day; in the last 15 minutes puts are written at 22500 (2M -> 6.5M) and the spot
// climbs from 22480 to 22530: the biggest put wall steps up to 22500 and the price goes with it.
const climb = (from, to, last) => (m) => {
  const p = (x) => (x <= 74 ? from + ((x % 4) - 1.5) : x >= 89 ? to : from + ((to - from) * (x - 74)) / 15)
  return m === 89 ? last : c(p(m), p(m + 1), 2)
}
const shiftLong = (o = {}) => world({
  candle: climb(22480, 22526, c(22526, 22530, 2)),
  ce: (k) => (k === 22650 ? 6e6 : 2e6),
  pe: (k, m) => (k === 22450 ? 6e6 : k === 22500 ? 2e6 + 0.3e6 * ramp(m) : 2e6),
  ...o,
})
const shiftShort = (o = {}) => world({
  candle: climb(22520, 22474, c(22474, 22470, 2)),
  ce: (k, m) => (k === 22550 ? 6e6 : k === 22500 ? 2e6 + 0.3e6 * ramp(m) : 2e6),
  pe: (k) => (k === 22350 ? 6e6 : 2e6),
  ...o,
})
test('#109 writer migration: the biggest OI wall steps one strike with the price, which follows', () => {
  const l = at(shiftLong()).find((x) => x.id === 'spotWallShift' && x.side === 'LONG')
  assert.ok(l, 'fires LONG: the put wall stepped up 22450 -> 22500')
  assert.ok(l.stop < 22500 && l.target > l.entry)
  assert.ok(!fires(shiftLong({ pe: (k) => (k === 22450 ? 6e6 : 2e6) }), 'spotWallShift', 'LONG'), 'the wall did not move')
  assert.ok(!fires(shiftLong({ pe: (k, m) => (k === 22450 ? 6e6 : k === 22550 ? 2e6 + 0.3e6 * ramp(m) : 2e6), candle: climb(22480, 22576, c(22576, 22580, 2)) }), 'spotWallShift', 'LONG'), 'it jumped two strikes, not one')
  assert.ok(!fires(shiftLong({ candle: climb(22510, 22526, c(22526, 22530, 2)) }), 'spotWallShift', 'LONG'), 'the price did not follow: up under half a strike')
  assert.ok(!fires(shiftLong({ candle: climb(22480, 22526, c(22530, 22526, 2)) }), 'spotWallShift', 'LONG'), 'the last candle goes against it')
  assert.ok(!fires(shiftLong({ pe: (k) => (k === 22450 ? 6e6 : k === 22500 ? 6.5e6 : 2e6), candle: climb(22430, 22526, c(22526, 22530, 2)) }), 'spotWallShift', 'LONG'), 'the new wall\'s OI did not grow (it was there all along)')
  const s = at(shiftShort()).find((x) => x.id === 'spotWallShift' && x.side === 'SHORT')
  assert.ok(s, 'fires SHORT: the call wall stepped down 22550 -> 22500')
  assert.ok(s.stop > 22500 && s.target < s.entry)
  assert.ok(!fires(shiftShort({ ce: (k) => (k === 22550 ? 6e6 : 2e6) }), 'spotWallShift', 'SHORT'))
  assert.ok(!fires(shiftShort({ candle: climb(22490, 22474, c(22474, 22470, 2)) }), 'spotWallShift', 'SHORT'))
  assert.ok(!fires(shiftShort({ candle: climb(22520, 22474, c(22470, 22474, 2)) }), 'spotWallShift', 'SHORT'))
})

// ---- #110 premium divergence ----
// SHORT: a high of 22540 at minute 60, a dip, then a new high 22551 at minute 89 closing 22545 - a bearish candle.
// The ATM 22550 call's premium follows the spot (0.5 a point) but loses 0.2 a minute to the day (IV / decay), so at
// the new high it is BELOW what it was at the first high.
const highDay = (last = c(22548, 22545, 3), rise = 2.3) => (m) => {
  if (m === 89) return last
  const p = (x) => (x <= 60 ? 22480 + x : x <= 75 ? 22540 - 2 * (x - 60) : 22510 + rise * (x - 75))
  return c(p(m), p(m + 1), 1)
}
const lowDay = (last = c(22452, 22455, 3), fall = 2.3) => (m) => {
  if (m === 89) return last
  const p = (x) => (x <= 60 ? 22520 - x : x <= 75 ? 22460 + 2 * (x - 60) : 22490 - fall * (x - 75))
  return c(p(m), p(m + 1), 1)
}
const closeOf = (day) => (m) => day(m).close
const premium = (day, side, crush = 0.2) => (k, m) => Math.max(5, 60 + side * 0.5 * (closeOf(day)(m) - k) - crush * m)
const flatOi = () => 2e6
const divShort = (o = {}) => { const day = o.day ?? highDay(); return world({ candle: day, ce: flatOi, pe: flatOi, ceP: premium(day, 1, o.crush), peP: premium(day, -1, o.crush), ...o }) }
const divLong = (o = {}) => { const day = o.day ?? lowDay(); return world({ candle: day, ce: flatOi, pe: flatOi, ceP: premium(day, 1, o.crush), peP: premium(day, -1, o.crush), ...o }) }

test('#110 premium divergence: a new session high the ATM call premium does not confirm -> short; the mirror long', () => {
  const s = at(divShort()).find((x) => x.id === 'spotPremDiverge' && x.side === 'SHORT')
  assert.ok(s, 'fires SHORT')
  assert.equal(s.entry, 22545)
  assert.ok(s.stop > 22551 && s.target < s.entry)
  assert.ok(!fires(divShort({ crush: 0 }), 'spotPremDiverge', 'SHORT'), 'the call premium confirms the new high')
  // The first high: minute 59, high 22541, close 22540. Here the last minutes stop 0.2 under it, closing above 22540.
  assert.ok(!fires(divShort({ day: highDay(c(22540.5, 22540.2, 0.3), 2) }), 'spotPremDiverge', 'SHORT'), 'no new session high')
  assert.ok(!fires(divShort({ day: highDay(c(22548, 22549, 3)) }), 'spotPremDiverge', 'SHORT'), 'the last candle does not turn down')
  assert.ok(!fires(divShort({ ce: (k, m) => 2e6 * (k === 22550 || k === 22600 ? 1 - 0.001 * ramp(m) : 1) }), 'spotPremDiverge', 'SHORT'), 'the call writers at ATM / above are covering')
  assert.ok(!fires(divShort({ day: highDay(c(22545, 22536, 9)) }), 'spotPremDiverge', 'SHORT'), 'closed back under the first high\'s close: the premium is lower anyway')
  const l = at(divLong()).find((x) => x.id === 'spotPremDiverge' && x.side === 'LONG')
  assert.ok(l, 'fires LONG')
  assert.ok(l.stop < 22449 && l.target > l.entry)
  assert.ok(!fires(divLong({ crush: 0 }), 'spotPremDiverge', 'LONG'))
  assert.ok(!fires(divLong({ day: lowDay(c(22459.5, 22459.8, 0.3), 2) }), 'spotPremDiverge', 'LONG'), 'no new session low')
  assert.ok(!fires(divLong({ day: lowDay(c(22452, 22451, 3)) }), 'spotPremDiverge', 'LONG'))
  assert.ok(!fires(divLong({ pe: (k, m) => 2e6 * (k === 22450 || k === 22400 ? 1 - 0.001 * ramp(m) : 1) }), 'spotPremDiverge', 'LONG'))
})

test('#108-#110 read nothing after the clock', () => {
  for (const make of [straddleShort, straddleLong, shiftLong, shiftShort, divShort, divLong]) {
    const w = make({ minutes: 130 })
    const cutMs = T + 90 * MIN
    const now = at(w)
    const cutMap = (map) => new Map([...map].map(([k, v]) => [k, v.filter((p) => p.t <= cutMs)]))
    const cut = { ...w.oi, ce: cutMap(w.oi.ce), pe: cutMap(w.oi.pe), spot: w.oi.spot.filter((p) => p.t <= cutMs) }
    const again = evaluateSpotStrategies({ nowMs: cutMs, bars: w.bars.filter((b) => b.t + MIN <= cutMs), oi: cut })
    assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(now)))
    assert.ok(now.some((s) => ['spotStraddleFade', 'spotWallShift', 'spotPremDiverge'].includes(s.id)))
  }
})

test('no spot entry after 14:45', () => {
  const late = Date.parse('2026-10-09T09:16:00Z') // 14:46 IST
  const w = straddleShort()
  const bars = w.bars.map((b, i) => ({ ...b, t: late - (w.bars.length - i) * MIN }))
  assert.deepEqual(evaluateSpotStrategies({ nowMs: late, bars, oi: w.oi }), [])
  assert.ok(scanSpotDay({ bars: w.bars, oi: w.oi }).every((s) => (s.t / MIN + 330) % 1440 <= 14 * 60 + 45))
})

// ---- every spot strategy at BANKNIFTY and SENSEX scale (the scenarios of spot-strategies*.test.mjs mapped strike for
// strike, plus #108-#110) ----
const BASE_CE = (k) => (k === 22550 ? 6e6 : 2e6)
const BASE_PE = (k) => (k === 22450 ? 6e6 : 2e6)
const drift = (m, d, rampSign) => (1 + d * 0.00015 * m) * (1 + rampSign * 0.0004 * ramp(m))
const bull = { ce: (k, m) => BASE_CE(k) * drift(m, -1, -1), pe: (k, m) => BASE_PE(k) * drift(m, 1, 1) }
const bear = { ce: (k, m) => BASE_CE(k) * drift(m, 1, 1), pe: (k, m) => BASE_PE(k) * drift(m, -1, -1) }
const trend = (from, slope) => (m) => {
  const close = (x) => (x <= 100 ? from + slope * x : from + slope * 100 - Math.sign(slope) * (x - 100))
  return c(close(m), close(m + 1), 2)
}
const up = (m) => { const x = (y) => 22480 + y * 0.35; return c(x(m), x(m + 1), 2) }
const down = (m) => { const x = (y) => 22540 - y * 0.35; return c(x(m), x(m + 1), 2) }
const putsLate = (k, m) => 2e6 * (1 + 0.006 * Math.max(0, m - 79))
const callsAll = (k, m) => 2e6 * (1 + 0.0002 * m)
const peLadder = (k, m) => (k === 22400 ? 3.5e6 : k === 22350 || k === 22450 ? 3e6 : 2e6) * (k >= 22350 && k <= 22450 ? 1 + 0.012 * ramp(m) : 1)
const ceLadder = (k, m) => (k === 22600 ? 3.5e6 : k === 22550 || k === 22650 ? 3e6 : 2e6) * (k >= 22550 && k <= 22650 ? 1 + 0.012 * ramp(m) : 1)
const SCENARIOS = [
  ['spotWallBreak', 'LONG', { candle: around(22545, c(22546, 22556)), ...bull }],
  ['spotWallBreak', 'SHORT', { candle: around(22455, c(22454, 22444)), ...bear }],
  ['spotWallHold', 'LONG', { candle: around(22470, c(22452, 22459, 2)), ...bull }],
  ['spotWallHold', 'SHORT', { candle: around(22530, c(22548, 22541, 2)), ...bear }],
  ['spotSides', 'LONG', { candle: around(22500, c(22502, 22509, 1)), ...bull }],
  ['spotSides', 'SHORT', { candle: around(22500, c(22498, 22491, 1)), ...bear }],
  ['spotAvgPullback', 'LONG', { candle: (m) => (m === 163 ? c(22495, 22501, 1) : trend(22400, 1.6)(m)), minutes: 165, ...bull }, 164],
  ['spotAvgPullback', 'SHORT', { candle: (m) => (m === 163 ? c(22505, 22499, 1) : trend(22600, -1.6)(m)), minutes: 165, ...bear }, 164],
  ['spotFreshWriting', 'LONG', { candle: around(22510, c(22508, 22512)), ce: (k, m) => 2e6 * (k === 22550 || k === 22600 ? 1 - 0.001 * ramp(m) : 1), pe: (k, m) => 2e6 * (k === 22500 ? 1 + 0.002 * ramp(m) : 1) }],
  ['spotFreshWriting', 'SHORT', { candle: around(22490, c(22492, 22488)), ce: (k, m) => 2e6 * (k === 22500 ? 1 + 0.002 * ramp(m) : 1), pe: (k, m) => 2e6 * (k === 22450 || k === 22400 ? 1 - 0.001 * ramp(m) : 1) }],
  ['spotCumFlip', 'LONG', { candle: up, ce: callsAll, pe: putsLate }],
  ['spotCumFlip', 'SHORT', { candle: down, ce: putsLate, pe: callsAll }],
  ['spotLadder', 'LONG', { candle: around(22470, c(22466, 22471, 2)), ce: (k) => (k === 22600 ? 4e6 : 2e6), pe: peLadder }],
  ['spotLadder', 'SHORT', { candle: around(22530, c(22534, 22529, 2)), ce: ceLadder, pe: (k) => (k === 22400 ? 4e6 : 2e6) }],
]
const NEW = [
  ['spotStraddleFade', 'SHORT', straddleShort], ['spotStraddleFade', 'LONG', straddleLong],
  ['spotWallShift', 'LONG', shiftLong], ['spotWallShift', 'SHORT', shiftShort],
  ['spotPremDiverge', 'SHORT', divShort], ['spotPremDiverge', 'LONG', divLong],
  // #111 - #113 on the day's own spot profile (their own rules: spot-strategies-4).
  ['spotLvnReject', 'LONG', lvnRefusedLong], ['spotLvnReject', 'SHORT', lvnRefusedShort],
  ['spotLvnFill', 'LONG', lvnFillLong], ['spotLvnFill', 'SHORT', lvnFillShort],
  ['spotPocReject', 'SHORT', pocRejectShort], ['spotPocReject', 'LONG', pocRejectLong],
]

test('every spot strategy fires LONG and SHORT at NIFTY, BANKNIFTY and SENSEX scale', () => {
  for (const scale of [NIFTY, BANKNIFTY, SENSEX]) {
    for (const [id, side, spec, minute] of SCENARIOS) assert.ok(fires(world({ ...spec, scale }), id, side, minute ?? 90), `${id} ${side} at ${scale.base}`)
    for (const [id, side, make] of NEW) assert.ok(fires(make({ scale }), id, side), `${id} ${side} at ${scale.base}`)
  }
  const covered = new Set([...SCENARIOS, ...NEW].map(([id, side]) => `${id}:${side}`))
  for (const s of SPOT_STRATEGIES) for (const side of ['LONG', 'SHORT']) assert.ok(covered.has(`${s.id}:${side}`), `${s.id} ${side} has a scale scenario`)
})

test('at BANKNIFTY and SENSEX scale the new strategies still do not fire when a key condition is missing', () => {
  for (const scale of [BANKNIFTY, SENSEX]) {
    assert.ok(!fires(straddleShort({ scale, ceP: () => 60, peP: () => 60 }), 'spotStraddleFade', 'SHORT'))
    assert.ok(!fires(straddleLong({ scale, pe: RANGE_PE }), 'spotStraddleFade', 'LONG'))
    assert.ok(!fires(shiftLong({ scale, pe: (k) => (k === 22450 ? 6e6 : 2e6) }), 'spotWallShift', 'LONG'))
    assert.ok(!fires(shiftShort({ scale, candle: climb(22490, 22474, c(22474, 22470, 2)) }), 'spotWallShift', 'SHORT'))
    assert.ok(!fires(divShort({ scale, crush: 0 }), 'spotPremDiverge', 'SHORT'))
    assert.ok(!fires(divLong({ scale, crush: 0 }), 'spotPremDiverge', 'LONG'))
  }
})

test('the stops and targets of the new strategies are the same in strike terms at every scale', () => {
  for (const [id, side, make] of NEW) {
    const rel = (scale) => {
      const s = at(make({ scale })).find((x) => x.id === id && x.side === side)
      return { stop: (s.stop - s.entry) / scale.step, target: (s.target - s.entry) / scale.step }
    }
    const n = rel(NIFTY)
    for (const scale of [BANKNIFTY, SENSEX]) {
      const o = rel(scale)
      assert.equal(Math.sign(o.stop), Math.sign(n.stop), `${id} ${side}`)
      assert.equal(Math.sign(o.target), Math.sign(n.target), `${id} ${side}`)
      // The ATR floor (0.04% of the price) is relatively wider at SENSEX - within 1.5 strikes of the NIFTY levels.
      assert.ok(Math.abs(o.stop - n.stop) <= 1.5 && Math.abs(o.target - n.target) <= 3, `${id} ${side} at ${scale.base}: ${JSON.stringify({ n, o })}`)
    }
  }
})
