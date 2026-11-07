// SAVED STRATEGIES SCANNED LIVE (signalLive.js, scanner-runner/signal-live.mjs): today read only to the minutes completed
// at the clock, the same trades a backtest of the whole day gives up to then (entries at once, an exit only once it has
// happened, a trade still running open), each event keyed so it goes out once, the day's report when the session is
// over - and the loop, against a fake server as the server runs it: the events and the report it posts, nothing outside
// the session, a day it cannot read backed off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { day as syntheticDay } from './synthetic-day.mjs'
import { prepareDay, simulateDay } from '../src/signalBacktest.js'
import { cleanBacktestSettings, engineSettings } from '../src/signalBacktestJob.js'
import { completedRun, dayRecord, dayReportText, istClock, liveDayEvents, liveRunUrl, liveTrade, prepareLiveDay, tradeRow } from '../src/signalLive.js'

const { run } = syntheticDay()          // 2026-10-05, 09:15 - 14:15
const DATE = '2026-10-05'
const MIN = 60_000
const at = (hhmm) => Date.parse(`${DATE}T${hhmm}:00+05:30`)
const SETTINGS = cleanBacktestSettings({
  underlying: 'NIFTY', rule: { tree: { op: 'and', not: false, items: [{ line: { id: 'vwap', value: 'crossedAbove', windowMin: 5 } }] }, action: 'buyCE', mirror: true },
  maxTradesPerDay: 6, cooldownMin: 0, timeStopMin: 30,
})
const ENGINE = engineSettings(SETTINGS)
const full = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
const fullTrades = simulateDay(full, ENGINE).trades

test('today is read to the minutes COMPLETED at the clock - the one still forming never counts', () => {
  const cut = completedRun(run, at('10:00') + 30_000)            // 10:00:30 - the 10:00 minute is still forming
  const last = (list) => Date.parse(list.at(-1).time)
  assert.equal(last(cut.spotCandlesOneMinute), at('09:59'))
  assert.equal(last(cut.futuresBars), at('09:59'))
  assert.ok(cut.cePoints.every((p) => Date.parse(p.time) <= at('09:59')) && cut.pePoints.every((p) => Date.parse(p.time) <= at('09:59')))
  assert.equal(last(completedRun(run, at('10:01')).spotCandlesOneMinute), at('10:00'))
  assert.equal(prepareLiveDay(run, { underlying: 'NIFTY', nowMs: at('09:19') }).ok, false)   // 4 minutes: not yet
  assert.equal(prepareLiveDay(run, { underlying: 'NIFTY', nowMs: at('09:20') }).ok, true)    // 5: read
  assert.equal(liveRunUrl('NIFTY', DATE), `/api/oi-replay/NIFTY/run?date=${DATE}&timeframeMinutes=1&expiryFlag=WEEK&forceLive=true`)
  assert.deepEqual(istClock(at('15:31')), { date: DATE, minute: 15 * 60 + 31, weekday: 1 })
})

