// A day that is OVER is finished on the server: every signal gets its outcome and every paper trade its exit on the
// day's complete minutes, each closed signal says what its bought and its sold option would have made, and the record
// is final - nothing of a past day is ever left showing "open". A day the runner was not up for at the close is
// finished the same way at the next start, from its minutes read back (pastDay).
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner } from '../scanner-runner/indexScanner.mjs'
import { ALL_IDS, MIN } from '../src/scannerCore.js'
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

test('the day is over: no signal and no paper trade is left open, and both options are captured', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig(SETTINGS)
  // The synthetic day's minutes end at 14:15 - so signals that never reached their stop or target are still running.
  await runDay(scanner, io, at(15), at(300))
  const before = io.posted.at(-1)
  assert.ok(before.signals.some((x) => x.status === 'open'), 'the day ended with signals still running')
  assert.ok(before.trades.some((t) => !t.exitTime), 'and with paper trades still open')

  assert.equal(await scanner.finishDay(DATE), true)
  const final = io.posted.at(-1)
  assert.equal(final.date, DATE)
  assert.equal(final.signals.length, before.signals.length, 'the same signals - none added, none lost')
  assert.ok(final.signals.every((x) => x.status && x.status !== 'open'), 'none left open')
  assert.ok(final.signals.every((x) => x.exitReason && Number.isFinite(x.r)), 'each says why it left, with its R')
  assert.ok(final.trades.length > 0 && final.trades.every((t) => t.exitTime && t.exitPremium != null && t.points != null),
    'every paper trade closed, with its exit premium and points')
  // What the option bought and the option sold would have made - on every signal that had a strike to trade.
  const withLegs = final.signals.filter((x) => x.buyOption || x.sellOption)
  assert.ok(withLegs.length >= 1, 'signals with an option')
  assert.ok(withLegs.every((x) => x.buyPoints != null && x.sellPoints != null && x.indexPoints != null),
    'both legs and the index points are captured on every one of them')

  // Final: the day is never scanned, re-priced or posted again.
  const posts = io.posted.length
  await runDay(scanner, io, at(300), at(302))
  assert.equal(io.posted.length, posts, 'a finished day is never posted again')
  assert.equal(await scanner.finishDay(DATE), false, 'and never finished twice')
  assert.equal((await io.loadState('NIFTY', DATE)).finished, true, 'the state says so across a restart')
})

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

test('a past day the runner never finished is finished from its minutes read back', async () => {
  // A day left open by a restart: only its state file is there - no data in memory, and the scanner is on another day.
  const io = fakeIo()
  const first = new IndexScanner('NIFTY', io)
  first.reset(DATE)
  first.setConfig(SETTINGS)
  await runDay(first, io, at(15), at(300))
  const open = io.posted.at(-1).signals.filter((x) => x.status === 'open').length
  assert.ok(open > 0)

  const next = new IndexScanner('NIFTY', io)
  next.reset('2026-10-06') // the next day - DATE is not its own
  next.setConfig(SETTINGS)
  next.pastDay = async (date) => {
    assert.equal(date, DATE)
    return { view: { minuteBars }, oi, spotBars: [] }
  }
  const posts = io.posted.length
  assert.equal(await next.finishDay(DATE), true)
  assert.equal(io.posted.length, posts + 1)
  const final = io.posted.at(-1)
  assert.equal(final.date, DATE)
  assert.ok(final.signals.length > 0 && final.signals.every((x) => x.status !== 'open'), 'the past day has no open signal left')
  assert.equal(next.date, '2026-10-06', 'and the scanner is still on its own day')
  assert.equal(next.finished, null)
  assert.equal((await io.loadState('NIFTY', DATE)).finished, true)
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

test('a signal still running reports both its options as they stand now, and a closed one its exits', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig(SETTINGS)
  await runDay(scanner, io, at(15), at(300))

  const status = scanner.status()
  assert.ok(status.signals.length > 0)
  const open = status.signals.filter((s) => s.status === 'open')
  assert.ok(open.length > 0, 'the day ends with signals still running')
  for (const s of open) {
    assert.equal(s.running, true, 'marked as still running')
    assert.ok(Number.isFinite(s.points), 'its points so far on the index')
    // Both options: in at the signal, worth this much now, points so far - and no exit reason yet.
    for (const which of ['buy', 'sell']) {
      if (!s[`${which}Option`]) continue
      assert.ok(Number.isFinite(s[`${which}Entry`]), `${which} entry premium`)
      assert.ok(Number.isFinite(s[`${which}Now`]), `${which} premium now`)
      assert.ok(Number.isFinite(s[`${which}Points`]), `${which} points now`)
      assert.equal(s[`${which}ExitReason`], null, `${which} has not left yet`)
    }
  }
  // Once the day is finished, the same signals report their exits instead - final, not "now".
  await scanner.finishDay(DATE)
  const done = scanner.status()
  assert.ok(done.signals.every((s) => s.status !== 'open'))
  assert.ok(done.signals.every((s) => !s.running), 'nothing still running')
  const withLegs = done.signals.filter((s) => s.buyOption || s.sellOption)
  assert.ok(withLegs.length > 0 && withLegs.every((s) => s.buyExitReason || s.sellExitReason), 'each leg says why it left')
})
