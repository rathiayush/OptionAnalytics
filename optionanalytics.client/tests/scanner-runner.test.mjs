// The server-side scanner's per-index logic (scanner-runner/indexScanner.mjs) driven through a synthetic
// day with a fake server: it fires what the page would, paper-trades each alert once, announces exits
// once, keeps its record, survives a restart without repeating itself, and applies a new SL / target to
// open trades from that minute. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner, topFromSignalsCsv, TAG } from '../scanner-runner/indexScanner.mjs'
import { ALL_IDS, MIN } from '../src/scannerCore.js'
import { day } from './synthetic-day.mjs'

const { minuteBars, prints, oi, path, T915, at } = day()
const DATE = '2026-10-05'

function fakeIo() {
  const io = {
    clock: at(15), telegrams: [], logs: [], states: new Map(), posted: [],
    now: () => io.clock,
    log: (m) => io.logs.push(m),
    telegram: async (text) => { io.telegrams.push(text) },
    api: async (path, opts) => { if (path === '/api/scanner-log/day') { io.posted.push(opts.body); return {} } throw new Error(`unexpected ${path}`) },
    previousSession: async () => null,
    loadState: async (u, d) => io.states.get(`${u}:${d}`) ?? null,
    saveState: async (u, d, s) => { io.states.set(`${u}:${d}`, JSON.parse(JSON.stringify(s))) },
  }
  return io
}

// The day as the server would show it at clock t.
function dataAt(t) {
  return {
    view: {
      meta: { securityId: 1, lotSize: 75, lastPrice: path[Math.floor((t - T915) / MIN)], day: DATE, contractSymbol: 'NIFTY-FUT' },
      minuteBars: minuteBars.filter((b) => Date.parse(b.time) <= t), trades: [], icebergs: [], sweeps: [],
      heatmap: [{ t, bids: [], asks: [] }], book: { bids: [{ price: 1, quantity: 500 }], asks: [{ price: 2, quantity: 500 }] }, source: 'live',
    },
    prints: prints.filter((p) => p.time <= t),
    oi,
    profile: null,
  }
}

async function runDay(scanner, io, from, to) {
  for (let t = from; t <= to; t += 30_000) {
    io.clock = t
    scanner.data = dataAt(t)
    scanner.oiVersion = 0
    await scanner.evaluate()
  }
}

test('a day through the server scanner: alerts paper-traded once each, exits announced once, the record kept', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ alertIds: ALL_IDS, settings: { telegram: true, autoPaper: 'sell', paperLots: 2 } })
  await runDay(scanner, io, at(15), at(300))

  const fired = scanner.memory.fired
  assert.ok(fired.length >= 3, `fired ${fired.length}`)
  assert.equal(scanner.positions.length, fired.filter((s) => s.options?.sell).length, 'one paper trade per alerted signal with an option')
  const entries = io.telegrams.filter((m) => m.startsWith(`${TAG} Paper SELL NIFTY`))
  assert.equal(entries.length, scanner.positions.length)
  const exits = io.telegrams.filter((m) => m.startsWith(`${TAG} Paper exit`))
  assert.equal(new Set(exits).size, exits.length, 'each exit once')
  assert.ok(exits.length >= 1, 'some trades closed during the day')
  assert.ok(io.posted.length >= 1)
  const last = io.posted.at(-1)
  assert.equal(last.source, 'server')
  assert.equal(last.signals.length, fired.length)
  assert.equal(last.trades.length, scanner.positions.length)
  assert.ok(last.trades.every((t) => t.lots === 2), 'paper trades sized by the lots set')
  const status = scanner.status()
  assert.equal(status.signals.length, fired.length)
  assert.equal(status.trades.length, scanner.positions.length)

  // A restart part-way: the state comes back and nothing already sent is sent again.
  const sent = io.telegrams.length
  const again = new IndexScanner('NIFTY', io)
  again.reset(DATE)
  again.restore(await io.loadState('NIFTY', DATE))
  again.setConfig({ alertIds: ALL_IDS, settings: { telegram: true, autoPaper: 'sell', paperLots: 2 } })
  await runDay(again, io, at(300), at(301))
  assert.equal(io.telegrams.length, sent, 'nothing repeated after a restart')
  assert.equal(again.memory.fired.length, fired.length)
})

test('nothing is scanned before the engine has today\'s data, or for a switched-off index', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset('2026-10-06') // today is the 6th, the snapshot still the 5th
  scanner.setConfig({ alertIds: ALL_IDS })
  await runDay(scanner, io, at(100), at(200))
  assert.equal(scanner.memory.fired.length, 0)
  const off = new IndexScanner('NIFTY', io)
  off.reset(DATE)
  off.setConfig({ alertIds: ALL_IDS, enabled: { NIFTY: false } })
  await runDay(off, io, at(100), at(200))
  assert.equal(off.memory.fired.length, 0)
})

test('a new SL / target reaches the open paper trades from that minute', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell' }, levels: { NIFTY: { sl: 20, target: 30 } } })
  // Run until a trade is open.
  let t = at(15)
  for (; t <= at(300) && !scanner.positions.length; t += 30_000) { io.clock = t; scanner.data = dataAt(t); await scanner.evaluate() }
  assert.ok(scanner.positions.length, 'a trade opened')
  const open = scanner.status().trades.filter((r) => !r.exitTime)
  assert.ok(open.length, 'it is open')
  scanner.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell' }, levels: { NIFTY: { sl: 12, target: 30 } } })
  const changed = scanner.positions.find((p) => p.key === open[0].key)
  assert.equal(changed.slPts, 12)
  assert.equal(changed.levelLog.length, 2)
  assert.equal(changed.levelLog[1].t, Math.floor((t - 30_000) / MIN) * MIN, 'from the minute of the change')
  assert.equal(changed.levelLog[0].sl, 20)
})

test('the Top 15 from the scanner log\'s signals', () => {
  const csv = ['key,date,underlying,strategy_id,status,r', 'a,d,NIFTY,wallBreak,win,2', 'b,d,NIFTY,wallBreak,loss,-1', 'c,d,NIFTY,buildUp,open,'].join('\n')
  const top = topFromSignalsCsv(csv)
  assert.ok(top.ids.length > 0)
  assert.deepEqual(topFromSignalsCsv('').ids, topFromSignalsCsv(null).ids)
})
