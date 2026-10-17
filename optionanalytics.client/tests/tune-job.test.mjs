// The strategy tuning job end to end (scanner-runner/tune.mjs): against a stand-in for the server's API serving
// synthetic days, it lists the recorded days, scans each, ranks the strategies, tunes the chosen ones and
// writes its result - and reports a clear failure when there is nothing to tune on.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
// usageAfter - after N days fetched, the server reports Dhan's daily Data-API limit nearly used;
// busyOiAlways - these days' OI ALWAYS comes back incomplete, however often it is asked for (a day the job must give
// up on rather than keep paying 42 Dhan calls for); rangeFallback - the range fetch serves these days but says the
// SERVER itself fell back to the per-day path for them (fetchSource "day"), which the job must still seed so it never
// pays for them again; rangeUnserved - the range fetch refuses these days without fetching them (perDayFallback=false),
// so the job fetches each exactly once; dayDelayMs / listDelayMs - a day request / the day listing takes this long, so
// a time budget can run out mid-job or before any day at all.
const isWeekendDate = (d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())
function fakeServer(recordedDays, faults = {}) {
  const seen = []
  const count = new Map()
  const nth = (key) => { const n = (count.get(key) ?? 0) + 1; count.set(key, n); return n }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ path: url.pathname, key: req.headers['x-runner-key'], priority: req.headers['x-request-priority'] ?? null, date: url.searchParams.get('date'), query: Object.fromEntries(url.searchParams) })
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    let m
    if (url.pathname === '/api/scanner-runner/config') return json(faults.config ?? { settings: {} })
    if (url.pathname === '/api/strategy-tuning/dhan-usage') {
      const fetchedDays = new Set(seen.filter((x) => /\/run$/.test(x.path)).map((x) => x.date)).size
      return json({ day: '2026-10-10', calls: faults.usageAfter != null && fetchedDays >= faults.usageAfter ? 95_000 : 1_200, dailyLimit: 100_000 })
    }
    if (url.pathname === '/api/order-flow/NIFTY/days') {
      const list = () => json(recordedDays.map((date) => ({ date, contractSymbol: 'NIFTY-FUT', expiry: '2026-10-27', live: false })))
      if (faults.listDelayMs) return void setTimeout(list, faults.listDelayMs)
      return list()
    }
    if ((m = url.pathname.match(/^\/api\/order-flow\/NIFTY\/day\/(\d{4}-\d{2}-\d{2})$/))) {
      if (faults.rateLimit && nth(`day-${m[1]}`) <= faults.rateLimit) return json({ error: 'Too many requests' }, 429)
      const body = orderFlowDay(m[1])
      const send = () => json(m[1] === faults.partial ? { ...body, bars: body.bars.slice(0, 200) } : body)
      if (faults.slowDay === m[1]) return void setTimeout(send, faults.slowDayMs ?? 3_000)
      if (faults.dayDelayMs) return void setTimeout(send, faults.dayDelayMs)
      return send()
    }
    if (url.pathname === '/api/order-flow/NIFTY/tape') return json({ prints: syn.prints.map((p) => ({ ...p, time: new Date(p.time + offset(url.searchParams.get('date')) * DAY_MS).toISOString() })) })
    // The cycle-at-a-time option-chain fetch and its proof (faults.rangeMismatch: the server says the two ways differ;
    // faults.rangeError: the range fetch itself fails part way).
    if (url.pathname === '/api/oi-replay/NIFTY/range-check') {
      return json({ match: !faults.rangeMismatch, windowDays: 4, comparison: faults.rangeMismatch ? { match: false, differences: ['2026-09-29 22600 CE 10:15: openInterest 120 vs 121'] } : { match: true }, error: null })
    }
    // The 30-day span proof (faults.span: 'pass' | 'expiryDiff' | 'fail'; unset = the route is not there).
    if (url.pathname === '/api/oi-replay/NIFTY/range-span-check' && faults.span) {
      const across = faults.span !== 'fail'
      return json({ acrossMatch: across, expiryDayMatch: faults.span === 'pass', expiry: '2026-09-29', error: null,
        days: [{ date: '2026-09-28', role: 'before', match: true, differences: [] }, { date: '2026-09-29', role: 'expiry', match: faults.span === 'pass', differences: faults.span === 'pass' ? [] : ['22600 CE 09:15: openInterest 1 vs 2'] },
          { date: '2026-09-30', role: 'after', match: across, differences: across ? [] : ['22600 CE 09:15: openInterest 1 vs 2'] }] })
    }
    if (url.pathname === '/api/oi-replay/NIFTY/range') {
      if (faults.rangeError) return json({ error: 'the window failed' }, 500)
      const from = url.searchParams.get('from'), to = url.searchParams.get('to')
      const unserved = faults.rangeUnserved ?? []
      const fellBack = faults.rangeFallback ?? []
      const wanted = recordedDays.filter((d) => d >= from && d <= to && !isWeekendDate(d))
      // A day the server could not serve from a window: with perDayFallback=false it comes back named and unfetched.
      const days = wanted.map((d) => (unserved.includes(d)
        ? { success: false, date: d, error: 'No window answered for it and this request was asked not to fetch it.', fetchSource: 'unserved' }
        // A day the server itself fell back per-day for inside the request: the whole, usable day, marked as such.
        : fellBack.includes(d) ? { ...oiRun(d), fetchSource: 'day' } : { ...oiRun(d), fetchSource: 'range' }))
      return json({
        success: true, days, windows: [{ from, to, strikes: 42 }],
        optionSeriesCalls: 42 + fellBack.length * 42, windowOptionSeriesCalls: 42,
        fallbackOptionSeriesCalls: fellBack.length * 42,
        fallbackDays: wanted.filter((d) => fellBack.includes(d)), unservedDays: wanted.filter((d) => unserved.includes(d)),
      })
    }
    if (url.pathname === '/api/oi-replay/NIFTY/run') {
      const date = url.searchParams.get('date')
      if ((faults.busyOiAlways ?? []).includes(date)) return json({ ...oiRun(date), optionErrors: ['ATM+4 CALL: Too many requests'] })
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

test('nothing recorded: the job runs on estimated days instead of failing - and says so', { timeout: 300_000 }, async () => {
  // The server keeps only the last few recorded days, in memory - a restart empties it. A futures job asked for recorded
  // days only (a scheduled one, every day) used to fail there; it now runs on the days rebuilt from 1-minute candles.
  const { server, base } = await fakeServer([])
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: 'top3', days: 10, oiFactors: ['tradeOiFlow', 'tradeTape', 'tradeBig'] })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.ok, true)
    assert.match(result.notice, /no recorded days in this range, so the job ran on estimated days/)
    assert.ok(result.days.length > 0, 'it ran on the days rebuilt from candles (the fake server does not mark them estimated)')
    // ...and the order-flow inputs are left out: on estimated days they let every trade through.
    assert.deepEqual(result.oiFactors, ['tradeOiFlow'])
    assert.match(result.notice, /order-flow inputs were left out/)
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
    // Nothing recorded in the range: the job runs on that range's estimated days instead of failing, and says so.
    const none = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], minTrades: 2, what: 'trade', from: '2026-08-24', to: '2026-08-28' })
    assert.equal(none.code, 0, JSON.stringify(none.result))
    assert.match(none.result.notice, /no recorded days in this range/)
    assert.ok(none.result.days.length > 0 && none.result.days.every((d) => d.date >= '2026-08-24' && d.date <= '2026-08-28'), 'only that range')
    // Recorded days in the range: they are used as before, and no notice.
    assert.equal(result.notice, undefined)
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
    // {run}-days.csv: every day looked at - the used ones with their train / test role (the newest 30% are the test, as
    // tuneStrategy splits them) and the left-out one with why.
    const dl = rows(join(history, `${runId}-days.csv`))
    const used = dl.filter((x) => x.status === 'used')
    assert.deepEqual(used.map((x) => x.date).sort(), result.days.map((d) => d.date).sort())
    const test = used.filter((x) => x.role === 'test').map((x) => x.date)
    assert.ok(test.length > 0 && used.every((x) => x.role === 'train' || x.role === 'test'))
    assert.ok(test.every((d) => used.filter((x) => x.role === 'train').every((x) => x.date < d)), 'the test days are the newest')
    const left = dl.filter((x) => x.status === 'left out')
    assert.equal(left.length, 1)
    assert.ok(left[0].reason.length > 0, 'why it was left out')

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

    // The cross-check (tuneChecks.mjs): the run's own fine-tuned setting measured per day on its held-back days only,
    // with the setting's own parameter columns.
    const ck = rows(join(history, `${runId}-checks.csv`))
    const tuned = st.find((x) => x.which === 'fine-tuned')
    assert.ok(ck.length > 0, 'checked')
    assert.ok(ck.every((x) => test.includes(x.date)), 'never on a day the setting was chosen on')
    assert.ok(ck.every((x) => x.strategy_id === 'weakWall' && x.tradeSide === tuned.tradeSide && x.tradeFrom === tuned.tradeFrom && x.base_n !== ''))
    assert.equal(ck.reduce((a, x) => a + Number(x.n), 0), Number(tuned.test_trades), 'what the tuning counted on its test days')
    assert.ok(again.result.checks.fromEarlierRuns >= 1, 'the second run re-checked the first run\'s setting')

    // A re-check job: no new tuning - every setting found so far measured on the days again.
    const check = await runJob(base, { underlying: 'NIFTY', strategies: 'top3', days: 30, minTrades: 2, what: 'check' }, env)
    assert.equal(check.code, 0, JSON.stringify(check.result))
    assert.deepEqual(check.result.results, [], 'nothing tuned')
    assert.ok(check.result.checks.settings >= 1 && check.result.checks.fromEarlierRuns >= 1)
    const checkRun = rows(join(history, 'runs.csv')).at(-1).run_id
    assert.equal(rows(join(history, `${checkRun}-settings.csv`)).length, 0)
    assert.ok(rows(join(history, `${checkRun}-checks.csv`)).length > 0)
  } finally {
    server.close()
  }
})

