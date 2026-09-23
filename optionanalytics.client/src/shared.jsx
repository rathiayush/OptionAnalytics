import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Menu, Select, Space, Tag, Typography } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import { createChart, createSeriesMarkers, HistogramSeries, LineSeries, CrosshairMode, LineStyle, TickMarkType } from 'lightweight-charts'

// Provided once, at the app root (App.jsx), after GET /api/auth/me resolves - {email, role} or
// null. NavBar (rendered independently from four different pages) reads this via useAuth() rather
// than each page threading it through as a prop.
export const AuthContext = createContext(null)
export function useAuth() {
  return useContext(AuthContext)
}

// Path keys from NAV_ITEMS below that only an Admin account may see or use - Triggers arms real
// money, Contracts exposes the raw scrip-master/subscription diagnostic. Kept as one list so
// NavBar's own filtering and App.jsx's route guards can never drift apart on which paths these are.
export const ADMIN_ONLY_PATHS = ['/triggers', '/contracts']

// Constants/components shared between App.jsx's DashboardPage and BacktestPage.jsx - kept in
// their own module (not exported from App.jsx) specifically to avoid a circular import: App.jsx
// imports BacktestPage for its route, so BacktestPage importing back from App.jsx creates a cycle
// that breaks under Vite's dev-time ESM evaluation order ("Cannot access 'X' before
// initialization"), even though a production build happens to paper over it.

export const UP_COLOR = '#26a69a'
export const DOWN_COLOR = '#ef5350'
export const CE_COLOR = '#3ddc84'
export const PE_COLOR = '#ff5c5c'
// The 5 EMA overlay's own line color on Backtrack/Expired Backtest's spot charts - distinct from
// every other color already in play there (CE/PE, UP/DOWN, the amber "Open" trade status).
export const EMA_COLOR = '#9254de'

// Standard EMA: seeded with a plain average of the first `period` closes, then the usual
// exponential recurrence. Returns one value per input bar, null before the seed window fills.
// Shared rather than duplicated per page - App.jsx's own EMA9/21 crossover overlay used this first;
// Backtrack/Expired Backtest's own "Show 5 EMA" chart toggle reuses it for the same visual line the
// 5 EMA strategies themselves reason about (see EmaCrossoverDetector.EmaSeries server-side - not
// byte-for-byte identical seeding, but the same standard EMA, close enough for a chart overlay).
export function computeEma(closes, period) {
  const result = new Array(closes.length).fill(null)
  if (closes.length < period) return result

  const k = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  let prev = sum / period
  result[period - 1] = prev

  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k)
    result[i] = prev
  }
  return result
}

// A plain EMA line over a chart's own (already timeframe-bucketed) bars - used by both
// BacktestPage/ExpiredBacktestPage's own per-strategy indicator overlays (see each page's own
// indicatorDefs) to plot whichever EMA a strategy's own parameters currently specify.
export function emaLine(bars, period) {
  const values = computeEma(bars.map((b) => b.close), period)
  return bars.reduce((points, b, i) => {
    if (values[i] != null) points.push({ time: b.time, value: values[i] })
    return points
  }, [])
}

