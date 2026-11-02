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
import { completedRun, dayRecord, dayReportText, istClock, liveDayEvents, liveRunUrl, prepareLiveDay } from '../src/signalLive.js'

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
  assert.deepEqual(Object.keys(record.trades[0]), ['date', 'side', 'signal', 'action', 'option', 'entryTime', 'entry', 'exitTime', 'exit', 'exitReason', 'points', 'gross', 'charges', 'net', 'expiryDay', 'why'])
  const text = dayReportText('VWAP cross', day, live)
  assert.match(text, /^📊 VWAP cross · NIFTY · Mon 5 Oct/)
  assert.match(text, new RegExp(`${fullTrades.length} trades`))
  assert.match(text, /\nNet −?₹[\d,]+ after ₹[\d,]+ charges \(gross −?₹[\d,]+\)/)
  assert.equal(text.split('\n').filter((l) => /^\d+\. /.test(l)).length, fullTrades.length)
  // A day with no trade says so.
  const quiet = liveDayEvents(day, engineSettings(cleanBacktestSettings({ ...SETTINGS, rule: { tree: { op: 'and', not: false, items: [{ line: { id: 'ib', value: 'inside' } }] }, action: 'buyCE', mirror: false }, maxTradesPerDay: 1 })), { complete: true })
  assert.match(dayReportText('Quiet', day, { ...quiet, closed: [], trades: [], signals: 0, summary: { ...quiet.summary, trades: 0 } }), /No trades today\./)
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
async function runLoop(nowIso, { strategies, runOk = true }) {
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
      if (url.pathname.endsWith('/previous-day-volume-profile')) return json(200, { success: false })
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
