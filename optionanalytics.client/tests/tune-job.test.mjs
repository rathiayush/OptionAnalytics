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

function fakeServer(recordedDays) {
  const seen = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ path: url.pathname, key: req.headers['x-runner-key'] })
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    let m
    if (url.pathname === '/api/scanner-runner/config') return json({ settings: {} })
    if (url.pathname === '/api/order-flow/NIFTY/days') return json(recordedDays.map((date) => ({ date, contractSymbol: 'NIFTY-FUT', expiry: '2026-10-27', isLive: false })))
    if ((m = url.pathname.match(/^\/api\/order-flow\/NIFTY\/day\/(\d{4}-\d{2}-\d{2})$/))) return json(orderFlowDay(m[1]))
    if (url.pathname === '/api/order-flow/NIFTY/tape') return json({ prints: syn.prints.map((p) => ({ ...p, time: new Date(p.time + offset(url.searchParams.get('date')) * DAY_MS).toISOString() })) })
    if (url.pathname === '/api/oi-replay/NIFTY/run') return json(oiRun(url.searchParams.get('date')))
    if (url.pathname === '/api/oi-replay/NIFTY/expiries') return json({ week: '2026-10-08', month: '2026-10-27' })
    return json({ error: 'not found' }, 404)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })))
}

function runJob(base, job) {
  const out = join(mkdtempSync(join(tmpdir(), 'oa-tune-')), 'result.json')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, '..', 'scanner-runner', 'tune.mjs')], {
      env: { ...process.env, RUNNER_BASE_URL: base, RUNNER_KEY: 'k123', TUNE_JOB: JSON.stringify(job), TUNE_OUT: out },
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
    assert.equal(result.ranked[0].id, 'weakWall')
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