// Mirrors SrFlowSellStrategy's own rolling support/resistance channel exactly (see the backend's
// own doc comment on THE LEVEL): aggregates the NATIVE 1-minute spot history (oneMinuteBars, not
// the chart's own possibly-coarser timeframe) into srTimeframeMinutes buckets, drops a still-
// forming trailing one exactly like BacktestUtil.AggregateCandles does, then for each of the
// chart's own bars reads the rolling high (resistance) or low (support) over the last
// srLookbackBars such buckets that have fully closed strictly before that bar's own time - never
// the bucket still forming through it, so this never looks ahead of what the strategy itself could
// have known at the same moment.
export function srLevelLine(oneMinuteBars, chartBars, srTimeframeMinutes, srLookbackBars, which) {
  if (oneMinuteBars.length === 0 || chartBars.length === 0) return []

  const bucketSeconds = Math.max(1, srTimeframeMinutes) * 60
  const buckets = new Map()
  let latestCovered = 0
  for (const b of oneMinuteBars) {
    const t = Math.floor(b.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(t)
    if (!existing) buckets.set(t, { time: t, high: b.high, low: b.low })
    else { existing.high = Math.max(existing.high, b.high); existing.low = Math.min(existing.low, b.low) }
    if (b.time + 60 > latestCovered) latestCovered = b.time + 60
  }
  const srBars = Array.from(buckets.values()).sort((a, b) => a.time - b.time)
  if (srBars.length > 0 && srBars[srBars.length - 1].time + bucketSeconds > latestCovered) srBars.pop()

  const points = []
  let srIndex = -1
  for (const bar of chartBars) {
    while (srIndex + 1 < srBars.length && srBars[srIndex + 1].time + bucketSeconds <= bar.time) srIndex++
    if (srIndex + 1 < srLookbackBars) continue

    let value = which === 'high' ? -Infinity : Infinity
    for (let w = srIndex - srLookbackBars + 1; w <= srIndex; w++) {
      value = which === 'high' ? Math.max(value, srBars[w].high) : Math.min(value, srBars[w].low)
    }
    points.push({ time: bar.time, value })
  }
  return points
}

export const ALERT_KIND_LABEL = { Spot: 'Spot', AtmCe: 'ATM CE', AtmPe: 'ATM PE', Confluence: 'CONFLUENCE' }

// One list for every page, so a timeframe stored by one is always a valid choice on the others.
// Everything server-side stays at 1-minute resolution; coarser ones are aggregated from it.
export const TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 3, label: '3 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
]

// The underlying and the timeframe describe WHAT you are looking at rather than being a per-page
// setting, so picking either one should hold wherever you navigate next - and across a reload.
// Both live under these keys, and every page reads and writes the same two.
export const STORED_UNDERLYING = 'optionanalytics.underlying'
export const STORED_TIMEFRAME = 'optionanalytics.timeframe'

function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    // Storage can throw outright (private browsing, blocked site data) - the app still works,
    // it just doesn't remember.
    return fallback
  }
}

export function usePersistedState(key, fallback) {
  const [value, setValue] = useState(() => readStored(key, fallback))

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Same as above - remembering is a convenience, never a requirement.
    }
  }, [key, value])

  return [value, setValue]
}

// Keeps a stored underlying only if the backend still offers it, otherwise falls back to the
// first one - so a stale or renamed symbol can't leave a page stuck on nothing.
export function pickUnderlying(list, current) {
  if (list?.some((u) => u.underlying === current)) return current
  return list?.[0]?.underlying ?? null
}

// Which expiry a PAGE is looking at. The app now tracks several expiries at once per underlying
// (NIFTY's nearest 3, BANKNIFTY's nearest 2 - see CdvHostedService), each with its own live state,
// so this is a per-page read: the page appends ?expiry= to its own requests and nothing about that
// choice reaches any other page, or any armed trigger. It used to POST a server-side switch that
// unsubscribed and rebuilt everything, which is why changing expiry used to blank all three pages
// for a minute or two.
//
// `expiries` is the TRACKED set, not every listed one - those are the expiries with live data
// behind them. `selectedExpiry` is what to display; `expiryParam` is what to put in a URL, and is
// null while the page is following the server's own selection (so the request stays identical to
// what it was before this existed).
export function useExpirySelector(underlying) {
  const [expiries, setExpiries] = useState([])
  const [defaultExpiry, setDefaultExpiry] = useState(null)
  const [pinned, setPinned] = useState(null)

  useEffect(() => {
    if (!underlying) return
    const cancelledRef = { cancelled: false }
    fetch(`/api/cdv/${underlying}/expiries`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelledRef.cancelled) return
        setExpiries(data?.expiries ?? [])
        setDefaultExpiry(data?.selected ?? null)
        // A pin from a previous underlying cannot survive the switch - the new underlying tracks a
        // different set of expiries entirely.
        setPinned((current) => ((data?.expiries ?? []).includes(current) ? current : null))
      })
      .catch((err) => console.error('Failed to load expiries:', err))
    return () => { cancelledRef.cancelled = true }
  }, [underlying])

  // Local only, and resolved so callers that refetch in a .then() keep working unchanged.
  const selectExpiry = (expiry) => {
    if (expiry !== undefined) setPinned(expiry ?? null)
    return Promise.resolve()
  }

  return {
    expiries,
    selectedExpiry: pinned ?? defaultExpiry,
    expiryParam: pinned,
    isManual: pinned !== null,
    loading: false,
    selectExpiry,
  }
}

