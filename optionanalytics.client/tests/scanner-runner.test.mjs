// The server's alert runner, one index (scanner-runner/indexScanner.mjs), driven through a synthetic day with a fake
// server: its profile-level alerts (the page's switches, Telegram for a POC / LVN only), nothing before today's data or
// for a switched-off index, and a missed push loading the day again. (The strategy scanner it also ran was removed.)
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner, TAG } from '../scanner-runner/indexScanner.mjs'

const MIN = 60_000
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

// Spot from 22420 up to the previous day's spot POC (22473.98 - the OI Replay chart's line), ticking around
// it, away to 22520 and back: two hits, each sent once. `oi.spot` holds only the minutes up to the clock.
function spotAt(t) {
  const m = (t - T915) / MIN
  if (m <= 40) return 22420 + (m - 15) * 2
  if (m <= 60) return Math.round(m * 2) % 2 ? 22470.8 : 22471.5
  if (m <= 80) return 22471 + (m - 60) * 2.5
  return Math.max(22476, 22520 - (m - 80) * 2.5)
}
async function runSpot(scanner, io, from, to) {
  for (let t = from; t <= to; t += 30_000) {
    io.clock = t
    const spot = []
    for (let s = at(15); s <= t; s += 30_000) spot.push({ t: s, close: spotAt(s) })
    scanner.data = { ...dataAt(t), oi: { ...oi, spot } }
    await scanner.evaluate()
  }
}
const SPOT_VP = { success: true, poc: 22473.98, vah: 22610.5, val: 22350.25, hvn: [22560], lvn: [22300], profileDate: '2026-10-04T00:00:00' }

test('the server sends a profile-level alert when spot reaches the previous day\'s spot POC - once per touch', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ settings: { telegram: true } })
  scanner.setData({ ...dataAt(at(15)), spotVp: SPOT_VP })
  assert.equal(scanner.status().profileAlerts.spot, true, 'the page sees the server covers spot')
  assert.equal(scanner.status().profileAlerts.futures, false, 'no futures levels without the previous session')
  await runSpot(scanner, io, at(15), at(110))
  const alerts = io.telegrams.filter((m) => m.startsWith(`${TAG} 📊`))
  assert.equal(alerts.length, 2, alerts.join('\n'))
  assert.match(alerts[0], /^\[Server\] 📊 NIFTY spot 2247\d\.\d reached Spot VP POC 22474\.0 \(2026-10-04\)/)
  assert.ok(alerts.every((m) => m.includes('Spot VP POC')))
})

test('the server\'s profile alerts follow the page\'s switches and the Telegram switch', async () => {
  const off = fakeIo()
  const spotOff = new IndexScanner('NIFTY', off)
  spotOff.reset(DATE)
  spotOff.setConfig({ settings: { telegram: true }, profileAlerts: { spot: false } })
  spotOff.setData({ ...dataAt(at(15)), spotVp: SPOT_VP })
  assert.equal(spotOff.status().profileAlerts.spot, false)
  await runSpot(spotOff, off, at(15), at(110))
  assert.equal(off.telegrams.filter((m) => m.includes('📊')).length, 0)

  const quiet = fakeIo()
  const noTelegram = new IndexScanner('NIFTY', quiet)
  noTelegram.reset(DATE)
  noTelegram.setConfig({ settings: { telegram: false } })
  noTelegram.setData({ ...dataAt(at(15)), spotVp: SPOT_VP })
  await runSpot(noTelegram, quiet, at(15), at(110))
  assert.equal(quiet.telegrams.length, 0)
  assert.equal(quiet.logs.filter((m) => m.includes('Spot VP POC')).length, 2, 'still logged')
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

test('the server sends a POC or LVN profile alert to Telegram, an HVN one only to its log', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ settings: { telegram: true }, profileAlerts: { spot: false } })
  const top = Math.max(...path.slice(15, 120))
  scanner.setData({ ...dataAt(at(15)), profile: { vp: { poc: null, vah: null, val: null, hvn: [top - 2], lvn: [] }, tpoPrev: null } })
  await runDay(scanner, io, at(15), at(300))
  assert.equal(io.telegrams.filter((m) => m.includes('📊')).length, 0, io.telegrams.join('\n'))
  assert.ok(io.logs.some((m) => m.includes('reached VP HVN')), 'the HVN hit is still logged')
})

test('a push that leaves a minute out loads the day again; a normal one is folded in', async () => {
  const { orderFlowPushGap } = await import('../src/liveFeeds.js')
  const bar = (i) => ({ ...minuteBars[i], levels: minuteBars[i].levels ?? [] })
  const view = { minuteBars: [bar(10), bar(11)] }
  assert.equal(orderFlowPushGap(view, { bars: [bar(11), bar(12)] }), false)   // the forming minute and the next
  assert.equal(orderFlowPushGap(view, { bars: [bar(12), bar(13)] }), false)   // the next two
  assert.equal(orderFlowPushGap(view, { bars: [bar(13), bar(14)] }), true)    // minute 12 missed
  assert.equal(orderFlowPushGap({ minuteBars: [] }, { bars: [bar(3)] }), false)
  assert.equal(orderFlowPushGap(view, { bars: [] }), false)

  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.data = dataAt(at(40))
  const held = scanner.data.view.minuteBars.length
  scanner.onOrderFlowLive({ meta: { securityId: 1, day: DATE }, bars: [bar(held - 1), bar(held)], trades: [] })
  assert.ok(scanner.data, 'a normal push is folded in')
  assert.equal(scanner.data.view.minuteBars.length, held + 1)
  scanner.onOrderFlowLive({ meta: { securityId: 1, day: DATE }, bars: [bar(held + 5), bar(held + 6)], trades: [] })
  assert.equal(scanner.data, null, 'a gap drops the day so it is loaded again')
})

test('nothing is alerted before the engine has today\'s data, or for a switched-off index', async () => {
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset('2026-10-06') // today is the 6th, the snapshot still the 5th
  scanner.setConfig({ settings: { telegram: true } })
  scanner.setData({ ...dataAt(at(15)), spotVp: SPOT_VP })
  await runSpot(scanner, io, at(15), at(110))
  assert.deepEqual(io.telegrams, [])
  const off = new IndexScanner('NIFTY', io)
  off.reset(DATE)
  off.setConfig({ settings: { telegram: true }, enabled: { NIFTY: false } })
  off.setData({ ...dataAt(at(15)), spotVp: SPOT_VP })
  await runSpot(off, io, at(15), at(110))
  assert.deepEqual(io.telegrams, [])
  // The status the pages read: what the server covers - no strategy signals or trades any more.
  assert.deepEqual(Object.keys(off.status()).sort(), ['clockUtc', 'contract', 'date', 'enabled', 'error', 'oiBreakAlerts', 'priceFired', 'profileAlerts', 'ready', 'underlying'])
})