test('the Strategy lab job: one strategy measured with the setting sent, beside it as written - and no tuning history', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days)
  const dir = mkdtempSync(join(tmpdir(), 'oa-lab-'))
  const history = join(dir, 'history')
  try {
    const params = { tradeSide: 'long', tradeStopX: 1.5, optLeg: 'buy', optMoneyness: 0, optExit: 'indexSl', optSlPct: 30 }
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'lab', params },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_HISTORY_DIR: history, TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.ok, true)
    assert.equal(result.lab, true)
    assert.equal(result.strategy.id, 'weakWall')
    assert.equal(result.days.length, 6)
    assert.equal(result.applied, null, 'nothing applied on NIFTY')
    const { asWritten, yours } = result
    assert.ok(asWritten.r.n > 0, 'as written traded')
    assert.deepEqual(asWritten.params, {})
    assert.equal(yours.params.tradeSide, 'long')
    assert.equal(yours.params.optLeg, 'buy')
    assert.ok(yours.trades.every((t) => t.side === 'LONG'), 'only longs with tradeSide long')
    assert.ok(yours.r.n <= asWritten.r.n)
    assert.equal(yours.r.n, yours.trades.length)
    assert.ok(yours.trades.every((t) => Math.abs(Math.abs(t.entry - t.stop) / (Math.abs(asWritten.trades.find((a) => a.t === t.t && a.date === t.date)?.slPts ?? NaN)) - 1.5) < 1e-6 || !asWritten.trades.some((a) => a.t === t.t && a.date === t.date)), 'its stop 1.5x as wide')
    assert.ok(yours.option && yours.option.text && yours.option.n === yours.option.trades.length, 'the option trades it takes its own way (buy)')
    assert.ok(yours.option.trades.every((t) => t.opt.label.startsWith('BUY ')))
    assert.ok(Number.isFinite(yours.points.total) && Number.isFinite(yours.points.buy.total))
    assert.ok(!existsSync(join(history, 'runs.csv')), 'a lab run writes nothing to the tuning history')
  } finally {
    server.close()
  }
})

