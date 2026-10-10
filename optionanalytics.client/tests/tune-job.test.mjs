// The strategy tuning job end to end (scanner-runner/tune.mjs): against a stand-in for the server's API serving
// synthetic days, it lists the recorded days, scans each, ranks the strategies, tunes the chosen ones and
// writes its result - and reports a clear failure when there is nothing to tune on.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
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
const isWeekendDate = (d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())
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
    // The cycle-at-a-time option-chain fetch and its proof (faults.rangeMismatch: the server says the two ways differ;
    // faults.rangeError: the range fetch itself fails part way).
    if (url.pathname === '/api/oi-replay/NIFTY/range-check') {
      return json({ match: !faults.rangeMismatch, windowDays: 4, comparison: faults.rangeMismatch ? { match: false, differences: ['2026-09-29 22600 CE 10:15: openInterest 120 vs 121'] } : { match: true }, error: null })
    }
    if (url.pathname === '/api/oi-replay/NIFTY/range') {
      if (faults.rangeError) return json({ error: 'the window failed' }, 500)
      const from = url.searchParams.get('from'), to = url.searchParams.get('to')
      const wanted = recordedDays.filter((d) => d >= from && d <= to && !isWeekendDate(d))
      return json({ success: true, days: wanted.map((d) => oiRun(d)), windows: [{ from, to, strikes: 42 }], optionSeriesCalls: 42, fallbackDays: [] })
    }
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

/** A CSV file as rows (the files the tuning history writes - quoted fields included). */
function rows(path) {
  const text = readFileSync(path, 'utf8')
  const out = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); out.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field.length || row.length) { row.push(field); out.push(row) }
  const header = out[0]
  return out.slice(1).filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
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
  const history = join(dir, 'history')
  // TUNE_FAST_OI off: this is the per-day path's own test (a busy Dhan, an incomplete day, the disk cache). The
  // cycle-at-a-time fetch has its own test below.
  const env = { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_HISTORY_DIR: history, TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5', TUNE_PRIORITY: 'background', TUNE_FAST_OI: 'off' }
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
    // Every trade written to the run's own history CSV, with its date / time, levels and why it fired.
    const files = readdirSync(history)
    const runId = files.find((f) => f.endsWith('-trades.csv')).replace('-trades.csv', '')
    assert.match(runId, /^NIFTY-futures-\d{8}-\d{6}$/)
    const t = rows(join(history, `${runId}-trades.csv`))
    assert.ok(t.length > 0 && t.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x.entry_time_ist) && x.index === 'NIFTY' && x.entry && x.stop))
    assert.ok(t.some((x) => x.setting === 'as written' && x.why.length > 10), 'why it fired is kept')
    assert.ok(t.some((x) => x.setting === 'fine-tuned' && x.setting_text), 'the fine-tuned trades and the setting they used')
    assert.deepEqual([...new Set(t.map((x) => x.run_id))], [runId])
    // Sorted by date then time, as the page shows them.
    const keys = t.map((x) => `${x.date} ${x.entry_time_ist}`)
    assert.deepEqual(keys, [...keys].sort(), 'the file is in date / time order')
    // The settings of that run: each strategy as written and fine-tuned, with every parameter.
    const st = rows(join(history, `${runId}-settings.csv`))
    assert.deepEqual([...new Set(st.map((x) => x.which))].sort(), ['as written', 'fine-tuned'])
    assert.ok(st.every((x) => x.strategy_id && x.tradeSide && x.tradeFrom && x.train_trades !== undefined))
    // runs.csv: a row for the run, with the days and trades it holds.
    const runs = rows(join(history, 'runs.csv'))
    assert.equal(runs.length, 1)
    assert.equal(runs[0].run_id, runId)
    assert.equal(runs[0].index, 'NIFTY')
    assert.equal(Number(runs[0].days_used), result.days.length)
    assert.equal(Number(runs[0].days_skipped), 1)
    assert.equal(Number(runs[0].trades), t.length)

    // A second run (a rerun, or a job resumed after a restart): every full day comes from the disk cache.
    const before = seen.length
    const again = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }, env)
    assert.equal(again.code, 0, JSON.stringify(again.result))
    assert.deepEqual(again.result.days.map((d) => d.date), result.days.map((d) => d.date))
    const fetchedAgain = seen.slice(before).map((x) => x.path).filter((p) => /\/day\/|\/tape|\/run/.test(p))
    assert.ok(fetchedAgain.every((p) => p.endsWith('/day/2026-09-30')), `only the partial day is asked again: ${fetchedAgain.join(', ')}`)
    assert.ok(again.result.fetched.cacheHits >= 15)
    assert.deepEqual(again.result.ranked.map((x) => [x.id, x.n, x.total]), result.ranked.map((x) => [x.id, x.n, x.total]), 'the same result from the cache')
    // The second run is its OWN history entry - an earlier run is never overwritten, so runs can be compared.
    const runsAfter = rows(join(history, 'runs.csv'))
    assert.equal(runsAfter.length, 2, 'two runs kept')
    assert.equal(new Set(runsAfter.map((r) => r.run_id)).size, 2)
    assert.ok(readdirSync(history).filter((f) => f.endsWith('-trades.csv')).length === 2)
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