test('at any minute the live day is the backtest of the whole day so far: entries at once, exits once they happen, the rest open', () => {
  // The day's two trades: 11:27 - 11:57 and 13:44 - 14:14 (time stops) - read before, during and after each.
  assert.deepEqual(fullTrades.map((t) => [t.entryTime, t.exitTime]), [[at('11:27'), at('11:57')], [at('13:44'), at('14:14')]])
  const keysSeen = new Set()
  let openSeen = 0
  for (const hhmm of ['10:30', '11:40', '12:45', '13:50', '14:16']) {
    const nowMs = at(hhmm)
    const day = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs })
    const live = liveDayEvents(day, ENGINE, { name: 'VWAP cross', nowMs })
    const known = day.t.at(-1)                                      // the last completed minute
    // Every trade entered by then - with the same entry as the whole day's.
    const entered = fullTrades.filter((t) => t.entryTime <= known)
    assert.deepEqual(live.trades.map((t) => [t.strategy, t.entryTime, t.entry, t.strike, t.side]), entered.map((t) => [t.strategy, t.entryTime, t.entry, t.strike, t.side]), hhmm)
    // Closed: exactly the whole day's trades that had exited by then, exit and all.
    for (const t of live.closed) assert.deepEqual(t, fullTrades.find((f) => f.entryTime === t.entryTime && f.strategy === t.strategy), hhmm)
    assert.deepEqual(live.closed.map((t) => t.entryTime), entered.filter((t) => t.exitTime <= known && t.exitReason !== 'Day end').map((t) => t.entryTime), hhmm)
    // Open ones have no exit event yet.
    for (const t of live.open) assert.ok(!live.events.some((e) => e.key.endsWith(`|${t.entryTime}|exit`)))
    openSeen += live.open.length
    assert.equal(live.events.filter((e) => e.kind === 'entry').length, live.trades.length)
    assert.equal(live.events.filter((e) => e.kind === 'exit').length, live.closed.length)
    // A key once seen is the same later (so the server sends it once); later rounds only add.
    const keys = live.events.map((e) => e.key)
    for (const k of keysSeen) assert.ok(keys.includes(k), `${hhmm} lost ${k}`)
    keys.forEach((k) => keysSeen.add(k))
  }
  assert.equal(openSeen, 2)                                         // each trade read once while it was still running
  assert.equal(keysSeen.size, 4)                                     // two entries, two exits
})

test('when the session is over every trade is closed - the day\'s report and its record', () => {
  const day = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('15:35') })
  const live = liveDayEvents(day, ENGINE, { name: 'VWAP cross', complete: true, nowMs: at('15:35') })
  assert.equal(live.open.length, 0)
  assert.deepEqual(live.closed, fullTrades)
  const record = dayRecord(day, live)
  assert.equal(record.day.date, DATE)
  assert.equal(record.day.trades, fullTrades.length)
  assert.equal(record.trades.length, fullTrades.length)
  assert.equal(record.day.net, Math.round(fullTrades.reduce((a, t) => a + t.net, 0) * 100) / 100)
  // The server's Trades CSV columns (SignalStrategyStore.TradeColumns), each trade closed.
  assert.deepEqual(Object.keys(record.trades[0]).sort(), ['date', 'side', 'signal', 'action', 'option', 'entryTime', 'entry', 'sl', 'target', 'exitTime', 'exit', 'exitReason', 'points', 'gross', 'charges', 'net', 'expiryDay', 'why', 'status', 'key'].sort())
  assert.ok(record.trades.every((r) => r.status === 'closed'))
  const text = dayReportText('VWAP cross', day, live)
  assert.match(text, /^📊 VWAP cross · NIFTY · Mon 5 Oct/)
  assert.match(text, new RegExp(`${fullTrades.length} trades`))
  assert.match(text, /\nNet −?₹[\d,]+ after ₹[\d,]+ charges \(gross −?₹[\d,]+\)/)
  assert.equal(text.split('\n').filter((l) => /^\d+\. /.test(l)).length, fullTrades.length)
  assert.equal(live.dayLimit, null)
  assert.equal(record.day.limit, '')
  assert.doesNotMatch(text, /max (loss|profit) was reached/)
  // A day the strategy's own max loss / profit ended: its report says so, and the day ends with the trade that reached it.
  const first = fullTrades[0]
  const which = first.net >= 0 ? 'profit' : 'loss'
  const capped = engineSettings(cleanBacktestSettings({ ...SETTINGS, [which === 'profit' ? 'maxDayProfit' : 'maxDayLoss']: Math.abs(first.net) / 2 }))
  const limited = liveDayEvents(day, capped, { name: 'VWAP cross', complete: true, nowMs: at('15:35') })
  assert.equal(limited.dayLimit, which)
  assert.equal(limited.closed.length, 1)
  assert.equal(limited.closed[0].exitReason, `Day max ${which}`)
  assert.equal(dayRecord(day, limited).day.limit, which)                 // kept in the strategy's day history
  assert.match(dayReportText('VWAP cross', day, limited), new RegExp(`\\nThe day's max ${which} was reached - no more trades after it\\.`))
  // A day with no trade says so.
  const quiet = liveDayEvents(day, engineSettings(cleanBacktestSettings({ ...SETTINGS, rule: { tree: { op: 'and', not: false, items: [{ line: { id: 'ib', value: 'inside' } }] }, action: 'buyCE', mirror: false }, maxTradesPerDay: 1 })), { complete: true })
  assert.match(dayReportText('Quiet', day, { ...quiet, closed: [], trades: [], signals: 0, summary: { ...quiet.summary, trades: 0 } }), /No trades today\./)
  // A strategy set NOT to trade the expiry day: nothing sent on it, its report says why (not "no trades" / "not taken").
  const expiry = { ...day, isExpiry: true }
  const skipped = liveDayEvents(expiry, engineSettings(cleanBacktestSettings({ ...SETTINGS, expiryDay: 'skip' })), { complete: true, nowMs: at('15:35') })
  assert.deepEqual([skipped.trades.length, skipped.events.length, skipped.expirySkipped], [0, 0, true])
  assert.ok(skipped.signals > 0)
  const skipText = dayReportText('VWAP cross', expiry, skipped)
  assert.match(skipText, new RegExp(`\nExpiry day - not traded \\(the strategy's Expiry day setting\\); ${skipped.signals} signals? not taken\\.$`))
  assert.doesNotMatch(skipText, /No trades today|more signal/)
  // The same strategy on a day that is not the expiry trades as before.
  assert.deepEqual(liveDayEvents(day, engineSettings(cleanBacktestSettings({ ...SETTINGS, expiryDay: 'skip' })), { complete: true, nowMs: at('15:35') }).closed, fullTrades)
})