// Appends ?expiry= to a request when the page has pinned one. Null/undefined leaves the URL
// untouched, so a page following the server's own selection sends exactly the request it always
// did.
export function withExpiry(url, expiry) {
  if (!expiry) return url
  return `${url}${url.includes('?') ? '&' : '?'}expiry=${encodeURIComponent(expiry)}`
}

// Sentinel antd Select value for "Auto (nearest)" - real expiries are ISO date strings, so this
// can never collide with one.
const AUTO_EXPIRY = '__auto__'

export function ExpirySelect({ expiries, value, isManual, loading, onChange, style }) {
  const options = [
    { value: AUTO_EXPIRY, label: 'Auto (nearest)' },
    ...(expiries ?? []).map((e) => ({ value: e, label: e })),
  ]
  return (
    <Select
      value={isManual ? value : AUTO_EXPIRY}
      loading={loading}
      onChange={(picked) => onChange(picked === AUTO_EXPIRY ? null : picked)}
      style={style ?? { width: 170 }}
      options={options}
    />
  )
}

export function fmtPrice(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

// Every plain-text timestamp on the page (alert feed entries, Backtrack's tables) renders in IST
// (India, fixed UTC+5:30 - the market this app is about) regardless of the viewer's own browser
// timezone, same reasoning as App.jsx's chart-axis IST formatters - just via Intl's timeZone
// option directly here, since there's no lightweight-charts day-bucketing to work around for
// plain text.
export function fmtIstDateTime(isoOrDate) {
  return new Date(isoOrDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
}

// The IST calendar day a UTC timestamp falls on, as 'YYYY-MM-DD'. Sortable and directly
// comparable to what antd's date pickers format to, which is what makes a date filter possible
// without pulling timezone maths into every page: 'en-CA' is the locale that renders a date in
// exactly that order. A signal at 20:00 UTC belongs to the NEXT IST day, so filtering on the raw
// UTC date would put it under the wrong session.
export function istDateKey(isoOrDate) {
  return new Date(isoOrDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

export function fmtIstTime(isoOrDate) {
  return new Date(isoOrDate).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
}

// lightweight-charts styling/time-axis helpers, duplicated (not imported) from App.jsx's own
// private copies rather than having App.jsx import them from here - App.jsx's charting code is
// heavily tuned (cross-chart pan/zoom sync, EMA overlays, live-tick preservation of the visible
// range) and any of it is deliberately left untouched by pages that don't need that complexity.
// These are the small, stable, PURE pieces any simple read-only chart (StrikeDataPage's own) needs
// without the rest: lightweight-charts has no timezone support, so every timestamp fed to a chart
// is shifted forward by IST_OFFSET_SECONDS up front and then formatted AS IF it were UTC - which,
// because of the shift, is exactly its real IST wall-clock value. See App.jsx's own identical
// comment for the full reasoning; it is not repeated there to avoid the two drifting apart on
// wording while staying identical in behavior (the offset is fixed and will never change).
export const AXIS_COLOR = '#9aa4b2'
export const GRID_COLOR = '#ffffff14'
export const BORDER_COLOR = '#ffffff22'
export const RESET_MARKER_COLOR = '#ffd54f'

const IST_OFFSET_SECONDS = 5.5 * 3600

export function toChartTime(isoOrDate) {
  return Math.floor(new Date(isoOrDate).getTime() / 1000) + IST_OFFSET_SECONDS
}

// Inverse of toChartTime - a caller holding a chart-time value (e.g. a bar's own .time, already
// shifted for display) that needs to compare it against a REAL timestamp (an ISO string straight
// off the wire, never shifted) must convert back first - comparing the two directly, one shifted
// and one not, silently skews the comparison by a fixed 5.5 hours. Returns real UTC epoch seconds.
export function fromChartTime(chartTimeSeconds) {
  return chartTimeSeconds - IST_OFFSET_SECONDS
}

const IST_TIME_FORMAT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' })
const IST_TICK_DATE_FORMAT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export function istTimeFormatter(time) {
  return IST_TIME_FORMAT.format(new Date(time * 1000))
}

export function istTickMarkFormatter(time, tickMarkType) {
  const date = new Date(time * 1000)
  return tickMarkType >= TickMarkType.Time ? IST_TIME_FORMAT.format(date) : IST_TICK_DATE_FORMAT.format(date)
}

export function toBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }
}

// Chart times are already IST-shifted (see IST_OFFSET_SECONDS), so reading the shifted value AS
// UTC gives the IST calendar day directly - the chart-time counterpart to istDateKey above, which
// takes a plain ISO string instead.
function istDayKeyFromChartTime(chartTime) {
  return new Date(chartTime * 1000).toISOString().slice(0, 10)
}

// A "RESET" marker on the first bar of each new IST trading day, so a chart spanning several days
// reads as distinct sessions rather than one continuous, misleadingly smooth line/candle run
// straight through each overnight gap. The very first day in view gets no marker - there is no
// transition to see there, just the left edge of the loaded history.
export function dayResetMarkers(bars) {
  const markers = []
  let previousDay = null

  for (const bar of bars) {
    const day = istDayKeyFromChartTime(bar.time)
    if (previousDay !== null && day !== previousDay) {
      markers.push({ time: bar.time, position: 'aboveBar', color: RESET_MARKER_COLOR, shape: 'square', text: 'RESET' })
    }
    previousDay = day
  }
  return markers
}

// Last line of defense before handing data to lightweight-charts, which throws an UNCAUGHT error if
// two consecutive points share a time or aren't strictly ascending - duplicated (not imported) from
// App.jsx's own identical copy, same reasoning as every other duplicated helper in this file's own
// header comment. Sorts ascending; for a duplicate time, keeps the LAST occurrence.
function sanitizeSeries(points) {
  if (points.length === 0) return points
  const sorted = [...points].sort((a, b) => a.time - b.time)
  const result = []
  for (const p of sorted) {
    if (result.length > 0 && result[result.length - 1].time === p.time) {
      result[result.length - 1] = p
    } else {
      result.push(p)
    }
  }
  return result
}

// Raw {time: isoString, [valueKey]: number} points (the shape an ObvPoint/CandleWithVolume-derived
// series comes off the wire as) into lightweight-charts' own {time: epochSeconds, value} shape.
function toLinePoints(points, valueKey) {
  return points.map((p) => ({ time: toChartTime(p.time), value: p[valueKey] }))
}

// Recenters `chart`'s own current visible window on `isoTime`, preserving however wide/zoomed that
// window already is - what a "click a row, jump every chart to that moment" feature needs, WITHOUT
// changing zoom level out from under the user the way fitContent() or a fixed-width window would.
// lightweight-charts has no direct "scroll to this time" call (only scrollToPosition, which moves by
// a bar-index offset from the right edge - meaningless across charts with different bar counts/
// timeframes), so this reads the current {from, to} itself and shifts it by hand. A silent no-op if
// the chart has no data yet (getVisibleRange returns null) or the target falls outside what
// setVisibleRange will accept - "nothing to show there" is not worth surfacing as an error over a
// chart the user didn't necessarily mean to scroll (an OBV chart has no data before its own history
// started, for instance, even when the spot chart right next to it does).
export function scrollChartToTime(chart, isoTime) {
  if (!chart || !isoTime) return
  const range = chart.timeScale().getVisibleRange()
  if (!range) return
  const target = toChartTime(isoTime)
  const half = (range.to - range.from) / 2
  try { chart.timeScale().setVisibleRange({ from: target - half, to: target + half }) } catch { /* empty */ }
}

// One page's own group of charts that pan/zoom together - dragging or zooming any ONE of them pushes
// the same visible time range to every other chart in the SAME group. Deliberately NOT the global,
// module-level registry the Dashboard used to use (removed at the user's own report that it made the
// Dashboard hard to use - its charts remount/re-fit on every live tick and ATM strike roll, which
// kept re-broadcasting a stale chart's own auto-fit over whatever the user was actively looking at).
// Backtrack/Expired Backtest's own charts are a much safer fit for this: they only ever refresh on a
// deliberate Run, not continuously, so there is no equivalent stream of remounts to fight - and here
// the user explicitly asked for it, to correlate a spot move with what CDV/OBV/Volume did at the same
// instant by eye. One group per page instance (see useChartSyncGroup) rather than a shared singleton,
// so a page unmounting can never leave stale chart references behind for the next page to inherit.
function createChartSyncGroup() {
  const charts = new Set()
  let isApplying = false

  function register(chart) {
    const onVisibleRangeChange = () => {
      if (isApplying) return
      const range = chart.timeScale().getVisibleRange()
      if (!range) return

      isApplying = true
      try {
        for (const other of charts) {
          if (other === chart) continue
          // A chart whose own data doesn't reach into this window can reject the range - "nothing
          // to show there", not an error worth breaking the drag over.
          try { other.timeScale().setVisibleRange(range) } catch { /* empty */ }
        }
      } finally {
        isApplying = false
      }
    }

    charts.add(chart)
    chart.timeScale().subscribeVisibleTimeRangeChange(onVisibleRangeChange)

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onVisibleRangeChange)
      charts.delete(chart)
    }
  }

  return { register }
}

