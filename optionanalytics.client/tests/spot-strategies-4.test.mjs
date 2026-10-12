// The spot + options strategies on the day's OWN spot profile (spotEngine.js spotProfile, #111 - #113): an LVN refused
// (back to the node it came from), an LVN filled fast (across to the next node), and the POC refusing a fast run into it.
// The profile is built by the engine itself from the spot minutes that finished 15+ minutes before the clock - time at
// price, no server profile, no futures. Each fires on its rules - LONG and SHORT, at NIFTY, BANKNIFTY and SENSEX scale -
// and not when each key condition is missing; nothing after the clock is read. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPOT_STRATEGIES, STRATEGY_BY_ID, buildOiContext } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, scanSpotDay, spotProfile, PROFILE_LAG, PROFILE_MIN_BARS } from '../src/spotEngine.js'
import { spotScanTick } from '../src/scannerCore.js'
import {
  MIN, T, NIFTY, BANKNIFTY, SENSEX, ramp, morning, lvnRefusedLong, lvnRefusedShort, lvnFillLong, lvnFillShort, pocRejectShort, pocRejectLong,
} from './spot-profile-world.mjs'

const done = (w, minute = 90) => w.bars.filter((b) => b.t + MIN <= T + minute * MIN)
const at = (w, minute = 90) => evaluateSpotStrategies({ nowMs: T + minute * MIN, bars: done(w, minute), oi: w.oi })
const profileOf = (w, minute = 90) => spotProfile(done(w, minute), w.oi.step)
const find = (w, id, side) => at(w).find((s) => s.id === id && s.side === side)
const fires = (w, id, side) => !!find(w, id, side)
// OI 15 minutes before the clock -> now: a side rising / falling by `rate` a minute over those minutes.
const moving = (rate, only = null) => (k, m) => 2e6 * (only == null || only === k ? 1 + rate * ramp(m) : 1)

test('three own-profile spot strategies, #111 - #113, in the profile group', () => {
  assert.deepEqual(SPOT_STRATEGIES.slice(-3).map((s) => [s.no, s.id, s.group]), [[111, 'spotLvnReject', 'profile'], [112, 'spotLvnFill', 'profile'], [113, 'spotPocReject', 'profile']])
  assert.ok(['spotLvnReject', 'spotLvnFill', 'spotPocReject'].every((id) => STRATEGY_BY_ID[id]?.spot && /own spot profile/.test(STRATEGY_BY_ID[id].name)))
})

test('our own spot profile: time at price over the minutes finished 15+ minutes ago - its nodes and the thin area between', () => {
  const w = lvnRefusedLong()
  const p = profileOf(w)
  // The 'up' morning: a balance round 22400, three fast candles up, a balance round 22620 (longer - the POC).
  assert.equal(p.row, 5, 'a tenth of the strike step')
  assert.equal(p.minutes, 75, 'the 90 finished minutes less the last 15')
  assert.equal(p.upTo, T + 75 * MIN)
  assert.equal(p.poc, 22610)
  assert.deepEqual(p.nodes, [22390, 22610])
  assert.equal(p.lvns.length, 1)
  assert.deepEqual([p.lvns[0].low, p.lvns[0].high, p.lvns[0].mid], [22432.5, 22582.5, 22507.5], 'the thin rows between the two nodes')
  assert.ok(p.lvns[0].lvn > p.lvns[0].low && p.lvns[0].lvn < p.lvns[0].high)
  assert.deepEqual([p.val, p.vah], [22410, 22650], 'the value area (70% of the time) round both nodes')
  // Only what finished 15+ minutes ago: the last 15 minutes changed any way leave it as it was.
  const bars = done(w)
  const wild = [...bars.slice(0, -PROFILE_LAG), ...bars.slice(-PROFILE_LAG).map((b) => ({ ...b, open: 22500, close: 22500, high: 22505, low: 22495 }))]
  assert.deepEqual(spotProfile(wild, 50), p)
  // Too few minutes: none (the strategies wait for it).
  assert.equal(spotProfile(bars.slice(0, PROFILE_MIN_BARS + PROFILE_LAG - 1), 50), null)
  assert.ok(spotProfile(bars.slice(0, PROFILE_MIN_BARS + PROFILE_LAG), 50))
  assert.equal(spotProfile(bars, 0), null)
  // One balance all morning: one node, no thin area.
  assert.deepEqual(profileOf(lvnRefusedLong({ flat: 22600 })).lvns, [])
  // Each scale maps row for row (BANKNIFTY / SENSEX: step 100, the day at twice the NIFTY points).
  for (const scale of [BANKNIFTY, SENSEX]) {
    const q = profileOf(lvnRefusedLong({ scale }))
    assert.equal(q.poc, scale.base + 2 * (22610 - 22500))
    assert.deepEqual([q.lvns[0].low, q.lvns[0].high].map((x) => (x - scale.base) / 2 + 22500), [22432.5, 22582.5])
  }
  assert.ok(morning, 'the mornings are shared with spot-strategies-3')
})

