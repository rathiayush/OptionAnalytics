// The Signal backtest (signalBacktest.js): a day's features from data up to each minute only (nothing after it), each
// strategy firing on its rule and not without it, the option trade (BUY / SELL, stop before target, a gap through the
// stop, the time stop, the 15:10 square-off) and the report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import {
  BACKTEST_DEFAULTS, SIGNAL_STRATEGIES, SIGNAL_STRATEGY_IDS, istMinute, optionFor, prepareDay, simulateDay, simulateTrade, summarize, tradesCsv,
} from '../src/signalBacktest.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const strategy = (id) => SIGNAL_STRATEGIES.find((s) => s.id === id)

// A prepared day built by hand: `n` minutes from 09:15, everything flat unless given.
function fakeDay({ n = 360, spot = () => 25000, price = null, vwap = () => 24990, oi = () => ({ ce: 0, pe: 0 }), walls = () => ({ support: null, resistance: null }),
  gex = () => null, straddle = () => null, profile = () => null, ib = null, breaks = [], hp = [], netCum = () => NaN, straddleWidth = 100, legs = {} } = {}) {
  const t = Array.from({ length: n }, (_, i) => T915 + i * MIN)
  const bar = (f) => Array.from({ length: n }, (_, i) => f(i))
  const sp = (i) => (typeof spot(i) === 'number' ? { o: spot(i), h: spot(i), l: spot(i), c: spot(i) } : spot(i))
  const pr = price ?? sp
  const pack = (f) => {
    const a = new Float64Array(n * 4).fill(NaN)
    for (let i = 0; i < n; i++) { const b = f(i); if (b) { a[i * 4] = b.o; a[i * 4 + 1] = b.h; a[i * 4 + 2] = b.l; a[i * 4 + 3] = b.c } }
    return a
  }
  const side = (key) => new Map(Object.entries(legs[key] ?? {}).map(([k, f]) => [Number(k), pack(f)]))
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: bar((i) => Math.round(sp(i).c / 50) * 50),
    spot: { o: bar((i) => sp(i).o), h: bar((i) => sp(i).h), l: bar((i) => sp(i).l), c: bar((i) => sp(i).c) },
    price: { o: bar((i) => pr(i).o), h: bar((i) => pr(i).h), l: bar((i) => pr(i).l), c: bar((i) => pr(i).c) },
    vwap: bar(vwap), oi: bar(oi), walls: bar(walls), gex: bar(gex), straddle: bar(straddle), profile: bar(profile), netCum: bar(netCum),
    ib, breaks, hp, straddleWidth, priceSource: 'futures', ce: side('ce'), pe: side('pe'),
  }
}
const flat = (v) => () => ({ o: v, h: v, l: v, c: v })

test('a day prepared from the OI Replay run: every feature for each minute, nothing after it', () => {
  const { run } = syntheticDay()
  const full = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  assert.equal(full.ok, true)
  assert.equal(full.n, 301)
  assert.equal(full.priceSource, 'futures')
  assert.ok(full.breaks.length > 0)
  assert.ok(full.ib && full.ib.done === 59)   // 10:14
  // The same day cut at 11:45 (minute 150): every feature of minutes 0 - 150 is the same - nothing after a minute counts.
  const cut = Date.parse('2026-10-05T11:45:00+05:30')
  const keep = (list) => list.filter((p) => Date.parse(p.time) <= cut)
  const part = prepareDay({
    ...run, optionExpiry: '2026-10-06', spotCandlesOneMinute: keep(run.spotCandlesOneMinute), futuresBars: keep(run.futuresBars), cePoints: keep(run.cePoints), pePoints: keep(run.pePoints),
  }, { underlying: 'NIFTY' })
  assert.equal(part.n, 151)
  for (let i = 0; i < part.n; i++) {
    for (const k of ['oi', 'walls', 'gex', 'straddle', 'profile']) assert.deepEqual(part[k][i], full[k][i], `${k} at ${i}`)
    for (const k of ['vwap', 'netCum', 'atm']) assert.deepEqual(part[k][i], full[k][i], `${k} at ${i}`)
  }
  assert.deepEqual(part.breaks, full.breaks.filter((b) => b.i < part.n))
  assert.deepEqual(part.hp, full.hp.filter((b) => b.i < part.n))
  assert.deepEqual(part.ib, full.ib)
  // And so are its signals and its trades' entries (the trades themselves run on to the day's end).
  const signalsOf = (d) => simulateDay(d, { lotSize: 65 }).signals.map((s) => [s.strategy, s.time, s.dir])
  assert.deepEqual(signalsOf(part), signalsOf(full).filter(([, time]) => time <= cut))
})