test('the texts: an entry (and "seen late" after a restart), an exit with its result', () => {
  const day = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('15:35') })
  const first = fullTrades[0]
  const onTime = liveDayEvents(day, ENGINE, { name: 'S', complete: true, nowMs: first.entryTime + 2 * MIN })
  const entry = onTime.events.find((e) => e.kind === 'entry')
  assert.match(entry.text, new RegExp(`^🟢 S · NIFTY: ${first.action} ${first.strike} ${first.side} @ ${first.entry.toFixed(2)} \\(`))
  assert.doesNotMatch(entry.text, /seen late/)
  assert.match(liveDayEvents(day, ENGINE, { name: 'S', complete: true, nowMs: first.entryTime + 10 * MIN }).events[0].text, /seen late/)
  const exit = onTime.events.find((e) => e.kind === 'exit')
  assert.match(exit.text, /^(✅|❌) S · NIFTY: out of /)
  assert.match(exit.text, / pts · net −?₹[\d,]+ after ₹[\d,]+ charges$/)
})

// The loop against a fake server, as the server runs it.
// SENSEX's day for a strategy trading in it: the synthetic day, its premiums half as high again.
const sensexRun = { ...run, underlying: 'SENSEX', optionExpiry: '2026-10-08', cePoints: run.cePoints.map((p) => ({ ...p, price: p.price * 1.5 })), pePoints: run.pePoints.map((p) => ({ ...p, price: p.price * 1.5 })) }

// The day's other expiries for a strategy with "Σ 3 expiries": the next (the same OI) and the monthly (twice it).
const sumChain = (scale, expiry) => ({ expiry, cePoints: run.cePoints.map((p) => ({ ...p, openInterest: p.openInterest * scale })), pePoints: run.pePoints.map((p) => ({ ...p, openInterest: p.openInterest * scale })) })
const SUM_NEXT = sumChain(1, '2026-10-13')
const SUM_MONTHLY = sumChain(2, '2026-10-27')

