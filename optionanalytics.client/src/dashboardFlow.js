import { useEffect, useMemo, useState } from 'react'
import { sanitizeLine } from './chartLine.js'

// Today's option CDV and OBV exactly as the dashboard shows them - the server's own CDV engine (CdvUnderlyingState),
// which classifies every live tick (up-tick buys, down-tick sells) instead of reading minute candles. Read from server
// memory only (no Dhan call): the CDV and OBV series every SERIES_POLL_MS, the forming minute's CDV every
// SNAPSHOT_POLL_MS, so the line ticks. Shaped like optionFlowSeries ({ ceCdv, peCdv, ceObv, peObv }, each
// [{ time (ms), value }]) and cut to today, so the OI Replay page can show it in place of its own minute-bar estimate.

const SERIES_POLL_MS = 30_000
const SNAPSHOT_POLL_MS = 2_000
const IST_OFFSET_MS = 330 * 60_000
const istDay = (ms) => Math.floor((ms + IST_OFFSET_MS) / 86_400_000)

/** The dashboard's series cut to the IST day of their newest point, as `[{ time (ms), value }]`. */
export function dashboardFlowFromSeries(cdvBars, obv) {
  const cdv = (cdvBars ?? []).map((p) => ({ ms: new Date(p.time).getTime(), ce: Number(p.ceCdv), pe: Number(p.peCdv) })).filter((p) => Number.isFinite(p.ms))
  const day = cdv.length ? istDay(cdv.at(-1).ms) : null
  const today = (ms) => day != null && istDay(ms) === day
  const line = (points, key) => points.filter((p) => today(p.ms) && Number.isFinite(p[key])).map((p) => ({ time: p.ms, value: p[key] }))
  const obvLine = (points) => (points ?? []).map((p) => ({ ms: new Date(p.time).getTime(), v: Number(p.obv) }))
    .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.v) && today(p.ms)).map((p) => ({ time: p.ms, value: p.v }))
  // The server's series can repeat a minute or hold one out of order (a backfill joined to live bars) - one point per
  // minute, in time order, the later of a repeated one (sanitizeLine).
  return { ceCdv: sanitizeLine(line(cdv, 'ce')), peCdv: sanitizeLine(line(cdv, 'pe')), ceObv: sanitizeLine(obvLine(obv?.ce)), peObv: sanitizeLine(obvLine(obv?.pe)) }
}

/** The forming minute (the snapshot's current bar) put in place of / after the series' last minute. */
export function withCurrentBar(flow, bar) {
  if (!flow || !bar) return flow
  const ms = new Date(bar.time).getTime()
  if (!Number.isFinite(ms)) return flow
  const put = (line, value) => {
    if (!Number.isFinite(value)) return line
    if (line.length && line.at(-1).time === ms) return [...line.slice(0, -1), { time: ms, value }]
    if (line.length && line.at(-1).time > ms) return line
    return [...line, { time: ms, value }]
  }
  return { ...flow, ceCdv: put(flow.ceCdv, Number(bar.ceCdv)), peCdv: put(flow.peCdv, Number(bar.peCdv)) }
}

/**
 * The dashboard's own CDV / OBV for `underlying` (and `expiry`, yyyy-MM-dd, when given) while `enabled`:
 * `{ status: 'ok', flow }`, `{ status: 'unavailable' }` when the dashboard holds nothing for that chain (the caller then
 * shows its own estimate), or null while loading / disabled.
 */
export function useDashboardFlow(underlying, expiry, enabled) {
  const [state, setState] = useState(null)
  const [currentBar, setCurrentBar] = useState(null)

  useEffect(() => {
    if (!enabled || !underlying) return undefined
    let cancelled = false
    const query = expiry ? `?expiry=${encodeURIComponent(expiry)}` : ''
    const loadSeries = async () => {
      try {
        const [series, obv] = await Promise.all([
          fetch(`/api/cdv/${underlying}/series${query}`), fetch(`/api/cdv/${underlying}/obv-series${query}`),
        ])
        if (cancelled) return
        if (!series.ok) { setState({ status: 'unavailable', key: `${underlying}|${expiry}` }); return }
        const flow = dashboardFlowFromSeries(await series.json(), obv.ok ? await obv.json() : null)
        if (cancelled) return
        setState(flow.ceCdv.length || flow.peCdv.length
          ? { status: 'ok', flow, key: `${underlying}|${expiry}` }
          : { status: 'unavailable', key: `${underlying}|${expiry}` })
      } catch { /* the next poll tries again */ }
    }
    const loadSnapshot = async () => {
      try {
        const r = await fetch(`/api/cdv/${underlying}/snapshot${query}`)
        if (!r.ok || cancelled) return
        const snap = await r.json()
        if (!cancelled) setCurrentBar(snap?.currentBar ? { ...snap.currentBar, key: `${underlying}|${expiry}` } : null)
      } catch { /* the next poll tries again */ }
    }
    loadSeries()
    loadSnapshot()
    const seriesId = setInterval(loadSeries, SERIES_POLL_MS)
    const snapshotId = setInterval(loadSnapshot, SNAPSHOT_POLL_MS)
    return () => { cancelled = true; clearInterval(seriesId); clearInterval(snapshotId) }
  }, [underlying, expiry, enabled])

  const key = `${underlying}|${expiry}`
  return useMemo(() => {
    if (!enabled || state?.key !== key) return null
    if (state.status !== 'ok') return state
    return { status: 'ok', flow: withCurrentBar(state.flow, currentBar?.key === key ? currentBar : null) }
  }, [enabled, state, currentBar, key])
}
