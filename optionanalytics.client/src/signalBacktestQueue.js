// The Signal backtest's BACKGROUND runs - the API (SignalBacktestController) and the page's list of them. The page's part
// (the queue dialog, the list) is SignalBacktestRuns.jsx.
import { useCallback, useEffect, useState } from 'react'
import { POLL_HEADERS } from './shared.jsx'
import { reportReviver } from './signalBacktestJob.js'

const API = '/api/signal-backtest/jobs'

async function api(path, options) {
  const r = await fetch(path, options)
  const text = await r.text()
  if (!r.ok) {
    let reason = text.slice(0, 200)
    try { reason = JSON.parse(text)?.error ?? reason } catch { /* not JSON */ }
    throw new Error(reason || `HTTP ${r.status}`)
  }
  return text ? JSON.parse(text, reportReviver) : null
}
export const queueRun = (body) => api(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const cancelRun = (id) => api(`${API}/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
export const deleteRun = (id) => api(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** A finished run's report: { ok, settings, dates, report } (Infinity kept). */
export const runResult = (id) => api(`${API}/${encodeURIComponent(id)}/result`)

/** The next close of the session (15:45 IST today) while the market is open or yet to open today, else null (= now). */
export function afterTheClose(nowMs = Date.now()) {
  const ist = new Date(nowMs + 5.5 * 3_600_000)
  if (ist.getUTCDay() === 0 || ist.getUTCDay() === 6) return null
  const close = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 10, 15)   // 15:45 IST
  return nowMs < close ? close : null
}

/** The runs: listed on opening, then - a page TIMER, so with POLL_HEADERS - every 5 s while one runs or waits to run now,
 *  every 30 s while one only waits for its time, and again when the tab comes back into view. */
export function useBackgroundRuns() {
  const [jobs, setJobs] = useState(null)
  const refresh = useCallback(async (timer = false) => {
    try { setJobs(await api(API, timer ? { headers: POLL_HEADERS } : undefined)) } catch { /* kept as it was */ }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  // A run set for later is seen starting by the 30 s round.
  const busy = Boolean(jobs?.some((j) => j.state === 'running' || (j.state === 'queued' && !j.startAtUtc)))
  const waiting = Boolean(jobs?.some((j) => j.state === 'queued'))
  useEffect(() => {
    if (!busy && !waiting) return undefined
    const id = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(true) }, busy ? 5_000 : 30_000)
    return () => clearInterval(id)
  }, [busy, waiting, refresh])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])
  return { jobs: jobs ?? [], refresh }
}