// One sync group per page instance, stable across re-renders (React's lazy useState initializer
// runs the factory only once, on mount) - pass the SAME returned object to every chart on the page
// that should pan/zoom together.
export function useChartSyncGroup() {
  return useState(() => createChartSyncGroup())[0]
}

// Joins `chart` to `syncGroup` only once `chart`'s own fitContent() has actually settled - measured
// (against this exact lightweight-charts version) to still be raising its own visibleTimeRangeChange
// events a full animation frame after fitContent() is called and returns, so registering any sooner
// - including synchronously right after that call - broadcasts THIS chart's own first-load auto-fit
// to every other chart in the group as if it were a user's pan/zoom, silently overriding whatever
// view the user had already set on one of them. Two frames leaves a full frame of margin beyond the
// measured worst case. `isStale` lets a caller detect its own unmount/remount before the deferred
// callback runs (pass e.g. `() => chartRef.current !== chart`) and skip registering a chart that no
// longer belongs to the calling component instance. No-op if `syncGroup` is falsy, so a chart that
// doesn't want syncing can simply omit the prop.
export function registerChartForSyncAfterSettling(syncGroup, chart, isStale, onRegistered) {
  if (!syncGroup) return
  requestAnimationFrame(() => {
    if (isStale()) return
    requestAnimationFrame(() => {
      if (isStale()) return
      onRegistered(syncGroup.register(chart))
    })
  })
}

