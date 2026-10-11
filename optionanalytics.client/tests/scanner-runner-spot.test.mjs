// The SPOT + OPTIONS strategies in the server-side scanner (scanner-runner/indexScanner.mjs): judged once each finished
// minute on the server's 1-minute spot candles, they fire exactly what the Strategy tuning's day scan finds for the
// same day (scanSpotDay + firstPerCooldown) - never reading the minute still running -, their outcomes follow the spot
// candles, a spot strategy is paper-traded only where it was applied or put on the live list, and live today its order
// tells the server to watch the index stop on the SPOT price. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner, TAG } from '../scanner-runner/indexScanner.mjs'
import { buildOiContext, simulateOutcome } from '../src/strategyEngine.js'
import { scanSpotDay, spotBarsOf } from '../src/spotEngine.js'
import { firstPerCooldown } from '../src/scanDay.js'
import { tuningDay } from '../src/strategyTuning.js'
import { crossCheck } from '../scanner-runner/tuneChecks.mjs'

const MIN = 60_000
const DATE = '2026-10-09'
const T = Date.parse(`${DATE}T03:45:00Z`) // 09:15 IST
const iso = (m) => new Date(T + m * MIN).toISOString()
const STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
const MINUTES = 140

// The spot strategies' own test day (tests/spot-strategies.test.mjs, #101): quiet under the 22550 call wall, the call
// writers leaving and the puts written in the 15 minutes to 10:45, the 10:44 minute closing through the wall - then a
// steady climb to the target.
const c = (open, close, pad = 3) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
const candle = (m) => (m < 89 ? c(22545 + ((m % 4) - 1.5), 22545 + (((m + 1) % 4) - 1.5)) : m === 89 ? c(22546, 22556) : c(22556 + 3 * (m - 90), 22559 + 3 * (m - 90)))
const ramp = (m) => Math.max(0, m - 74)
const drift = (m, d, rampSign) => (1 + d * 0.00015 * m) * (1 + rampSign * 0.0004 * ramp(m))
const ce = (k, m) => (k === 22550 ? 6e6 : 2e6) * drift(m, -1, -1)
const pe = (k, m) => (k === 22450 ? 6e6 : 2e6) * drift(m, 1, 1)
const spot = Array.from({ length: MINUTES }, (_, m) => ({ time: iso(m), ...candle(m) }))
const points = (f) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: k, openInterest: Math.round(f(k, m)), price: 60 })))
const run = { success: true, date: DATE, step: 50, cePoints: points(ce), pePoints: points(pe), futuresBars: [], spotCandlesOneMinute: spot }
const oi = { ...buildOiContext(run, null, { live: false }), expiry: '2026-10-13' }
const bars = spotBarsOf(spot)

function fakeIo({ orders = [], exits = [], stops = [], spotCalls = [] } = {}) {
  const io = {
    clock: T, telegrams: [], logs: [], states: new Map(), posted: [],
    now: () => io.clock,
    log: (m) => io.logs.push(m),
    telegram: async (text) => { io.telegrams.push(text) },
    api: async (path, opts) => {
      if (path === '/api/scanner-log/day') { io.posted.push(opts.body); return {} }
      if (path.startsWith('/api/spot/NIFTY/candles')) {
        spotCalls.push(path)
        // The server's candles: every minute that has STARTED - the running one too, half-built (its later ticks are
        // not in yet); the scanner must not take it for a finished minute.
        return spot.filter((x) => Date.parse(x.time) <= io.clock).map((x) => (Date.parse(x.time) + MIN > io.clock ? { ...x, close: x.open, high: x.open, low: x.open } : x))
      }
      if (path === '/api/scanner-runner/live/NIFTY/order') { orders.push(opts.body); return { placed: true, message: 'placed', order: { success: true, orderIds: [`o${orders.length}`], lotSize: 65, prices: { limit: 60 } } } }
      if (path === '/api/scanner-runner/live/NIFTY/exit') { exits.push(opts.body); return { success: true } }
      if (path === '/api/scanner-runner/live/NIFTY/index-stop') { stops.push(opts.body); return {} }
      throw new Error(`unexpected ${path}`)
    },
    previousSession: async () => null,
    loadState: async (u, d) => io.states.get(`${u}:${d}`) ?? null,
    saveState: async (u, d, s) => { io.states.set(`${u}:${d}`, JSON.parse(JSON.stringify(s))) },
  }
  return io
}

