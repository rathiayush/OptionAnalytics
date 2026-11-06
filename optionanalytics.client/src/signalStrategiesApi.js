// The Signal backtest's SAVED STRATEGIES - the API (SignalStrategyController, CSV on the server) and the page's list of
// them. The page's part (the card, the save dialog, the history) is SignalStrategiesCard.jsx.
import { useCallback, useEffect, useState } from 'react'
import { POLL_HEADERS } from './shared.jsx'

const API = '/api/signal-strategies'

async function api(path, options) {
  const r = await fetch(path, options)
  const text = await r.text()
  if (!r.ok) {
    let reason = text.slice(0, 200)
    try { reason = JSON.parse(text)?.error ?? reason } catch { /* not JSON */ }
    throw new Error(reason || `HTTP ${r.status}`)
  }
  return text ? JSON.parse(text) : null
}
const send = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const createStrategy = (body) => api(API, send('POST', body))
export const updateStrategy = (id, body) => api(`${API}/${encodeURIComponent(id)}`, send('PUT', body))
export const deleteStrategy = (id) => api(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** A strategy's history: { days, trades, events, orders } - the live scan's CSV rows (`timer`: a page timer's refresh). */
export const strategyHistory = (id, timer = false) => api(`${API}/${encodeURIComponent(id)}/history`, timer ? { headers: POLL_HEADERS } : undefined)
export const historyCsvUrl = (id, kind) => `${API}/${encodeURIComponent(id)}/history/${kind}.csv`

/** The saved strategies ({ today, liveScan, strategies }): listed on opening, then - a page TIMER, with POLL_HEADERS -
 *  each minute while one is on Live (today's live events counted), and when the tab comes back into view. */
export function useSavedStrategies() {
  const [data, setData] = useState(null)
  const refresh = useCallback(async (timer = false) => {
    try { setData(await api(API, timer ? { headers: POLL_HEADERS } : undefined)) } catch { /* kept as it was */ }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const anyLive = Boolean(data?.strategies?.some((s) => s.live))
  useEffect(() => {
    if (!anyLive) return undefined
    const id = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(true) }, 60_000)
    return () => clearInterval(id)
  }, [anyLive, refresh])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])
  return { strategies: data?.strategies ?? [], today: data?.today ?? null, liveScan: data?.liveScan ?? null, loaded: data != null, refresh }
}