test('a day with too little to read is not run', () => {
  assert.equal(prepareDay({ spotCandlesOneMinute: [] }).ok, false)
  const { run } = syntheticDay()
  assert.equal(prepareDay({ ...run, cePoints: [], pePoints: [], step: 0 }).ok, false)
})

test('a signal trades the call / put: BUY in its direction, or SELL the other side; in / out of the money by a strike', () => {
  assert.deepEqual(optionFor(1, 'buy', 25000, 50), { side: 'CE', strike: 25000, action: 'BUY' })
  assert.deepEqual(optionFor(-1, 'buy', 25000, 50), { side: 'PE', strike: 25000, action: 'BUY' })
  assert.deepEqual(optionFor(1, 'sell', 25000, 50), { side: 'PE', strike: 25000, action: 'SELL' })
  assert.deepEqual(optionFor(-1, 'sell', 25000, 50), { side: 'CE', strike: 25000, action: 'SELL' })
  assert.equal(optionFor(1, 'buy', 25000, 50, 1).strike, 24950)    // ITM call: below spot
  assert.equal(optionFor(-1, 'buy', 25000, 50, 1).strike, 25050)   // ITM put: above spot
  assert.equal(optionFor(1, 'buy', 25000, 50, -1).strike, 25050)   // OTM call
  assert.equal(optionFor(1, 'sell', 25000, 50, -1).strike, 24950)  // OTM put sold
})

test('the trade: entered at the signal minute\'s close, managed from the next minute - stop before target, a gap through the stop at the open', () => {
  const opts = { slPct: 20, targetPct: 40 }
  const at = (bars) => fakeDay({ n: 20, legs: { ce: { 25000: (i) => bars[i] ?? { o: 100, h: 100, l: 100, c: 100 } } } })
  const buy = { side: 'CE', strike: 25000, action: 'BUY' }
  // Minute 1 reaches both the stop (80) and the target (140): the stop first.
  let tr = simulateTrade(at({ 0: { o: 100, h: 100, l: 100, c: 100 }, 1: { o: 100, h: 150, l: 70, c: 120 } }), 0, buy, opts)
  assert.deepEqual([tr.entry, tr.exit, tr.exitReason, tr.exitIndex], [100, 80, 'Stop', 1])
  // The signal minute's own range is never read: a stop-like low IN minute 0 does nothing.
  tr = simulateTrade(at({ 0: { o: 100, h: 100, l: 50, c: 100 }, 2: { o: 100, h: 145, l: 95, c: 140 } }), 0, buy, opts)
  assert.deepEqual([tr.exit, tr.exitReason, tr.exitIndex], [140, 'Target', 2])
  // A bar opening below the stop fills at its open.
  tr = simulateTrade(at({ 3: { o: 60, h: 65, l: 55, c: 62 } }), 0, buy, opts)
  assert.deepEqual([tr.exit, tr.exitReason], [60, 'Stop (opened through it)'])
  // SOLD: the stop is above (premium rising), the target below; points are entry - exit.
  const sell = { side: 'CE', strike: 25000, action: 'SELL' }
  tr = simulateTrade(at({ 4: { o: 100, h: 110, l: 58, c: 70 } }), 0, sell, opts)
  assert.deepEqual([tr.exit, tr.exitReason, tr.points], [60, 'Target', 40])
  tr = simulateTrade(at({ 4: { o: 100, h: 125, l: 90, c: 110 } }), 0, sell, opts)
  assert.deepEqual([tr.exit, tr.exitReason, tr.points], [120, 'Stop', -20])
  // No premium at the signal minute (or within 5 before it): no trade.
  assert.equal(simulateTrade(fakeDay({ n: 20 }), 0, buy, opts), null)
})

