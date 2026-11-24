import { useCallback, useEffect, useRef, useState } from 'react'
import { POLL_HEADERS } from './shared.jsx'
import { addOrders } from './tickBigOrders.js'

/**
 * The big option orders of TrueData's live option ticks (`GET /api/tick-flow/options?since=`): the stream's state, and the orders so far - the
 * server sends only those after the last sequence seen, and the page keeps the newest few thousand. A page timer (POLL_HEADERS), every 2 s while
 * `enabled`; a server whose sequence starts again (a restart) starts the list over. `pick(index, strikes)` (admin) chooses the index streamed.
 * One hook for the Tick Flow page's card and OI Replay's spot chart - nothing else polls it.
 */
export function useBigOptionOrders(enabled) {
  const [orders, setOrders] = useState([])
  const [state, setState] = useState(null)
  const [live, setLive] = useState(true)     // false = the TrueData live feed is off on the server
  const [error, setError] = useState(null)
  const [now, setNow] = useState(0)
  const [reload, setReload] = useState(0)
  const since = useRef(0)

  useEffect(() => {
    if (!enabled) return undefined
    let stop = false
    const load = async () => {
      try {
        const r = await fetch(`/api/tick-flow/options?since=${since.current}`, { headers: POLL_HEADERS })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = await r.json()
        if (stop) return
        setLive(body.enabled !== false)
        setNow(Date.now())
        setError(null)
        const options = body.options ?? null
        // Nothing changed in the state: keep the object (no render for it).
        setState((prev) => (prev && options && JSON.stringify(prev) === JSON.stringify(options) ? prev : options))
        if (options && options.lastSeq < since.current) { since.current = 0; setOrders([]); return }   // the server started its sequence again
        if (body.events?.length) {
          since.current = body.events[body.events.length - 1].seq
          setOrders((kept) => addOrders(kept, body.events))
        }
      } catch (e) { if (!stop) setError(e.message) }
    }
    load()
    const timer = setInterval(load, 2000)
    return () => { stop = true; clearInterval(timer) }
  }, [enabled, reload])

  const pick = useCallback(async (underlying, strikes) => {
    try {
      const r = await fetch('/api/tick-flow/options', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ underlying, strikes }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
      since.current = 0
      setOrders([])
      setReload((n) => n + 1)
    } catch (e) { setError(e.message) }
  }, [])

  return { orders, state, live, error, now, pick }
}
