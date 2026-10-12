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
  assert.ok(last.signals.every((x) => x.market && 'tape60' in x.market && 'futOi15' in x.market && 'bookImb' in x.market), 'each signal keeps the market at its time')
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

test('an index switched to Live: each alert asks the server for a real order once, and its exit closes it there', async () => {
  const io = fakeIo()
  const orders = []
  const exits = []
  const stops = []
  let refuseAfter = 1 // the server places the first and refuses the rest (one open at a time, its limits...)
  io.api = async (path, opts) => {
    if (path === '/api/scanner-log/day') { io.posted.push(opts.body); return {} }
    if (path === '/api/scanner-runner/live/NIFTY/order') {
      orders.push(opts.body)
      if (orders.length > refuseAfter) return { placed: false, message: 'a live NIFTY trade is still open - one at a time' }
      return { placed: true, message: 'placed', order: { success: true, orderIds: [`o${orders.length}`], lotSize: 65, prices: { limit: opts.body.strike > 0 ? 101.5 : 0 } } }
    }
    if (path === '/api/scanner-runner/live/NIFTY/exit') { exits.push(opts.body); return { success: true } }
    if (path === '/api/scanner-runner/live/NIFTY/index-stop') { stops.push(opts.body); return {} }
    throw new Error(`unexpected ${path}`)
  }
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ alertIds: ALL_IDS, settings: { telegram: true, autoPaper: 'sell', paperLots: 2 }, live: { NIFTY: true } })
  await runDay(scanner, io, at(15), at(300))

  assert.ok(scanner.positions.length >= 2, 'several alerts')
  assert.equal(orders.length, scanner.positions.length, 'every alert asked once - the server decides')
  assert.equal(new Set(orders.map((o) => o.key)).size, orders.length, 'never the same signal twice')
  const first = orders[0]
  assert.ok(first.strategyId && first.key.startsWith(first.strategyId), 'the strategy is named, for the live-list check')
  // The index stop goes with the order (the server's own index SL check), and on the right side of the entry.
  const fired = scanner.memory.fired.find((x) => first.key.startsWith(`${x.id}-${x.t}`))
  assert.equal(first.indexStop, fired.stop)
  assert.equal(first.indexSide, fired.side)
  assert.equal(first.indexTarget, fired.target, 'and its index target - the server exits there too')
  // A trailed stop is only ever sent tighter than the last one sent.
  for (let i = 1; i < stops.length; i++) if (stops[i].key === stops[i - 1].key) assert.ok(fired.side === 'LONG' ? stops[i].stop > stops[i - 1].stop : stops[i].stop < stops[i - 1].stop)
  assert.ok(first.expiry && first.strike > 0 && ['CE', 'PE'].includes(first.side) && first.action === 'SELL' && first.stopLossPoints > 0 && first.targetPoints > 0 && first.exitAtMs > 0, JSON.stringify(first))
  assert.equal(first.lots, 2, 'the lots go with the order - the index\'s here (no lot size of its own)')
  const live = scanner.positions.filter((p) => p.live)
  assert.equal(live.length, 1)
  assert.deepEqual(live[0].orderIds, ['o1'])
  assert.equal(live[0].lotSize, 65, "the contract's lot size from Dhan")
  assert.equal(live[0].premium, 101.5, 'the price the order went at')
  assert.ok(io.telegrams.some((m) => m.startsWith(`${TAG} LIVE order placed: SELL NIFTY`)))
  assert.ok(io.telegrams.some((m) => m.includes('LIVE order NOT placed') && m.includes('one at a time')), 'a refused order says why')
  // Its exit went to the server once, with the P&L.
  const closed = scanner.status().trades.find((r) => r.key === live[0].key)
  assert.ok(closed?.exitTime, 'the live trade closed during the day')
  assert.equal(exits.filter((e) => e.key === live[0].key).length, 1)
  assert.ok(Number.isFinite(exits[0].pnl) && exits[0].reason)
  assert.ok(io.telegrams.some((m) => m.startsWith(`${TAG} LIVE exit`)))
  // A restart: nothing is asked again.
  const asked = orders.length
  const sentExits = exits.length
  const again = new IndexScanner('NIFTY', io)
  again.reset(DATE)
  again.restore(await io.loadState('NIFTY', DATE))
  again.setConfig({ alertIds: ALL_IDS, settings: { telegram: true, autoPaper: 'sell', paperLots: 2 }, live: { NIFTY: true } })
  await runDay(again, io, at(300), at(301))
  assert.equal(orders.length, asked)
  assert.equal(exits.length, sentExits)
  refuseAfter = 99
})

