// The spot + options strategies on the previous day's SPOT volume profile (spotEngine.js #111 - #113): an LVN refused
// (back to the volume it came from), an LVN filled fast (run to the next volume node - the POC), and the POC refusing a
// fast run into it. Each fires on its rules - LONG and SHORT, at NIFTY, BANKNIFTY and SENSEX scale - and not when each
// key condition is missing; the profile is the previous day's (known before the session) and nothing after the clock is
// read. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPOT_STRATEGIES, STRATEGY_BY_ID, buildOiContext } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, lvnZones, scanSpotDay, spotVpOf } from '../src/spotEngine.js'
import { spotScanTick } from '../src/scannerCore.js'
import {
  MIN, T, NIFTY, BANKNIFTY, SENSEX, ramp, vpAt, lvnRefusedLong, lvnRefusedShort, lvnFillLong, lvnFillShort, pocRejectShort, pocRejectLong,
} from './spot-vp-world.mjs'

const at = (w, minute = 90, vp = w.vp) => {
  const nowMs = T + minute * MIN
  return evaluateSpotStrategies({ nowMs, bars: w.bars.filter((b) => b.t + MIN <= nowMs), oi: w.oi, vp })
}
const find = (w, id, side) => at(w).find((s) => s.id === id && s.side === side)
const fires = (w, id, side) => !!find(w, id, side)
// OI 15 minutes before the clock -> now: a side rising / falling by `rate` a minute over those minutes.
const moving = (rate, only = null) => (k, m) => 2e6 * (only == null || only === k ? 1 + rate * ramp(m) : 1)

test('three volume-profile spot strategies, #111 - #113, in the profile group', () => {
  assert.deepEqual(SPOT_STRATEGIES.slice(-3).map((s) => [s.no, s.id, s.group]), [[111, 'spotLvnReject', 'profile'], [112, 'spotLvnFill', 'profile'], [113, 'spotPocReject', 'profile']])
  assert.ok(['spotLvnReject', 'spotLvnFill', 'spotPocReject'].every((id) => STRATEGY_BY_ID[id]?.spot))
})

test('the LVN zone: the LVN widened over its thin neighbouring bins', () => {
  const [z] = lvnZones(vpAt())
  assert.deepEqual([z.low, z.high, z.mid, z.lvn], [22475, 22505, 22490, 22490])
  assert.deepEqual(lvnZones({ lvn: [22490] }, 10).map((x) => [x.low, x.high]), [[22480, 22500]], 'no bins: a half width either side')
  assert.deepEqual(lvnZones({ lvn: [] }, 10), [])
  assert.equal(spotVpOf({ success: false }), null)
  assert.deepEqual(Object.keys(spotVpOf({ success: true, poc: 1, vah: 2, val: 0.5, hvn: [], lvn: [], bins: [], bars: [1, 2] })).sort(), ['bins', 'date', 'hvn', 'lvn', 'poc', 'vah', 'val'], 'its bars are not kept')
})

test('#111 LVN refused: came from 2 ATR away, reached into the thin area, no close past its middle, turned back out -> to the node it came from', () => {
  const s = find(lvnRefusedLong(), 'spotLvnReject', 'LONG')
  assert.ok(s, 'fires LONG')
  assert.equal(s.entry, 22516)
  assert.equal(s.target, 22560, 'back to the POC it came from')
  assert.ok(s.stop < 22503, 'the stop under the touch')
  assert.match(s.checks.Profile, /LVN 22490/)
  assert.ok(!fires(lvnRefusedLong({ from: 22516 }), 'spotLvnReject', 'LONG'), 'it did not come from away')
  assert.ok(!fires(lvnRefusedLong({ accepted: true }), 'spotLvnReject', 'LONG'), 'a close past the middle: accepted, not refused')
  assert.ok(!fires(lvnRefusedLong({ noTurn: true }), 'spotLvnReject', 'LONG'), 'the last candle does not turn')
  assert.ok(!fires(lvnRefusedLong({ ce: moving(0.001), pe: moving(-0.001) }), 'spotLvnReject', 'LONG'), 'calls written, puts covered: the option chain is against it')
  assert.ok(!fires(lvnRefusedLong({ vp: vpAt(NIFTY, { vah: 22524, poc: 22526 }) }), 'spotLvnReject', 'LONG'), 'the node above too close: no room')
  assert.ok(!at(lvnRefusedLong(), 90, null).some((x) => x.id === 'spotLvnReject'), 'no profile: nothing')
  const l = find(lvnRefusedShort(), 'spotLvnReject', 'SHORT')
  assert.ok(l, 'fires SHORT')
  assert.equal(l.target, 22420, 'back down to the HVN it came from')
  assert.ok(!fires(lvnRefusedShort({ accepted: true }), 'spotLvnReject', 'SHORT'))
  assert.ok(!fires(lvnRefusedShort({ pe: moving(0.001), ce: moving(-0.001) }), 'spotLvnReject', 'SHORT'))
})