test('the Strategy lab job: several strategies measured at once - each as written, as applied and with the changes on top of its start', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  // weakWall is applied on NIFTY (longs only, a 1.5x stop, bought); squeeze is not applied anywhere.
  const applied = { tradeSide: 'long', tradeStopX: 1.5, tradeOptLeg: 'buy', tradeOptExit: 'indexSl', tradeOptSlPct: 30 }
  const { server, base } = await fakeServer(days, { config: { settings: {}, filtersByIndex: { NIFTY: { weakWall: applied } } } })
  const dir = mkdtempSync(join(tmpdir(), 'oa-lab-multi-'))
  try {
    const env = { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_HISTORY_DIR: join(dir, 'history'), TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' }
    // From as applied, with a 2x target on top: weakWall keeps its own longs / 1.5x stop / bought option; squeeze (none
    // applied) starts as written. An option leg of 'none' would take the applied one off.
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall', 'squeeze'], days: 30, minTrades: 2, what: 'lab', labBase: 'applied', params: { tradeTargetX: 2 } }, env)
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.ok, true)
    assert.deepEqual(result.results.map((r) => r.strategy.id), ['weakWall', 'squeeze'])
    assert.equal(result.strategy.id, 'weakWall', 'the first one at the top level too')
    const [ww, sq] = result.results
    assert.equal(ww.base, 'applied')
    assert.equal(sq.base, 'written', 'nothing applied: from as written')
    assert.ok(ww.applied && sq.applied === null)
    assert.deepEqual({ side: ww.yours.params.tradeSide, stop: ww.yours.params.tradeStopX, target: ww.yours.params.tradeTargetX, leg: ww.yours.params.optLeg }, { side: 'long', stop: 1.5, target: 2, leg: 'buy' })
    assert.deepEqual(sq.yours.params, { tradeTargetX: 2 })
    assert.deepEqual(sq.asWritten.params, {})
    assert.equal(result.days.length, 6, 'the days scanned once for both')
    // The option taken off on top of what is applied.
    const off = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'lab', labBase: 'applied', params: { optLeg: 'none' } }, env)
    assert.equal(off.code, 0, JSON.stringify(off.result))
    const offYours = off.result.results[0].yours
    assert.equal(offYours.params.tradeSide, 'long')
    assert.equal(offYours.params.optLeg, undefined)
    assert.equal(offYours.option, null)
    // WHAT IS APPLIED, nothing on top (the lab's "run what is applied"): the setting tried IS the applied one - measured
    // once, with the same numbers and the trades listed - and a strategy with nothing applied is just as written.
    const plain = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall', 'squeeze'], days: 30, minTrades: 2, what: 'lab', labBase: 'applied', params: {} }, env)
    assert.equal(plain.code, 0, JSON.stringify(plain.result))
    const [pw, ps] = plain.result.results
    assert.deepEqual(pw.yours.r, pw.applied.r, 'the applied setting is what was measured')
    assert.equal(pw.yours.trades.length, pw.yours.r.n, 'its trades are listed')
    assert.deepEqual(pw.applied.trades, [], 'the summary copy carries no second list')
    assert.deepEqual(ps.yours.r, ps.asWritten.r, 'nothing applied: as written')
    // A strategy of the other kind, an unknown one or a RETIRED one no longer takes the whole run down with it: it is
    // left out and said, so asking for every strategy still measures the ones that work.
    const wrong = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall', 'nope', 'lvnRun', 'spotWallBreak'], days: 30, minTrades: 2, what: 'lab' }, env)
    assert.equal(wrong.code, 0, JSON.stringify(wrong.result))
    assert.deepEqual(wrong.result.results.map((r) => r.strategy.id), ['weakWall'], 'the one that can run was measured')
    assert.deepEqual(wrong.result.strategiesLeftOut, [
      { id: 'nope', reason: 'no such strategy' },
      { id: 'lvnRun', reason: 'retired' },
      { id: 'spotWallBreak', reason: 'a spot + options strategy, not futures' },
    ])
    // Nothing left to measure is still a failure, and says why for each.
    const none = await runJob(base, { underlying: 'NIFTY', strategies: ['nope', 'lvnRun'], days: 30, minTrades: 2, what: 'lab' }, env)
    assert.notEqual(none.code, 0)
    assert.match(none.result.error, /nothing to measure.*nope \(no such strategy\).*lvnRun \(retired\)/)

    // SEVERAL strategies: only the setting being tried carries its trades. As written / as applied are read as a
    // summary and nothing else, so their trade lists are not shipped - with every strategy picked that was most of the
    // file. Their numbers are untouched.
    const many = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall', 'cumFlip'], days: 30, minTrades: 2, what: 'lab', params: { tradeSide: 'long' } }, env)
    assert.equal(many.code, 0, JSON.stringify(many.result))
    assert.equal(many.result.results.length, 2)
    for (const r of many.result.results) {
      assert.deepEqual(r.asWritten.trades, [], `${r.strategy.id}: as written ships no trade list`)
      assert.ok(Number.isFinite(r.asWritten.r.n) && Number.isFinite(r.asWritten.points.total), 'but keeps every number the comparison reads')
      assert.equal(r.yours.r.n, r.yours.trades.length, 'the setting tried keeps its trades')
    }
    // One strategy is the deep dive and keeps everything, as it always did.
    const one = many.result.results[0].strategy.id
    const single = await runJob(base, { underlying: 'NIFTY', strategies: [one], days: 30, minTrades: 2, what: 'lab', params: { tradeSide: 'long' } }, env)
    assert.equal(single.code, 0, JSON.stringify(single.result))
    assert.equal(single.result.asWritten.r.n, single.result.asWritten.trades.length, 'as written keeps its trades for one strategy')
  } finally {
    server.close()
  }
})