// The last point in a chart-time-ascending, already-converted array (bars from toBar, or points from
// toLinePoints/the volume mapper - anything shaped {time, [valueKey]}) at or before targetChartTime -
// what a highlight needs to know "where on this series' own line does that time actually fall",
// since a click's exact time rarely lands on one of this particular series' own bars (CE/PE/volume
// bars do not share spot's own timestamps).
export function lastValueAtOrBeforeChartTime(points, targetChartTime, valueKey = 'value') {
  let value = null
  for (const p of points) {
    if (p.time > targetChartTime) break
    value = p[valueKey]
  }
  return value
}

// Drops lightweight-charts' own crosshair (the dashed vertical+horizontal line pair, with axis
// labels) onto `series` at `targetChartTime`/`price` and leaves it there - unlike the crosshair's
// usual behavior (following the mouse, vanishing when it leaves the chart), an explicitly-set one
// stays exactly where put until moved or cleared, which is what makes it work as a persistent
// "here is the row you clicked" marker rather than something that disappears the instant the pointer
// moves. This is what actually answers "which bar is that" - scrollChartToTime alone only brings the
// right neighborhood into view, it does not mark anything.
//
// `targetChartTime` null clears the crosshair outright (nothing focused, or nothing to show it on
// yet); a non-null price` of null/undefined leaves the previous crosshair as-is rather than setting
// a nonsensical one - the caller has nothing at or before that time on THIS particular series (e.g.
// an OBV chart whose own history starts later than the clicked row).
export function highlightChartAtTime(chart, series, targetChartTime, price) {
  if (!chart) return
  if (targetChartTime == null) {
    try { chart.clearCrosshairPosition() } catch { /* empty */ }
    return
  }
  if (!series || price == null) return
  try { chart.setCrosshairPosition(price, targetChartTime, series) } catch { /* empty */ }
}