test('the trade: the time stop and the 15:10 square-off at the bar\'s close', () => {
  const d = fakeDay({ legs: { ce: { 25000: (i) => ({ o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i }) } } })
  const buy = { side: 'CE', strike: 25000, action: 'BUY' }
  let tr = simulateTrade(d, 10, buy, { slPct: 90, targetPct: 900, timeStopMin: 15 })
  assert.deepEqual([tr.exitIndex, tr.exit, tr.exitReason], [25, 125, 'Time stop 15 min'])
  tr = simulateTrade(d, 10, buy, { slPct: 90, targetPct: 900 })
  assert.equal(istMinute(d.t[tr.exitIndex]), 15 * 60 + 10)
  assert.equal(tr.exitReason, '15:10 square-off')
  assert.equal(tr.exit, 100 + tr.exitIndex)
})

test('OI since open: put writing ahead with price over VWAP is bullish - from 09:45, once, and not against VWAP', () => {
  const oi = (i) => (i >= 20 ? { ce: 1e6, pe: 3e6 } : { ce: 0, pe: 0 })
  const fires = strategy('dayOi').signals(fakeDay({ oi, spot: () => 25000, vwap: () => 24990 }))
  assert.deepEqual(fires.map((s) => [s.i, s.dir]), [[30, 1]])   // 09:45 - not at 09:35 when it first held
  assert.deepEqual(strategy('dayOi').signals(fakeDay({ oi, vwap: () => 25010 })), [])        // price under VWAP
  assert.deepEqual(strategy('dayOi').signals(fakeDay({ oi: () => ({ ce: 2e6, pe: 2.2e6 }) })), [])   // bias 5%: not enough
  const bear = strategy('dayOi').signals(fakeDay({ oi: () => ({ ce: 3e6, pe: 1e6 }), vwap: () => 25010 }))
  assert.deepEqual(bear.map((s) => s.dir), [-1])
})

test('cumulative Δ and 🎯: a break is a signal only with price on its side of VWAP; the 🎯 signal as it comes', () => {
  const breaks = [{ i: 40, dir: 1, text: 'PE broke resistance' }, { i: 60, dir: -1, text: 'CE broke resistance' }]
  const d = fakeDay({ breaks, hp: [{ i: 70, dir: -1, text: '🎯' }] })
  assert.deepEqual(strategy('cumDelta').signals(d).map((s) => [s.i, s.dir]), [[40, 1]])   // the bearish one has price over VWAP
  assert.deepEqual(strategy('hp').signals(d).map((s) => [s.i, s.dir]), [[70, -1]])
})

test('OI wall bounce: a touch of the support closing up and back above it; nothing when it closes down', () => {
  const walls = () => ({ support: 24900, resistance: 25200 })
  const spot = (i) => (i === 50 ? { o: 24905, h: 24920, l: 24895, c: 24915 } : { o: 25000, h: 25000, l: 25000, c: 25000 })
  assert.deepEqual(strategy('oiWalls').signals(fakeDay({ walls, spot })).map((s) => [s.i, s.dir]), [[50, 1]])
  const down = (i) => (i === 50 ? { o: 24915, h: 24920, l: 24895, c: 24905 } : { o: 25000, h: 25000, l: 25000, c: 25000 })
  assert.deepEqual(strategy('oiWalls').signals(fakeDay({ walls, spot: down })), [])
  const reject = (i) => (i === 80 ? { o: 25195, h: 25205, l: 25180, c: 25185 } : { o: 25100, h: 25100, l: 25100, c: 25100 })
  assert.deepEqual(strategy('oiWalls').signals(fakeDay({ walls, spot: reject })).map((s) => [s.i, s.dir]), [[80, -1]])
})

test('GEX: short gamma - through a wall with it; long gamma - faded at the wall', () => {
  const through = (i) => (i < 100 ? flat(25040)() : flat(25060)())
  const short = fakeDay({ spot: through, gex: () => ({ net: -1e9, callWall: 25050, putWall: 24900 }) })
  assert.deepEqual(strategy('gex').signals(short).map((s) => [s.i, s.dir]), [[100, 1]])
  const long = fakeDay({ spot: through, gex: () => ({ net: 1e9, callWall: 25050, putWall: 24900 }) })
  assert.deepEqual(strategy('gex').signals(long), [])   // long gamma: a close through is no signal
  const fade = (i) => (i === 120 ? { o: 25045, h: 25052, l: 25030, c: 25035 } : flat(25000)())
  assert.deepEqual(strategy('gex').signals(fakeDay({ spot: fade, gex: () => ({ net: 1e9, callWall: 25050, putWall: 24900 }) })).map((s) => [s.i, s.dir]), [[120, -1]])
})

