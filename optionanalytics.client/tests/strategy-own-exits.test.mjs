// Every strategy trades by its OWN exits: its trailing stop (its own, or the one its tuned setting was applied with) is
// not changed by a later change of the scanner's trailing stop; an option exit of its own (tradeOptExit, carried from the
// tuning) is taken EXACTLY - none of the index's option SL / target points or its option trailing stop on top, and a
// change of the index's levels leaves its open trades alone - so a tuned strategy trades as the tuning measured it.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { optionPlanFor, optionTradeAt, ownOptionExit, pinnedTrailOf, simulateOutcome, squareOffMs } from '../src/strategyEngine.js'
import { followSetups, liveLegsFor, newPosition, positionRows, withLevelChange, withOwnTrail, MIN } from '../src/scannerCore.js'
import { scanDaySetups } from '../src/scanDay.js'
import { DEFAULT_VARIANT, OPTION_DEFAULT, filtersFromTuning, optionOutcome, paramsFromFilters, tuningDay } from '../src/strategyTuning.js'
import { day } from './synthetic-day.mjs'

const T0 = Date.parse('2026-10-05T10:00:00+05:30')
const bar = (m, o, h, l, c) => ({ time: T0 + m * MIN, open: o, high: h, low: l, close: c })
// A long from 100 (stop 90, target 200): up to 113, then back down through 90.
const bars = [bar(0, 100, 102, 99, 101), bar(1, 101, 108, 100, 107), bar(2, 107, 112, 106, 111), bar(3, 111, 113, 108, 109),
  bar(4, 109, 110, 103, 104), bar(5, 104, 105, 95, 96), bar(6, 96, 97, 85, 86)]
const long = { id: 'wallBreak', side: 'LONG', t: T0, entry: 100, stop: 90, target: 200 }
const scannerTrail = { startR: 1, gapR: 1 }

test('a change of the scanner\'s trailing stop moves only the trades on the scanner\'s trail - never one trailing its strategy\'s own', () => {
  const onScanner = { ...long, trail: scannerTrail }
  const ownNone = { ...long, id: 'buildUp', trailOverride: null, trail: null } // its strategy: no trailing stop
  const ownR = { ...long, id: 'trap', trailOverride: { startR: 1, gapR: 1 }, trail: { startR: 1, gapR: 1 } }
  // The scanner's trail is tightened to 0.5R / 0.5R from 10:02.
  const log = [{ t: T0 + 2 * MIN, trail: { startR: 0.5, gapR: 0.5 } }]
  const [a, b, c] = followSetups([onScanner, ownNone, ownR], log, bars, T0 + 60 * MIN)
  assert.ok(Math.abs(a.outcome.r - 0.8) < 1e-9, `the scanner's trade follows the change: out at 108, ${a.outcome.r}`)
  assert.equal(b.outcome.r, -1, 'its own "no trailing stop": out at its stop')
  assert.ok(Math.abs(c.outcome.r - 0.3) < 1e-9, `its own 1R / 1R: out at 103 (10 behind the best 113), ${c.outcome.r}`)
  // Exactly as each would have gone with no change at all.
  assert.deepEqual(b.outcome, simulateOutcome(ownNone, bars, T0 + 60 * MIN))
  assert.deepEqual(c.outcome, simulateOutcome(ownR, bars, T0 + 60 * MIN))
})

test('a tuned setting keeps the trailing stop it was applied with; a trailing stop of its own wins over it', () => {
  const pts = { startR: 1, gapR: 1, unit: 'pts', startPts: 30, gapPts: 30 }
  const pinned = withOwnTrail(long, { tradeSide: 'both', _trail: pts }, scannerTrail)
  assert.deepEqual(pinned.trail, pts)
  assert.deepEqual(pinned.trailOverride, pts, 'its own from now on - a scanner change does not move it')
  const none = withOwnTrail(long, { _trail: null }, scannerTrail)
  assert.equal(none.trail, null, 'the scanner had none when it was applied: none')
  assert.equal(none.trailOverride, null)
  const own = withOwnTrail({ ...long, trailOverride: { startR: 2, gapR: 1 } }, { _trail: pts }, scannerTrail)
  assert.deepEqual(own.trail, { startR: 2, gapR: 1 }, 'its tuned trailing stop is the one')
  const plain = withOwnTrail(long, { tradeSide: 'both' }, scannerTrail)
  assert.deepEqual(plain.trail, scannerTrail, 'nothing stored: the scanner\'s, as before')
  assert.equal(plain.trailOverride, undefined)
  assert.equal(pinnedTrailOf({ _trail: { gapR: 0 } }), undefined, 'a broken one is not used')
})