test('the option chain a cycle at a time: proved on this job first, and the job is the same either way', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const job = { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }
  const base = { TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' }
  const run = async (faults, env) => {
    const { server, seen, base: url } = await fakeServer(days, faults)
    const dir = mkdtempSync(join(tmpdir(), 'oa-fast-'))
    try {
      const out = await runJob(url, job, { ...base, TUNE_CACHE_DIR: join(dir, 'cache'), ...env })
      return { ...out, perDayRuns: seen.filter((x) => x.path === '/api/oi-replay/NIFTY/run').length, ranges: seen.filter((x) => x.path === '/api/oi-replay/NIFTY/range').length }
    } finally { server.close() }
  }

  // Proved, so used: the days come from the range fetch and the per-day OI endpoint is not called for them.
  const fast = await run({}, {})
  assert.equal(fast.code, 0, JSON.stringify(fast.result))
  assert.equal(fast.result.fastOi.used, true, JSON.stringify(fast.result.fastOi))
  assert.equal(fast.result.fastOi.checked.match, true)
  assert.ok(fast.result.fastOi.seeded >= days.length - 1, JSON.stringify(fast.result.fastOi))
  assert.ok(fast.ranges >= 1)
  assert.equal(fast.perDayRuns, 0, 'no per-day option-chain call once the cycle fetch is proved')

  // Not proved: every day fetched the old way, and the job still finishes - with the SAME result.
  const safe = await run({ rangeMismatch: true }, {})
  assert.equal(safe.code, 0, JSON.stringify(safe.result))
  assert.equal(safe.result.fastOi.used, false)
  assert.match(safe.result.fastOi.reason, /did not match/)
  assert.ok(safe.perDayRuns >= days.length, 'back to a day at a time')
  assert.deepEqual(fast.result.days.map((d) => d.date), safe.result.days.map((d) => d.date))
  assert.deepEqual(fast.result.ranked.map((r) => [r.id, r.n, r.total]), safe.result.ranked.map((r) => [r.id, r.n, r.total]), 'the same strategies, trades and scores either way')
  assert.deepEqual(fast.result.results[0].best?.params, safe.result.results[0].best?.params, 'and the same chosen setting')

  // The range fetch breaking part way does not break the job: the rest is fetched a day at a time.
  const broken = await run({ rangeError: true }, {})
  assert.equal(broken.code, 0, JSON.stringify(broken.result))
  assert.equal(broken.result.fastOi.used, false)
  assert.ok(broken.perDayRuns >= days.length)
  assert.deepEqual(broken.result.ranked.map((r) => [r.id, r.n]), fast.result.ranked.map((r) => [r.id, r.n]))

  // And it can simply be switched off.
  const off = await run({}, { TUNE_FAST_OI: 'off' })
  assert.equal(off.result.fastOi.used, false)
  assert.match(off.result.fastOi.reason, /switched off/)
  assert.equal(off.ranges, 0, 'not even the check is run')
})