test('VWAP cross: two closes on the new side', () => {
  const price = (i) => flat(i < 100 ? 24980 : 25020)()
  assert.deepEqual(strategy('vwap').signals(fakeDay({ price, vwap: () => 25000 })).map((s) => [s.i, s.dir]), [[101, 1]])
  // One close over it is no bullish signal (back under it for two closes is the bearish one).
  const blip = (i) => flat(i === 100 ? 25020 : 24980)()
  assert.deepEqual(strategy('vwap').signals(fakeDay({ price: blip, vwap: () => 25000 })).filter((s) => s.dir > 0), [])
})

test('straddle expansion: over its VWAP 3 minutes with the futures moving a quarter of the priced range', () => {
  const st = (rise) => (i) => ({ value: 120, vwap: 110, decay: 100, forward: 25000 + (i >= 40 ? (i - 40) * rise : 0) })
  assert.deepEqual(strategy('straddle').signals(fakeDay({ straddle: st(2) })).map((s) => [s.i, s.dir]).slice(0, 1), [[53, 1]])  // +26 > 25 by minute 53
  // A slower move - 15 points in 15 minutes, under a quarter of the 100-point range: nothing.
  assert.deepEqual(strategy('straddle').signals(fakeDay({ straddle: st(1) })), [])
  // Under its VWAP (premium melting): no buying signal however far the futures move.
  assert.deepEqual(strategy('straddle').signals(fakeDay({ straddle: (i) => ({ ...st(2)(i), value: 100 }) })), [])
})

test('IB / value-area breakout: two closes over the IB high and over the POC, after the IB', () => {
  const ib = { high: 25050, low: 24950, done: 59 }
  const price = (i) => flat(i < 90 ? 25000 : 25060)()
  assert.deepEqual(strategy('profile').signals(fakeDay({ ib, price, profile: () => ({ poc: 25010, vah: 25040, val: 24980 }) })).map((s) => [s.i, s.dir]), [[91, 1]])
  // Over the IB high but under the POC: no.
  assert.deepEqual(strategy('profile').signals(fakeDay({ ib, price, profile: () => ({ poc: 25080, vah: 25100, val: 25000 }) })), [])
})

test('confluence: all four directions agree, and the gates follow the mode - buying needs short gamma, selling long', () => {
  const base = {
    oi: () => ({ ce: 1e6, pe: 3e6 }), netCum: () => -5e5, walls: () => ({ support: 24900, resistance: 25200 }), vwap: () => 24990,
    straddle: () => ({ value: 120, vwap: 110, decay: 100, forward: 25000 }),
  }
  const shortGamma = fakeDay({ ...base, gex: () => ({ net: -1, callWall: 25200, putWall: 24900 }) })
  assert.deepEqual(strategy('confluence').signals(shortGamma, { mode: 'buy' }).map((s) => [s.i, s.dir]), [[30, 1]])
  assert.deepEqual(strategy('confluence').signals(shortGamma, { mode: 'sell' }), [])   // selling needs long gamma
  const longGamma = fakeDay({ ...base, gex: () => ({ net: 1, callWall: 25200, putWall: 24900 }), straddle: () => ({ value: 100, vwap: 110, decay: 90, forward: 25000 }) })
  assert.deepEqual(strategy('confluence').signals(longGamma, { mode: 'sell' }).map((s) => s.dir), [1])
  // One direction against (price under VWAP): nothing.
  assert.deepEqual(strategy('confluence').signals(fakeDay({ ...base, vwap: () => 25010, gex: () => ({ net: -1 }) }), { mode: 'buy' }), [])
})

