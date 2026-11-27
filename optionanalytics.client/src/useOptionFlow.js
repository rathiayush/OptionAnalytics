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

/**
 * The options' flow of a PAST day (`GET /api/tick-flow/options/day?underlying&date&flow=true`): the same server build as the big orders' replay (one TrueData
 * history call per option contract over the day's futures range, a few minutes the first time, then kept) - the page asks until it is ready (a page timer,
 * POLL_HEADERS, every 3 s while loading) and then holds every minute of the day; the replay cuts it at its clock. `enabled` false = nothing asked.
 */
export function useOptionFlowDay(underlying, date, enabled) {
  const [answer, setAnswer] = useState(null)
  const [error, setError] = useState(null)
  const [rows, setRows] = useState([])
  useEffect(() => {
    setAnswer(null); setError(null); setRows([])
    if (!enabled || !underlying || !date) return undefined
    let stop = false
    let timer = null
    const load = async () => {
      try {
        const r = await fetch(`/api/tick-flow/options/day?underlying=${encodeURIComponent(underlying)}&date=${date}&flow=true`, { headers: POLL_HEADERS })
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
        const body = await r.json()
        if (stop) return
        setError(null)
        setAnswer({ state: body.state, done: body.done, total: body.total, error: body.error })
        if (body.state === 'ready') {
          setRows((Array.isArray(body.flow) ? body.flow : []).map((x) => ({ t: x.t, symbol: x.symbol, type: x.type, strike: x.strike, buy: x.buy, sell: x.sell, open: x.open, close: x.close, lot: x.lotSize })))
          return
        }
        if (body.state === 'failed') return
        timer = setTimeout(load, 3000)
      } catch (e) { if (!stop) { setError(e.message); timer = setTimeout(load, 10000) } }
    }
    load()
    return () => { stop = true; clearTimeout(timer) }
  }, [underlying, date, enabled])
  return { rows, answer, error, ready: answer?.state === 'ready' }
}
