import { useEffect, useState } from 'react'
import { POLL_HEADERS } from './shared.jsx'
import { previousWeekdays } from './tickFlowMath.js'
import { ordersOfDay } from './tickBigOrders.js'

// The sessions BEFORE the day on the Tick Flow page's profile cards (asked for - "load previous day data into these profiles and cache them"): for each of the
// `days` weekdays before `date` the futures day (`GET /api/tick-flow/{u}/profile-day` - 1-minute bars with their footprint rows, kept on the server's disk once
// built) and, when the card needs it, the day's big option orders (`GET /api/tick-flow/options/day` - built once from TrueData's tick history, kept on disk).
// A TICK, never a timer of its own: asked when `enabled`, walked ONE DAY AT A TIME newest first, a day with no data (a holiday, one TrueData no longer keeps -
// a 404) stepped over, any other failure STOPS the walk and says which day (never a loop). A day that came back is kept for the tab. NIFTY only for now - the
// server answers 404 for another index.
const KEPT = new Map()
const WALK_EXTRA = 4

const getJson = async (url) => {
  const r = await fetch(url, { headers: POLL_HEADERS })
  const body = await r.json().catch(() => null)
  return { ok: r.ok, status: r.status, body }
}

async function futuresOf(index, date) {
  const key = `f|${index}|${date}`
  if (KEPT.has(key)) return KEPT.get(key)
  const { ok, status, body } = await getJson(`/api/tick-flow/${encodeURIComponent(index)}/profile-day?date=${date}`)
  if (status === 404) return { missing: body?.error ?? 'no data' }
  if (!ok) throw new Error(body?.error ?? `HTTP ${status}`)
  const day = { bars: body.bars ?? [], lotSize: body.lotSize || 1 }
  KEPT.set(key, day)
  return day
}

async function optionsOf(index, date, stopRef, onProgress) {
  const key = `o|${index}|${date}`
  if (KEPT.has(key)) return KEPT.get(key)
  for (;;) {
    const { ok, status, body } = await getJson(`/api/tick-flow/options/day?underlying=${encodeURIComponent(index)}&date=${date}`)
    if (stopRef.stop) return null
    if (status === 404) return { missing: body?.error ?? 'no data' }
    if (!ok) throw new Error(body?.error ?? `HTTP ${status}`)
    if (body.state === 'failed') return { missing: body.error ?? 'the option ticks could not be built' }
    if (body.state === 'ready') { const day = { orders: ordersOfDay(body.events ?? []) }; KEPT.set(key, day); return day }
    onProgress(`${date}: option ticks ${body.done ?? 0} of ${body.total ?? '?'} contracts`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    if (stopRef.stop) return null
  }
}

/** { sessions: [{ date, bars, lotSize, orders }] (newest first), status: 'idle' | 'loading' | 'done' | 'error', note, error } */
export function usePastTickDays({ index, date, days, enabled, withOptions }) {
  const [state, setState] = useState({ sessions: [], status: 'idle', note: '', error: null })
  useEffect(() => {
    if (!enabled || !index || !date) { setState({ sessions: [], status: 'idle', note: '', error: null }); return undefined }
    const stopRef = { stop: false }
    const sessions = []
    const skipped = []
    setState({ sessions: [], status: 'loading', note: 'Loading the previous session…', error: null })
    ;(async () => {
      try {
        for (const d of previousWeekdays(date, days + WALK_EXTRA)) {
          if (sessions.length >= days || stopRef.stop) break
          setState((s) => ({ ...s, note: `Loading ${d}…` }))
          const f = await futuresOf(index, d)
          if (stopRef.stop) return
          if (f.missing) { skipped.push(`${d}: ${f.missing}`); continue }
          let orders = []
          if (withOptions) {
            const o = await optionsOf(index, d, stopRef, (note) => !stopRef.stop && setState((s) => ({ ...s, note })))
            if (stopRef.stop) return
            if (o?.missing) { skipped.push(`${d}: ${o.missing}`); continue }
            orders = o.orders
          }
          sessions.push({ date: d, bars: f.bars, lotSize: f.lotSize, orders })
          setState({ sessions: [...sessions], status: 'loading', note: `Loaded ${sessions.length} of ${days}…`, error: null })
        }
        if (!stopRef.stop) setState({ sessions: [...sessions], status: 'done', note: skipped.length ? `Stepped over: ${skipped.join(' · ')}` : '', error: null })
      } catch (e) {
        if (!stopRef.stop) setState({ sessions: [...sessions], status: 'error', note: '', error: e.message })
      }
    })()
    return () => { stopRef.stop = true }
  }, [index, date, days, enabled, withOptions])
  return state
}