async function runLoop(nowIso, { strategies, runOk = true, sensexOk = true, bandsOk = true }) {
  const asked = []
  const posted = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      asked.push({ path: url.pathname, search: url.search, key: req.headers['x-runner-key'] })
      const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
      if (url.pathname === '/api/signal-strategies/live') return json(200, { today: DATE, strategies })
      if (url.pathname.startsWith('/api/signal-strategies/live/')) { posted.push({ path: url.pathname, body: JSON.parse(body) }); return json(200, {}) }
      if (url.pathname === '/api/oi-replay/NIFTY/run') return runOk ? json(200, { ...run, optionExpiry: '2026-10-06' }) : json(503, { error: 'busy' })
      if (url.pathname === '/api/oi-replay/SENSEX/run') return sensexOk ? json(200, sensexRun) : json(503, { error: 'busy' })
      if (url.pathname.endsWith('/previous-day-volume-profile')) return json(200, { success: false })
      if (url.pathname === '/api/oi-replay/NIFTY/summed-expiries') return json(200, { current: '2026-10-06', next: '2026-10-13', monthly: '2026-10-27' })
      if (url.pathname === '/api/oi-replay/NIFTY/expiry-band') {
        if (!bandsOk) return json(503, { error: 'busy' })
        const c = url.searchParams.get('expiryFlag') === 'MONTH' ? SUM_MONTHLY : SUM_NEXT
        return json(200, { success: true, cePoints: c.cePoints, pePoints: c.pePoints })
      }
      return json(404, { error: 'not mocked' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const script = fileURLToPath(new URL('../scanner-runner/signal-live.mjs', import.meta.url))
  const out = []
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, RUNNER_BASE_URL: `http://127.0.0.1:${server.address().port}`, RUNNER_KEY: 'k-9', LIVE_NOW: nowIso, LIVE_ONCE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (b) => out.push(String(b)))
    child.stderr.on('data', (b) => out.push(String(b)))
    child.on('exit', resolve)
  })
  server.close()
  return { code, asked, posted, log: out.join('') }
}

const STRATEGY = { id: 's1', name: 'VWAP cross', settings: SETTINGS, sent: [], reported: false }