test('two signals at once: the one higher on the live list goes first (it gets the open slot)', () => {
  const fresh = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  assert.deepEqual(byLiveList(fresh, ['c', 'a']).map((s) => s.id), ['c', 'a', 'b', 'd'])
  assert.deepEqual(byLiveList(fresh, null).map((s) => s.id), ['a', 'b', 'c', 'd'], 'paper: as they came')
})

test('on paper (not switched to Live) the scanner never asks for a live order', async () => {
  const io = fakeIo() // its api throws on anything but the scanner log
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell' }, live: { NIFTY: false, BANKNIFTY: true } })
  await runDay(scanner, io, at(15), at(300))
  assert.ok(scanner.positions.length > 0)
  assert.ok(scanner.positions.every((p) => !p.live))
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

test('a new Max SL reaches the open strategy trades from that minute', async () => {
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

test('the Top 15 from the scanner log\'s signals', () => {
  const csv = ['key,date,underlying,strategy_id,status,r', 'a,d,NIFTY,wallBreak,win,2', 'b,d,NIFTY,wallBreak,loss,-1', 'c,d,NIFTY,buildUp,open,'].join('\n')
  const top = topFromSignalsCsv(csv)
  assert.ok(top.ids.length > 0)
  assert.deepEqual(topFromSignalsCsv('').ids, topFromSignalsCsv(null).ids)
  // The pages' record and the server scanner's own together; a signal in both (same index, strategy, minute) counts once.
  const head = 'key,date,underlying,time_ist,strategy_id,status,r'
  const page = [head, 'p1,d,NIFTY,2026-10-12 10:15:00,wallBreak,win,2'].join('\n')
  const own = [head, 's1,d,NIFTY,2026-10-12 10:15:20,wallBreak,win,2', 's2,d,NIFTY,2026-10-12 11:00:00,wallBreak,loss,-1'].join('\n')
  assert.deepEqual(topFromSignalsCsv([page, own]), topFromSignalsCsv([[head, 'p1,d,NIFTY,2026-10-12 10:15:00,wallBreak,win,2', 's2,d,NIFTY,2026-10-12 11:00:00,wallBreak,loss,-1'].join('\n')]))
  assert.deepEqual(topFromSignalsCsv([null, own]).ids, topFromSignalsCsv(own).ids)
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

test('a strategy tuned to BUY its option: the server scanner trades that - unless a side was chosen, which wins', async () => {
  // What "Apply to the scanner" writes for one strategy, and who decides when it fires. The server scanner runs on
  // 'strategy' (nobody is there to choose); the Order Flow page sends its own 'buy' / 'sell', which always wins.
  const io = fakeIo()
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell', paperSl: 20, paperTarget: 30, paperLots: 1 }, levels: { NIFTY: MAX_20_30 } })
  await runDay(scanner, io, at(15), at(300))
  const sold = scanner.positions
  assert.ok(sold.length, 'the scanner traded')
  assert.ok(sold.every((p) => p.action === 'SELL' && p.slPts === 20 && p.targetPts === 30))

  const id = sold[0].strategy
  const tunedToBuy = { [id]: { tradeOptLeg: 'buy', tradeOptMoneyness: -1, tradeOptSlPct: 25, tradeOptTargetPct: 50 } }
  const run = async (autoPaper) => {
    const s = new IndexScanner('NIFTY', fakeIo())
    s.reset(DATE)
    s.setConfig({ alertIds: ALL_IDS, settings: { autoPaper, paperSl: 20, paperTarget: 30, paperLots: 1, filters: tunedToBuy }, levels: { NIFTY: MAX_20_30 } })
    await runDay(s, fakeIo(), at(15), at(300))
    return s.positions
  }

  // Left to the strategies: this one buys, 1 out of the money, with its own SL / target off the premium paid - held to
  // NIFTY's max rules (Max SL 20 / Max target 30, set here).
  const mine = (await run('strategy')).filter((p) => p.strategy === id)
  const others = (await run('strategy')).filter((p) => p.strategy !== id)
  assert.ok(mine.length && mine.every((p) => p.action === 'BUY'), 'the tuned strategy buys')
  for (const p of mine) {
    assert.ok(Math.abs(p.slPts - Math.min(p.premium * 0.25, 20)) < 1e-6, `SL is 25% of the ${p.premium} premium, at most 20 - not ${p.slPts}`)
    assert.ok(Math.abs(p.targetPts - Math.min(p.premium * 0.5, 30)) < 1e-6)
  }
  assert.ok(others.every((p) => p.action === 'SELL' && p.slPts === 20), 'a strategy with no setting of its own still sells')

  // A side chosen where the trading happens is the last word - the tuned BUY does not override it.
  const chosen = (await run('sell')).filter((p) => p.strategy === id)
  assert.ok(chosen.length && chosen.every((p) => p.action === 'SELL'), 'the chosen side wins over the strategy')
})

test('a strategy applied on an index, or on its live list, is traded there even when it is not in the alert list', async () => {
  const probe = new IndexScanner('NIFTY', fakeIo())
  probe.reset(DATE)
  probe.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell' } })
  await runDay(probe, fakeIo(), at(15), at(300))
  const id = probe.positions[0]?.strategy
  assert.ok(id, 'the scanner traded')
  const traded = async (config) => {
    const io = fakeIo()
    const scanner = new IndexScanner('NIFTY', io)
    scanner.reset(DATE)
    scanner.setConfig({ alertIds: [], settings: { autoPaper: 'sell' }, ...config })
    await runDay(scanner, io, at(15), at(300))
    return scanner.positions.filter((p) => p.strategy === id).length
  }
  assert.equal(await traded({}), 0, 'not alerted, not applied: signals only')
  assert.ok(await traded({ filtersByIndex: { NIFTY: { [id]: { tradeSide: 'both' } } } }) > 0, 'applied on NIFTY: traded')
  assert.equal(await traded({ filtersByIndex: { BANKNIFTY: { [id]: { tradeSide: 'both' } } } }), 0, 'applied on another index only: not here')
  assert.ok(await traded({ liveList: { NIFTY: [id] } }) > 0, 'on NIFTY\'s live list: traded (paper until Live today)')
  assert.equal(await traded({ settings: { autoPaper: 'sell', filters: { [id]: { tradeSide: 'both' } } } }), 0, 'a futures strategy\'s all-index filters alone do not make it traded')
})

test('a setting applied for ONE index (the tuning pages\' Apply): that index trades with it, the others keep theirs', async () => {
  // What a NIFTY-tuned "buy 1 OTM, SL 25% / target 50%" applied from the Trades page writes: config.filtersByIndex.NIFTY.
  const probe = new IndexScanner('NIFTY', fakeIo())
  probe.reset(DATE)
  probe.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'strategy', paperSl: 20, paperTarget: 30, paperLots: 1 } })
  await runDay(probe, fakeIo(), at(15), at(300))
  const id = probe.positions[0]?.strategy
  assert.ok(id, 'the scanner traded')
  const config = {
    alertIds: ALL_IDS,
    // The all-index filters still say "sell" for it; the NIFTY one replaces them on NIFTY only.
    settings: { autoPaper: 'strategy', paperSl: 20, paperTarget: 30, paperLots: 1, filters: { [id]: { tradeOptLeg: 'sell' } } },
    filtersByIndex: { NIFTY: { [id]: { tradeOptLeg: 'buy', tradeOptMoneyness: -1, tradeOptSlPct: 25, tradeOptTargetPct: 50 } } },
    levels: { NIFTY: MAX_20_30 },
  }
  const run = async (u) => {
    const s = new IndexScanner(u, fakeIo())
    s.reset(DATE)
    s.setConfig(config)
    assert.deepEqual(s.settings().filters[id], u === 'NIFTY' ? config.filtersByIndex.NIFTY[id] : config.settings.filters[id])
    await runDay(s, fakeIo(), at(15), at(300))
    return s.positions.filter((p) => p.strategy === id)
  }
  const nifty = await run('NIFTY')
  assert.ok(nifty.length && nifty.every((p) => p.action === 'BUY' && Math.abs(p.slPts - Math.min(p.premium * 0.25, 20)) < 1e-6 && Math.abs(p.targetPts - Math.min(p.premium * 0.5, 30)) < 1e-6),
    'NIFTY buys with the SL / target it was tuned to (within its max rules)')
  // The same strategy on another index: its all-index filters (the scanner settings), not NIFTY's.
  const other = new IndexScanner('BANKNIFTY', fakeIo())
  other.setConfig(config)
  assert.deepEqual(other.settings().filters[id], { tradeOptLeg: 'sell' })
  // Nothing applied per index: exactly the all-index filters, as before.
  other.setConfig({ ...config, filtersByIndex: undefined })
  assert.deepEqual(other.settings().filters, config.settings.filters)
})

test('a strategy applied to an index WITH a lot size: its paper and live trades there take that many lots, the rest the index\'s', async () => {
  const probe = new IndexScanner('NIFTY', fakeIo())
  probe.reset(DATE)
  probe.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell', paperSl: 20, paperTarget: 30 } })
  await runDay(probe, fakeIo(), at(15), at(300))
  const id = probe.positions[0]?.strategy
  assert.ok(id)
  const orders = []
  const io = fakeIo()
  io.api = async (path, opts) => {
    if (path === '/api/scanner-runner/live/NIFTY/order') { orders.push(opts.body); return { placed: true, message: 'placed', order: { success: true, orderIds: [`o${orders.length}`], lotSize: 65 } } }
    return {}
  }
  const s = new IndexScanner('NIFTY', io)
  s.reset(DATE)
  // The index trades 2 lots (Trade settings); this strategy was applied to NIFTY with 5.
  s.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell', paperSl: 20, paperTarget: 30 }, trade: { NIFTY: { lots: 2 } }, live: { NIFTY: true },
    filtersByIndex: { NIFTY: { [id]: { tradeSide: 'both', _lots: 5 } } } })
  await runDay(s, io, at(15), at(300))
  const mine = s.positions.filter((p) => p.strategy === id)
  const others = s.positions.filter((p) => p.strategy !== id)
  assert.ok(mine.length && mine.every((p) => p.lots === 5), JSON.stringify(mine.map((p) => p.lots)))
  assert.ok(others.every((p) => p.lots === 2), 'every other strategy: the index\'s lots')
  assert.ok(orders.filter((o) => o.strategyId === id).every((o) => o.lots === 5) && orders.filter((o) => o.strategyId !== id).every((o) => o.lots === 2), JSON.stringify(orders.map((o) => [o.strategyId, o.lots])))
  // The lot size never reaches the strategy's filters (the scanner reads only real ones).
  assert.equal(strategyFilters(id, s.settings().filters[id])._lots, undefined)
})

test('every strategy trades its own exit - never the manual SL / target / trail - held to the max rules, paper and live', async () => {
  const probe = new IndexScanner('NIFTY', fakeIo())
  probe.reset(DATE)
  probe.setConfig({ alertIds: ALL_IDS, settings: { autoPaper: 'sell' } })
  await runDay(probe, fakeIo(), at(15), at(300))
  const ids = [...new Set(probe.positions.map((p) => p.strategy))]
  assert.ok(ids.length >= 2, ids.join(', '))
  const [withIndex, optionOnly] = ids
  const orders = []
  const io = fakeIo()
  io.api = async (path, opts) => {
    if (path === '/api/scanner-runner/live/NIFTY/order') { orders.push(opts.body); return { placed: true, message: 'placed', order: { success: true, orderIds: [`o${orders.length}`], lotSize: 65 } } }
    return {}
  }
  const s = new IndexScanner('NIFTY', io)
  s.reset(DATE)
  // A manual trade's SL 20 / target 30 / trail 3 after +5 - and no max rules: nothing of the index holds the strategies.
  // One tuned out with the index trade; one with only its own SL / target (else 15:10); the rest untouched.
  const config = { alertIds: ALL_IDS, settings: { autoPaper: 'strategy' }, live: { NIFTY: true }, levels: { NIFTY: { sl: 20, target: 30, trailStart: 5, trailGap: 3, maxSl: 0, maxTarget: 0 } },
    filtersByIndex: { NIFTY: { [withIndex]: { tradeOptLeg: 'sell', tradeOptExit: 'index', _tuned: 'a' }, [optionOnly]: { tradeOptLeg: 'sell', tradeOptExit: 'option', tradeOptSlPct: 20, tradeOptTargetPct: 30, _tuned: 'b' } } } }
  s.setConfig(config)
  await runDay(s, io, at(15), at(150))
  const a = s.positions.filter((p) => p.strategy === withIndex)
  const b = s.positions.filter((p) => p.strategy === optionOnly)
  const plain = s.positions.filter((p) => p.strategy !== withIndex && p.strategy !== optionOnly)
  assert.ok(a.length && a.every((p) => p.optExit === 'index' && p.slPts === null && p.targetPts === null && p.trailGap === 0), JSON.stringify(a))
  assert.ok(b.length && b.every((p) => p.optExit === 'option' && Math.abs(p.slPts - p.premium * 0.2) < 1e-9 && Math.abs(p.targetPts - p.premium * 0.3) < 1e-9 && p.trailGap === 0))
  assert.ok(plain.every((p) => p.optExit === 'index' && p.slPts === null && p.targetPts === null && p.trailGap === 0), 'the rest: out with the index trade too - not the manual 20 / 30 / trail')
  // Live: no option trailing stop; no level at all = safety legs at the signal's own index distance.
  const fired = (key) => s.memory.fired.find((f) => key.startsWith(`${f.id}-${f.t}-`))
  assert.ok(orders.length && orders.every((o) => o.trailStartPoints === 0 && o.trailGapPoints === 0), JSON.stringify(orders.map((o) => o.trailGapPoints)))
  for (const o of orders.filter((x) => x.strategyId !== optionOnly)) {
    const sig = fired(o.key)
    assert.ok(Math.abs(o.stopLossPoints - Math.abs(sig.entry - sig.stop)) < 1e-9 && Math.abs(o.targetPoints - Math.abs(sig.target - sig.entry)) < 1e-9, JSON.stringify(o))
    assert.equal(o.indexStop, sig.stop, 'the server still watches its index stop')
  }
  for (const o of orders.filter((x) => x.strategyId === optionOnly)) {
    assert.equal(o.indexStop, undefined, 'its own option exit only: no index stop to watch')
    assert.equal(o.exitAtMs, squareOffMs(fired(o.key).t), 'closed at 15:10, not at the signal\'s time stop')
  }
  // Max rules set now: the open strategy trades are held to them from this minute; a manual SL change touches nothing.
  const openBefore = s.status().trades.filter((r) => !r.exitTime).map((r) => r.key)
  s.setConfig({ ...config, levels: { NIFTY: { sl: 5, target: 30, trailStart: 5, trailGap: 3, maxSl: 40, maxTarget: 0 } } })
  assert.ok(openBefore.length, 'a strategy trade was open')
  for (const key of openBefore) {
    const p = s.positions.find((x) => x.key === key)
    assert.equal(p.slPts, p.ownSlPts > 0 ? Math.min(p.ownSlPts, 40) : 40, key)
    // Changed (it had no SL of its own, or a wider one): from this minute, in its levelLog; else left as it was.
    assert.equal(p.levelLog?.length ?? 0, p.ownSlPts > 0 && p.ownSlPts <= 40 ? 0 : 2)
  }
})

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