test('#112 LVN filled fast: from under the thin area a big candle closes past its middle -> the next volume node (the POC)', () => {
  const s = find(lvnFillLong(), 'spotLvnFill', 'LONG')
  assert.ok(s, 'fires LONG')
  assert.equal(s.entry, 22496)
  assert.equal(s.target, 22560, 'the POC - banked there, it can be refused')
  assert.ok(s.stop < 22475, 'the stop back under the area')
  assert.match(s.checks.Profile, /the POC: it can be refused there/)
  assert.ok(!fires(lvnFillLong({ slow: true }), 'spotLvnFill', 'LONG'), 'a small candle: not fast')
  assert.ok(!fires(lvnFillLong({ close: 22486 }), 'spotLvnFill', 'LONG'), 'not past the middle')
  assert.ok(!fires(lvnFillLong({ before: 22481 }), 'spotLvnFill', 'LONG'), 'it was already inside the area')
  assert.ok(!fires(lvnFillLong({ ce: (k, m) => (k === 22550 ? 6e6 * (1 + 0.001 * ramp(m)) : 2e6) }), 'spotLvnFill', 'LONG'), 'a growing call wall before the POC')
  assert.ok(!fires(lvnFillLong({ ce: moving(0.001), pe: moving(-0.001) }), 'spotLvnFill', 'LONG'), 'the two sides against it')
  const l = find(lvnFillShort(), 'spotLvnFill', 'SHORT')
  assert.ok(l, 'fires SHORT')
  assert.equal(l.target, 22420, 'the HVN beyond the area')
  assert.ok(!fires(lvnFillShort({ slow: true }), 'spotLvnFill', 'SHORT'))
  assert.ok(!fires(lvnFillShort({ pe: (k, m) => (k === 22450 ? 6e6 * (1 + 0.001 * ramp(m)) : 2e6) }), 'spotLvnFill', 'SHORT'), 'a growing put wall before the HVN')
})

test('#113 POC rejection: a fast run into the previous POC, no close past it, a turn - the writers there holding', () => {
  const s = find(pocRejectShort(), 'spotPocReject', 'SHORT')
  assert.ok(s, 'fires SHORT')
  assert.equal(s.entry, 22548)
  assert.ok(s.stop > 22562, 'the stop over the touch')
  assert.ok(Math.abs((s.entry - s.target) / (s.stop - s.entry) - 3) < 1e-9, 'the HVN far below: 3x the stop')
  assert.ok(!fires(pocRejectShort({ from: 22545 }), 'spotPocReject', 'SHORT'), 'no fast run: it was near the POC all along')
  assert.ok(!fires(pocRejectShort({ accepted: true }), 'spotPocReject', 'SHORT'), 'a close above the POC: accepted')
  assert.ok(!fires(pocRejectShort({ noTurn: true }), 'spotPocReject', 'SHORT'), 'the last candle does not turn')
  assert.ok(!fires(pocRejectShort({ ce: moving(-0.002, 22600) }), 'spotPocReject', 'SHORT'), 'the call writers at the POC strike leaving')
  assert.ok(!fires(pocRejectShort({ pe: moving(0.001) }), 'spotPocReject', 'SHORT'), 'puts being written: the chain against a short')
  const l = find(pocRejectLong(), 'spotPocReject', 'LONG')
  assert.ok(l, 'fires LONG')
  assert.equal(l.target, 22620, 'back up to the value-area high')
  assert.ok(!fires(pocRejectLong({ pe: moving(-0.002, 22550) }), 'spotPocReject', 'LONG'), 'the put writers under the POC leaving')
  assert.ok(!fires(pocRejectLong({ accepted: true }), 'spotPocReject', 'LONG'))
})

test('every one fires LONG and SHORT at NIFTY, BANKNIFTY and SENSEX scale, with the same stop / target in strike terms', () => {
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
    const again = evaluateSpotStrategies({ nowMs: cutMs, bars: w.bars.filter((b) => b.t + MIN <= cutMs), oi: cut, vp: w.vp }).map((s) => `${s.id}:${s.side}:${s.entry}:${s.target}`).sort()
    assert.deepEqual(again, full)
    const tick = spotScanTick({ minute: cutMs, bars: w.bars.filter((b) => b.t + MIN <= cutMs), oi: w.oi, filters: {}, trail: null, vp: w.vp }, { fired: [] })
    const day = scanSpotDay({ bars: w.bars, oi: w.oi, vp: w.vp }).filter((s) => s.t === cutMs)
    assert.deepEqual(tick.fresh.map((s) => `${s.id}:${s.side}`).sort(), [...new Set(day.map((s) => `${s.id}:${s.side}`))].sort())
  }
})
