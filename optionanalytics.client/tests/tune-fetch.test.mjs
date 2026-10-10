// The tuning job's reads (scanner-runner/tuneFetch.mjs): a busy server / Dhan rate limit is tried again after a
// growing wait (Retry-After when sent) and gives up after the set tries; a fact about the day (a holiday, no OI) fails
// at once; a past day's checked data is kept on disk and read back without asking the server; today is never cached
// and a response that fails its check is not kept. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { busyKind, createFetcher, isTransient, retryDelayMs } from '../scanner-runner/tuneFetch.mjs'

/** A fake server: `script` is a list of responses ({ status, body, retryAfter } or 'network'), served in turn. */
function fakeServer(script) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const r = script[Math.min(calls.length - 1, script.length - 1)]
    if (r === 'network') throw new TypeError('fetch failed')
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body ?? null), headers: { get: (h) => (h === 'retry-after' ? r.retryAfter ?? null : null) } }
  }
  return { calls, fetchImpl }
}
const noSleep = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms) } } }

test('what is worth trying again: busy / rate-limited, not a fact about the day', () => {
  assert.equal(isTransient(429, ''), true)
  assert.equal(isTransient(503, ''), true)
  assert.equal(isTransient(500, 'Dhan DH-904: Too many requests'), true)
  assert.equal(isTransient(500, 'no OI for the day'), false, 'a 500 that is the day, not the load')
  assert.equal(isTransient(404, 'no bars'), false)
  assert.equal(isTransient(400, 'rate limit exceeded'), true)
  assert.equal(isTransient(null, 'fetch failed'), true, 'a network error')
  // What kind of busy, and how long each waits. Dhan's limit is per second and the server has already retried, so the
  // ladders are short and END (null = give up, skip the day, try it once more at the end of the job) - a long job must
  // never sit for minutes on one day. Only the Dhan session renewing (TOTP, about two minutes) waits longer.
  assert.deepEqual(['rate', 'auth', 'busy'].map((k) => [0, 1, 2, 3].map((i) => retryDelayMs(i, null, k))), [
    [2_000, 4_000, 8_000, null],
    [20_000, 40_000, 80_000, null],
    [2_000, 5_000, null, null],
  ])
  assert.equal(busyKind(429, ''), 'rate')
  assert.equal(busyKind(500, 'DH-904: Too many requests'), 'rate')
  assert.equal(busyKind(500, '805: too many requests or connections'), 'rate')
  assert.equal(busyKind(503, 'Dhan is not authenticated'), 'auth')
  assert.equal(busyKind(503, 'busy'), 'busy')
  assert.equal(retryDelayMs(0, '20'), 20_000, 'Retry-After wins')
  assert.equal(retryDelayMs(0, '600'), 30_000, 'but never more than 30 s')
  // The longest a single request can hold a job up: under a minute, except a renewing session (under 2 1/2).
  const total = (k) => [0, 1, 2, 3].map((i) => retryDelayMs(i, null, k) ?? 0).reduce((a, b) => a + b, 0)
  assert.ok(total('rate') <= 15_000 && total('busy') <= 10_000 && total('auth') <= 150_000, JSON.stringify(['rate', 'auth', 'busy'].map(total)))
})

test('a rate limit is waited out and the request goes through', async () => {
  const { calls, fetchImpl } = fakeServer([{ status: 429, body: { error: 'Too many requests' }, retryAfter: '7' }, { status: 500, body: { error: 'DH-904: Too many requests on server from single user breaching rate limits' } }, 'network', { status: 200, body: { ok: 1 } }])
  const { waits, sleep } = noSleep()
  const seen = []
  const f = createFetcher({ fetchImpl, sleep, today: '2026-10-10', onWait: (w) => seen.push(w) })
  assert.deepEqual(await f.api('/api/x'), { ok: 1 })
  assert.equal(calls.length, 4)
  assert.deepEqual(waits, [7_000, 4_000, 2_000], 'Retry-After, the rate-limit ladder, then a network error on its own ladder - seconds, never minutes')
  assert.deepEqual(seen.map((w) => w.attempt), [2, 3, 4])
  assert.equal(f.stats.retries, 3)
})

