// The scanner's shared core (scannerCore.js) - what the Order Flow page and the server runner both run.
// The live loop is checked against the loop as it was written in StrategyScanner.jsx before it moved, on a
// synthetic day, so the move changed nothing; then the outcome events, the option positions and the feeds.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateStrategies, coolOffGate, simulateOutcome } from '../src/strategyEngine.js'
import { findWalls } from '../src/orderFlowMath.js'
import {
  scanTick, completedBars, priceAt, trailFor, followSetups, setupEvents, newSetupEventMemory, newPosition, positionRows, COOLDOWN_MS, MIN,
  alertIdsFor, sameSignal, scannerLogBody, paperEntryText,
} from '../src/scannerCore.js'
import { applyOrderFlowPush, applyOiTicks, upsertSeries, mergePrints, orderFlowFromSnapshot } from '../src/liveFeeds.js'
import { day } from './synthetic-day.mjs'

const { minuteBars, prints, oi, path, T915, at } = day()
const viewAt = (t) => ({
  meta: { lastPrice: path[Math.floor((t - T915) / MIN)] }, minuteBars: minuteBars.filter((b) => Date.parse(b.time) <= t),
  book: { bids: [{ price: 1, quantity: 500 }], asks: [{ price: 2, quantity: 500 }] }, sweeps: [], icebergs: [], heatmap: [],
})
const msOf = (x) => (typeof x === 'number' ? x : new Date(x).getTime())

// The live loop exactly as StrategyScanner.jsx had it before scannerCore.js existed.
function oldLoop(input, firedRef, pendingRef) {
  const { nowMs, view, tapePrints, liquidity, pullStack, estimated, lotSize, largeLots, profile, rowSize, filters, trail } = input
  if (!(!estimated && !(tapePrints?.length && msOf(tapePrints.at(-1).time) >= nowMs - 3 * MIN))) {
    const bars = completedBars(view.minuteBars, nowMs, rowSize, lotSize, estimated)
    if (bars.length < 5) return null
    const price = priceAt(view, estimated ? null : tapePrints, nowMs, bars)
    const watchNow = []
    const setups = evaluateStrategies({
      nowMs, price, bars, minuteBars: view.minuteBars, prints: estimated ? null : tapePrints,
      book: view.book, walls: findWalls(view.book), liquidity, pullStack, sweeps: view.sweeps, icebergs: view.icebergs, oi, estimated, lotSize, bigLots: largeLots, profile, watch: watchNow, heatmap: view.heatmap, rowSize, filters,
    })
    const watching = watchNow.filter((w) => w.missing.length)
    const recentlyFired = (s) => firedRef.current.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS)
    const gate = coolOffGate(pendingRef.current, setups.filter((s) => !recentlyFired(s)), { nowMs, price, bars, oi })
    const held = [...pendingRef.current.values()].map((p) => p.setup)
    const fresh = gate.fire.filter((s) => !recentlyFired(s)).map((s) => ({ ...s, trail }))
    if (fresh.length) firedRef.current = [...firedRef.current, ...fresh]
    return { watching, held, fresh }
  }
  return null
}

test('the shared live loop fires exactly what the page\'s own loop fired, minute after minute', () => {
  const trail = trailFor({}, 'NIFTY')
  const memory = { fired: [], pending: new Map() }
  const firedRef = { current: [] }
  const pendingRef = { current: new Map() }
  let fires = 0
  for (let t = at(15); t <= at(300); t += 30_000) {
    const input = { nowMs: t, view: viewAt(t), tapePrints: prints.filter((x) => x.time <= t), liquidity: [], pullStack: [], oi, estimated: false, lotSize: 75, largeLots: 10, profile: null, rowSize: 1, filters: {}, trail }
    const now = scanTick(input, memory)
    const before = oldLoop(input, firedRef, pendingRef)
    assert.equal(now === null, before === null, `at ${new Date(t).toISOString()}`)
    if (!now) continue
    if (now.fresh.length) memory.fired = now.fired
    fires += now.fresh.length
    assert.deepEqual(now.fresh, before.fresh)
    assert.deepEqual(now.held, before.held)
    assert.deepEqual(now.watching, before.watching)
  }
  assert.deepEqual(memory.fired, firedRef.current)
  assert.ok(fires >= 3, `only ${fires} setups fired - the synthetic day should give a few`)
})