test('each event carries its trade for the server\'s live orders: the traded option, its expiry, the SL / target in points', () => {
  const day = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('15:35') })
  const live = liveDayEvents(day, ENGINE, { name: 'S', complete: true, nowMs: at('15:35') })
  const t = live.closed[0]
  const [entry, exit] = live.events.filter((e) => e.trade.key === `${DATE}|${t.strategy}|${t.entryTime}`)
  assert.equal(entry.kind, 'entry')
  assert.equal(exit.kind, 'exit')
  // The entry and the exit name the same trade; the key is the event's own without its "|entry" / "|exit".
  assert.equal(entry.key, `${entry.trade.key}|entry`)
  assert.equal(exit.key, `${exit.trade.key}|exit`)
  assert.deepEqual({ ...exit.trade, exitReason: undefined }, { ...entry.trade, exitReason: undefined })
  assert.equal(exit.trade.exitReason, t.exitReason)
  assert.equal(entry.trade.exitReason, undefined)
  // The option traded and the day's expiry; SL / target = the strategy's % of the entry premium, in points.
  assert.deepEqual(
    { underlying: entry.trade.underlying, expiry: entry.trade.expiry, strike: entry.trade.strike, side: entry.trade.side, action: entry.trade.action, entryTime: entry.trade.entryTime, strategy: entry.trade.strategy },
    { underlying: 'NIFTY', expiry: '2026-10-06', strike: t.strike, side: t.side, action: t.action, entryTime: t.entryTime, strategy: t.strategy },
  )
  assert.equal(entry.trade.stopLossPoints, Math.round(t.entry * SETTINGS.slPct) / 100)
  assert.equal(entry.trade.targetPoints, Math.round(t.entry * SETTINGS.targetPct) / 100)
  // Points as set; none (0) stays 0 - the server then takes the Trade settings'.
  const pts = liveTrade(t, day, { ...ENGINE, levelUnit: 'pts', slPct: 12, targetPct: 0 })
  assert.equal(pts.stopLossPoints, 12)
  assert.equal(pts.targetPoints, 0)
  // Mirror trades carry theirs too.
  assert.ok(live.events.some((e) => e.trade.strategy === 'mirror') || !live.closed.some((x) => x.strategy === 'mirror'))
  // Each event also carries its trade's HISTORY ROW as of that event: open at the entry, closed at the exit - the same key.
  assert.equal(entry.row.status, 'open')
  assert.equal(entry.row.key, entry.trade.key)
  assert.deepEqual([entry.row.exitTime, entry.row.exit, entry.row.net], ['', '', ''])
  assert.equal(exit.row.status, 'closed')
  assert.equal(exit.row.key, entry.row.key)
  assert.equal(exit.row.exit, Math.round(t.exit * 100) / 100)
  assert.equal(exit.row.exitReason, t.exitReason)
  // The stop-loss and target as PRICES: a bought option's stop under its entry, target over it; a sold one's the other way.
  const sl = entry.trade.stopLossPoints
  const tg = entry.trade.targetPoints
  assert.equal(t.action, 'BUY')
  assert.equal(entry.row.sl, Math.round((t.entry - sl) * 100) / 100)
  assert.equal(entry.row.target, Math.round((t.entry + tg) * 100) / 100)
  const sold = tradeRow({ ...t, action: 'SELL' }, day, ENGINE, { open: true })
  assert.ok(sold.sl > t.entry && sold.target < t.entry)
  assert.equal(tradeRow(t, day, { ...ENGINE, levelUnit: 'pts', slPct: 0, targetPct: 0 }).sl, '')     // none = no level
  // Traded in SENSEX: SENSEX's option and SENSEX's expiry.
  const sensex = prepareLiveDay(sensexRun, { underlying: 'SENSEX', nowMs: at('15:35') })
  const cross = liveDayEvents(day, engineSettings(cleanBacktestSettings({ ...SETTINGS, tradeIn: 'SENSEX' })), { complete: true, nowMs: at('15:35'), tradeDay: sensex })
  assert.ok(cross.events.length > 0 && cross.events.every((e) => e.trade.underlying === 'SENSEX' && e.trade.expiry === '2026-10-08'))
})

test('the loop: in the session it posts the day\'s new events - nothing twice - and after the close the report', async () => {
  const noon = await runLoop('2026-10-05T06:30:00Z', { strategies: [STRATEGY] })           // 12:00 IST
  assert.equal(noon.code, 0)
  assert.ok(noon.asked.every((a) => a.key === 'k-9'))
  assert.ok(noon.asked.some((a) => a.path === '/api/oi-replay/NIFTY/run' && /forceLive=true/.test(a.search)))
  const events = noon.posted.filter((p) => p.path === '/api/signal-strategies/live/events')
  assert.equal(events.length, 1)
  assert.equal(events[0].body.strategyId, 's1')
  assert.equal(events[0].body.date, DATE)
  const day = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('12:00') })
  assert.deepEqual(events[0].body.events.map((e) => e.key), liveDayEvents(day, ENGINE).events.map((e) => e.key))
  // Each posted with its trade - what the server's live orders read - and its history row.
  assert.deepEqual(events[0].body.events.map((e) => e.trade), liveDayEvents(day, ENGINE).events.map((e) => e.trade))
  assert.deepEqual(events[0].body.events.map((e) => e.row), liveDayEvents(day, ENGINE).events.map((e) => e.row))
  assert.ok(!noon.posted.some((p) => p.path === '/api/signal-strategies/live/day'))           // no report mid-session
  // After the close, with the noon events already sent: only the new ones, and the report.
  const sent = events[0].body.events.map((e) => e.key)
  const close = await runLoop('2026-10-05T10:05:00Z', { strategies: [{ ...STRATEGY, sent }] })   // 15:35 IST
  const later = close.posted.find((p) => p.path === '/api/signal-strategies/live/events')
  assert.ok(later.body.events.every((e) => !sent.includes(e.key)))
  const report = close.posted.find((p) => p.path === '/api/signal-strategies/live/day')
  assert.equal(report.body.day.trades, fullTrades.length)
  assert.equal(report.body.trades.length, fullTrades.length)
  assert.match(report.body.text, /^📊 VWAP cross · NIFTY/)
  // Already reported: nothing more is asked of the day.
  const done = await runLoop('2026-10-05T10:10:00Z', { strategies: [{ ...STRATEGY, sent: [], reported: true }] })
  assert.ok(!done.asked.some((a) => a.path.endsWith('/run')))
})