// The rest of the server's day (the futures view): enough for the clock, nothing for the futures strategies to fire on.
const dataAt = (t) => ({ view: { meta: { securityId: 1, lotSize: 75, day: DATE }, minuteBars: [{ time: iso(0), open: 1, high: 1, low: 1, close: 1 }], trades: [], heatmap: [{ t, bids: [], asks: [] }], book: { bids: [], asks: [] }, source: 'live' }, prints: [], oi, profile: null })

async function runDay(scanner, io, fromMin, toMin) {
  for (let t = T + fromMin * MIN; t <= T + toMin * MIN; t += 10_000) {
    io.clock = t
    scanner.data = dataAt(t)
    await scanner.evaluate()
  }
}

const key = (s) => [s.id, s.side, s.t, s.entry, s.stop, s.target].join()

test('the server scanner fires the spot setups the tuning finds for the day - once a minute, on finished minutes only', async () => {
  const spotCalls = []
  const io = fakeIo({ spotCalls })
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ alertIds: [], settings: { telegram: true } })
  await runDay(scanner, io, 15, MINUTES - 1)

  const fired = scanner.memory.fired.filter((s) => s.spot)
  const tuning = firstPerCooldown(scanSpotDay({ bars, oi, until: T + (MINUTES - 1) * MIN }))
  assert.ok(fired.some((s) => s.id === 'spotWallBreak' && s.side === 'LONG' && s.t === T + 90 * MIN && s.entry === 22556), JSON.stringify(fired.map(key)))
  assert.deepEqual(fired.map(key), tuning.map(key), 'live == the tuning\'s day scan')
  assert.ok(spotCalls.length <= MINUTES, 'the spot candles are read about once a minute, not on every look')
  // Its outcome follows the spot candles - the target hit on the climb, as the tuning measures it.
  const sig = scanner.status().signals.find((s) => s.id === 'spotWallBreak')
  const expected = simulateOutcome(fired.find((s) => s.id === 'spotWallBreak'), bars, T + (MINUTES - 1) * MIN)
  assert.equal(sig.status, 'win')
  assert.equal(sig.status, expected.status)
  assert.equal(sig.exitAt, expected.exitAt)
  assert.equal(sig.spot, true)
  // Not applied, not on the live list: recorded, not traded and not announced.
  assert.equal(sig.alerted, false)
  assert.equal(scanner.positions.length, 0)
  assert.equal(io.telegrams.length, 0)
  const last = io.posted.at(-1)
  assert.ok(last.signals.some((x) => x.strategyId === 'spotWallBreak' && x.status === 'win'), 'in the server\'s scanner record')
})