test('nothing is judged on a tape that has not caught up, or without OI', () => {
  const t = at(120)
  const base = { nowMs: t, view: viewAt(t), liquidity: [], pullStack: [], oi, estimated: false, lotSize: 75, largeLots: 10, rowSize: 1, filters: {}, trail: null }
  assert.equal(scanTick({ ...base, tapePrints: prints.filter((x) => x.time <= t - 5 * MIN) }, { fired: [], pending: new Map() }), null)
  assert.equal(scanTick({ ...base, oi: null, tapePrints: prints.filter((x) => x.time <= t) }, { fired: [], pending: new Map() }), null)
})

test('a setup that stays true fires once per cooldown', () => {
  const memory = { fired: [], pending: new Map() }
  for (let t = at(15); t <= at(300); t += 30_000) {
    const r = scanTick({ nowMs: t, view: viewAt(t), tapePrints: prints.filter((x) => x.time <= t), liquidity: [], pullStack: [], oi, estimated: false, lotSize: 75, largeLots: 10, rowSize: 1, filters: {}, trail: null }, memory)
    if (r?.fresh.length) memory.fired = r.fired
  }
  for (const a of memory.fired) {
    for (const b of memory.fired) if (a !== b && a.id === b.id && a.side === b.side) assert.ok(Math.abs(a.t - b.t) >= COOLDOWN_MS)
  }
})

// A setup with a known outcome: LONG from 100, stop 90, target 120.
const setup = { id: 'wallDefence', side: 'LONG', t: at(60), entry: 100, stop: 90, target: 120, confidence: 70, checks: {}, trail: null }
const barsUpTo = (closes) => closes.map((c, i) => ({ time: new Date(at(60) + i * MIN).toISOString(), open: c, high: c + 1, low: c - 1, close: c }))

test('outcome events: an exit is reported once, and a restored setup does not re-report its past', () => {
  const rising = barsUpTo([101, 104, 108, 112, 117, 121])
  const done = followSetups([setup], [], rising, at(70))
  assert.equal(done[0].outcome.status, 'win')
  const memory = newSetupEventMemory()
  assert.deepEqual(setupEvents(done, memory, true).map((e) => e.type), ['exit'])
  assert.deepEqual(setupEvents(done, memory, true), [])
  const restored = newSetupEventMemory()
  restored.restored.add(`${setup.id}-${setup.t}`)
  assert.deepEqual(setupEvents(done, restored, false), [], 'not judged before the bars are in')
  assert.deepEqual(setupEvents(done, restored, true), [], 'already over when brought back')
  assert.equal(done[0].outcome.r, simulateOutcome(setup, rising, at(70)).r)
})

test('option positions: one per signal, closed by their own premium stop, P&L in rupees', () => {
  const trade = { action: 'SELL', side: 'PE', strike: 22600, premium: 50 }
  const cfg = { paperSl: 10, paperTarget: 20, paperLots: 2 }
  const p = newPosition({ setup, trade, which: 'sell', lots: 1, lotSize: 65, premium: 50, cfg, at: at(61) })
  assert.equal(p.key, `wallDefence-${setup.t}-sell`)
  assert.ok(sameSignal(p, { ...setup, t: setup.t + 5 * MIN }, trade))
  assert.ok(!sameSignal(p, { ...setup, t: setup.t + COOLDOWN_MS }, trade))
  // The PE premium rises to 61: the 10-point stop of the sold option is hit.
  const series = (premium) => [{ t: at(61), oi: 1e6, price: 50, high: 50, low: 50 }, { t: at(62), oi: 1e6, price: premium, high: premium, low: premium }]
  const book = { pe: new Map([[22600, series(61)]]), ce: new Map(), spot: [], futures: [], step: 50 }
  const [row] = positionRows({ positions: [p], dayResults: [], withOutcome: [{ ...setup, outcome: { status: 'open' } }], oi: book, nowMs: at(64), settings: cfg })
  assert.ok(row.exitTime, 'closed')
  assert.match(row.exitReason, /SL/)
  assert.equal(row.lots, 2, 'a paper trade is sized by the lots set now')
  assert.equal(row.points, -10)
  assert.equal(row.rupees, -10 * 2 * 65)
})

