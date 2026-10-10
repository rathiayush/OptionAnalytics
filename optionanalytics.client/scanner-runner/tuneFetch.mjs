// How the tuning job (tune.mjs) reads past days from the server, so a long job (120 - 250 days) finishes:
//  - a request the server could not serve because Dhan (or the server) is busy - HTTP 429 / 502 / 503 / 504, a
//    network error, a timeout, or an error naming a rate limit (Dhan's DH-904 "too many requests") - is tried again
//    after a growing wait (Retry-After when the server sends one), up to `attempts` times; anything else (a holiday,
//    "no OI for the day", a bad request) fails at once - waiting would not change it;
//  - each past day's data, once fetched and checked, is kept on disk (gzip JSON under `cacheDir`): a past day does
//    not change, so a rerun, a resumed job or a longer range reads it from disk and asks Dhan nothing. Today and later
//    are never cached (still changing); a response that fails its check is never cached (fetched again next time).
//  - `pace`: a pause between the requests that do reach the server, so a long job leaves Dhan's limits to the live app;
//  - `priority()` 'background' (the default - tune.mjs always) sends "X-Request-Priority: background": the server then
//    gives the live pages and the server scanner first call on Dhan and the job what they leave (up to 5/s when quiet);
//  - the cache is kept under `cacheMaxBytes`: the least recently read days are removed first.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/** Bump when a cached response's shape changes - older files are then simply not read. */
export const CACHE_VERSION = 1
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
// "not authenticated" / "invalid token": the server's Dhan session is renewing (TOTP) - back within a few minutes.
const TRANSIENT_TEXT = /rate.?limit|too many requests|DH-904|throttl|timed? ?out|timeout|did not respond|temporarily|try again|not authenticated|invalid token|token expired|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|HTTP 429|HTTP 50[234]/i

/** Whether an error is worth trying again (the server or Dhan busy), not a fact about the day. */
export function isTransient(status, text) {
  if (status != null && TRANSIENT_STATUS.has(status)) {
    // A 500 is only busy when it says so; a 500 "no OI for the day" is the day, not the load.
    return status !== 500 || TRANSIENT_TEXT.test(text ?? '')
  }
  return status == null ? true : TRANSIENT_TEXT.test(text ?? '')
}

// Dhan's Data-API limit is per second (5/s, 100,000/day - https://dhanhq.co/docs/v2/), and the server itself already
// retries a rate limit (1 s, 2 s): what still reaches the job clears within seconds. Waiting longer only makes a long job
// slower, so every ladder is short; only the Dhan session renewing (TOTP - about two minutes) is waited out longer.
const RATE_LIMIT_TEXT = /rate.?limit|too many|DH-904|(^|\D)805(\D|$)|HTTP 429/i
const AUTH_TEXT = /not authenticated|invalid token|token expired|access token|DH-901/i
export const isRateLimitText = (text) => RATE_LIMIT_TEXT.test(text ?? '')

/** What kind of busy an error is: 'rate' (Dhan's rate limit), 'auth' (the server's Dhan session renewing) or 'busy'
 *  (a 5xx / timeout / network error). */
export const busyKind = (status, text) => (status === 429 || isRateLimitText(text) ? 'rate' : AUTH_TEXT.test(text ?? '') ? 'auth' : 'busy')

/** The waits before each retry, by kind (then it fails - the day is listed as skipped and tried once more at the end). */
export const RETRY_LADDER = { rate: [2_000, 4_000, 8_000], auth: [20_000, 40_000, 80_000], busy: [2_000, 5_000] }

/** The wait before retry `i` (0 = the first) of a `kind` error, or null when its ladder is used up. A server Retry-After is
 *  followed, up to 30 s. `scale` shrinks every wait (tests). */
export function retryDelayMs(i, retryAfter = null, kind = 'busy', scale = 1) {
  const ladder = RETRY_LADDER[kind] ?? RETRY_LADDER.busy
  if (i >= ladder.length) return null
  const after = Number(retryAfter)
  if (Number.isFinite(after) && after > 0) return Math.round(Math.min(30_000, after * 1000) * scale)
  return Math.round(ladder[i] * scale)
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether an error TEXT (no status - e.g. a day's "success: false" reason, or one strike's error) is the load, not the day. */
export const isTransientText = (text) => TRANSIENT_TEXT.test(text ?? '')

/** Keeps the cache directory under `maxBytes`, removing the least recently read files first (reads touch the file). */
export function pruneCache(dir, maxBytes) {
  if (!dir || !(maxBytes > 0) || !existsSync(dir)) return { removed: 0, bytes: 0 }
  const files = []
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json.gz')) { const st = statSync(p); files.push({ p, size: st.size, at: st.mtimeMs }) } } }
  walk(dir)
  let bytes = files.reduce((a, f) => a + f.size, 0)
  let removed = 0
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (bytes <= maxBytes) break
    try { rmSync(f.p); bytes -= f.size; removed++ } catch { /* in use: next time */ }
  }
  return { removed, bytes }
}