const cfg = { autoPaper: 'strategy', paperSl: 20, paperTarget: 30, paperTrailStart: 5, paperTrailGap: 3 }
const plan = (f, premium = 100) => optionPlanFor('wallBreak', { wallBreak: f }, cfg, premium)

test('an option exit of its own is taken exactly - no index option points, no index option trailing stop', () => {
  assert.deepEqual(
    (({ exit, own, slPts, targetPts, trailStart, trailGap }) => ({ exit, own, slPts, targetPts, trailStart, trailGap }))(plan({ tradeOptLeg: 'buy', tradeOptExit: 'index' })),
    { exit: 'index', own: true, slPts: null, targetPts: null, trailStart: 0, trailGap: 0 })
  const capped = plan({ tradeOptLeg: 'sell', tradeOptExit: 'indexSl', tradeOptSlPct: 25 })
  assert.deepEqual([capped.slPts, capped.targetPts, capped.trailGap], [25, null, 0], 'its Max SL only - no index target')
  const first = plan({ tradeOptLeg: 'sell', tradeOptExit: 'first' })
  assert.deepEqual([first.slPts, first.targetPts], [20, 30], 'no % set: the tuning\'s own 20% / 30%')
  const option = plan({ tradeOptLeg: 'buy', tradeOptExit: 'option', tradeOptSlPct: 10, tradeOptTargetPct: 40 }, 50)
  assert.deepEqual([option.exit, option.slPts, option.targetPts], ['option', 5, 20])
  // None of its own: the index's levels and its option trailing stop, as before (a % of its own still applies).
  const plain = plan({ tradeOptLeg: 'buy', tradeOptSlPct: 30 })
  assert.deepEqual([plain.own, plain.slPts, plain.targetPts, plain.trailStart, plain.trailGap], [false, 30, 30, 5, 3])
  // Before its exit was stored: a TUNED option setting is read the way the lab reads it back; one set by hand is not.
  assert.equal(ownOptionExit({ tradeOptLeg: 'sell', tradeOptSlPct: 30, tradeOptTargetPct: 0 }, { _tuned: 'sig' }), 'indexSl')
  assert.equal(ownOptionExit({ tradeOptLeg: 'sell', tradeOptSlPct: 0, tradeOptTargetPct: 0 }, { _appliedAt: 1 }), 'index')
  assert.equal(ownOptionExit({ tradeOptLeg: 'buy', tradeOptSlPct: 0, tradeOptTargetPct: 0 }, {}), null, 'BUY chosen by hand keeps the index\'s levels')
  // The lab reads the stored exit back as it is.
  assert.equal(paramsFromFilters({ tradeOptLeg: 'buy', tradeOptExit: 'option', tradeOptSlPct: 10, tradeOptTargetPct: 40 }).optExit, 'option')
})

test('its live order: its own legs; where its exit has none, a safety leg at the signal\'s own index distance', () => {
  const s = { entry: 25000, stop: 24970, target: 25060 }
  assert.deepEqual(liveLegsFor(plan({ tradeOptLeg: 'sell', tradeOptExit: 'index' }), s), { slPts: 30, targetPts: 60 })
  assert.deepEqual(liveLegsFor(plan({ tradeOptLeg: 'sell', tradeOptExit: 'indexSl', tradeOptSlPct: 25 }), s), { slPts: 25, targetPts: 60 })
  assert.deepEqual(liveLegsFor(plan({ tradeOptLeg: 'sell', tradeOptExit: 'first', tradeOptSlPct: 10, tradeOptTargetPct: 15 }), s), { slPts: 10, targetPts: 15 })
  assert.deepEqual(liveLegsFor(plan({}), s), { slPts: 20, targetPts: 30 }, 'none of its own: the index\'s')
})