test('a day\'s trades: entries 09:30 - 14:45, one at a time per strategy, a cooldown after it, at most N a day', () => {
  // Price crossing VWAP back and forth every 20 minutes: a VWAP signal every 20 minutes all day.
  const price = (i) => flat(Math.floor(i / 20) % 2 ? 25020 : 24980)()
  const legs = { ce: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) }, pe: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) } }
  const d = fakeDay({ price, vwap: () => 25000, legs })
  const { trades, signals } = simulateDay(d, { strategies: ['vwap'], timeStopMin: 5, cooldownMin: 10, maxTradesPerDay: 3, lotSize: 65, charges: false })
  assert.equal(trades.length, 3)
  for (const tr of trades) {
    const m = istMinute(tr.entryTime)
    assert.ok(m >= 9 * 60 + 30 && m <= 14 * 60 + 45)
    assert.equal(tr.exitReason, 'Time stop 5 min')
    assert.equal(tr.net, tr.gross)
  }
  for (let k = 1; k < trades.length; k++) assert.ok(trades[k].entryTime >= trades[k - 1].exitTime + 10 * MIN)
  assert.ok(signals.some((s) => /outside/.test(s.skipped ?? '')))     // the 09:16 one
  assert.ok(signals.some((s) => /already today/.test(s.skipped ?? '')))
})

test('the synthetic day end to end: every trade enters after its signal minute\'s data and exits later; buy and sell both run', () => {
  const { run } = syntheticDay()
  const d = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  for (const mode of ['buy', 'sell']) {
    const { trades } = simulateDay(d, { mode, lotSize: 65 })
    assert.ok(trades.length > 0, mode)
    for (const tr of trades) {
      assert.ok(tr.exitTime > tr.entryTime)
      assert.equal(tr.action, mode === 'sell' ? 'SELL' : 'BUY')
      assert.ok(Math.abs(tr.gross - tr.points * 65) < 1e-6)
      assert.ok(tr.net < tr.gross)   // charges taken
    }
  }
  assert.deepEqual(SIGNAL_STRATEGY_IDS, SIGNAL_STRATEGIES.map((s) => s.id))
  assert.equal(BACKTEST_DEFAULTS.mode, 'buy')
})

test('the report: win rate, profit factor, drawdown, expectancy; the CSV', () => {
  const tr = (date, minute, net, points = net / 65) => ({ date, entryTime: T915 + minute * MIN, net, gross: net, charges: 0, points, holdMin: 10 })
  const s = summarize([tr('2026-10-05', 10, 1000), tr('2026-10-05', 40, -500), tr('2026-10-06', 10, -700), tr('2026-10-06', 50, 2000)])
  assert.equal(s.trades, 4)
  assert.equal(s.winRate, 50)
  assert.equal(s.net, 1800)
  assert.equal(s.profitFactor, 3000 / 1200)
  assert.equal(s.maxDrawdown, 1200)            // 1000 -> 500 -> -200
  assert.equal(s.expectancy, 450)
  assert.deepEqual([s.days, s.winningDays], [2, 2])   // +500 and +1300
  assert.deepEqual(summarize([]).trades, 0)
  const csv = tradesCsv([{ ...tr('2026-10-05', 30, 500), strategy: 'vwap', dir: 1, action: 'BUY', strike: 25000, side: 'CE', entry: 100, exit: 110, exitTime: T915 + 40 * MIN, exitReason: 'Target', why: '=cmd, "quoted"' }])
  const [head, row] = csv.split('\n')
  assert.match(head, /^date,strategy,signal,action/)
  assert.match(row, /^2026-10-05,VWAP cross,bullish,BUY,25000 CE,09:45,100.00,09:55,110.00,Target/)
  assert.match(row, /"'=cmd, ""quoted"""$/)  // formula-safe and quoted
})

test('the days a backtest runs: weekdays in the range, before today, the latest 60 at most', async () => {
  const { backtestDays } = await import('../src/signalBacktest.js')
  assert.deepEqual(backtestDays('2026-10-23', '2026-10-28', '2026-10-31'), ['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28'])
  assert.deepEqual(backtestDays('2026-10-29', '2026-11-03', '2026-10-31'), ['2026-10-29', '2026-10-30'])   // today and after: not run
  assert.equal(backtestDays('2026-01-01', '2026-10-30', '2026-10-31').length, 60)
  assert.equal(backtestDays('2026-01-01', '2026-10-30', '2026-10-31').at(-1), '2026-10-30')
  assert.deepEqual(backtestDays(null, '2026-10-30', '2026-10-31'), [])
})