// A generic two-line CE/PE running-total chart - CDV or OBV, whichever `valueKey` names on the raw
// point shape the backend returns (ObvPoint's own JSON field is "obv" for both: OBV and CDV are
// exposed as the same shape). A simplified port of App.jsx's own CeVsPeChart (the Dashboard's live
// CDV/OBV chart) for Backtrack/Expired Backtest's own verification charts - see this file's header
// comment for why App.jsx's tuned original is left untouched rather than imported.
//
// prevCeSeries/prevPeSeries (optional, dashed) is a reference line - CDV's previous trading day,
// typically; OBV has no equivalent and simply omits them. `syncGroup` (see useChartSyncGroup) joins
// this chart's own pan/zoom to every other chart passed the same group - omit it for a standalone
// chart that shouldn't sync with anything.
export function CeVsPeChart({ ceSeries, peSeries, prevCeSeries = [], prevPeSeries = [], valueKey = 'obv', height = 240, focusTime, syncGroup }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const ceRef = useRef(null)
  const peRef = useRef(null)
  const prevCeRef = useRef(null)
  const prevPeRef = useRef(null)
  const markersRef = useRef(null)
  const hasFitRef = useRef(false)
  const syncCleanupRef = useRef(null)

  const sanitizedCe = useMemo(() => sanitizeSeries(toLinePoints(ceSeries, valueKey)), [ceSeries, valueKey])
  const sanitizedPe = useMemo(() => sanitizeSeries(toLinePoints(peSeries, valueKey)), [peSeries, valueKey])
  const sanitizedPrevCe = useMemo(() => sanitizeSeries(toLinePoints(prevCeSeries, valueKey)), [prevCeSeries, valueKey])
  const sanitizedPrevPe = useMemo(() => sanitizeSeries(toLinePoints(prevPeSeries, valueKey)), [prevPeSeries, valueKey])

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    prevCeRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'CE (prev day)', priceLineVisible: false, crosshairMarkerVisible: false })
    prevPeRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'PE (prev day)', priceLineVisible: false, crosshairMarkerVisible: false })
    ceRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, title: 'CE', priceLineVisible: false })
    peRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, title: 'PE', priceLineVisible: false })
    markersRef.current = createSeriesMarkers(ceRef.current, [])
    hasFitRef.current = false
    syncCleanupRef.current = null

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      syncCleanupRef.current?.()
      chart.remove()
      chartRef.current = null
      ceRef.current = null
      peRef.current = null
      prevCeRef.current = null
      prevPeRef.current = null
      markersRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!ceRef.current || !peRef.current || !prevCeRef.current || !prevPeRef.current) return
    const preservedRange = hasFitRef.current ? chartRef.current?.timeScale().getVisibleRange() : null
    prevCeRef.current.setData(sanitizedPrevCe)
    prevPeRef.current.setData(sanitizedPrevPe)
    ceRef.current.setData(sanitizedCe)
    peRef.current.setData(sanitizedPe)
    const hasAnyData = sanitizedCe.length > 0 || sanitizedPe.length > 0 || sanitizedPrevCe.length > 0 || sanitizedPrevPe.length > 0
    if (!hasFitRef.current && hasAnyData) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
      const chartAtFit = chartRef.current
      registerChartForSyncAfterSettling(syncGroup, chartAtFit, () => chartRef.current !== chartAtFit, (cleanup) => { syncCleanupRef.current = cleanup })
    } else if (preservedRange) {
      try { chartRef.current?.timeScale().setVisibleRange(preservedRange) } catch { /* empty */ }
    }
  }, [sanitizedCe, sanitizedPe, sanitizedPrevCe, sanitizedPrevPe])

  const resetMarkers = useMemo(
    () => dayResetMarkers([...sanitizedPrevCe, ...sanitizedCe]),
    [sanitizedPrevCe, sanitizedCe],
  )

  useEffect(() => {
    markersRef.current?.setMarkers(resetMarkers)
  }, [resetMarkers])

  // A row click elsewhere on the page sets focusTime to that row's own time - recenter (see
  // scrollChartToTime's own doc comment for why that recenters rather than re-fits/re-zooms) AND
  // drop a persistent crosshair on the CE line so the exact bar is actually marked, not just
  // somewhere in view - see highlightChartAtTime's own doc comment for why scrolling alone isn't
  // enough to answer "which one is it".
  useEffect(() => {
    scrollChartToTime(chartRef.current, focusTime)
    const target = focusTime ? toChartTime(focusTime) : null
    const price = target != null ? lastValueAtOrBeforeChartTime(sanitizedCe, target) : null
    highlightChartAtTime(chartRef.current, ceRef.current, target, price)
  }, [focusTime, sanitizedCe])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// A plain volume histogram with a VWAP line overlaid - the third of the three verification charts