test('#111 LVN refused: came from 2 ATR away, reached into the thin area, no close past its middle, turned back out -> to the node it came from', () => {
  const s = find(lvnRefusedLong(), 'spotLvnReject', 'LONG')
  assert.ok(s, 'fires LONG')
  assert.equal(s.entry, 22584)
  assert.equal(s.target, 22610, 'back to the node it came from - the POC')
  assert.ok(s.stop < 22577, 'the stop under the touch')
  assert.match(s.checks.Profile, /LVN \d+ of today's spot profile \(thin 22432.5 - 22582.5/)
  const away = lvnRefusedLong({ from: 22598 })
  assert.deepEqual([profileOf(away).lvns[0].low, profileOf(away).lvns[0].high], [22432.5, 22582.5], 'the same thin area ...')
  assert.ok(!fires(away, 'spotLvnReject', 'LONG'), '... but it did not come from 2 ATR away')
  assert.ok(!fires(lvnRefusedLong({ accepted: true }), 'spotLvnReject', 'LONG'), 'a close past the middle: accepted, not refused')
  assert.ok(!fires(lvnRefusedLong({ noTurn: true }), 'spotLvnReject', 'LONG'), 'the last candle does not turn')
  assert.ok(!fires(lvnRefusedLong({ ce: moving(0.001), pe: moving(-0.001) }), 'spotLvnReject', 'LONG'), 'calls written, puts covered: the option chain is against it')
  assert.ok(!fires(lvnRefusedLong({ flat: 22600 }), 'spotLvnReject', 'LONG'), 'no thin area in the day\'s profile')
  assert.ok(!at(lvnRefusedLong(), 59).some((x) => x.id === 'spotLvnReject'), 'too early for a profile: nothing')
  const l = find(lvnRefusedShort(), 'spotLvnReject', 'SHORT')
  assert.ok(l, 'fires SHORT')
  assert.equal(l.target, 22390, 'back down to the node it came from')
  assert.ok(!fires(lvnRefusedShort({ accepted: true }), 'spotLvnReject', 'SHORT'))
  assert.ok(!fires(lvnRefusedShort({ pe: moving(0.001), ce: moving(-0.001) }), 'spotLvnReject', 'SHORT'))
})

test('#112 LVN filled fast: from under the thin area a big candle closes well inside it -> across to the next node (the POC)', () => {
  const s = find(lvnFillLong(), 'spotLvnFill', 'LONG')
  assert.ok(s, 'fires LONG')
  assert.equal(s.entry, 22462)
  assert.ok(s.stop < 22432.5, 'the stop back under the area')
  assert.ok(Math.abs((s.target - s.entry) / (s.entry - s.stop) - 3) < 1e-9, 'the POC 22610 farther than 3x the stop: 3x the stop')
  assert.match(s.checks.Profile, /toward 22610 .* - the POC: it can be refused there/)
  assert.ok(!fires(lvnFillLong({ slow: true }), 'spotLvnFill', 'LONG'), 'it crept in: not fast')
  assert.ok(!fires(lvnFillLong({ close: true }), 'spotLvnFill', 'LONG'), 'only just inside the area')
  assert.ok(!fires(lvnFillLong({ before: 22455 }), 'spotLvnFill', 'LONG'), 'it was already inside the area')
  assert.ok(!fires(lvnFillLong({ ce: (k, m) => (k === 22550 ? 6e6 * (1 + 0.001 * ramp(m)) : 2e6) }), 'spotLvnFill', 'LONG'), 'a growing call wall before the node')
  assert.ok(!fires(lvnFillLong({ ce: moving(0.001), pe: moving(-0.001) }), 'spotLvnFill', 'LONG'), 'the two sides against it')
  assert.ok(!fires(lvnFillLong({ flat: 22400 }), 'spotLvnFill', 'LONG'), 'no thin area in the day\'s profile')
  const l = find(lvnFillShort(), 'spotLvnFill', 'SHORT')
  assert.ok(l, 'fires SHORT')
  assert.ok(l.stop > 22567.5 && Math.abs((l.entry - l.target) / (l.stop - l.entry) - 3) < 1e-9, 'across toward the node 22390: 3x the stop')
  assert.ok(!fires(lvnFillShort({ slow: true }), 'spotLvnFill', 'SHORT'))
  assert.ok(!fires(lvnFillShort({ pe: (k, m) => (k === 22450 ? 6e6 * (1 + 0.001 * ramp(m)) : 2e6) }), 'spotLvnFill', 'SHORT'), 'a growing put wall before the node')
})

test('#113 POC rejection: a fast run into the day\'s POC, no close past it, a turn - the writers there holding', () => {
  const s = find(pocRejectShort(), 'spotPocReject', 'SHORT')
  assert.ok(s, 'fires SHORT')
  assert.equal(s.entry, 22597)
  assert.ok(s.stop > 22611, 'the stop over the touch')
  assert.ok(Math.abs((s.entry - s.target) / (s.stop - s.entry) - 3) < 1e-9, 'the node far below: 3x the stop')
  assert.match(s.checks.Profile, /today's spot POC 22610/)
  assert.ok(!fires(pocRejectShort({ from: 22600 }), 'spotPocReject', 'SHORT'), 'no fast run: it was near the POC all along')
  assert.ok(!fires(pocRejectShort({ accepted: true }), 'spotPocReject', 'SHORT'), 'a close above the POC: accepted')
  assert.ok(!fires(pocRejectShort({ noTurn: true }), 'spotPocReject', 'SHORT'), 'the last candle does not turn')
  assert.ok(!fires(pocRejectShort({ ce: moving(-0.002, 22650) }), 'spotPocReject', 'SHORT'), 'the call writers at the strike over the POC leaving')
  assert.ok(!fires(pocRejectShort({ pe: moving(0.001) }), 'spotPocReject', 'SHORT'), 'puts being written: the chain against a short')
  const l = find(pocRejectLong(), 'spotPocReject', 'LONG')
  assert.ok(l, 'fires LONG')
  assert.ok(Math.abs((l.target - l.entry) / (l.entry - l.stop) - 3) < 1e-9, 'the node far above: 3x the stop')
  assert.ok(!fires(pocRejectLong({ pe: moving(-0.002, 22600) }), 'spotPocReject', 'LONG'), 'the put writers under the POC leaving')
  assert.ok(!fires(pocRejectLong({ accepted: true }), 'spotPocReject', 'LONG'))
})

test('every one fires LONG and SHORT at NIFTY, BANKNIFTY and SENSEX scale, its target in the same place in strike terms', () => {
  const cases = [['spotLvnReject', 'LONG', lvnRefusedLong], ['spotLvnReject', 'SHORT', lvnRefusedShort], ['spotLvnFill', 'LONG', lvnFillLong],
    ['spotLvnFill', 'SHORT', lvnFillShort], ['spotPocReject', 'SHORT', pocRejectShort], ['spotPocReject', 'LONG', pocRejectLong]]
  for (const [id, side, make] of cases) {
    const rel = (scale) => {
      const s = find(make({ scale }), id, side)
      assert.ok(s, `${id} ${side} at ${scale.base}`)
      return { target: (s.target - s.entry) / scale.step }
    }
    const n = rel(NIFTY)
    for (const scale of [BANKNIFTY, SENSEX]) assert.ok(Math.abs(rel(scale).target - n.target) <= 3, `${id} ${side} target at ${scale.base}`)
  }
})

test('no look-ahead: the same setups with the day cut at the clock; the server scanner\'s tick and the tuning\'s day scan agree', () => {
  for (const make of [lvnRefusedLong, lvnFillLong, pocRejectShort]) {
    const w = make()
    const cutMs = T + 90 * MIN
    const run = { success: true, date: '2026-10-09', step: 50, futuresBars: [], spotCandlesOneMinute: w.bars.filter((b) => b.t < cutMs).map((b) => ({ ...b, time: b.time })),
      cePoints: [...w.oi.ce].flatMap(([k, list]) => list.filter((p) => p.t - MIN < cutMs).map((p) => ({ time: new Date(p.t - MIN).toISOString(), strike: k, openInterest: p.oi, price: p.price }))),
      pePoints: [...w.oi.pe].flatMap(([k, list]) => list.filter((p) => p.t - MIN < cutMs).map((p) => ({ time: new Date(p.t - MIN).toISOString(), strike: k, openInterest: p.oi, price: p.price }))) }
    const cut = buildOiContext(run, null, { live: false })
    const full = at(w).map((s) => `${s.id}:${s.side}:${s.entry}:${s.target}`).sort()
    assert.ok(full.length > 0)
    const again = evaluateSpotStrategies({ nowMs: cutMs, bars: done(w), oi: cut }).map((s) => `${s.id}:${s.side}:${s.entry}:${s.target}`).sort()
    assert.deepEqual(again, full)
    const tick = spotScanTick({ minute: cutMs, bars: done(w), oi: w.oi, filters: {}, trail: null }, { fired: [] })
    const day = scanSpotDay({ bars: w.bars, oi: w.oi }).filter((s) => s.t === cutMs)
    assert.deepEqual(tick.fresh.map((s) => `${s.id}:${s.side}`).sort(), [...new Set(day.map((s) => `${s.id}:${s.side}`))].sort())
  }
})
