// #114, the spot OI confluence (spotEngine.js): the option chain's OI reads - the ones the Strategy lab tunes as filters -
// all on the trade's side, as its own rules, and a dip bought (a pop sold) with them. For a long: puts written over calls
// since the open (the whole chain's net CE - PE, 0.2+ lean), the last 15 minutes not against it, CE / PE - one with it on
// the 15 minutes, neither against it since the open - the call wall in the way not growing and at least the target away,
// the day not trending down; a 1 ATR+ pullback off the last 20 minutes' high and a candle resuming up. It fires on its
// rules - LONG and SHORT, at NIFTY, BANKNIFTY and SENSEX scale - and not when each key condition is missing; nothing after
// the clock is read. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPOT_STRATEGIES, STRATEGY_BY_ID, dayTypeAt } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, scanSpotDay } from '../src/spotEngine.js'
import { MIN, T, BANKNIFTY, SENSEX } from './spot-profile-world.mjs'
import { confluenceLong, confluenceShort, confluenceLateLong, confluenceLateShort, LATE } from './spot-oi-world.mjs'

const done = (w, minute) => w.bars.filter((b) => b.t + MIN <= T + minute * MIN)
const at = (w, minute = 90) => evaluateSpotStrategies({ nowMs: T + minute * MIN, bars: done(w, minute), oi: w.oi })
const find = (w, side, minute = 90) => at(w, minute).find((s) => s.id === 'spotOiConfluence' && s.side === side)
const fires = (w, side, minute = 90) => !!find(w, side, minute)

test('#114 is the fourteenth spot strategy: the OI confluence', () => {
  assert.equal(SPOT_STRATEGIES.length, 14)
  const s = STRATEGY_BY_ID.spotOiConfluence
  assert.ok(s?.spot && s.no === 114 && !s.retired)
  assert.equal(SPOT_STRATEGIES.at(-1).id, 'spotOiConfluence')
})

test('#114 LONG: puts written since the open, CE / PE with it, room to the call wall - a dip bought as the candle resumes up', () => {
  const s = find(confluenceLong(), 'LONG')
  assert.ok(s, 'it fires')
  assert.equal(s.entry, 22512, 'the last finished minute\'s close')
  // Stop past the pullback's low (22491) plus 0.3 ATR, at least 1.2 ATR; target 2x the stop.
  assert.ok(s.stop < 22491 && s.stop > 22480, `stop ${s.stop}`)
  assert.ok(Math.abs((s.target - s.entry) - 2 * (s.entry - s.stop)) < 1e-9)
  assert.equal(s.timeStopMs, T + 150 * MIN, 'a 60-minute time stop')
  assert.match(s.checks.OI, /since the open puts written over calls/)
  assert.match(s.checks.OI, /the call wall 22650/)
  assert.match(s.checks.Price, /dipped .* resumed/)
  assert.ok(s.options?.buy && s.options?.sell, 'it carries its options')
  // The context the OI filters read is on it - the lab's filters would read the same numbers.
  assert.ok(s.oiCtx.cum >= 0.2 && s.oiCtx.peD > 0 && s.oiCtx.resistanceAhead === 22650)
})

test('#114 SHORT: calls written since the open, the put wall far enough below - a pop sold as the candle turns down', () => {
  const s = find(confluenceShort(), 'SHORT')
  assert.ok(s, 'it fires')
  assert.equal(s.entry, 22488)
  assert.ok(s.stop > 22509 && s.target < s.entry)
  assert.match(s.checks.OI, /since the open calls written over puts/)
  assert.ok(!fires(confluenceShort(), 'LONG'), 'never the other way on the same minute')
})

test('#114 does not fire when a key condition is missing - LONG and SHORT', () => {
  for (const [make, side] of [[confluenceLong, 'LONG'], [confluenceShort, 'SHORT']]) {
    assert.ok(!fires(make({ noDip: true }), side), `${side}: no pullback - a steady climb`)
    assert.ok(!fires(make({ noResume: true }), side), `${side}: the last candle does not resume`)
    assert.ok(!fires(make({ cumAgainst: true }), side), `${side}: since the open the chain leans the other way`)
    assert.ok(!fires(make({ sidesFlat: true }), side), `${side}: CE and PE both flat on the last 15 minutes`)
    assert.ok(!fires(make({ cumSideAgainst: true }), side), `${side}: since the open the CE / PE pair is against it`)
    assert.ok(!fires(make({ wallGrowing: true }), side), `${side}: the wall in the way is being written`)
    assert.ok(!fires(make({ wallClose: true }), side), `${side}: the wall in the way is inside the target`)
  }
})

test('#114 never trades against the day\'s trend: the same dip and resume fires on a day going its way, not against it', () => {
  for (const [make, side, want, not] of [[confluenceLateLong, 'LONG', 'trend-up', 'trend-down'], [confluenceLateShort, 'SHORT', 'trend-down', 'trend-up']]) {
    const withIt = make()
    const against = make({ against: true })
    assert.equal(dayTypeAt(withIt.oi, done(withIt, LATE), T + LATE * MIN).type, want)
    assert.equal(dayTypeAt(against.oi, done(against, LATE), T + LATE * MIN).type, not)
    assert.ok(fires(withIt, side, LATE), `${side} on a ${want} day`)
    assert.ok(!fires(against, side, LATE), `${side} not on a ${not} day`)
  }
})

test('#114 at BANKNIFTY and SENSEX scale: the same setups, the same misses', () => {
  for (const scale of [BANKNIFTY, SENSEX]) {
    assert.ok(fires(confluenceLong({ scale }), 'LONG') && fires(confluenceShort({ scale }), 'SHORT'), `${scale.base}`)
    assert.ok(!fires(confluenceLong({ scale, wallClose: true }), 'LONG') && !fires(confluenceShort({ scale, cumAgainst: true }), 'SHORT'), `${scale.base}`)
  }
})

test('#114 reads nothing after the clock, and the tuning\'s day scan finds it at the same minute', () => {
  const w = confluenceLong()
  const s = find(w, 'LONG')
  // The same day going on past 10:45 - a crash, calls piling in, puts shed: the setup at 10:45 is the same.
  const on = confluenceLong({ after: true })
  assert.ok(on.bars.length > w.bars.length)
  assert.deepEqual(find(on, 'LONG'), s)
  const day = scanSpotDay({ bars: w.bars, oi: w.oi })
  assert.ok(day.some((x) => x.id === 'spotOiConfluence' && x.side === 'LONG' && x.t === T + 90 * MIN && x.entry === s.entry), 'scanSpotDay - the tuning\'s scan')
})