test('one slow day does not freeze the counter: the days read are counted, and the slow one is named while it is in flight', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  // The newest day - the first one the job takes, in plan order - is the slow one (an uncached day fetched from Dhan).
  const { server, base } = await fakeServer(days, { slowDay: '2026-10-05', slowDayMs: 4_000 })
  const dir = mkdtempSync(join(tmpdir(), 'oa-slow-'))
  try {
    const env = { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_DAYS_AT_ONCE: '3', TUNE_HEARTBEAT_MS: '1000', TUNE_FAST_OI: 'off' }
    const { code, result, lines } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }, env)
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.days.length, 6, 'every day still measured, in the same order')
    const scans = lines.filter((l) => l.startsWith('PROGRESS ') && /"stage":"scan"/.test(l)).map((l) => JSON.parse(l.slice(9)))
    // While the slow day was still in flight, the other days that finished were counted (not "0 of 6" throughout)...
    const whileSlow = scans.filter((x) => x.waitingOn?.some((w) => w.date === '2026-10-05'))
    assert.ok(whileSlow.length > 0, 'the slow day is named while it is in flight')
    assert.ok(whileSlow.some((x) => x.done >= 3 && x.scanned >= 3), `days read behind it are counted: ${JSON.stringify(whileSlow.map((x) => x.done))}`)
    // ...and the heartbeat says how long it has taken.
    assert.ok(whileSlow.some((x) => x.waitingOn.find((w) => w.date === '2026-10-05').secs >= 2), 'with the seconds it has been in flight')
    assert.equal(scans.at(-1).done, 6)
  } finally {
    server.close()
  }
})