test('a spot strategy applied to the index is paper-traded with its own lots; the spot candles missing: nothing fires', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ alertIds: [], settings: { telegram: true }, filtersByIndex: { NIFTY: { spotWallBreak: { _lots: 3 } } } })
  await runDay(scanner, io, 15, 118) // (the climb breaks the next wall at 11:17 - another trade)
  assert.equal(scanner.positions.length, 1)
  const p = scanner.positions[0]
  assert.equal(p.strategy, 'spotWallBreak')
  assert.equal(p.action, 'SELL')
  assert.equal(p.side, 'PE', 'a long sells the put')
  assert.equal(p.strike, 22550)
  const entry = io.telegrams.find((m) => m.startsWith(`${TAG} Paper SELL NIFTY 22550 PE x3 lot(s)`))
  assert.ok(entry && entry.includes('spot 22556.0'), io.telegrams.join('\n'))
  const row = scanner.status().trades[0]
  assert.equal(row.lots, 3)
  assert.ok(row.exitTime, 'closed by its setup\'s target on the spot candles')
  assert.ok(io.telegrams.some((m) => m.startsWith(`${TAG} Paper exit`)))

  // The server's spot candles unreadable: no spot setup is judged on a guess.
  const down = fakeIo()
  down.api = async (path, opts) => { if (path === '/api/scanner-log/day') return {}; void opts; throw new Error('502') }
  const blind = new IndexScanner('NIFTY', down)
  blind.reset(DATE)
  blind.setConfig({ alertIds: [], settings: { telegram: true }, filtersByIndex: { NIFTY: { spotWallBreak: {} } } })
  await runDay(blind, down, 15, 100)
  assert.equal(blind.memory.fired.length, 0)
  assert.equal(down.logs.filter((m) => m.includes('spot candles not read')).length, 1, 'said once, not every minute')
  assert.equal(blind.status().spot.error, '502')
})

test('live today: a spot strategy on the live list is ordered with its index stop on the SPOT price, and closed there once', async () => {
  const orders = []
  const exits = []
  const io = fakeIo({ orders, exits })
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  const config = { alertIds: [], settings: { telegram: true, paperLots: 2 }, live: { NIFTY: true }, liveList: { NIFTY: ['spotWallBreak'] } }
  scanner.setConfig(config)
  await runDay(scanner, io, 15, 100)
  assert.equal(orders.length, 1, JSON.stringify(orders))
  const o = orders[0]
  const s = scanner.memory.fired.find((x) => x.id === 'spotWallBreak')
  assert.equal(o.strategyId, 'spotWallBreak')
  assert.equal(o.priceBasis, 'spot')
  assert.equal(o.indexStop, s.stop)
  assert.equal(o.indexTarget, s.target)
  assert.equal(o.indexSide, 'LONG')
  assert.equal(o.lots, 2)
  assert.ok(io.telegrams.some((m) => m.startsWith(`${TAG} LIVE order placed: SELL NIFTY 22550 PE`) && m.includes('spot 22556.0')))
  // A restart before the target: nothing is asked again; the exit goes once.
  const again = new IndexScanner('NIFTY', io)
  again.reset(DATE)
  again.restore(await io.loadState('NIFTY', DATE))
  again.setConfig(config)
  await runDay(again, io, 100, 118)
  assert.equal(orders.length, 1)
  assert.equal(exits.length, 1)
  assert.equal(exits[0].key, o.key)
  assert.ok(Number.isFinite(exits[0].pnl))
})

test('the tuning cross-checks spot settings too: a spot setting is measured on the days it was not chosen on', () => {
  const day = tuningDay(DATE, scanSpotDay({ bars, oi }), { minuteBars: bars, heatmap: [] }, oi)
  const longOnly = { id: 'spotWallBreak', no: 101, name: 'Spot wall break', unit: 'R', settingText: 'long only', raw: { tradeSide: 'long' }, params: { tradeSide: 'long' }, trainDates: new Set(), ranges: [], runs: ['r1'] }
  const shortOnly = { ...longOnly, settingText: 'short only', raw: { tradeSide: 'short' }, params: { tradeSide: 'short' } }
  const rows = crossCheck([day], [longOnly, shortOnly])
  const long = rows.find((r) => r.settingText === 'long only')
  assert.ok(long && long.n >= 1 && long.total > 0 && long.baseN >= long.n, JSON.stringify(rows))
  assert.ok(!rows.some((r) => r.settingText === 'short only' && r.n > 0), 'no short wall break that day')
  // Chosen on that day: not checked there.
  assert.equal(crossCheck([day], [{ ...longOnly, trainDates: new Set([DATE]) }]).length, 0)
})
