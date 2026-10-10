// How the tuning job (tune.mjs) reads past days from the server, so a long job (120 - 250 days) finishes:
//  - a request the server could not serve because Dhan (or the server) is busy - HTTP 429 / 502 / 503 / 504, a
//    network error, a timeout, or an error naming a rate limit (Dhan's DH-904 "too many requests") - is tried again
//    after a growing wait (Retry-After when the server sends one), up to `attempts` times; anything else (a holiday,
//    "no OI for the day", a bad request) fails at once - waiting would not change it;
//  - each past day's data, once fetched and checked, is kept on disk (gzip JSON under `cacheDir`): a past day does
//    not change, so a rerun, a resumed job or a longer range reads it from disk and asks Dhan nothing. Today and later
//    are never cached (still changing); a response that fails its check is never cached (fetched again next time).
//  - `pace`: a pause between the requests that do reach the server, so a long job leaves Dhan's limits to the live app;
//  - `priority()` 'background' (tune.mjs: during market hours) sends "X-Request-Priority: background": the server then
//    serves the request's Dhan calls from its background lane, never from the live pages' / server scanner's;
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

/** The wait before try `i` (0 = the first retry): 5 s, 15 s, 45 s, 2 min 15, 5 min, 5 min ... or the server's Retry-After. */
export function retryDelayMs(i, retryAfter = null, baseMs = 5_000) {
  const after = Number(retryAfter)
  if (Number.isFinite(after) && after > 0) return Math.min(600_000, after * 1000)
  return Math.min(60 * baseMs, baseMs * 3 ** i)
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether an error TEXT (no status - e.g. a day's "success: false" reason, or one strike's error) is the load, not the day. */
export const isTransientText = (text) => TRANSIENT_TEXT.test(text ?? '')

/** Market hours (IST, Monday - Friday, 09:00 - 15:45): when the live pages and the server scanner use Dhan. */
export function inMarketHours(ms = Date.now()) {
  const ist = new Date(ms + 330 * 60_000)
  const day = ist.getUTCDay()
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes()
  return day >= 1 && day <= 5 && minute >= 9 * 60 && minute <= 15 * 60 + 45
}

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

export function createFetcher({ base = '', key = '', cacheDir = null, today, attempts = 6, paceMs = 0, timeoutMs = 300_000, fetchImpl = globalThis.fetch, sleep = sleepReal, onWait = () => {}, now = () => Date.now(), priority = () => 'interactive', retryBaseMs = 5_000 } = {}) {
  const stats = { requests: 0, retries: 0, cacheHits: 0, cacheWrites: 0, waitedMs: 0 }
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

  /** GET `path` from the server, trying again while it is busy. */
  async function api(path, { label = path.split('?')[0] } = {}) {
    for (let i = 0; ; i++) {
      try {
        return await once(path)
      } catch (err) {
        if (!err.transient || i + 1 >= attempts) {
          if (err.transient) err.message = `${err.message} (still failing after ${attempts} tries)`
          throw err
        }
        const wait = retryDelayMs(i, err.retryAfter, retryBaseMs)
        stats.retries++
        stats.waitedMs += wait
        onWait({ label, attempt: i + 2, of: attempts, waitMs: wait, reason: err.message })
        await sleep(wait)
      }
    }
  }

  const fileOf = (name, date, path) => {
    let h = 0
    for (const ch of path) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
    return join(cacheDir, `v${CACHE_VERSION}`, date.slice(0, 7), `${date}-${name}-${(h >>> 0).toString(36)}.json.gz`)
  }

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
    const body = await api(path)
    if (file && valid(body)) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.tmp`, gzipSync(JSON.stringify(body)))
        renameSync(`${file}.tmp`, file)
        stats.cacheWrites++
      } catch { /* no room on disk: the job goes on uncached */ }
    }
    return body
  }

  return { api, dayApi, stats }
}