test('the job stops before Dhan\'s daily limit: the days it reached are tuned, the rest listed with the reason', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days, { usageAfter: 3 })
  try {
    // One day at a time, so the stop lands on an exact day: the allowance is read before each day is started, and the
    // fake server reports it used up once three days have been fetched.
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }, { TUNE_DAYS_AT_ONCE: '1' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.deepEqual(result.days.map((d) => d.date), ['2026-10-05', '2026-10-02', '2026-10-01'])
    assert.deepEqual(result.skipped.map((x) => x.date), ['2026-09-30', '2026-09-29', '2026-09-28'])
    assert.ok(result.skipped.every((x) => /Dhan's daily Data-API limit nearly used \(95,000 of 1,00,000 calls today\)/.test(x.reason)), result.skipped[0].reason)
  } finally {
    server.close()
  }
})

test('days are read several at a time, and the job still stops on Dhan\'s daily limit', { timeout: 300_000 }, async () => {
  const days = ['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days, { usageAfter: 3 })
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }, { TUNE_DAYS_AT_ONCE: '3' })
    assert.equal(code, 0, JSON.stringify(result))
    // Several days are in flight when the allowance tips, so the stop is not on an exact day any more - but it still
    // stops well short of the plan, keeps the NEWEST days in order, and says why it left the rest.
    assert.ok(result.days.length >= 3 && result.days.length <= 5, `${result.days.length} day(s) kept`)
    const kept = result.days.map((d) => d.date)
    assert.deepEqual(kept, [...kept].sort().reverse(), 'newest first, in order - never the order the reads finished in')
    assert.deepEqual(kept, days.slice(-kept.length).reverse(), 'and they are the newest days of the plan')
    assert.equal(kept.length + result.skipped.length, days.length, 'every day is either measured or listed')
    assert.ok(result.skipped.some((x) => /Dhan's daily Data-API limit nearly used/.test(x.reason)), JSON.stringify(result.skipped))
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

// ---------------------------------------------------------------------------------------------------------------
// EVERY DAY'S DATA IS PAID FOR AT MOST ONCE, AND A JOB ALWAYS ENDS.
// The two faults these cover: a 95-day job making ~10,000 Dhan calls instead of ~4,300 (the same day's option chain
// fetched again and again), and a job that "keeps on trying and never ending". Both are checked by COUNTING the
// job's own requests per endpoint against a stated bound, not by reading the result's own claims.
// ---------------------------------------------------------------------------------------------------------------

/** How many times each endpoint was asked, with the dates folded together (the job's own report does the same). */
const perPath = (seen, from = 0) => {
  const out = {}
  for (const x of seen.slice(from)) {
    const key = x.path.replace(/\d{4}-\d{2}-\d{2}/g, '{date}')
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

test('every day is fetched at most once per kind, and the result counts the calls by source', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days)
  const dir = mkdtempSync(join(tmpdir(), 'oa-once-'))
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 0, JSON.stringify(result))
    const n = perPath(seen)

    // The option chain: served by the cycle fetch, so the per-day endpoint is not called ONCE for these days.
    assert.equal(n['/api/oi-replay/NIFTY/run'] ?? 0, 0, JSON.stringify(n))
    assert.equal(n['/api/oi-replay/NIFTY/range'], 1, 'one wide range request, not one per 5 days')
    // Futures and tape: once per day, never twice. The one extra is the day BEFORE the oldest scanned day - the
    // profile strategies' previous session, which is not itself a scanned day; every scanned day's own previous
    // session is another day of the job and shares its one request.
    assert.equal(n['/api/order-flow/NIFTY/day/{date}'], days.length + 1)
    assert.equal(n['/api/order-flow/NIFTY/tape'], days.length)
    const dayDates = seen.filter((x) => /\/day\/\d{4}-\d{2}-\d{2}$/.test(x.path)).map((x) => x.path.slice(-10))
    assert.equal(new Set(dayDates).size, dayDates.length, `a day was asked for twice: ${dayDates.join(', ')}`)

    // And the result says so, by source, so this is provable from a real run too.
    assert.equal(result.calls.bySource['option-chain-day'] ?? 0, 0)
    assert.equal(result.calls.bySource['range-window'], 1)
    // Which of the two sources paid for a day depends on which batch reached it first (a day fetched as another
    // day's previous session is then read from the cache as its own day) - the TOTAL is what matters, and the
    // unique-dates check above is what says none of them was a second fetch.
    assert.equal(result.calls.bySource['futures-day'] + result.calls.bySource['previous-session'], days.length + 1)
    assert.equal(result.calls.bySource.tape, days.length)
    assert.equal(result.calls.repeatFetches, 0, 'no day of any kind was fetched twice')
    assert.equal(result.calls.optionChain.perDayFetches, 0)
    assert.equal(result.calls.optionChain.perDayCalls, 0)
    assert.equal(result.calls.optionChain.rangeWindowCalls, 42)
    assert.equal(result.calls.optionChain.total, 42, 'the whole job\'s option chain: one cycle of 42 Dhan calls')
    assert.equal(result.calls.perKind.oi, undefined, 'the per-day option chain was never reached')
    assert.equal(result.calls.perKind.flow.most, 1)
    assert.equal(result.calls.maxFetchesPerDay, 3)
    // The measured Dhan counter, read before and after.
    assert.equal(typeof result.calls.dhan.caused, 'number')
  } finally {
    server.close()
  }
})

test('a day the SERVER itself fell back per-day for inside the range is still seeded - never paid for twice', { timeout: 300_000 }, async () => {
  // This was the doubling: the range request spent its window calls AND the per-day calls for such a day, and the
  // scan loop could then go and spend them a third time. Every usable day a range returns is now kept.
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days, { rangeFallback: ['2026-09-29', '2026-10-01'] })
  const dir = mkdtempSync(join(tmpdir(), 'oa-fb-'))
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.days.length, days.length, 'every day still scanned')
    assert.equal(perPath(seen)['/api/oi-replay/NIFTY/run'] ?? 0, 0, 'not one per-day option-chain call')
    assert.equal(result.fastOi.seeded, days.length)
    assert.equal(result.fastOi.fromFallback, 2, 'the two days the server fell back for were seeded as well')
    assert.equal(result.fastOi.fromWindows, days.length - 2)
  } finally {
    server.close()
  }
})