test('the loop: nothing outside the session, nothing with no strategy on Live, a day it cannot read is left (backed off)', async () => {
  const sunday = await runLoop('2026-10-04T06:30:00Z', { strategies: [STRATEGY] })
  assert.equal(sunday.asked.length, 0)
  const early = await runLoop('2026-10-05T03:40:00Z', { strategies: [STRATEGY] })          // 09:10 IST
  assert.equal(early.asked.length, 0)
  const evening = await runLoop('2026-10-05T11:00:00Z', { strategies: [STRATEGY] })        // 16:30 IST
  assert.equal(evening.asked.length, 0)
  const none = await runLoop('2026-10-05T06:30:00Z', { strategies: [] })
  assert.deepEqual(none.asked.map((a) => a.path), ['/api/signal-strategies/live'])
  const failing = await runLoop('2026-10-05T06:30:00Z', { strategies: [STRATEGY], runOk: false })
  assert.equal(failing.posted.length, 0)
  assert.match(failing.log, /NIFTY: today not read \(.*busy.*\) - again in 1 min/)
})

test('trade in another index live: the signals read on NIFTY today, the trades taken in SENSEX - the texts name it', async () => {
  const trading = cleanBacktestSettings({ ...SETTINGS, tradeIn: 'SENSEX' })
  const engine = engineSettings(trading)
  const nifty = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('15:35') })
  const sensex = prepareLiveDay(sensexRun, { underlying: 'SENSEX', nowMs: at('15:35') })
  const live = liveDayEvents(nifty, engine, { name: 'VWAP cross', complete: true, nowMs: at('15:35'), tradeDay: sensex })
  // The backtest of the day traded in SENSEX: the same trades, each SENSEX's, at NIFTY's signal minutes.
  assert.deepEqual(live.closed, simulateDay(full, engine, { tradeDay: prepareDay(sensexRun, { underlying: 'SENSEX' }) }).trades)
  assert.ok(live.closed.length > 0 && live.closed.every((t) => t.tradeIndex === 'SENSEX'))
  assert.deepEqual(live.closed.map((t) => t.entryTime), fullTrades.map((t) => t.entryTime))
  assert.match(live.events[0].text, /^🟢 VWAP cross · NIFTY: BUY SENSEX \d+ (CE|PE) @ /)
  assert.match(dayReportText('VWAP cross', nifty, live), /^📊 VWAP cross · NIFTY → traded in SENSEX · Mon 5 Oct/)
  assert.match(dayRecord(nifty, live).trades[0].option, /^SENSEX \d+ (CE|PE)$/)
  // The loop reads SENSEX's day too and posts the SENSEX trades; without SENSEX's day the strategy waits (nothing posted).
  const strategy = { ...STRATEGY, settings: trading }
  const noon = await runLoop('2026-10-05T06:30:00Z', { strategies: [strategy] })
  assert.ok(noon.asked.some((a) => a.path === '/api/oi-replay/SENSEX/run' && /forceLive=true/.test(a.search)))
  const posted = noon.posted.find((p) => p.path === '/api/signal-strategies/live/events')
  assert.ok(posted.body.events.length > 0 && posted.body.events.every((e) => /SENSEX/.test(e.text)))
  const waiting = await runLoop('2026-10-05T06:30:00Z', { strategies: [strategy], sensexOk: false })
  assert.equal(waiting.posted.length, 0)
  assert.match(waiting.log, /SENSEX: today not read/)
  // A NIFTY-only strategy beside it is not held up by SENSEX.
  const both = await runLoop('2026-10-05T06:30:00Z', { strategies: [STRATEGY, { ...strategy, id: 's2' }], sensexOk: false })
  assert.deepEqual(both.posted.map((p) => p.body.strategyId), ['s1'])
})

