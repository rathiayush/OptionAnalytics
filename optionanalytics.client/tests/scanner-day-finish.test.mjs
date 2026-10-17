// A day that is OVER is finished on the server: every signal gets its outcome and every paper trade its exit on the
// day's complete minutes, each closed signal says what its bought and its sold option would have made, and the record
// is final - nothing of a past day is ever left showing "open". A day the runner was not up for at the close is
// finished the same way at the next start, from its minutes read back (pastDay).
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner, futuresMinuteBars } from '../scanner-runner/indexScanner.mjs'
import { ALL_IDS, MIN, signalLegs } from '../src/scannerCore.js'
import { optionTradesFor } from '../src/strategyEngine.js'
import { day } from './synthetic-day.mjs'

const { minuteBars, prints, oi, path, T915, at, run } = day()
const DATE = '2026-10-05'
const SETTINGS = { alertIds: ALL_IDS, settings: { telegram: true, autoPaper: 'sell', paperLots: 2 } }

function fakeIo() {
  const io = {
    clock: at(15), telegrams: [], logs: [], states: new Map(), posted: [], asked: [],
    now: () => io.clock,
    log: (m) => io.logs.push(m),
    telegram: async (text) => { io.telegrams.push(text) },
    api: async (p, opts) => {
      io.asked.push(p)
      if (p === '/api/scanner-log/day') { io.posted.push(opts.body); return {} }
      throw new Error(`unexpected ${p}`)
    },
    previousSession: async () => null,
    loadState: async (u, d) => io.states.get(`${u}:${d}`) ?? null,
    saveState: async (u, d, s) => { io.states.set(`${u}:${d}`, JSON.parse(JSON.stringify(s))) },
  }
  return io
}

const dataAt = (t) => ({
  view: {
    meta: { securityId: 1, lotSize: 75, lastPrice: path[Math.floor((t - T915) / MIN)], day: DATE, contractSymbol: 'NIFTY-FUT' },
    minuteBars: minuteBars.filter((b) => Date.parse(b.time) <= t), trades: [], icebergs: [], sweeps: [],
    heatmap: [{ t, bids: [], asks: [] }], book: { bids: [{ price: 1, quantity: 500 }], asks: [{ price: 2, quantity: 500 }] }, source: 'live',
  },
  prints: prints.filter((p) => p.time <= t),
  oi,
  profile: null,
})

async function runDay(scanner, io, from, to) {
  for (let t = from; t <= to; t += 30_000) {
    io.clock = t
    scanner.data = dataAt(t)
    scanner.oiVersion = 0
    await scanner.evaluate()
  }
}

test('a finished day stays finished after a restart', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig(SETTINGS)
  await runDay(scanner, io, at(15), at(300))
  await scanner.finishDay(DATE)
  const posts = io.posted.length

  const again = new IndexScanner('NIFTY', io)
  again.reset(DATE)
  again.restore(await io.loadState('NIFTY', DATE))
  again.setConfig(SETTINGS)
  assert.equal(again.finished, DATE)
  await runDay(again, io, at(300), at(302))
  assert.equal(io.posted.length, posts, 'nothing re-posted')
  assert.equal(io.telegrams.filter((m) => m.includes('Paper exit')).length,
    new Set(io.telegrams.filter((m) => m.includes('Paper exit'))).size, 'and no exit announced twice')
})

test('pastDay reads the day back: the futures minutes, and that date\'s OI and spot as a replay sees them', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('SENSEX', io)
  scanner.reset('2026-10-06')
  scanner.setConfig(SETTINGS)
  const asked = []
  io.api = async (p) => {
    asked.push(p.split('?')[0])
    if (p.startsWith('/api/oi-replay/SENSEX/run')) return run
    if (p.startsWith('/api/oi-replay/SENSEX/expiries')) return { week: '2026-10-08' }
    if (p.startsWith('/api/order-flow/SENSEX/day/')) return null // the recorded day is gone - the OI side still finishes
    throw new Error(`unexpected ${p}`)
  }
  const data = await scanner.pastDay(DATE)
  assert.ok(asked.includes(`/api/order-flow/SENSEX/day/${DATE}`))
  assert.ok(asked.includes('/api/oi-replay/SENSEX/run'))
  assert.equal(data.oi?.date, DATE)
  assert.equal(data.oi.lag, MIN, 'read as a replay reads it - each point at its minute\'s end, no look-ahead')
  assert.ok(data.spotBars.length > 100, 'the day\'s spot minutes')
})

test('futuresMinuteBars: the futures own candles stand in for a day with no order flow', () => {
  const bars = futuresMinuteBars(run)
  assert.ok(bars.length > 100, 'a day of minutes')
  assert.ok(bars.every((b) => b.high >= b.low && b.close > 0 && b.time), 'each with its own range')
  assert.ok(Date.parse(bars[0].time) < Date.parse(bars.at(-1).time), 'oldest first')
  assert.deepEqual(futuresMinuteBars(null), [])
  assert.deepEqual(futuresMinuteBars({ futuresBars: [] }), [])
})

test('an option side the setup never captured is filled from the chain, not left blank for ever', async () => {
  // A futures (order-flow) setup is built AT THE CLOCK, part-way through a minute: a strike with no tick yet made
  // optionTradesFor return that side as null, and the setup kept the null all day - so its If bought / If sold stayed
  // empty. The stored pair is no longer taken wholesale; a missing side is read from the chain at the signal's minute.
  const t = at(100)
  const dir = 1
  const full = optionTradesFor(oi, dir, 22700, t)
  assert.ok(full?.buy && full?.sell, 'the chain has both sides at that minute')
  const halfCaptured = { buy: full.buy, sell: null } // what a mid-minute read left behind
  const base = { id: 'weakWall', side: 'LONG', t, entry: 22760, stop: 22740, target: 22800, outcome: { status: 'win', r: 1, exitAt: at(120), exitPrice: 22800 } }

  const filled = signalLegs({ ...base, options: halfCaptured }, oi, {})
  assert.ok(filled.sellOption, 'the side the setup missed is filled in')
  assert.ok(Number.isFinite(filled.sellPoints), 'and it has its points')
  // What the setup DID capture is still used as it stood - never replaced by a later read.
  const both = signalLegs({ ...base, options: full }, oi, {})
  assert.equal(filled.buyOption, both.buyOption)
  assert.equal(filled.buyEntry, both.buyEntry)
})