test('it gives up when the ladder ends, and never retries a fact about the day', async () => {
  const busy = fakeServer([{ status: 503, body: { error: 'busy' } }])
  const { waits, sleep } = noSleep()
  const f = createFetcher({ fetchImpl: busy.fetchImpl, sleep, today: '2026-10-10' })
  await assert.rejects(f.api('/api/x'), /busy \(still failing after 3 tries\)/)
  assert.equal(busy.calls.length, 3, 'a 5xx: two retries, then the day is skipped')
  assert.deepEqual(waits, [2_000, 5_000])
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 10_000, 'at most ~7 s held up by one request')
  const holiday = fakeServer([{ status: 500, body: { error: 'no OI for the day' } }])
  const g = createFetcher({ fetchImpl: holiday.fetchImpl, sleep: noSleep().sleep, today: '2026-10-10' })
  await assert.rejects(g.api('/api/oi'), /no OI for the day$/)
  assert.equal(holiday.calls.length, 1, 'no waiting for a holiday')
})

test('a past day is kept on disk and read back without the server; today and a failed check are not kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tune-cache-'))
  try {
    const srv = fakeServer([{ status: 200, body: { bars: [1, 2, 3] } }])
    const f = createFetcher({ fetchImpl: srv.fetchImpl, sleep: noSleep().sleep, today: '2026-10-10', cacheDir: dir })
    const valid = (b) => b?.bars?.length > 0
    assert.deepEqual(await f.dayApi('day', '2026-10-08', '/api/day/2026-10-08?a=1', valid), { bars: [1, 2, 3] })
    assert.deepEqual(await f.dayApi('day', '2026-10-08', '/api/day/2026-10-08?a=1', valid), { bars: [1, 2, 3] })
    assert.equal(srv.calls.length, 1, 'the second read came from disk')
    // A second job (a new fetcher) on the same cache: nothing asked of the server.
    const again = fakeServer([{ status: 500, body: { error: 'must not be called' } }])
    const g = createFetcher({ fetchImpl: again.fetchImpl, sleep: noSleep().sleep, today: '2026-10-10', cacheDir: dir })
    assert.deepEqual(await g.dayApi('day', '2026-10-08', '/api/day/2026-10-08?a=1', valid), { bars: [1, 2, 3] })
    assert.equal(again.calls.length, 0)
    assert.equal(g.stats.cacheHits, 1)
    // Another query of the same day is its own entry.
    await f.dayApi('day', '2026-10-08', '/api/day/2026-10-08?a=2', valid)
    assert.equal(srv.calls.length, 2)
    // Today: always fetched.
    await f.dayApi('day', '2026-10-10', '/api/day/2026-10-10', valid)
    await f.dayApi('day', '2026-10-10', '/api/day/2026-10-10', valid)
    assert.equal(srv.calls.length, 4)
    // A response that fails its check is not kept.
    const empty = fakeServer([{ status: 200, body: { bars: [] } }])
    const h = createFetcher({ fetchImpl: empty.fetchImpl, sleep: noSleep().sleep, today: '2026-10-10', cacheDir: dir })
    await h.dayApi('day', '2026-10-07', '/api/day/2026-10-07', valid)
    await h.dayApi('day', '2026-10-07', '/api/day/2026-10-07', valid)
    assert.equal(empty.calls.length, 2)
    assert.equal(readdirSync(join(dir, 'v1', '2026-10')).filter((n) => n.startsWith('2026-10-07')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('requests are paced: a pause between the ones that reach the server', async () => {
  const srv = fakeServer([{ status: 200, body: {} }])
  let clock = 0
  const waits = []
  const f = createFetcher({ fetchImpl: srv.fetchImpl, today: '2026-10-10', paceMs: 1_500, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms } })
  await f.api('/a'); clock += 200
  await f.api('/b')
  await f.api('/c')
  assert.deepEqual(waits, [1_300, 1_500])
})