test('a change of the index\'s option levels reaches only the trades with no exit of their own', () => {
  const trade = { action: 'SELL', side: 'PE', strike: 25000 }
  const own = newPosition({ setup: long, trade, which: 'sell', lots: 1, lotSize: 65, premium: 100, cfg, at: T0, plan: plan({ tradeOptLeg: 'sell', tradeOptExit: 'indexSl', tradeOptSlPct: 25 }) })
  const plain = newPosition({ setup: { ...long, id: 'buildUp' }, trade, which: 'sell', lots: 1, lotSize: 65, premium: 100, cfg, at: T0, plan: plan({}) })
  assert.deepEqual([own.optExit, own.slPts, own.targetPts, own.trailGap], ['indexSl', 25, null, 0])
  assert.deepEqual([plain.optExit, plain.slPts, plain.targetPts, plain.trailGap], [undefined, 20, 30, 3])
  const after = withLevelChange([own, plain], new Set([own.key, plain.key]), { paperSl: 40, paperTarget: 60 }, T0 + 5 * MIN, cfg)
  assert.deepEqual(after[0], own, 'its own exit: untouched')
  assert.deepEqual([after[1].slPts, after[1].targetPts, after[1].levelLog.length], [40, 60, 2])
})

// ---- tuning == scanner: the paper trade of a strategy applied with its option exit is the tuning's own trade ----
const syn = day()
const heatmap = syn.path.map((p, m) => ({ t: syn.at(m) + 30_000, bids: [[p - 1, 500]], asks: [[p + 1, 500]] }))
const replayDay = { meta: { lotSize: 75, lastPrice: syn.path.at(-1) }, minuteBars: syn.minuteBars, trades: [], icebergs: [], heatmap, sweeps: [], source: 'live' }
const all = await scanDaySetups({ day: replayDay, prints: syn.prints, oi: syn.oi, profile: null, rowSize: 1, lotSize: 75, largeLots: 10, estimated: false, filters: {}, keepAll: true })
const d = tuningDay('2026-10-05', all, replayDay, syn.oi)

test('tuning == scanner: each option exit as applied is the same trade the tuning measured (same exit, premium, points)', () => {
  const id = all[0].id
  // The index's levels are set (and tight) - none of them may reach a strategy with an exit of its own.
  const index = { autoPaper: 'strategy', paperSl: 2, paperTarget: 3, paperTrailStart: 0, paperTrailGap: 1, paperLots: 1, filters: {} }
  let compared = 0
  const reasons = new Set()
  for (const [leg, exit, sl, tg] of [['sell', 'index'], ['buy', 'index'], ['sell', 'indexSl', 15], ['buy', 'indexSl', 3], ['sell', 'first', 15, 20], ['buy', 'first', 5, 10], ['sell', 'option', 20, 30], ['buy', 'option', 10, 15]]) {
    const v = { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, optLeg: leg, optExit: exit, ...(sl ? { optSlPct: sl } : {}), ...(tg ? { optTargetPct: tg } : {}) }
    const filters = { [id]: { ...filtersFromTuning({}, v, { option: true }), _tuned: 'sig' } }
    for (const s of all.filter((x) => x.id === id).slice(0, 12)) {
      const outcome = { status: 'win', exitAt: s.t + 20 * MIN, r: 1 }
      const tuned = optionOutcome(d, s, outcome, v)
      if (!tuned) continue
      const first = optionPlanFor(id, filters, index)
      const trade = optionTradeAt(syn.oi, s, first.leg, first.moneyness, s.t)
      const p = optionPlanFor(id, filters, index, trade.premium)
      assert.equal(p.exit, exit)
      const position = newPosition({ setup: s, trade, which: first.leg, lots: 1, lotSize: 75, premium: trade.premium, cfg: { ...index, paperSl: p.slPts, paperTarget: p.targetPts }, at: s.t, plan: p })
      const [row] = positionRows({ positions: [position], dayResults: [{ ...s, outcome }], withOutcome: [], oi: syn.oi, nowMs: null, settings: index })
      assert.ok(row.exitTime, `${leg} ${exit}: closed`)
      assert.ok(Math.abs(row.current - tuned.exitPremium) < 1e-9, `${leg} ${exit} @${s.t}: exit premium ${row.current} vs the tuning's ${tuned.exitPremium} (${tuned.reason} / ${row.exitReason})`)
      assert.ok(Math.abs(row.points - tuned.points) < 1e-9)
      if (tuned.exitMs < Math.min(d.endMs, squareOffMs(s.t))) assert.equal(row.exitTime, tuned.exitMs)
      reasons.add(`${exit}:${/SL|Target/.test(tuned.reason) ? 'own level' : 'other'}`)
      compared++
    }
  }
  assert.ok(compared >= 20, `${compared}`)
  assert.ok(reasons.has('first:own level') || reasons.has('option:own level') || reasons.has('indexSl:own level'), [...reasons].join(', '))
})