test('a day the range would not serve is fetched the old way exactly once', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days, { rangeUnserved: ['2026-09-30'] })
  const dir = mkdtempSync(join(tmpdir(), 'oa-uns-'))
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.days.length, days.length, 'the unserved day is still scanned, just fetched its own way')
    const asked = seen.filter((x) => x.path === '/api/oi-replay/NIFTY/run')
    assert.deepEqual(asked.map((x) => x.date), ['2026-09-30'], 'only the unserved day, and only once')
    assert.equal(result.fastOi.unservedByServer, 1)
    assert.equal(result.calls.optionChain.perDayFetches, 1)
    assert.equal(result.calls.optionChain.total, 42 + 42)
  } finally {
    server.close()
  }
})

test('the proof of the cycle fetch is kept, so a second job does not pay for it again', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days)
  const dir = mkdtempSync(join(tmpdir(), 'oa-proof-'))
  const env = { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' }
  const job = { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }
  try {
    const first = await runJob(base, job, env)
    assert.equal(first.code, 0, JSON.stringify(first.result))
    assert.match(first.result.fastOi.proof, /proved on this job/)
    assert.equal(perPath(seen)['/api/oi-replay/NIFTY/range-check'], 1)

    const before = seen.length
    const second = await runJob(base, job, env)
    assert.equal(second.code, 0, JSON.stringify(second.result))
    assert.match(second.result.fastOi.proof, /not proved again/)
    assert.equal(perPath(seen, before)['/api/oi-replay/NIFTY/range-check'] ?? 0, 0, 'the proof came from disk')
    assert.equal(second.result.fastOi.checked.match, true)
  } finally {
    server.close()
  }
})