export function createFetcher({ base = '', key = '', cacheDir = null, today, attempts = 6, paceMs = 0, timeoutMs = 120_000, fetchImpl = globalThis.fetch, sleep = sleepReal, onWait = () => {}, now = () => Date.now(), priority = () => 'background', retryScale = 1 } = {}) {
  const stats = { requests: 0, retries: 0, cacheHits: 0, cacheWrites: 0, shared: 0, waitedMs: 0 }
  let lastRequest = -Infinity

  async function once(path) {
    if (paceMs > 0) {
      const gap = lastRequest + paceMs - now()
      if (gap > 0) { stats.waitedMs += gap; await sleep(gap) }
    }
    lastRequest = now()
    stats.requests++
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    let res
    try {
      const headers = { 'X-Runner-Key': key, ...(priority() === 'background' ? { 'X-Request-Priority': 'background' } : {}) }
      res = await fetchImpl(path.startsWith('/') ? `${base}${path}` : path, { headers, signal: controller?.signal })
    } catch (err) {
      const e = new Error(`${path.split('?')[0]}: ${err.name === 'AbortError' ? `no answer in ${Math.round(timeoutMs / 1000)} s (timed out)` : err.message}`)
      e.transient = true
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
    const text = await res.text()
    if (!res.ok) {
      let reason = text.slice(0, 300)
      try { reason = JSON.parse(text)?.error ?? reason } catch { /* not JSON */ }
      const e = new Error(`${path.split('?')[0]}: ${reason || `HTTP ${res.status}`}`)
      e.status = res.status
      e.transient = isTransient(res.status, reason)
      e.retryAfter = res.headers?.get?.('retry-after') ?? null
      throw e
    }
    return text ? JSON.parse(text) : null
  }

  /** GET `path` from the server, trying again while it is busy: each kind of busy walks its OWN ladder (a rate limit
   *  clears in seconds, a renewing Dhan session takes a couple of minutes), and `attempts` caps the tries in all. */
  async function api(path, { label = path.split('?')[0] } = {}) {
    const tries = { rate: 0, auth: 0, busy: 0 }
    for (let i = 0; ; i++) {
      try {
        return await once(path)
      } catch (err) {
        const kind = busyKind(err.status, err.message)
        const wait = err.transient && i + 1 < attempts ? retryDelayMs(tries[kind], err.retryAfter, kind, retryScale) : null
        if (wait == null) {
          if (err.transient) err.message = `${err.message} (still failing after ${i + 1} tries)`
          throw err
        }
        tries[kind]++
        stats.retries++
        stats.waitedMs += wait
        onWait({ label, attempt: i + 2, of: Math.min(attempts, i + 2 + (RETRY_LADDER[kind].length - tries[kind])), waitMs: wait, reason: err.message })
        await sleep(wait)
      }
    }
  }

  const fileOf = (name, date, path) => {
    let h = 0
    for (const ch of path) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
    return join(cacheDir, `v${CACHE_VERSION}`, date.slice(0, 7), `${date}-${name}-${(h >>> 0).toString(36)}.json.gz`)
  }

  // The same thing asked for twice at once (several days are scanned together, and one day's "previous session" is
  // often another day of the batch) is fetched once and shared - no double Dhan call, and no two writers on one file.
  const inFlight = new Map()

  /** `api(path)` for a PAST day's data, kept on disk once fetched and `valid(body)`. */
  async function dayApi(name, date, path, valid = (b) => b != null) {
    const cacheable = !!cacheDir && typeof date === 'string' && date < today
    const file = cacheable ? fileOf(name, date, path) : null
    if (file && existsSync(file)) {
      try {
        const body = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'))
        stats.cacheHits++
        try { const t = new Date(now()); utimesSync(file, t, t) } catch { /* read-only: no matter */ }
        return body
      } catch { /* a damaged file: fetch it again */ }
    }
    const already = inFlight.get(path)
    if (already) { stats.shared++; return already }
    const pending = (async () => {
      const body = await api(path)
      if (file && valid(body)) {
        try {
          mkdirSync(dirname(file), { recursive: true })
          // A name of its own, so two writers can never be in one temporary file; the rename onto the final name is
          // atomic, so a reader sees either the old file or a whole new one.
          const tmp = `${file}.${process.pid}.${(stats.cacheWrites + 1).toString(36)}.tmp`
          writeFileSync(tmp, gzipSync(JSON.stringify(body)))
          renameSync(tmp, file)
          stats.cacheWrites++
        } catch { /* no room on disk: the job goes on uncached */ }
      }
      return body
    })()
    inFlight.set(path, pending)
    try { return await pending } finally { inFlight.delete(path) }
  }

  /** Puts a PAST day's body into the cache as if it had been fetched for `path` - so a later `dayApi` for that day
   *  reads it from disk and asks the server nothing. Used by a range fetch that brought many days back at once; a body
   *  that fails `valid` is not kept. Returns whether it was kept. */
  function putDay(name, date, path, body, valid = (b) => b != null) {
    if (!cacheDir || typeof date !== 'string' || !(date < today) || !valid(body)) return false
    const file = fileOf(name, date, path)
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.p${(stats.cacheWrites + 1).toString(36)}.tmp`
      writeFileSync(tmp, gzipSync(JSON.stringify(body)))
      renameSync(tmp, file)
      stats.cacheWrites++
      return true
    } catch { return false }
  }

  return { api, dayApi, putDay, stats }
}
