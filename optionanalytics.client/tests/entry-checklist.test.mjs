import test from 'node:test'
import assert from 'node:assert/strict'
import { entryChecklist } from '../src/entryChecklist.js'

const T0 = Date.parse('2026-10-16T04:30:00Z') // 10:00 IST
const at = (m) => new Date(T0 + m * 60000).toISOString()
const STEP = 50

// A day where a CE buy has everything: spot rising above VWAP, puts written at / below ATM, calls cut above, calls
// bought (CE bars closing at their highs), spot at yesterday's POC, IV calm, 10:00-10:30 IST.
function bullishDay({ minutes = 30, ceWallAbove = false } = {}) {
  const spot = [], vwap = [], ce = [], pe = []
  for (let m = 0; m < minutes; m++) {
    const s = 24000 + m
    spot.push({ time: at(m), close: s })
    vwap.push({ time: at(m), value: 23990 })
    for (let k = 23800; k <= 24250; k += STEP) {
      const peOi = k <= 24000 ? 1e6 + m * 20000 : 1e6
      const ceBase = k > 24000 ? 1e6 - m * 10000 : 1e6
      const ceOi = ceWallAbove && k === 24050 ? 5e6 : ceBase
      ce.push({ time: at(m), strike: k, openInterest: ceOi, impliedVolatility: 14, price: 110, open: 100, high: 110, low: 100, volume: 1000 })
      pe.push({ time: at(m), strike: k, openInterest: peOi, impliedVolatility: 14, price: 90, open: 100, high: 100, low: 90, volume: 800 })
    }
  }
  return { spot, vwap, ce, pe }
}

const profile = { poc: 24025, vah: 24300, val: 23700, hvn: [], lvn: [] }
const run = (day, asOfMin, extra = {}) => entryChecklist({
  asOfMs: T0 + asOfMin * 60000, spotBars: day.spot, vwap: day.vwap, cePoints: day.ce, pePoints: day.pe, step: STEP, profile, ...extra,
})
const pass = (side, key) => side.checks.find((c) => c.key === key).pass

test('a CE buy with everything in its favour passes every check; the PE buy fails the directional ones', () => {
  const r = run(bullishDay(), 25)
  assert.equal(r.atm, 24050)
  assert.equal(r.ce.passed, 7, JSON.stringify(r.ce.checks.filter((c) => c.pass !== true)))
  for (const key of ['direction', 'writers', 'flow']) assert.equal(pass(r.pe, key), false, key)
  assert.deepEqual(r.ce.strikes.map((s) => s.strike), [24050, 24000])
  assert.deepEqual(r.pe.strikes.map((s) => s.strike), [24050, 24100])
})

test('a big CE wall at the next strike above fails "no wall ahead" for the CE buy', () => {
  const r = run(bullishDay({ ceWallAbove: true }), 10)
  assert.equal(pass(r.ce, 'wall'), false)
  assert.match(r.ce.checks.find((c) => c.key === 'wall').detail, /wall right ahead/)
})

test('nothing after the clock is used: the same answer whether the later minutes exist or not', () => {
  const full = bullishDay({ minutes: 30 })
  const cut = bullishDay({ minutes: 21 })
  assert.deepEqual(run(full, 20), run(cut, 20))
})

test('a check without the data to judge it is unknown, never a pass', () => {
  const day = bullishDay({ minutes: 3 })
  const r = entryChecklist({ asOfMs: T0 + 2 * 60000, spotBars: day.spot, vwap: [], cePoints: day.ce.map((p) => ({ ...p, impliedVolatility: null })), pePoints: day.pe, step: STEP, profile: null })
  for (const key of ['direction', 'writers', 'location']) assert.equal(pass(r.ce, key), null, key)
  assert.equal(pass(r.ce, 'iv'), null)
  assert.ok(r.ce.judged < 7)
})

test('no strike standing out is no wall; early in the day the writers are measured from the open', () => {
  const day = bullishDay({ minutes: 8 })
  const r = run(day, 7)
  // Every CE strike near 1M: nothing stands out, so nothing blocks the CE buy.
  assert.equal(pass(r.ce, 'wall'), true)
  assert.match(r.ce.checks.find((c) => c.key === 'wall').detail, /no CE strike stands out/)
  // 7 minutes in, the 15-minute window starts before the open: measured from the first readings instead.
  assert.equal(pass(r.ce, 'writers'), true)
  // Under 5 minutes of OI is too little to judge.
  assert.equal(pass(run(day, 3).ce, 'writers'), null)
})

test('before 09:15 there is nothing to judge: the pre-open prints and yesterday are not used', async () => {
  const { entryChecklist, sessionOpenMs } = await import('../src/entryChecklist.js')
  const preOpen = Date.parse('2026-10-22T03:38:00Z') // 09:08 IST
  const open = Date.parse('2026-10-22T03:45:00Z')    // 09:15 IST
  assert.equal(sessionOpenMs(preOpen), open)
  assert.equal(sessionOpenMs(Date.parse('2026-10-22T10:00:00Z')), open)
  const yesterday = Date.parse('2026-10-21T09:59:00Z') // 15:29 IST the day before
  const spotBars = [{ time: yesterday, close: 22850 }, { time: preOpen - 60000, close: 22811.3 }]
  const vwap = [{ time: yesterday, value: 22847.7 }]
  assert.deepEqual(entryChecklist({ asOfMs: preOpen, spotBars, vwap, cePoints: [], pePoints: [], step: 50 }), { waiting: true, opensAt: open })
  // From the first minute on it judges - on today's data only (yesterday's VWAP is not today's).
  const r = entryChecklist({ asOfMs: open + 60000, spotBars: [...spotBars, { time: open, close: 22830 }], vwap, cePoints: [], pePoints: [], step: 50 })
  assert.equal(r.spot, 22830)
  assert.equal(r.ce.checks.find((c) => c.key === 'direction').pass, null)
})

test('gamma: dealers short gamma under both signs passes for either buy; long gamma fails; the signs disagreeing is unknown', () => {
  const day = bullishDay()
  const gexOf = (standardNet, buildupNet, walls = {}) => ({ standard: { net: standardNet, ...walls }, buildup: { net: buildupNet, ...walls } })
  const short = run(day, 25, { gex: gexOf(-5e10, -2e10) })
  assert.equal(pass(short.ce, 'gamma'), true)
  assert.equal(pass(short.pe, 'gamma'), true)
  assert.match(short.ce.checks.find((c) => c.key === 'gamma').detail, /short gamma: moves run/)
  const long = run(day, 25, { gex: gexOf(4e10, 1e10) })
  assert.equal(pass(long.ce, 'gamma'), false)
  assert.match(long.ce.checks.find((c) => c.key === 'gamma').detail, /long gamma/)
  const split = run(day, 25, { gex: gexOf(4e10, -1e10) })
  assert.equal(pass(split.ce, 'gamma'), null)
  assert.match(split.ce.checks.find((c) => c.key === 'gamma').detail, /disagree/)
  // No GEX given: unknown, never a pass.
  assert.equal(pass(run(day, 25).ce, 'gamma'), null)
  // With everything else in its favour and dealers short gamma, the CE buy has all eight - no GEX room check any more.
  assert.equal(short.ce.checks.length, 8)
  assert.equal(short.ce.checks.some((c) => c.key === 'gexRoom'), false)
  assert.equal(short.ce.passed, 8, JSON.stringify(short.ce.checks.filter((c) => c.pass !== true)))
})
