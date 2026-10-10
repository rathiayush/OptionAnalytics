// The strategy tuning job end to end (scanner-runner/tune.mjs): against a stand-in for the server's API serving
// synthetic days, it lists the recorded days, scans each, ranks the strategies, tunes the chosen ones and
// writes its result - and reports a clear failure when there is nothing to tune on.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { day } from './synthetic-day.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DAY_MS = 86_400_000
const syn = day()
const BASE_DATE = '2026-10-05'
const shiftIso = (iso, d) => new Date(Date.parse(iso) + d * DAY_MS).toISOString()
const offset = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${BASE_DATE}T00:00:00Z`)) / DAY_MS)

function orderFlowDay(date) {
  const d = offset(date)
  return {
    meta: { underlying: 'NIFTY', contractSymbol: 'NIFTY-FUT', lotSize: 75, lastPrice: syn.path.at(-1), day: date },
    source: 'live', bars: syn.minuteBars.map((b) => ({ ...b, time: shiftIso(b.time, d) })), trades: [], icebergs: [], sweeps: [],
    heatmap: syn.path.map((p, m) => ({ time: new Date(syn.at(m) + 30_000 + d * DAY_MS).toISOString(), bids: [[p - 1, 500]], asks: [[p + 1, 500]] })),
  }
}
function oiRun(date) {
  const d = offset(date)
  const r = syn.run
  const sh = (rows) => rows.map((x) => ({ ...x, time: shiftIso(x.time, d) }))
  return { ...r, date, spotCandlesOneMinute: sh(r.spotCandlesOneMinute), futuresBars: sh(r.futuresBars), cePoints: sh(r.cePoints), pePoints: sh(r.pePoints) }
}

// faults: rateLimit - the first N requests for each day's futures answer HTTP 429; busyOi - each day's first OI replay
// comes back with a strike series that failed for Dhan's rate limit; partial - a day with only 200 minutes of bars;
// usageAfter - after N days fetched, the server reports Dhan's daily Data-API limit nearly used.
function fakeServer(recordedDays, faults = {}) {
  const seen = []
  const count = new Map()
  const nth = (key) => { const n = (count.get(key) ?? 0) + 1; count.set(key, n); return n }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ path: url.pathname, key: req.headers['x-runner-key'], priority: req.headers['x-request-priority'] ?? null, date: url.searchParams.get('date') })
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    let m
    if (url.pathname === '/api/scanner-runner/config') return json({ settings: {} })
    if (url.pathname === '/api/strategy-tuning/dhan-usage') {
      const fetchedDays = new Set(seen.filter((x) => /\/run$/.test(x.path)).map((x) => x.date)).size
      return json({ day: '2026-10-10', calls: faults.usageAfter != null && fetchedDays >= faults.usageAfter ? 95_000 : 1_200, dailyLimit: 100_000 })
    }
    if (url.pathname === '/api/order-flow/NIFTY/days') return json(recordedDays.map((date) => ({ date, contractSymbol: 'NIFTY-FUT', expiry: '2026-10-27', live: false })))
    if ((m = url.pathname.match(/^\/api\/order-flow\/NIFTY\/day\/(\d{4}-\d{2}-\d{2})$/))) {
      if (faults.rateLimit && nth(`day-${m[1]}`) <= faults.rateLimit) return json({ error: 'Too many requests' }, 429)
      const body = orderFlowDay(m[1])
      return json(m[1] === faults.partial ? { ...body, bars: body.bars.slice(0, 200) } : body)
    }
    if (url.pathname === '/api/order-flow/NIFTY/tape') return json({ prints: syn.prints.map((p) => ({ ...p, time: new Date(p.time + offset(url.searchParams.get('date')) * DAY_MS).toISOString() })) })
    if (url.pathname === '/api/oi-replay/NIFTY/run') {
      const date = url.searchParams.get('date')
      if (faults.busyOi && nth(`oi-${date}`) === 1) return json({ ...oiRun(date), optionErrors: ['ATM+4 CALL: Too many requests'] })
      return json(oiRun(date))
    }
    if (url.pathname === '/api/oi-replay/NIFTY/expiries') return json({ week: '2026-10-08', month: '2026-10-27' })
    return json({ error: 'not found' }, 404)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })))
}

function runJob(base, job, env = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'oa-tune-')), 'result.json')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, '..', 'scanner-runner', 'tune.mjs')], {
      env: { ...process.env, RUNNER_BASE_URL: base, RUNNER_KEY: 'k123', TUNE_JOB: JSON.stringify(job), TUNE_OUT: out, ...env },
    })
    const lines = []
    child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
    child.stderr.on('data', () => {})
    child.on('exit', (code) => resolve({ code, result: JSON.parse(readFileSync(out, 'utf8')), lines }))
  })
}

test('the tuning job scans the recorded days, ranks the strategies and tunes the chosen one', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days)
  try {
    const { code, result, lines } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2 })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.ok, true)
    assert.deepEqual(result.days.map((d) => d.date), [...days].reverse())
    assert.ok(result.days.every((d) => d.setups > 0 && !d.estimated))
    // (the top of the ranking is whichever strategy scores best on the synthetic day - #33 since it came in)
    assert.ok(result.ranked[0].n >= 2, JSON.stringify(result.ranked[0]))
    assert.ok(result.ranked.some((x) => x.id === 'weakWall' && x.n > 0))
    assert.equal(result.results.length, 1)
    const r = result.results[0]
    assert.equal(r.id, 'weakWall')
    assert.equal(r.tried, 7200)
    assert.equal(r.trainDays.length + r.testDays.length, 6)
    assert.ok(r.best, r.reason)
    assert.ok(typeof r.recommend === 'boolean' && r.reason)
    assert.ok(lines.some((l) => l.startsWith('PROGRESS ') && /"stage":"tune"/.test(l)))
    assert.ok(seen.every((s) => s.key === 'k123'), 'every call carries the runner key')
  } finally {
    server.close()
  }
})

test('nothing recorded: a clear failure, written to the result', { timeout: 60_000 }, async () => {
  const { server, base } = await fakeServer([])
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: 'top3', days: 10 })
    assert.equal(code, 1)
    assert.equal(result.ok, false)
    assert.match(result.error, /no recorded past days/)
  } finally {
    server.close()
  }
})

test('a date range picks the days: only the recorded days inside it, both ends included', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days)
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 2, minTrades: 2, what: 'trade', from: '2026-09-29', to: '2026-10-02' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.deepEqual(result.days.map((d) => d.date), ['2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29'], 'the range wins over "the last 2 days"')
    assert.equal(result.from, '2026-09-29')
    assert.equal(result.to, '2026-10-02')
    // An open start: everything up to the end date.
    const upTo = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], minTrades: 2, what: 'trade', to: '2026-09-30' })
    assert.deepEqual(upTo.result.days.map((d) => d.date), ['2026-09-30', '2026-09-29', '2026-09-28'])
    // Nothing in the range: a clear failure naming it.
    const none = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], from: '2026-08-01', to: '2026-08-31' })
    assert.equal(none.code, 1)
    assert.match(none.result.error, /no recorded past days on the server between 2026-08-01 and 2026-08-31/)
  } finally {
    server.close()
  }
})

test('Saturdays and Sundays are never fetched, even when a listing has them', { timeout: 300_000 }, async () => {
  // 2026-10-03 is a Saturday and 2026-10-04 a Sunday.
  const days = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']
  const { server, seen, base } = await fakeServer(days)
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], minTrades: 2, what: 'trade', from: '2026-10-01', to: '2026-10-05' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.deepEqual(result.days.map((d) => d.date), ['2026-10-05', '2026-10-02'])
    const fetched = seen.map((s) => s.path).filter((p) => /\/day\/2026-10-0[34]$/.test(p))
    assert.deepEqual(fetched, [], 'no request for a Saturday or Sunday')
    // The estimated days a range adds are weekdays only too.
    const est = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], minTrades: 2, what: 'trade', includeEstimated: true, from: '2026-09-30', to: '2026-10-05' })
    assert.ok(est.result.days.every((d) => ![0, 6].includes(new Date(`${d.date}T00:00:00Z`).getUTCDay())))
  } finally {
    server.close()
  }
})

test('a long job rides out a busy Dhan, leaves out a partial day, re-uses the disk cache and writes every trade', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days, { rateLimit: 2, busyOi: true, partial: '2026-09-30' })
  const dir = mkdtempSync(join(tmpdir(), 'oa-tune-cache-'))
  const trades = join(dir, 'trades.json')
  const env = { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_TRADES_OUT: trades, TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5', TUNE_PRIORITY: 'background' }
  try {
    const { code, result, lines } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }, env)
    assert.equal(code, 0, JSON.stringify(result))
    // Every 429 was waited out and every first (incomplete) OI fetched again: all full days used.
    assert.deepEqual(result.days.map((d) => d.date), ['2026-10-05', '2026-10-02', '2026-10-01', '2026-09-29', '2026-09-28'])
    assert.ok(result.fetched.retries >= 5 * 2, JSON.stringify(result.fetched))
    assert.ok(lines.some((l) => /"wait":\{"label":"option OI"/.test(l)), 'the wait for an incomplete OI day is reported')
    // The partial day is left out with its reason - never scored as a whole day.
    assert.deepEqual(result.skipped.map((x) => x.date), ['2026-09-30'])
    assert.match(result.skipped[0].reason, /only 200 of 375 minutes - a partial day/)
    // Each day says where it came from and how complete it was.
    assert.ok(result.days.every((d) => d.minutes >= 300 && d.oiMinutes >= 300 && d.source === 'live' && d.prints > 0))
    // Every request was sent at background priority (the server then keeps Dhan's interactive lane for the live app).
    assert.ok(seen.filter((x) => x.path.startsWith('/api/')).every((x) => x.priority === 'background'))
    // Every trade written, with its date / time, levels and why it fired.
    const t = JSON.parse(readFileSync(trades, 'utf8'))
    assert.ok(t.trades.length > 0 && t.trades.every((x) => x.date && x.t && x.setting && Number.isFinite(x.entry) && Number.isFinite(x.stop)))
    assert.ok(t.trades.some((x) => x.setting === 'as written' && x.checks && Object.keys(x.checks).length > 0))
    assert.ok(t.trades.some((x) => x.setting === 'best'))
    assert.deepEqual(t.skipped.map((x) => x.date), ['2026-09-30'])

    // A second run (a rerun, or a job resumed after a restart): every full day comes from the disk cache.
    const before = seen.length
    const again = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }, env)
    assert.equal(again.code, 0, JSON.stringify(again.result))
    assert.deepEqual(again.result.days.map((d) => d.date), result.days.map((d) => d.date))
    const fetchedAgain = seen.slice(before).map((x) => x.path).filter((p) => /\/day\/|\/tape|\/run/.test(p))
    assert.ok(fetchedAgain.every((p) => p.endsWith('/day/2026-09-30')), `only the partial day is asked again: ${fetchedAgain.join(', ')}`)
    assert.ok(again.result.fetched.cacheHits >= 15)
    assert.deepEqual(again.result.ranked.map((x) => [x.id, x.n, x.total]), result.ranked.map((x) => [x.id, x.n, x.total]), 'the same result from the cache')
  } finally {
    server.close()
  }
})

test('the job stops before Dhan\'s daily limit: the days it reached are tuned, the rest listed with the reason', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days, { usageAfter: 3 })
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.deepEqual(result.days.map((d) => d.date), ['2026-10-05', '2026-10-02', '2026-10-01'])
    assert.deepEqual(result.skipped.map((x) => x.date), ['2026-09-30', '2026-09-29', '2026-09-28'])
    assert.ok(result.skipped.every((x) => /Dhan's daily Data-API limit nearly used \(95,000 of 1,00,000 calls today\)/.test(x.reason)), result.skipped[0].reason)
  } finally {
    server.close()
  }
})