test('a day that stays broken is given up on - never fetched again and again', { timeout: 300_000 }, async () => {
  // One day's OI comes back incomplete EVERY time. It used to cost up to eight fetches (two per attempt x the
  // initial pass plus three retry rounds) = eight x 42 Dhan calls for one unusable day. The job still finishes, the
  // day is listed with a plain reason, and the fetch ledger caps what it cost.
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days, { busyOiAlways: ['2026-09-30'] })
  const dir = mkdtempSync(join(tmpdir(), 'oa-broken-'))
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5', TUNE_FAST_OI: 'off', TUNE_MAX_FETCHES_PER_DAY: '3' })
    assert.equal(code, 0, JSON.stringify(result))
    // Every other day used; the broken one listed, not retried for ever.
    assert.deepEqual(result.days.map((d) => d.date), ['2026-10-05', '2026-10-02', '2026-10-01', '2026-09-29', '2026-09-28'])
    assert.deepEqual(result.skipped.map((x) => x.date), ['2026-09-30'])
    const asked = seen.filter((x) => x.path === '/api/oi-replay/NIFTY/run' && x.date === '2026-09-30').length
    assert.equal(asked, 3, `the broken day was fetched ${asked} times - the limit is 3`)
    assert.equal(result.calls.perKind.oi.most, 3)
    assert.ok(result.calls.refusedOverThatLimit >= 1, JSON.stringify(result.calls))
    // Every good day still cost exactly one fetch.
    assert.equal(seen.filter((x) => x.path === '/api/oi-replay/NIFTY/run' && x.date === '2026-10-05').length, 1)
  } finally {
    server.close()
  }
})

test('a job where nothing works still finishes and writes a result saying why', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, seen, base } = await fakeServer(days, { busyOiAlways: days })
  const dir = mkdtempSync(join(tmpdir(), 'oa-nothing-'))
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5', TUNE_FAST_OI: 'off', TUNE_MAX_FETCHES_PER_DAY: '2' })
    // It FINISHES - with a result file and a reason, never a hang and never a silent exit.
    assert.equal(code, 1)
    assert.equal(result.ok, false)
    assert.match(result.error, /none of the 6 day\(s\) could be scanned/)
    assert.ok(result.calls.requests > 0, JSON.stringify(result.calls))
    // And no day cost more than the limit, however hard it kept failing.
    for (const date of days) {
      assert.ok(seen.filter((x) => x.path === '/api/oi-replay/NIFTY/run' && x.date === date).length <= 2, `${date} fetched over the limit`)
    }
  } finally {
    server.close()
  }
})

test('the job\'s own time budget stops it, and the result says how many days it got to', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days, { dayDelayMs: 700 })
  const dir = mkdtempSync(join(tmpdir(), 'oa-budget-'))
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_DAYS_AT_ONCE: '1', TUNE_JOB_BUDGET_MS: '1500', TUNE_FAST_OI: 'off', TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 0, JSON.stringify(result))
    assert.equal(result.ok, true, 'the days it DID get are tuned and written')
    assert.ok(result.days.length >= 1 && result.days.length < days.length, `${result.days.length} of ${days.length} days`)
    assert.equal(result.budget.stoppedBy, 'budget')
    assert.match(result.budget.reason, /time budget of \d+ (minute|second)\(s\) ran out after \d+ of \d+ day\(s\)/)
    assert.equal(result.budget.daysScanned, result.days.length)
    assert.equal(result.days.length + result.skipped.length, result.budget.daysPlanned, 'every planned day is either used or listed')
    // The days it did not reach say so in plain words, not "unknown".
    assert.ok(result.skipped.length >= 1)
    assert.ok(result.skipped.every((x) => /time budget/.test(x.reason)), JSON.stringify(result.skipped))
  } finally {
    server.close()
  }
})

test('a budget that runs out before any day: still a result, with the budget as the reason', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days, { listDelayMs: 1_500 })
  const dir = mkdtempSync(join(tmpdir(), 'oa-budget0-'))
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_DAYS_AT_ONCE: '1', TUNE_JOB_BUDGET_MS: '1000', TUNE_FAST_OI: 'off', TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 1)
    assert.equal(result.ok, false)
    assert.match(result.error, /no day was scanned before the job's own time budget/)
    assert.equal(result.budget.stoppedBy, 'budget')
  } finally {
    server.close()
  }
})

test('the run\'s history row carries what it cost and whether it ran to the end', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days)
  const dir = mkdtempSync(join(tmpdir(), 'oa-hist-'))
  const history = join(dir, 'history')
  try {
    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_HISTORY_DIR: history, TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 0, JSON.stringify(result))
    const run = rows(join(history, 'runs.csv'))[0]
    assert.equal(Number(run.option_chain_window_calls), 42)
    assert.equal(Number(run.option_chain_per_day_calls), 0)
    assert.equal(Number(run.option_chain_calls_total), 42)
    assert.equal(Number(run.days_seeded_by_range), days.length)
    assert.equal(Number(run.repeat_day_fetches), 0)
    assert.ok(Number(run.http_requests) > 0)
    assert.equal(Number(run.budget_minutes), 90)
    assert.equal(run.stopped_by, '', 'it ran to the end')
  } finally {
    server.close()
  }
})

