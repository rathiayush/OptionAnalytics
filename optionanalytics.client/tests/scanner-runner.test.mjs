// The server-side scanner's per-index logic (scanner-runner/indexScanner.mjs) driven through a synthetic
// day with a fake server: it fires what the page would, paper-trades each alert once, announces exits
// once, keeps its record, survives a restart without repeating itself, and applies a new SL / target to
// open trades from that minute. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner, topFromSignalsCsv, TAG, byLiveList } from '../scanner-runner/indexScanner.mjs'
import { ALL_IDS, MIN } from '../src/scannerCore.js'
import { squareOffMs, strategyFilters } from '../src/strategyEngine.js'
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

test('two signals at once: the one higher on the live list goes first (it gets the open slot)', () => {
  const fresh = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  assert.deepEqual(byLiveList(fresh, ['c', 'a']).map((s) => s.id), ['c', 'a', 'b', 'd'])
  assert.deepEqual(byLiveList(fresh, null).map((s) => s.id), ['a', 'b', 'c', 'd'], 'paper: as they came')
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

test('the server sends a profile-level alert when the futures reach the previous session\'s volume profile POC', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ settings: { telegram: true }, profileAlerts: { spot: false } })
  const top = Math.max(...path.slice(15, 120))
  // The levels come with the day's load; the pushes after it carry no profile of their own.
  scanner.setData({ ...dataAt(at(15)), profile: { vp: { poc: top - 2, vah: null, val: null, hvn: [], lvn: [] }, tpoPrev: null } })
  assert.equal(scanner.status().profileAlerts.futures, true)
  await runDay(scanner, io, at(15), at(300))
  const alerts = io.telegrams.filter((m) => m.startsWith(`${TAG} 📊`))
  assert.equal(alerts.length, 1, alerts.join('\n'))
  assert.match(alerts[0], new RegExp(`^\\[Server\\] 📊 NIFTY futures \\d+\\.\\d reached VP POC ${(top - 2).toFixed(1)} \\(profile level\\)`))
})

test('no Trade settings from the server yet: each index runs with its defaults - the trader\'s own', async () => {
  const { runnerSettingsOf } = await import('../src/scannerCore.js')
  const of = (u, config = {}) => { const s = runnerSettingsOf(config, u); return [s.paperSl, s.paperTarget, s.paperMaxSl, s.paperMaxTarget] }
  assert.deepEqual(of('NIFTY'), [30, 40, 50, 0], 'manual SL 30 / target 40; the strategies held to Max SL 50, no max target')
  assert.deepEqual(of('BANKNIFTY'), [50, 75, 80, 0])
  assert.deepEqual(of('SENSEX'), [60, 90, 120, 0])
  // Levels sent without max rules (a server from before them): their SL / target are the max, as the server reads them.
  assert.deepEqual(of('NIFTY', { levels: { NIFTY: { sl: 25, target: 35 } } }), [25, 35, 25, 35])
  // What the server sends wins.
  assert.deepEqual(of('NIFTY', { levels: { NIFTY: { sl: 30, target: 40, maxSl: 45, maxTarget: 60 } } }), [30, 40, 45, 60])
})

// NIFTY's Trade settings these tests hold the strategies to (set here, not the app's defaults): SL 20 / target 30, as the max.
const MAX_20_30 = { sl: 20, target: 30, maxSl: 20, maxTarget: 30 }

test('today is not loaded at weekends or before the open, and a failing load backs off (each try costs Dhan calls)', async () => {
  const io = fakeIo()
  const tries = []
  io.api = async (path) => { tries.push([io.clock, path]); throw new Error('no index data yet') }
  const ist = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`)
  const scanner = new IndexScanner('NIFTY', io)

  io.clock = ist('2026-10-11', '10:00') // a Sunday
  await scanner.ensureDay('2026-10-11')
  io.clock = ist('2026-10-12', '08:30') // Monday, before the open
  await scanner.ensureDay('2026-10-12')
  assert.equal(tries.length, 0, 'no load attempted')

  io.clock = ist('2026-10-12', '09:20')
  await scanner.ensureDay('2026-10-12')
  const first = tries.length
  assert.ok(first > 0, 'tried once the market is open')
  // Retries at 30 s, then 60 s, then 120 s after each failure - not every 30 s.
  const attemptsAt = []
  for (let s = 0; s <= 600; s += 10) {
    io.clock = ist('2026-10-12', '09:20') + s * 1000
    const before = tries.length
    await scanner.ensureDay('2026-10-12')
    if (tries.length > before) attemptsAt.push(s)
  }
  assert.deepEqual(attemptsAt.slice(0, 3), [30, 90, 210], attemptsAt.join())
})
