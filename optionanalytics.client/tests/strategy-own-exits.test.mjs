// Every strategy trades by its OWN exits: its trailing stop (its own, or the one its tuned setting was applied with) is
// not changed by a later change of the scanner's trailing stop; its option leaves the trade by its own exit (tradeOptExit,
// carried from the tuning) with its own SL / target - never the Trade settings' SL / target / trail (a manual trade's) -
// held only to the index's max rules (Max SL / Max target), which the tuning measures with too: the paper trade is the
// tuning's own trade. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { capPoints, optionPlanFor, optionTradeAt, ownOptionExit, pinnedTrailOf, simulateOutcome, squareOffMs } from '../src/strategyEngine.js'
import { followSetups, liveLegsFor, newPosition, positionRows, withCapChange, withLevelChange, withOwnTrail, MIN } from '../src/scannerCore.js'
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

// The index: a manual trade's SL 20 / target 30 / trail (never a strategy's), and max rules for the strategies.
const cfg = { autoPaper: 'strategy', paperSl: 20, paperTarget: 30, paperTrailStart: 5, paperTrailGap: 3, paperMaxSl: 40, paperMaxTarget: 60 }
const plan = (f, premium = 100, c = cfg) => optionPlanFor('wallBreak', { wallBreak: f }, c, premium)
const levels = (p) => [p.exit, p.slPts, p.targetPts, p.trailStart, p.trailGap]

test('a strategy\'s option follows ITS OWN exit, held to the index\'s max rules - never the Trade settings\' SL / target / trail', () => {
  // Out with the index trade (nothing of its own): the max rules alone - not the manual SL 20 / target 30, no trail.
  assert.deepEqual(levels(plan({})), ['index', 40, 60, 0, 0])
  assert.deepEqual(levels(plan({}, 100, { ...cfg, paperMaxSl: 0, paperMaxTarget: 0 })), ['index', null, null, 0, 0], 'no max: only its index exit')
  // Its own SL / target used where tighter than the max; the max where its own is wider.
  assert.deepEqual(levels(plan({ tradeOptExit: 'first', tradeOptSlPct: 25, tradeOptTargetPct: 50 })), ['first', 25, 50, 0, 0])
  assert.deepEqual(levels(plan({ tradeOptExit: 'first', tradeOptSlPct: 25, tradeOptTargetPct: 50 }, 200)), ['first', 40, 60, 0, 0], '50 / 100 pts on a 200 premium: held to 40 / 60')
  assert.deepEqual(levels(plan({ tradeOptExit: 'indexSl', tradeOptSlPct: 25 })), ['indexSl', 25, 60, 0, 0], 'its SL only - the Max target still holds')
  assert.deepEqual(levels(plan({ tradeOptExit: 'option', tradeOptSlPct: 10, tradeOptTargetPct: 40 }, 50)), ['option', 5, 20, 0, 0])
  // No exit set: read from its % (the lab's way) - a target %: first; an SL % only: indexSl.
  assert.equal(ownOptionExit({ tradeOptSlPct: 30, tradeOptTargetPct: 0 }), 'indexSl')
  assert.equal(ownOptionExit({ tradeOptSlPct: 30, tradeOptTargetPct: 40 }), 'first')
  assert.equal(ownOptionExit({ tradeOptLeg: 'buy' }), 'index')
  assert.equal(plan({ tradeOptLeg: 'buy', tradeOptSlPct: 30 }).slPts, 30, 'its % on the premium - not the manual 20')
  assert.equal(paramsFromFilters({ tradeOptLeg: 'buy', tradeOptExit: 'option', tradeOptSlPct: 10, tradeOptTargetPct: 40 }).optExit, 'option')
  assert.equal(capPoints(null, 0), null)
  assert.equal(capPoints(25, 0), 25)
  assert.equal(capPoints(null, 40), 40)
  assert.equal(capPoints(50, 40), 40)
})

test('its live order: the legs in force; where there are none (no max, out with the index), a safety leg at the signal\'s own index distance', () => {
  const s = { entry: 25000, stop: 24970, target: 25060 }
  const free = { ...cfg, paperMaxSl: 0, paperMaxTarget: 0 }
  assert.deepEqual(liveLegsFor(plan({}, 100, free), s), { slPts: 30, targetPts: 60 })
  assert.deepEqual(liveLegsFor(plan({ tradeOptExit: 'indexSl', tradeOptSlPct: 25 }, 100, free), s), { slPts: 25, targetPts: 60 })
  assert.deepEqual(liveLegsFor(plan({ tradeOptExit: 'first', tradeOptSlPct: 10, tradeOptTargetPct: 15 }), s), { slPts: 10, targetPts: 15 })
  assert.deepEqual(liveLegsFor(plan({}), s), { slPts: 40, targetPts: 60 }, 'the max rules')
})