test('Σ 3 expiries live: a strategy saved with it reads today with its next and monthly expiries summed - the others as before', async () => {
  // A rule that reads the OI: total PE OI above CE.
  const sumSettings = cleanBacktestSettings({
    underlying: 'NIFTY', sumExpiries: true, maxTradesPerDay: 6, cooldownMin: 0, timeStopMin: 30,
    rule: { tree: { op: 'and', not: false, items: [{ line: { id: 'vwap', value: 'crossedAbove', windowMin: 5 } }] }, action: 'buyCE', mirror: true },
  })
  const summing = { id: 's2', name: 'Summed', settings: sumSettings, sent: [], reported: false }
  const noon = await runLoop('2026-10-05T06:30:00Z', { strategies: [STRATEGY, summing] })
  assert.equal(noon.code, 0)
  // Today's bands from the server's memory (forceLive): the next (code 2 of the weekly series) and the monthly.
  const bands = noon.asked.filter((a) => a.path === '/api/oi-replay/NIFTY/expiry-band').map((a) => a.search)
  assert.deepEqual(bands, ['?date=2026-10-05&expiryFlag=WEEK&expiryCode=2&forceLive=true', '?date=2026-10-05&expiryFlag=MONTH&expiryCode=1&forceLive=true'])
  const events = (id) => noon.posted.find((p) => p.path === '/api/signal-strategies/live/events' && p.body.strategyId === id)?.body.events ?? []
  const summedDay = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('12:00'), expiryChains: [SUM_NEXT, SUM_MONTHLY] })
  assert.equal(summedDay.expiries, 3)
  assert.deepEqual(events('s2').map((e) => e.key), liveDayEvents(summedDay, engineSettings(sumSettings)).events.map((e) => e.key))
  // The strategy without it: as before.
  const day = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('12:00') })
  assert.deepEqual(events('s1').map((e) => e.key), liveDayEvents(day, ENGINE).events.map((e) => e.key))
  // Its other expiries not readable now: it waits (backed off on its own) - the strategy without it goes on.
  const busy = await runLoop('2026-10-05T06:30:00Z', { strategies: [STRATEGY, summing], bandsOk: false })
  assert.ok(busy.posted.some((p) => p.body.strategyId === 's1'))
  assert.ok(!busy.posted.some((p) => p.body.strategyId === 's2'))
  assert.match(busy.log, /NIFTY Σ 3 expiries: today not read \(.*busy.*\) - again in 1 min/)
  // No strategy with it: no band asked.
  const plain = await runLoop('2026-10-05T06:30:00Z', { strategies: [STRATEGY] })
  assert.ok(!plain.asked.some((a) => a.path.endsWith('/expiry-band') || a.path.endsWith('/summed-expiries')))
})

test('the live day is cut to the completed minutes - the other expiries\' too', () => {
  const late = { ...SUM_NEXT, cePoints: SUM_NEXT.cePoints.map((p) => ({ ...p })), pePoints: SUM_NEXT.pePoints }
  const a = prepareLiveDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', nowMs: at('11:00'), expiryChains: [late] })
  const cut = (list) => list.filter((p) => Date.parse(p.time) + MIN <= at('11:00'))
  const b = prepareDay(completedRun({ ...run, optionExpiry: '2026-10-06' }, at('11:00')), { underlying: 'NIFTY', minMinutes: 5, expiryChains: [{ ...late, cePoints: cut(late.cePoints), pePoints: cut(late.pePoints) }] })
  assert.deepEqual(a.tot, b.tot)
  assert.deepEqual(a.gex, b.gex)
})
