import { useEffect, useRef, useState } from 'react'
import { POLL_HEADERS } from './shared.jsx'
import { mergeFlowRows } from './tickOptionFlow.js'

/**
 * The options' minute-by-minute flow from TrueData's live option ticks (`GET /api/tick-flow/options/flow?since=`): the first answer is the whole day, then
 * only the minutes from the last one seen (the forming minute comes again). A page timer (POLL_HEADERS), every 5 s while `enabled`. Live only.
 */
export function useOptionFlow(enabled) {
  const [rows, setRows] = useState([])
  const [live, setLive] = useState(true)
  const [optionTicks, setOptionTicks] = useState(true)
  const [error, setError] = useState(null)
  const since = useRef(0)
  useEffect(() => {
    if (!enabled) return undefined
    let stop = false
    const load = async () => {
      try {
        const r = await fetch(`/api/tick-flow/options/flow?since=${since.current}`, { headers: POLL_HEADERS })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = await r.json()
        if (stop) return
        setLive(body.enabled !== false)
        setOptionTicks(body.optionTicks !== false)
        setError(null)
        const fresh = (Array.isArray(body.rows) ? body.rows : []).map((x) => ({ t: x.t, symbol: x.symbol, type: x.type, strike: x.strike, buy: x.buy, sell: x.sell, open: x.open, close: x.close, lot: x.lotSize }))
        if (fresh.length) {
          since.current = Math.max(...fresh.map((x) => x.t))
          setRows((kept) => mergeFlowRows(kept, fresh))
        }
      } catch (e) { if (!stop) setError(e.message) }
    }
    load()
    const timer = setInterval(load, 5000)
    return () => { stop = true; clearInterval(timer) }
  }, [enabled])
  return { rows, live, optionTicks, error }
}