test('an older runs.csv with fewer columns is brought up to date, keeping every run already in it', { timeout: 300_000 }, async () => {
  // Adding a column to the history used to make every NEW row longer than the file's own header, so a reader would
  // drop it. The file is rebuilt instead, and no earlier run is lost.
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const { server, base } = await fakeServer(days)
  const dir = mkdtempSync(join(tmpdir(), 'oa-oldcsv-'))
  const history = join(dir, 'history')
  try {
    mkdirSync(history, { recursive: true })
    writeFileSync(join(history, 'runs.csv'),
      'run_id,finished_ist,index,data,tuned,days_used,trades\nNIFTY-futures-20260101-100000,2026-01-01 10:00:00,NIFTY,futures,trade,4,9\n')

    const { code, result } = await runJob(base, { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' },
      { TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_HISTORY_DIR: history, TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5' })
    assert.equal(code, 0, JSON.stringify(result))

    const runs = rows(join(history, 'runs.csv'))
    assert.equal(runs.length, 2, 'the old run is still there and the new one was added')
    assert.equal(runs[0].run_id, 'NIFTY-futures-20260101-100000')
    assert.equal(runs[0].days_used, '4', 'the old run keeps its own values')
    assert.equal(runs[0].option_chain_calls_total, '', 'and is blank under the columns it never had')
    assert.equal(Number(runs[1].option_chain_calls_total), 42)
  } finally {
    server.close()
  }
})

test('the option chain a whole span per Dhan call: only once a window across an expiry is proved, expiry days only when they match too', { timeout: 300_000 }, async () => {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const job = { underlying: 'NIFTY', strategies: ['weakWall'], days: 30, minTrades: 2, what: 'trade' }
  const run = async (faults, env = {}) => {
    const { server, seen, base: url } = await fakeServer(days, faults)
    const dir = mkdtempSync(join(tmpdir(), 'oa-span-'))
    try {
      const out = await runJob(url, job, { TUNE_RETRY_SCALE: '0.001', TUNE_BUSY_PAUSE_MS: '5', TUNE_CACHE_DIR: join(dir, 'cache'), TUNE_SPAN_DAYS: '4', ...env })
      const ranges = seen.filter((x) => x.path === '/api/oi-replay/NIFTY/range')
      return { ...out, ranges, perDayRuns: seen.filter((x) => x.path === '/api/oi-replay/NIFTY/run').length, spanChecks: seen.filter((x) => x.path === '/api/oi-replay/NIFTY/range-span-check').length }
    } finally { server.close() }
  }

  const span = await run({ span: 'pass' })
  assert.equal(span.code, 0, JSON.stringify(span.result))
  assert.equal(span.result.fastOi.span.used, true, JSON.stringify(span.result.fastOi.span))
  assert.equal(span.result.fastOi.span.includeExpiryDays, true)
  assert.deepEqual(span.ranges.map((r) => [r.query.from, r.query.to]), [['2026-09-28', '2026-10-01'], ['2026-10-02', '2026-10-05']], 'one request per span')
  assert.ok(span.ranges.every((r) => r.query.spanExpiries === 'true' && r.query.includeExpiryDays === 'true'), JSON.stringify(span.ranges.map((r) => r.query)))
  assert.equal(span.perDayRuns, 0)
  assert.equal(span.spanChecks, 1)

  // The expiry day differs: still one span, but expiry days are left to the per-day path.
  const noExpiry = await run({ span: 'expiryDiff' })
  assert.equal(noExpiry.result.fastOi.span.used, true)
  assert.ok(noExpiry.ranges.every((r) => r.query.includeExpiryDays === 'false'))

  // Not proved (or no such check on the server): one window per expiry cycle, exactly as before.
  for (const faults of [{ span: 'fail' }, {}]) {
    const old = await run(faults)
    assert.equal(old.code, 0)
    assert.equal(old.result.fastOi.span.used, false)
    assert.equal(old.result.fastOi.used, true)
    assert.ok(old.ranges.every((r) => r.query.spanExpiries === undefined), 'per-cycle range requests')
    assert.deepEqual(old.result.ranked.map((r) => [r.id, r.n, r.total]), span.result.ranked.map((r) => [r.id, r.n, r.total]), 'the same result either way')
  }

  // Switched off.
  const off = await run({ span: 'pass' }, { TUNE_SPAN_OI: 'off' })
  assert.equal(off.result.fastOi.span.used, false)
  assert.equal(off.spanChecks, 0)
})