test('a change of the max rules reaches the open strategy trades from that minute - their own SL / target held to the new max', () => {
  const trade = { action: 'SELL', side: 'PE', strike: 25000 }
  const own = newPosition({ setup: long, trade, which: 'sell', lots: 1, lotSize: 65, premium: 100, cfg, at: T0, plan: plan({ tradeOptExit: 'indexSl', tradeOptSlPct: 25 }) })
  const plain = newPosition({ setup: { ...long, id: 'buildUp' }, trade, which: 'sell', lots: 1, lotSize: 65, premium: 100, cfg, at: T0, plan: plan({}) })
  assert.deepEqual([own.optExit, own.ownSlPts, own.slPts, own.ownTargetPts, own.targetPts, own.trailGap], ['indexSl', 25, 25, null, 60, 0])
  assert.deepEqual([plain.optExit, plain.ownSlPts, plain.slPts, plain.targetPts, plain.trailGap], ['index', null, 40, 60, 0])
  const at = T0 + 5 * MIN
  const after = withCapChange([own, plain], new Set([own.key, plain.key]), { maxSl: 20, maxTarget: 0 }, at)
  assert.deepEqual([after[0].slPts, after[0].targetPts], [20, null], 'its 25 held to the new 20; no max target: none')
  assert.deepEqual(after[0].levelLog, [{ t: T0, sl: 25, target: 60, trailStart: 0, trailGap: 0 }, { t: at, sl: 20, target: null, trailStart: 0, trailGap: 0 }])
  assert.deepEqual([after[1].slPts, after[1].targetPts], [20, null])
  // A manual trade's level change (withLevelChange) does not touch a strategy's trade.
  assert.deepEqual(withLevelChange([own], new Set([own.key]), { paperSl: 5 }, at, cfg)[0], own)
})

// ---- tuning == scanner: the paper trade of a strategy applied with its option exit is the tuning's own trade ----
const syn = day()
const heatmap = syn.path.map((p, m) => ({ t: syn.at(m) + 30_000, bids: [[p - 1, 500]], asks: [[p + 1, 500]] }))
const replayDay = { meta: { lotSize: 75, lastPrice: syn.path.at(-1) }, minuteBars: syn.minuteBars, trades: [], icebergs: [], heatmap, sweeps: [], source: 'live' }
const all = await scanDaySetups({ day: replayDay, prints: syn.prints, oi: syn.oi, profile: null, rowSize: 1, lotSize: 75, largeLots: 10, estimated: false, filters: {}, keepAll: true })
const d = tuningDay('2026-10-05', all, replayDay, syn.oi)

test('tuning == scanner: each option exit as applied, held to the max rules, is the same trade the tuning measured (same exit, premium, points)', () => {
  const id = all[0].id
  // A manual trade's levels are set (and tight) - none of them may reach a strategy; the max rules hold both the tuning and
  // the scanner the same way (wide enough that its own levels still decide some trades, tight enough to decide others).
  const caps = { maxSl: 6, maxTarget: 9 }
  const index = { autoPaper: 'strategy', paperSl: 2, paperTarget: 3, paperTrailStart: 0, paperTrailGap: 1, paperLots: 1, filters: {}, paperMaxSl: caps.maxSl, paperMaxTarget: caps.maxTarget }
  const dc = { ...d, optionCaps: caps }
  let compared = 0
  const reasons = new Set()
  for (const [leg, exit, sl, tg] of [['sell', 'index'], ['buy', 'index'], ['sell', 'indexSl', 15], ['buy', 'indexSl', 3], ['sell', 'first', 15, 20], ['buy', 'first', 5, 10], ['sell', 'option', 20, 30], ['buy', 'option', 10, 15]]) {
    const v = { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, optLeg: leg, optExit: exit, ...(sl ? { optSlPct: sl } : {}), ...(tg ? { optTargetPct: tg } : {}) }
    const filters = { [id]: { ...filtersFromTuning({}, v, { option: true }), _tuned: 'sig' } }
    for (const s of all.filter((x) => x.id === id).slice(0, 12)) {
      const outcome = { status: 'win', exitAt: s.t + 20 * MIN, r: 1 }
      const tuned = optionOutcome(dc, s, outcome, v)
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
      if (tuned.exitMs < Math.min(dc.endMs, squareOffMs(s.t))) assert.equal(row.exitTime, tuned.exitMs)
      reasons.add(`${exit}:${/SL|Target/.test(tuned.reason) ? 'own level' : 'other'}`)
      compared++
    }
  }
  assert.ok(compared >= 20, `${compared}`)
  assert.ok(reasons.has('first:own level') || reasons.has('option:own level') || reasons.has('indexSl:own level'), [...reasons].join(', '))
})