// (CDV/OBV via CeVsPeChart above, this one for real spot/index volume - see
// DhanHistoricalDataService's own doc comment on Dhan's January 2026 index-volume rollout, and
// VwapCalculator). `volumeBars` is raw {time: isoString, volume: number} (CandleWithVolume's own
// JSON shape - open/high/low/close are ignored, only the bar's own volume is plotted); `vwapSeries`
// is raw {time: isoString, obv: number} (ObvPoint's own JSON shape, reused for VWAP the same way
// CdvCeSeries/CdvPeSeries reuse it for CDV).
export function VolumeVwapChart({ volumeBars, vwapSeries, height = 180, focusTime, syncGroup }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const volumeRef = useRef(null)
  const vwapRef = useRef(null)
  const hasFitRef = useRef(false)
  const syncCleanupRef = useRef(null)

  const sanitizedVolume = useMemo(
    () => sanitizeSeries(volumeBars.map((b) => ({ time: toChartTime(b.time), value: b.volume, color: UP_COLOR }))),
    [volumeBars],
  )
  const sanitizedVwap = useMemo(() => sanitizeSeries(toLinePoints(vwapSeries, 'obv')), [vwapSeries])

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    volumeRef.current = chart.addSeries(HistogramSeries, { color: UP_COLOR, priceFormat: { type: 'volume' }, title: 'Volume', priceLineVisible: false })
    vwapRef.current = chart.addSeries(LineSeries, { color: EMA_COLOR, lineWidth: 2, title: 'VWAP', priceLineVisible: false, priceScaleId: 'left' })
    chart.priceScale('left').applyOptions({ visible: true, borderColor: BORDER_COLOR })
    hasFitRef.current = false
    syncCleanupRef.current = null

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      syncCleanupRef.current?.()
      chart.remove()
      chartRef.current = null
      volumeRef.current = null
      vwapRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!volumeRef.current || !vwapRef.current) return
    const preservedRange = hasFitRef.current ? chartRef.current?.timeScale().getVisibleRange() : null
    volumeRef.current.setData(sanitizedVolume)
    vwapRef.current.setData(sanitizedVwap)
    const hasAnyData = sanitizedVolume.length > 0 || sanitizedVwap.length > 0
    if (!hasFitRef.current && hasAnyData) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
      const chartAtFit = chartRef.current
      registerChartForSyncAfterSettling(syncGroup, chartAtFit, () => chartRef.current !== chartAtFit, (cleanup) => { syncCleanupRef.current = cleanup })
    } else if (preservedRange) {
      try { chartRef.current?.timeScale().setVisibleRange(preservedRange) } catch { /* empty */ }
    }
  }, [sanitizedVolume, sanitizedVwap])

  useEffect(() => {
    scrollChartToTime(chartRef.current, focusTime)
    const target = focusTime ? toChartTime(focusTime) : null
    const price = target != null ? lastValueAtOrBeforeChartTime(sanitizedVolume, target) : null
    highlightChartAtTime(chartRef.current, volumeRef.current, target, price)
  }, [focusTime, sanitizedVolume])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