test('alert lists and the day\'s log', () => {
  const top = { ids: ['a', 'b'], trial: ['c'], oi: { ids: ['a'] }, profile: { ids: ['b'] } }
  assert.deepEqual(alertIdsFor({ pick: 'top15' }, top), ['a', 'b', 'c'])
  assert.deepEqual(alertIdsFor({ pick: 'oi5' }, top), ['a'])
  assert.deepEqual(alertIdsFor({ pick: 'custom', custom: ['x'] }, top), ['x'])
  const body = scannerLogBody({ underlying: 'NIFTY', date: '2026-10-05', source: 'server', dayResults: [{ ...setup, outcome: { status: 'win', r: 2, exitAt: at(65), exitPrice: 120 } }], rows: [], charges: undefined })
  assert.equal(body.source, 'server')
  assert.equal(body.signals[0].strategyId, 'wallDefence')
  assert.equal(body.signals[0].status, 'win')
  assert.match(paperEntryText({ underlying: 'NIFTY', trade: { action: 'SELL', strike: 22600, side: 'PE' }, lots: 1, premium: 50, setup, cfg: { paperSl: 10, paperTarget: 20 } }), /^Paper SELL NIFTY 22600 PE x1 lot\(s\) @ 50\.0 - #\d+ /)
})

test('feeds: an order flow push adds prints, a heatmap column and the forming bar; OI ticks extend the minute series', () => {
  const view = orderFlowFromSnapshot({ meta: { securityId: 1 }, bars: [], trades: [{ seq: 1, time: at(1), price: 1, quantity: 75, buy: true }], icebergs: [], book: { bids: [], asks: [] }, heatmap: [], source: 'live' })
  const next = applyOrderFlowPush(view, {
    meta: { securityId: 1 }, time: new Date(at(2)).toISOString(), book: { bids: [{ price: 99, quantity: 10 }], asks: [{ price: 101, quantity: 10 }] },
    trades: [{ seq: 1, time: at(1) }, { seq: 2, time: at(2), price: 100, quantity: 75, buy: false }],
    bars: [{ time: new Date(at(2)).toISOString(), open: 100, high: 100, low: 100, close: 100, buy: 0, sell: 75, trades: 1, levels: [{ price: 100, buy: 0, sell: 75 }] }],
  }, 1)
  assert.deepEqual(next.trades.map((t) => t.seq), [1, 2])
  assert.equal(next.heatmap.length, 1)
  assert.equal(next.minuteBars.length, 1)
  assert.equal(next.lastSeq, 2)
  assert.deepEqual(mergePrints([{ seq: 2 }, { seq: 1 }], [{ seq: 3 }]).map((p) => p.seq), [1, 2, 3])

  const ctx = { ce: new Map(), pe: new Map(), futures: [], spot: [] }
  assert.ok(applyOiTicks(ctx, [{ underlying: 'NIFTY', expiryFlag: 'WEEK', side: 'CE', strike: 22600, time: new Date(at(3)).toISOString(), openInterest: 100, price: 5 }], 'NIFTY', 'WEEK'))
  assert.ok(!applyOiTicks(ctx, [{ underlying: 'SENSEX', expiryFlag: 'WEEK', side: 'CE', strike: 22600, time: new Date(at(3)).toISOString(), openInterest: 1, price: 5 }], 'NIFTY', 'WEEK'))
  // A packet with no OI keeps the minute's real OI.
  applyOiTicks(ctx, [{ underlying: 'NIFTY', expiryFlag: 'WEEK', side: 'CE', strike: 22600, time: new Date(at(3) + 20_000).toISOString(), openInterest: 0, price: 6 }], 'NIFTY', 'WEEK')
  assert.deepEqual(ctx.ce.get(22600), [{ t: at(3), oi: 100, price: 6, high: 6, low: 5 }])
  assert.ok(!upsertSeries(ctx.ce.get(22600), new Date(at(2)).toISOString(), { oi: 1 }), 'an older minute never rewrites the newer one')
})