export function DirectionTag({ direction }) {
  if (!direction) return <Tag>—</Tag>
  return <Tag color={direction === 'Bullish' ? UP_COLOR : DOWN_COLOR}>{direction === 'Bullish' ? '▲ Bullish' : '▼ Bearish'}</Tag>
}

const NAV_ITEMS = [
  { key: '/', label: 'Dashboard' },
  { key: '/backtest', label: 'Backtrack' },
  {
    key: 'strike-data-group',
    label: 'Strike Data',
    children: [
      { key: '/strike-data', label: 'Live' },
      { key: '/rolling-strike-data', label: 'Rolling (Expired)' },
    ],
  },
  { key: '/expired-backtest', label: 'Expired Backtest' },
  { key: '/oi-replay', label: 'OI Replay' },
  { key: '/oi-live', label: 'Live OI' },
  { key: '/triggers', label: 'Triggers' },
  { key: '/contracts', label: 'Contracts' },
]

// Shared between DashboardPage/BacktestPage/TriggersPage/ContractsPage - a proper horizontal menu
// (not just plain text links) so it reads as real site navigation, sitting inline in each page's
// own header row with a transparent background so it blends into the page rather than looking
// like a separate bar. Also carries the signed-in email and a log-out button - the one place
// that's shown regardless of which page rendered this.
//
// Triggers/Contracts are hidden here for a non-Admin account, but that is a convenience, not the
// actual security boundary - App.jsx's own route guard covers someone typing the URL directly, and
// the real enforcement is server-side (TriggersController/CdvController's [Authorize(Roles =
// "Admin")]), since hiding a link never stops a direct API call.
export function NavBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const items = isAdmin ? NAV_ITEMS : NAV_ITEMS.filter((item) => !ADMIN_ONLY_PATHS.includes(item.key))

  return (
    <Space align="center" size={16} wrap>
      <Menu
        mode="horizontal"
        theme="dark"
        selectedKeys={[location.pathname]}
        items={items}
        onClick={({ key }) => navigate(key)}
        style={{ minWidth: 340, background: 'transparent', borderBottom: 'none', lineHeight: '32px' }}
      />
      {auth?.user && (
        <Space size={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{auth.user.email}</Typography.Text>
          <Button size="small" onClick={auth.logout}>Log out</Button>
        </Space>
      )}
    </Space>
  )
}
