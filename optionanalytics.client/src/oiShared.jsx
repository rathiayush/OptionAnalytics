import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Select, Space, Typography, Button, Row, Col, Tooltip, Tag, InputNumber, Table, Segmented, Empty, Alert } from 'antd'
import { createChart, CandlestickSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import {
  UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR, RECONNECT_RETRY_POLICY,
  istTimeFormatter, istTickMarkFormatter, toChartTime, TIMEFRAME_OPTIONS,
  syncSignalRGroups, joinAllSignalRGroups,
} from './shared.jsx'

const { Text } = Typography

// Pure helpers and chart/table components originally lived inside OiReplayPage.jsx, extracted here
// UNCHANGED so a second live consumer (LiveStrikeDataPage.jsx) could reuse the identical
// implementation rather than a bespoke copy. OiReplayPage.jsx keeps its own separate replay-clock
// machinery (visibleCount/asOfMs) entirely to itself; nothing in this file depends on that, which is
// exactly why it was safe to lift out - every function/component below takes its data via plain
// arguments/props.
//
// RECONNECT_RETRY_POLICY itself now lives in shared.jsx (not here) so App.jsx's own useHub can use
// the identical policy instead of a third copy - see its doc comment there for why the bare
// withAutomaticReconnect() default is unsafe for a live-market page.

// A stable default for an optional array prop (ReplayChart/EmaChart's own vwapSeries) - a plain `[]`
// literal default is a NEW array every render, which would re-trigger any effect keyed on it
// (re-feeding the chart, losing its own pan/zoom) even when the caller never actually passes one.
const EMPTY_ARRAY = []

// Keeps a chart's own visible time range showing "the whole day so far", growing as more bars
// accumulate live, instead of staying frozen at whatever few bars existed the moment fitContent()
// happened to run once. Every chart on this page/OiReplayPage.jsx used to call fitContent() only
// on [dayKey] (a fresh day loading) - correct for that one moment, but a real report ("charts are
// too zoomed, I have to squeeze/zoom out myself") traced back to exactly this: fitContent() fits to
// however many bars exist RIGHT THEN, and nothing ever widened that window again as a live session
// went on to accumulate far more bars over the rest of the day. The vertical (price) axis needed no
// separate fix - lightweight-charts' own default autoScale already re-fits to whatever's in the
// CURRENT visible window, so it was only ever following the same too-narrow horizontal window.
//
// Only re-fits while the viewer is already at the live edge (the previous last bar was already
// visible) - re-fitting on every single new tick regardless would otherwise yank someone back to
// the day's full span the moment they scroll/zoom back to inspect an earlier stretch, fighting the
// very thing they just did. Same reasoning ReplayChart's own allowShiftVisibleRangeOnWhitespaceReplacement
// doc comment already gives for shiftVisibleRangeOnNewBar.
export function useFitContentAsDataGrows(chartRef, dataLength, dayKey) {
  const prevLengthRef = useRef(0)

  // A fresh day (or combo switch) always gets an unconditional fit, regardless of where the OLD
  // day's chart happened to be scrolled to - there is no "previous" position to preserve.
  useEffect(() => {
    if (dataLength > 0) chartRef.current?.timeScale().fitContent()
    prevLengthRef.current = dataLength
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

  useEffect(() => {
    const chart = chartRef.current
    const previousLength = prevLengthRef.current
    prevLengthRef.current = dataLength
    if (!chart || dataLength === 0 || dataLength <= previousLength) return
    const timeScale = chart.timeScale()
    const range = timeScale.getVisibleLogicalRange()
    const wasAtLiveEdge = !range || range.to >= previousLength - 1
    if (wasAtLiveEdge) timeScale.fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataLength])
}

// Modeled directly on App.jsx's own useHub: ONE connection, opened on mount and never torn down or
// rebuilt - no `enabled` gate, no dependency on underlying/expiryFlag (a fresh connection would mean
// a fresh reconnect-and-rejoin cycle on every selection change, exactly the "reconnect churn"
// OiReplayPage's own useOiReplayLiveFeed used to be exposed to before its own [enabled] dependency
// was removed - see its doc comment). Instead the connection stays open across a selection change
// and just SWITCHES GROUPS (see syncSignalRGroups) - underlying/expiryFlag are passed in purely to
// drive that, never to gate the connection's own lifecycle. Currently only used by
// LiveStrikeDataPage.jsx - OiReplayPage.jsx keeps its own separate hook (it also needs a
// futures-only underlying-group case oiRestSnapshot never does) but follows the exact same
// group-membership shape.
export function useOiLiveHub(onSpotUpdate, onOiReplayTick, onReconnected, onCdvUpdate, onCdvBarClosed, onOiRestSnapshot, underlying, expiryFlag) {
  const spotRef = useRef(onSpotUpdate)
  const tickRef = useRef(onOiReplayTick)
  const reconnectedRef = useRef(onReconnected)
  const cdvRef = useRef(onCdvUpdate)
  const cdvBarClosedRef = useRef(onCdvBarClosed)
  const restSnapshotRef = useRef(onOiRestSnapshot)
  spotRef.current = onSpotUpdate
  tickRef.current = onOiReplayTick
  reconnectedRef.current = onReconnected
  cdvRef.current = onCdvUpdate
  cdvBarClosedRef.current = onCdvBarClosed
  restSnapshotRef.current = onOiRestSnapshot

  const [connectionState, setConnectionState] = useState('connecting')
  const connectionRef = useRef(null)
  // Groups the SERVER currently thinks this connection is in - empty until the first successful
  // connect/reconnect actually joins something. Read by the groups-sync effect below to compute a
  // diff against a later selection change, and by the connection effect's own reconnect handler to
  // know what to rejoin from scratch.
  const groupsRef = useRef([])

  useEffect(() => {
    // Belt-and-suspenders, not a fix for an observed leak - see OiReplayPage.jsx's own
    // useOiReplayLiveFeed for the identical guard and its full reasoning: with today's `[]` deps this
    // is already unreachable in every normal case (React's own cleanup-before-next-effect ordering
    // already stops the previous connection), but costs nothing and closes off a future edit
    // reintroducing a dependency here leaving an old connection open and unreferenced.
    if (connectionRef.current) connectionRef.current.stop()
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect(RECONNECT_RETRY_POLICY)
      .build()
    connectionRef.current = connection

    // Optional chaining on every one of these - a caller like LiveStrikeDataPage genuinely has no
    // use for some of these events and passes null for them; calling a null ref directly would throw
    // the moment that event arrives, which for spotUpdate/oiReplayTick is roughly every second.
    connection.on('spotUpdate', (snapshot) => spotRef.current?.(snapshot))
    connection.on('oiReplayTick', (tick) => tickRef.current?.(tick))
    // Same CDV/OBV events App.jsx's own useHub already listens for, off the SAME shared hub -
    // CdvHostedService broadcasts these regardless of which page is open, so nothing extra needs
    // subscribing server-side for this page to receive them too.
    connection.on('cdvUpdate', (snapshot) => cdvRef.current?.(snapshot))
    connection.on('cdvBarClosed', (point) => cdvBarClosedRef.current?.(point))
    // OPTIONAL REST-quote fallback (OiReplayLiveFeedService.RunRestQuoteLoopAsync) - every strike's
    // OI/price from Dhan's Option Chain snapshot endpoint, re-broadcast every ~30s regardless of
    // whether any client wants it (see that method's own doc comment for why that's safe/cheap).
    // No current caller passes a handler for this (null, like LiveStrikeDataPage's other unused
    // events above) - kept wired up since a future caller may want it.
    connection.on('oiRestSnapshot', (snapshot) => restSnapshotRef.current?.(snapshot))
    connection.onreconnecting(() => setConnectionState('reconnecting'))
    // A reconnect gets a brand-new server-side connection with NO group membership at all - rejoin
    // whatever the current selection is (groupsRef.current), not what it was when this specific
    // connection object was first created.
    connection.onreconnected(() => {
      setConnectionState('connected')
      joinAllSignalRGroups(connection, groupsRef.current)
      reconnectedRef.current?.()
    })
    connection.onclose(() => setConnectionState('disconnected'))
    connection.start()
      .then(() => {
        setConnectionState('connected')
        joinAllSignalRGroups(connection, groupsRef.current)
      })
      .catch((err) => {
        // React StrictMode double-mounts every effect once in development - the first connection's
        // start() gets aborted by this effect's own cleanup before negotiation finishes on the
        // second mount. Not a real failure.
        if (err?.name === 'AbortError') return
        console.error('Live hub connection failed:', err)
        setConnectionState('disconnected')
      })

    return () => { connectionRef.current = null; connection.stop() }
  }, [])

  // Keeps server-side group membership in sync with the caller's own CURRENT selection, without
  // touching the connection itself - runs on every underlying/expiryFlag change (including the
  // first render, where groupsRef.current is still empty so every group here counts as "new" and
  // gets joined once the connect effect above actually reaches Connected; syncSignalRGroups itself
  // is a no-op before that, and groupsRef.current is still updated below so the connect effect's own
  // joinAllSignalRGroups call picks it up the moment it does connect).
  useEffect(() => {
    const newGroups = [
      underlying ? `u:${underlying}` : null,
      underlying && expiryFlag ? `c:${underlying}:${expiryFlag}` : null,
    ].filter(Boolean)
    syncSignalRGroups(connectionRef.current, groupsRef.current, newGroups)
    groupsRef.current = newGroups
  }, [underlying, expiryFlag])

  return connectionState
}

// One entry per distinct strike this side ever reported, its own points sorted ascending by time.
export function groupByStrike(points) {
  const byStrike = new Map()
  for (const p of points) {
    let list = byStrike.get(p.strike)
    if (!list) byStrike.set(p.strike, (list = []))
    list.push(p)
  }
  for (const list of byStrike.values()) list.sort((a, b) => new Date(a.time) - new Date(b.time))
  return byStrike
}

// The last point at or before asOfMs in a time-ascending list - null if the series hasn't started
// yet as of this point. Linear scan from the end: a real day's own per-strike series is at most a
// few hundred points, nowhere near hot enough to need a binary search.
export function latestAtOrBefore(sortedPoints, asOfMs) {
  for (let i = sortedPoints.length - 1; i >= 0; i--) {
    const t = new Date(sortedPoints[i].time).getTime()
    if (t <= asOfMs) return sortedPoints[i]
  }
  return null
}

// Buckets native 1-minute bars (already chart-time-shifted) into timeframeMinutes candles.
// Deliberately does NOT drop a trailing incomplete bucket - the whole point is to show the
// CURRENTLY FORMING candle live as 1-minute ticks keep arriving.
export function aggregateBars(oneMinBars, timeframeMinutes) {
  if (timeframeMinutes <= 1) return oneMinBars
  const bucketSeconds = timeframeMinutes * 60
  const buckets = new Map()
  for (const bar of oneMinBars) {
    const bucketTime = Math.floor(bar.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(bucketTime)
    if (existing) {
      existing.high = Math.max(existing.high, bar.high)
      existing.low = Math.min(existing.low, bar.low)
      existing.close = bar.close
    } else {
      buckets.set(bucketTime, { time: bucketTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close })
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

// Standard EMA over already-aggregated bars' own closes - SMA-seeded, then smoothed forward with
// k = 2/(period+1). One point per bar from index period-1 onward.
export function computeEma(bars, period) {
  if (!bars || period <= 0 || bars.length < period) return []
  const k = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += bars[i].close
  let ema = sum / period
  const points = [{ time: bars[period - 1].time, value: ema }]
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k)
    points.push({ time: bars[i].time, value: ema })
  }
  return points
}

// ATM+-10 offset dropdown options, shared by anything that lets the user pick a strike RELATIVE to
// the currently-drifting ATM - an offset rather than an absolute strike, so "the default stays ATM"
// holds true all through the session even as ATM itself moves.
export function buildStrikeOffsetOptions(atmStrike, step) {
  if (atmStrike == null || !step) return []
  return Array.from({ length: 21 }, (_, i) => i - 10).map((offset) => ({
    value: offset,
    label: offset === 0 ? `ATM (${atmStrike})` : `ATM${offset > 0 ? '+' : ''}${offset} (${atmStrike + offset * step})`,
  }))
}

// One strike/side's own premium as a lightweight-charts line-series dataset, clipped to
// asOfMs. toChartTime already does its own new Date(...).getTime()/1000 internally - passing it a
// value already divided by 1000 double-converts every point's time down near the Unix epoch, which
// used to crash this chart once enough live ticks piled up (duplicate/out-of-order timestamps).
// Passing p.time straight through (ms number or ISO string, toChartTime accepts either) is correct.
export function buildPremiumLine(points, asOfMs) {
  if (!points || asOfMs == null) return []
  const mapped = points
    .filter((p) => new Date(p.time).getTime() <= asOfMs)
    .map((p) => ({ time: toChartTime(p.time), value: p.price }))
    // A malformed p.time (toChartTime returns NaN for it) or a missing p.price would otherwise
    // produce a non-finite point lightweight-charts throws on - see sanitizeCandles' own doc
    // comment for the exact same reasoning applied to the candle-shaped chart alongside this one.
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
  // Sort first rather than assume input is already time-ascending - a confirmed real crash
  // ("data must be asc ordered by time... prev time" later than the current one) showed that
  // assumption does not always hold for a live tick stream, not just a theoretical concern.
  const sorted = [...mapped].sort((a, b) => a.time - b.time)
  // De-duplicate same-second points, keeping the LAST value for that second rather than rejecting it.
  const deduped = []
  for (const point of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === point.time) deduped[deduped.length - 1] = point
    else deduped.push(point)
  }
  return deduped
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Linear interpolation between a light and a dark shade, t in [0,1].
function shade(lightHex, darkHex, t) {
  const [lr, lg, lb] = hexToRgb(lightHex)
  const [dr, dg, db] = hexToRgb(darkHex)
  const r = Math.round(lr + (dr - lr) * t)
  const g = Math.round(lg + (dg - lg) * t)
  const b = Math.round(lb + (db - lb) * t)
  return `rgb(${r}, ${g}, ${b})`
}

// lightweight-charts' price-line `title` label auto-sizes to its own text, not to any data value -
// block characters baked into the title text are the only way to get a genuinely variable-length
// visual: "R ██████░░░░ 23400 (11.94M OI)".
const OI_BAR_BLOCKS = 10
function oiBarText(t, maxBlocks = OI_BAR_BLOCKS) {
  const filled = Math.max(1, Math.min(maxBlocks, Math.round(t * maxBlocks)))
  return '█'.repeat(filled) + '░'.repeat(maxBlocks - filled)
}

// OI, everywhere, always in millions - one comparable unit everywhere on the page.
export function formatOiMillions(n, { signed = false, withUnit = true } = {}) {
  if (n == null) return '—'
  const millions = n / 1_000_000
  const sign = signed && millions > 0 ? '+' : ''
  return `${sign}${millions.toFixed(2)}${withUnit ? 'M' : ''}`
}

const RESISTANCE_LIGHT = '#ffb3b3'
const RESISTANCE_DARK = '#7a0000'
const SUPPORT_LIGHT = '#b3f0c2'
const SUPPORT_DARK = '#0a5c1f'

// How many strikes on EACH side get an actual line drawn on the chart - only the strongest few (by
// OI) per side earn a line; the ladder already shows every strike.
const CHART_LEVELS_PER_SIDE = 5
// The widest ReplayChart's own candidate window is ever allowed to grow to hunt for
// CHART_LEVELS_PER_SIDE strikes with real OI.
const CHART_MAX_WINDOW_STEPS = 10

// Anything older than this, relative to "now", is flagged stale (dimmed + tooltip) instead of shown
// as if live - a real stored-data gap, not a rendering bug.
const OI_STALE_MS = 5 * 60_000

// Candlestick chart that draws the strongest OI levels on each side as horizontal price lines
// directly on the chart (darker = heavier OI = a "harder" level).
export function ReplayChart({ bars, ladderRows, dayKey, atmStrike, step, top5Only = true, vwapSeries = EMPTY_ARRAY, showVwap = false, onStrikeClick, height = 440 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const vwapSeriesRef = useRef(null)
  const priceLinesRef = useRef([])
  // Refs, not effect dependencies - clicking is wired up once in the chart-creation effect below
  // ([height] only), so a new onStrikeClick/step on every render must not tear down and recreate
  // the whole chart.
  const onStrikeClickRef = useRef(onStrikeClick)
  onStrikeClickRef.current = onStrikeClick
  const stepRef = useRef(step)
  stepRef.current = step

  const { ceTop, peTop, topRows } = useMemo(() => {
    if (!ladderRows || ladderRows.length === 0 || atmStrike == null || !step) return { ceTop: [], peTop: [], topRows: [] }
    const findTop = (key) => {
      for (let windowSteps = CHART_LEVELS_PER_SIDE; windowSteps <= CHART_MAX_WINDOW_STEPS; windowSteps++) {
        const candidates = ladderRows.filter((r) => Math.abs(r.strike - atmStrike) <= step * windowSteps && (r[key] ?? 0) > 0)
        if (candidates.length >= CHART_LEVELS_PER_SIDE || windowSteps === CHART_MAX_WINDOW_STEPS)
          return candidates.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, CHART_LEVELS_PER_SIDE)
      }
      return []
    }
    const ceTop = findTop('ceOi')
    const peTop = findTop('peOi')

    if (!top5Only) {
      const allWalls = ladderRows.filter((r) =>
        Math.abs(r.strike - atmStrike) <= step * CHART_MAX_WINDOW_STEPS && ((r.ceOi ?? 0) > 0 || (r.peOi ?? 0) > 0))
      return { ceTop, peTop, topRows: allWalls }
    }

    const byStrike = new Map()
    for (const row of [...ceTop, ...peTop]) byStrike.set(row.strike, row)
    return { ceTop, peTop, topRows: [...byStrike.values()] }
  }, [ladderRows, atmStrike, step, top5Only])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 13 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      // allowShiftVisibleRangeOnWhitespaceReplacement: lightweight-charts' own default
      // (shiftVisibleRangeOnNewBar, true) auto-scrolls to keep a freshly-appended bar in view, but
      // ONLY for a bar strictly past the chart's existing range - not one filling in a WHITESPACE
      // time point the chart had already pre-rendered further right (e.g. the next minute's empty
      // slot within today's still-ahead market hours). Every chart here re-supplies its FULL series
      // via setData() on every new tick (not series.update() for just the one changed bar), which is
      // exactly the shape that tends to land as "replacing whitespace" rather than "a genuinely new
      // bar" from the library's own perspective - without this flag, a live page's chart can silently
      // stop auto-scrolling forward as the day progresses, leaving the visible candles/EMAs looking
      // "stuck" in the past while a price label (which always reflects the true latest point
      // regardless of what's currently scrolled into view) correctly shows a real, much newer price -
      // a real report ("price incorrect") was exactly this: EMAs and candles frozen well behind the
      // shown current price. Harmless for OI Replay's own manual-scrub use of these same charts too -
      // both this and shiftVisibleRangeOnNewBar only ever act "when the last bar is visible", i.e.
      // only once a viewer is already AT the live/current edge, never while deliberately scrolled
      // back to inspect an earlier moment.
      timeScale: {
        borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })

    // Click-to-drill-down: rounds whatever price was clicked to the nearest tracked strike, same as
    // OiReplayPage's own identical chart. Guards non-finite price/strike explicitly (a click landing
    // on the price axis/label margin - exactly where the R/S wall labels render - can hand back a
    // non-finite value from coordinateToPrice) after a real report of that crashing the whole app.
    chart.subscribeClick((param) => {
      if (!param.point || !seriesRef.current || !stepRef.current) return
      const price = seriesRef.current.coordinateToPrice(param.point.y)
      if (price == null || !Number.isFinite(price)) return
      const strike = Math.round(price / stepRef.current) * stepRef.current
      if (!Number.isFinite(strike)) return
      onStrikeClickRef.current?.(strike)
    })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      vwapSeriesRef.current = null
      priceLinesRef.current = []
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
  }, [bars])

  // Fed only while checked, empty otherwise - simpler and just as instant as toggling a `visible`
  // option, and it means an unchecked chart never even pays for lightweight-charts re-rendering data
  // nobody asked to see.
  useEffect(() => {
    vwapSeriesRef.current?.setData(showVwap ? vwapSeries : EMPTY_ARRAY)
  }, [vwapSeries, showVwap])

  useFitContentAsDataGrows(chartRef, bars.length, dayKey)

  useEffect(() => {
    if (!seriesRef.current) return
    for (const line of priceLinesRef.current) seriesRef.current.removePriceLine(line)
    priceLinesRef.current = []
    if (topRows.length === 0) return

    const allOi = [...topRows.map((r) => r.ceOi ?? 0), ...topRows.map((r) => r.peOi ?? 0)]
    const maxOi = allOi.length > 0 ? Math.max(...allOi) : 0

    const drawSide = (rows, key, ivKey, staleKey, sinceOpenKey, suspectKey, lightColor, darkColor, labelPrefix) => {
      for (const row of rows) {
        if ((row[key] ?? 0) <= 0) continue
        const t = maxOi > 0 ? row[key] / maxOi : 1
        const stale = row[staleKey]
        const sinceOpen = row[sinceOpenKey]
        // suspectKey (Live OI Dashboard only - OI Replay rows never set it) means a Δ WAS computed
        // but looks implausible against current OI - see SinceOpenChange's own doc comment. Still
        // shown, just flagged with "(mismatch?)" appended - never hidden. A real report ("this
        // calculation is incorrect") once traced back to this exact figure being suppressed instead
        // of flagged, which read as "no data" rather than "here's a number, treat it with caution".
        const suspect = suspectKey && row[suspectKey]
        const srDiff = (row.peOi ?? 0) - (row.ceOi ?? 0)
        const line = seriesRef.current.createPriceLine({
          price: row.strike,
          color: stale ? `${shade(lightColor, darkColor, t)}80` : shade(lightColor, darkColor, t),
          lineWidth: 1 + Math.round(t * 2),
          lineStyle: stale ? 1 : 2,
          axisLabelVisible: true,
          title: `${labelPrefix} ${oiBarText(t)} ${row.strike} (${formatOiMillions(row[key])} OI${row[ivKey] != null ? `, IV ${row[ivKey].toFixed(1)}` : ''}${sinceOpen != null ? `, Δ ${formatOiMillions(sinceOpen, { signed: true })}${suspect ? ' (mismatch?)' : ''}` : ''}, S-R ${formatOiMillions(srDiff, { signed: true })})${stale ? ' [STALE]' : ''}`,
        })
        priceLinesRef.current.push(line)
      }
    }

    drawSide(topRows, 'ceOi', 'ceIv', 'ceStale', 'ceOiSinceOpen', 'ceOiSinceOpenSuspect', RESISTANCE_LIGHT, RESISTANCE_DARK, 'R')
    drawSide(topRows, 'peOi', 'peIv', 'peStale', 'peOiSinceOpen', 'peOiSinceOpenSuspect', SUPPORT_LIGHT, SUPPORT_DARK, 'S')
  }, [topRows])

  const ceLead = ceTop[0] ?? null
  const peLead = peTop[0] ?? null
  const ceDelta = ceLead?.ceOiSinceOpen ?? null
  const peDelta = peLead?.peOiSinceOpen ?? null
  const ceBias = ceDelta ? (ceDelta > 0 ? 'bearish' : 'bullish') : null
  const peBias = peDelta ? (peDelta > 0 ? 'bullish' : 'bearish') : null
  const tagBiasColor = (bias) => (bias === 'bullish' ? UP_COLOR : bias === 'bearish' ? DOWN_COLOR : AXIS_COLOR)
  const deltaTagStyle = (bias) => ({
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#00000080',
    color: tagBiasColor(bias),
    border: `1px solid ${tagBiasColor(bias)}`,
  })

  return (
    <div style={{ position: 'relative', width: '100%', height, overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {(ceLead || peLead) && (
        <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'none' }}>
          {ceLead && <span style={deltaTagStyle(ceBias)}>R {ceLead.strike} Δ {formatOiMillions(ceDelta, { signed: true })}</span>}
          {peLead && <span style={deltaTagStyle(peBias)}>S {peLead.strike} Δ {formatOiMillions(peDelta, { signed: true })}</span>}
        </div>
      )}
    </div>
  )
}

const EMA1_COLOR = '#f0b429'
const EMA2_COLOR = '#38bdf8'
const VWAP_COLOR = '#e072e8'
// A subset of the shared TIMEFRAME_OPTIONS (1/3/5 min only) - the whole point of the fast entry
// charts is a faster read than the main chart's own coarser timeframe.
export const FAST_TIMEFRAME_OPTIONS = TIMEFRAME_OPTIONS.filter((o) => o.value <= 5)

// A second, independently-timeframed candlestick chart with two EMA overlays, driven by the SAME
// oneMinBars/visibleCount the caller owns - never fetches or replays anything on its own.
export function EmaChart({ oneMinBars, visibleCount, timeframe, onTimeframeChange, ema1Period, onEma1PeriodChange, ema2Period, onEma2PeriodChange, dayKey, vwapSeries = EMPTY_ARRAY, showVwap = false, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const ema1SeriesRef = useRef(null)
  const ema2SeriesRef = useRef(null)
  const vwapSeriesRef = useRef(null)

  const displayBars = useMemo(
    () => aggregateBars(oneMinBars.slice(0, visibleCount), timeframe),
    [oneMinBars, visibleCount, timeframe],
  )
  const ema1Points = useMemo(() => computeEma(displayBars, ema1Period), [displayBars, ema1Period])
  const ema2Points = useMemo(() => computeEma(displayBars, ema2Period), [displayBars, ema2Period])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      // allowShiftVisibleRangeOnWhitespaceReplacement: lightweight-charts' own default
      // (shiftVisibleRangeOnNewBar, true) auto-scrolls to keep a freshly-appended bar in view, but
      // ONLY for a bar strictly past the chart's existing range - not one filling in a WHITESPACE
      // time point the chart had already pre-rendered further right (e.g. the next minute's empty
      // slot within today's still-ahead market hours). Every chart here re-supplies its FULL series
      // via setData() on every new tick (not series.update() for just the one changed bar), which is
      // exactly the shape that tends to land as "replacing whitespace" rather than "a genuinely new
      // bar" from the library's own perspective - without this flag, a live page's chart can silently
      // stop auto-scrolling forward as the day progresses, leaving the visible candles/EMAs looking
      // "stuck" in the past while a price label (which always reflects the true latest point
      // regardless of what's currently scrolled into view) correctly shows a real, much newer price -
      // a real report ("price incorrect") was exactly this: EMAs and candles frozen well behind the
      // shown current price. Harmless for OI Replay's own manual-scrub use of these same charts too -
      // both this and shiftVisibleRangeOnNewBar only ever act "when the last bar is visible", i.e.
      // only once a viewer is already AT the live/current edge, never while deliberately scrolled
      // back to inspect an earlier moment.
      timeScale: {
        borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    ema1SeriesRef.current = chart.addSeries(LineSeries, { color: EMA1_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    ema2SeriesRef.current = chart.addSeries(LineSeries, { color: EMA2_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      ema1SeriesRef.current = null
      ema2SeriesRef.current = null
      vwapSeriesRef.current = null
    }
  }, [height])

  useEffect(() => { ema1SeriesRef.current?.applyOptions({ title: `EMA ${ema1Period}` }) }, [ema1Period])
  useEffect(() => { ema2SeriesRef.current?.applyOptions({ title: `EMA ${ema2Period}` }) }, [ema2Period])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(displayBars) }, [displayBars])
  useEffect(() => { if (ema1SeriesRef.current) ema1SeriesRef.current.setData(ema1Points) }, [ema1Points])
  useEffect(() => { if (ema2SeriesRef.current) ema2SeriesRef.current.setData(ema2Points) }, [ema2Points])
  // Same "own timeframe, not the candles' own" reasoning as ReplayChart's identical effect - VWAP is
  // a session-cumulative value, not a moving average of the visible candles, so it is shown at its
  // own native 1-minute cadence regardless of what timeframe this chart's OWN candles are aggregated
  // to (exactly how TradingView shows it too).
  useEffect(() => {
    vwapSeriesRef.current?.setData(showVwap ? vwapSeries : EMPTY_ARRAY)
  }, [vwapSeries, showVwap])

  useFitContentAsDataGrows(chartRef, displayBars.length, `${dayKey}-${timeframe}`)

  return (
    <div style={{ width: '100%' }}>
      <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
        <Select value={timeframe} onChange={onTimeframeChange} style={{ width: 90 }} options={FAST_TIMEFRAME_OPTIONS} />
        <Text type="secondary" style={{ fontSize: 12, color: EMA1_COLOR }}>EMA</Text>
        <InputNumber value={ema1Period} onChange={(v) => onEma1PeriodChange(v || 1)} min={1} max={200} style={{ width: 70 }} />
        <Text type="secondary" style={{ fontSize: 12, color: EMA2_COLOR }}>EMA</Text>
        <InputNumber value={ema2Period} onChange={(v) => onEma2PeriodChange(v || 1)} min={1} max={200} style={{ width: 70 }} />
      </Space>
      <div ref={containerRef} style={{ width: '100%', height }} />
    </div>
  )
}

// A single leg's own premium as its own chart, with its own auto-scaled price axis - two of these
// (CE and PE) render side by side rather than one chart with both as overlaid lines, since a far
// OTM leg's premium can be a small fraction of ATM's and would otherwise flatten to a useless sliver.
export function PremiumLineChart({ points, dayKey, color, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const sanitizedPoints = useMemo(() => sanitizeLinePoints(points), [points])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      // allowShiftVisibleRangeOnWhitespaceReplacement: lightweight-charts' own default
      // (shiftVisibleRangeOnNewBar, true) auto-scrolls to keep a freshly-appended bar in view, but
      // ONLY for a bar strictly past the chart's existing range - not one filling in a WHITESPACE
      // time point the chart had already pre-rendered further right (e.g. the next minute's empty
      // slot within today's still-ahead market hours). Every chart here re-supplies its FULL series
      // via setData() on every new tick (not series.update() for just the one changed bar), which is
      // exactly the shape that tends to land as "replacing whitespace" rather than "a genuinely new
      // bar" from the library's own perspective - without this flag, a live page's chart can silently
      // stop auto-scrolling forward as the day progresses, leaving the visible candles/EMAs looking
      // "stuck" in the past while a price label (which always reflects the true latest point
      // regardless of what's currently scrolled into view) correctly shows a real, much newer price -
      // a real report ("price incorrect") was exactly this: EMAs and candles frozen well behind the
      // shown current price. Harmless for OI Replay's own manual-scrub use of these same charts too -
      // both this and shiftVisibleRangeOnNewBar only ever act "when the last bar is visible", i.e.
      // only once a viewer is already AT the live/current edge, never while deliberately scrolled
      // back to inspect an earlier moment.
      timeScale: {
        borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [height, color])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(sanitizedPoints) }, [sanitizedPoints])

  useFitContentAsDataGrows(chartRef, sanitizedPoints.length, dayKey)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Buckets one strike/side's own raw points into real per-minute OHLC bars, the same way a genuine
// tick-driven candlestick chart is built anywhere else in this app (e.g. CdvStrikeRuntime's own
// ApplyPriceTick on the backend). Naturally handles BOTH the backfilled portion of the day (one
// point per minute from the rolling-option collector, so each becomes its own flat open=high=low=
// close candle - an honest "we only know the per-minute closing print" read for anything before this
// page was open) AND the live-ticked portion (several raw points landing in the same minute get
// properly folded into open/high/low/close as they arrive) with the SAME bucketing logic - no need
// to special-case which regime a given point came from.
export function buildPremiumCandles(points) {
  if (!points) return []
  const buckets = new Map()
  for (const p of points) {
    const minute = Math.floor(toChartTime(p.time) / 60) * 60
    // A malformed/unparseable p.time (toChartTime returns NaN for it) or a missing/non-numeric
    // p.price would otherwise silently produce a NaN-valued or NaN-keyed bucket - lightweight-charts
    // throws an UNCAUGHT error on a non-finite candle value, which is exactly the "this chart could
    // not be rendered" crash ChartErrorBoundary exists to catch, not something worth risking when a
    // single bad point can be dropped here instead with no visible loss (this page already tolerates
    // gaps - see OI_STALE_MS).
    if (!Number.isFinite(minute) || !Number.isFinite(p.price)) continue
    // A real historical (or live-Dhan-sourced) minute bar already carries its OWN true Open/High/Low
    // - see OiReplayPoint's own doc comment on the backend - so use those directly instead of
    // re-deriving a synthetic range from p.price alone, which flattened every historical minute into
    // a doji (open=high=low=close) even when the real bar underneath it had genuine intra-minute
    // range. A genuine live tick (no open/high/low of its own, a single point in time rather than a
    // bar) still falls back to price-only bucketing below, correctly widening high/low as multiple
    // ticks land in the same still-forming minute.
    const hasOwnRange = Number.isFinite(p.open) && Number.isFinite(p.high) && Number.isFinite(p.low)
    // volume: last-value-wins, same as close - a real historical minute already carries its own
    // true per-minute volume (see OiReplayPoint's own doc comment on the backend), a live tick
    // defaults to 0 there (no per-tick volume of its own), so this correctly stays 0 through a
    // still-forming minute rather than fabricating one. Feeds computePremiumVwap below.
    const volume = Number.isFinite(p.volume) ? p.volume : 0
    const existing = buckets.get(minute)
    if (hasOwnRange) {
      if (existing) {
        existing.high = Math.max(existing.high, p.high)
        existing.low = Math.min(existing.low, p.low)
        existing.close = p.price
        existing.volume = volume
      } else {
        buckets.set(minute, { time: minute, open: p.open, high: p.high, low: p.low, close: p.price, volume })
      }
    } else if (existing) {
      existing.high = Math.max(existing.high, p.price)
      existing.low = Math.min(existing.low, p.price)
      existing.close = p.price
      existing.volume = volume
    } else {
      buckets.set(minute, { time: minute, open: p.price, high: p.price, low: p.price, close: p.price, volume })
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

// Session VWAP for one leg's own premium candles - cumulative typicalPrice*volume / cumulative
// volume, mirroring VwapCalculator.cs's own backend convention exactly (typical price =
// (H+L+C)/3, a zero-volume bar contributes nothing to the running total rather than being treated
// as a real reading, and no point at all is emitted before the day's first traded volume - not a
// zero, which would silently read as "below VWAP" against any real price). OI Replay is always one
// day at a time already, so there is no cross-day reset to handle here the way the backend's own
// multi-day version needs.
export function computePremiumVwap(oneMinCandles) {
  const points = []
  let cumulativePriceVolume = 0
  let cumulativeVolume = 0
  for (const c of oneMinCandles) {
    if (c.volume > 0) {
      const typicalPrice = (c.high + c.low + c.close) / 3
      cumulativePriceVolume += typicalPrice * c.volume
      cumulativeVolume += c.volume
    }
    if (cumulativeVolume > 0) points.push({ time: c.time, value: cumulativePriceVolume / cumulativeVolume })
  }
  return points
}

// Last line of defense before handing candles to lightweight-charts, which throws an UNCAUGHT error
// on a non-finite value, a duplicate time, or non-ascending order - same reasoning as App.jsx's own
// sanitizeSeries (this page's equivalent for a candle shape, not a plain line point). buildPremiumCa
// ndles above already filters/sorts its own output, but this is a second, independent guard so a
// crash here can never happen regardless of what future caller might pass to PremiumCandleChart.
function sanitizeCandles(bars) {
  const finite = bars.filter((b) => Number.isFinite(b.time) && Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close))
  const sorted = [...finite].sort((a, b) => a.time - b.time)
  const result = []
  for (const b of sorted) {
    if (result.length > 0 && result[result.length - 1].time === b.time) result[result.length - 1] = b
    else result.push(b)
  }
  return result
}

// Same "last line of defense" reasoning as sanitizeCandles above, for a plain {time, value} line
// point instead of a candle - used by PremiumLineChart just below.
function sanitizeLinePoints(points) {
  const finite = points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
  const sorted = [...finite].sort((a, b) => a.time - b.time)
  const result = []
  for (const p of sorted) {
    if (result.length > 0 && result[result.length - 1].time === p.time) result[result.length - 1] = p
    else result.push(p)
  }
  return result
}

// A single leg's own premium as a genuine candlestick chart, with its own auto-scaled price axis -
// two of these (CE and PE) render side by side rather than one chart with both overlaid, for the
// same reason PremiumLineChart above does (a far OTM leg's premium can be a small fraction of ATM's
// and would otherwise flatten to a useless sliver against the other leg's own scale). Mirrors how
// the Dashboard page (App.jsx) shows its own ATM CE/PE charts as real candles, not a line - unlike
// OiReplayPage's own single-price-per-minute rolling-collector data (which genuinely has no OHLC to
// show, hence PremiumLineChart's own line), this page also has the raw tick stream, so it can build
// real OHLC itself - see buildPremiumCandles above.
export function PremiumCandleChart({ bars, dayKey, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const sanitizedBars = useMemo(() => sanitizeCandles(bars), [bars])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      // allowShiftVisibleRangeOnWhitespaceReplacement: lightweight-charts' own default
      // (shiftVisibleRangeOnNewBar, true) auto-scrolls to keep a freshly-appended bar in view, but
      // ONLY for a bar strictly past the chart's existing range - not one filling in a WHITESPACE
      // time point the chart had already pre-rendered further right (e.g. the next minute's empty
      // slot within today's still-ahead market hours). Every chart here re-supplies its FULL series
      // via setData() on every new tick (not series.update() for just the one changed bar), which is
      // exactly the shape that tends to land as "replacing whitespace" rather than "a genuinely new
      // bar" from the library's own perspective - without this flag, a live page's chart can silently
      // stop auto-scrolling forward as the day progresses, leaving the visible candles/EMAs looking
      // "stuck" in the past while a price label (which always reflects the true latest point
      // regardless of what's currently scrolled into view) correctly shows a real, much newer price -
      // a real report ("price incorrect") was exactly this: EMAs and candles frozen well behind the
      // shown current price. Harmless for OI Replay's own manual-scrub use of these same charts too -
      // both this and shiftVisibleRangeOnNewBar only ever act "when the last bar is visible", i.e.
      // only once a viewer is already AT the live/current edge, never while deliberately scrolled
      // back to inspect an earlier moment.
      timeScale: {
        borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [height])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(sanitizedBars) }, [sanitizedBars])

  useFitContentAsDataGrows(chartRef, sanitizedBars.length, dayKey)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// A leg's own premium as candles (via buildPremiumCandles above) PLUS two configurable EMA overlays
// on top - CE/PE's own counterpart to EmaChart above (which does the same for the underlying spot),
// so OI Replay's own CE/PE charts aren't a bare candle chart (PremiumCandleChart, no EMA) or a plain
// line (its own now-removed PremiumLineChart), instead matching the same "candles + two EMAs, own
// timeframe" pattern the Entry charts already use. `asOfMs` is optional: while isToday, OI Replay
// omits it ("live" already means "everything captured so far" needs no cutoff); for a historical day
// it passes its own replay clock's asOfMs so this chart only ever reveals what the rest of that
// page's replay has "played" up to, same as every other chart there.
export function PremiumEmaChart({
  points, asOfMs, timeframe, onTimeframeChange, ema1Period, onEma1PeriodChange, ema2Period, onEma2PeriodChange, dayKey,
  showVwap = false, height = 320,
}) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const ema1SeriesRef = useRef(null)
  const ema2SeriesRef = useRef(null)
  const vwapSeriesRef = useRef(null)

  const filteredPoints = useMemo(
    () => (asOfMs == null ? points : (points ?? []).filter((p) => new Date(p.time).getTime() <= asOfMs)),
    [points, asOfMs],
  )
  const oneMinCandles = useMemo(() => buildPremiumCandles(filteredPoints), [filteredPoints])
  const displayBars = useMemo(() => sanitizeCandles(aggregateBars(oneMinCandles, timeframe)), [oneMinCandles, timeframe])
  const ema1Points = useMemo(() => computeEma(displayBars, ema1Period), [displayBars, ema1Period])
  const ema2Points = useMemo(() => computeEma(displayBars, ema2Period), [displayBars, ema2Period])
  // This LEG's own genuine VWAP - its own volume, not the underlying spot's (see
  // computePremiumVwap's own doc comment) - computed at native 1-minute resolution like the EMAs
  // above, not re-bucketed to the chart's own coarser timeframe (a session VWAP is a running total
  // across the whole day regardless of display timeframe, the same way the spot VWAP elsewhere on
  // this page is never re-aggregated either).
  const vwapPoints = useMemo(() => computePremiumVwap(oneMinCandles), [oneMinCandles])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      // allowShiftVisibleRangeOnWhitespaceReplacement: lightweight-charts' own default
      // (shiftVisibleRangeOnNewBar, true) auto-scrolls to keep a freshly-appended bar in view, but
      // ONLY for a bar strictly past the chart's existing range - not one filling in a WHITESPACE
      // time point the chart had already pre-rendered further right (e.g. the next minute's empty
      // slot within today's still-ahead market hours). Every chart here re-supplies its FULL series
      // via setData() on every new tick (not series.update() for just the one changed bar), which is
      // exactly the shape that tends to land as "replacing whitespace" rather than "a genuinely new
      // bar" from the library's own perspective - without this flag, a live page's chart can silently
      // stop auto-scrolling forward as the day progresses, leaving the visible candles/EMAs looking
      // "stuck" in the past while a price label (which always reflects the true latest point
      // regardless of what's currently scrolled into view) correctly shows a real, much newer price -
      // a real report ("price incorrect") was exactly this: EMAs and candles frozen well behind the
      // shown current price. Harmless for OI Replay's own manual-scrub use of these same charts too -
      // both this and shiftVisibleRangeOnNewBar only ever act "when the last bar is visible", i.e.
      // only once a viewer is already AT the live/current edge, never while deliberately scrolled
      // back to inspect an earlier moment.
      timeScale: {
        borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    ema1SeriesRef.current = chart.addSeries(LineSeries, { color: EMA1_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    ema2SeriesRef.current = chart.addSeries(LineSeries, { color: EMA2_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      ema1SeriesRef.current = null
      ema2SeriesRef.current = null
      vwapSeriesRef.current = null
    }
  }, [height])

  useEffect(() => { ema1SeriesRef.current?.applyOptions({ title: `EMA ${ema1Period}` }) }, [ema1Period])
  useEffect(() => { ema2SeriesRef.current?.applyOptions({ title: `EMA ${ema2Period}` }) }, [ema2Period])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(displayBars) }, [displayBars])
  useEffect(() => { if (ema1SeriesRef.current) ema1SeriesRef.current.setData(ema1Points) }, [ema1Points])
  useEffect(() => { if (ema2SeriesRef.current) ema2SeriesRef.current.setData(ema2Points) }, [ema2Points])
  useEffect(() => { vwapSeriesRef.current?.setData(showVwap ? vwapPoints : EMPTY_ARRAY) }, [vwapPoints, showVwap])

  useFitContentAsDataGrows(chartRef, displayBars.length, `${dayKey}-${timeframe}`)

  return (
    <div style={{ width: '100%' }}>
      <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
        <Select value={timeframe} onChange={onTimeframeChange} style={{ width: 90 }} options={FAST_TIMEFRAME_OPTIONS} />
        <Text type="secondary" style={{ fontSize: 12, color: EMA1_COLOR }}>EMA</Text>
        <InputNumber value={ema1Period} onChange={(v) => onEma1PeriodChange(v || 1)} min={1} max={200} style={{ width: 70 }} />
        <Text type="secondary" style={{ fontSize: 12, color: EMA2_COLOR }}>EMA</Text>
        <InputNumber value={ema2Period} onChange={(v) => onEma2PeriodChange(v || 1)} min={1} max={200} style={{ width: 70 }} />
      </Space>
      <div ref={containerRef} style={{ width: '100%', height }} />
    </div>
  )
}

// Scans every REVEALED point strictly after entry (bounded by asOfMs when given, for a replay that
// must never "see" a bar it hasn't played yet) to find whether a stop-loss or target was actually
// TOUCHED at any point since entry - not merely whether the LATEST point has crossed it, which would
// miss an intra-minute spike that reversed before the next check. Each point's own high/low (a real
// historical minute bar - see OiReplayPoint's own doc comment on the backend) is used when present;
// a live tick (a genuine single point in time, with no range of its own) falls back to its own price
// for both - the most accurate check that kind of data supports. Returns { kind: 'sl' | 'target',
// fillPrice } for the FIRST point where either level was touched (fillPrice is the configured level
// itself, not the bar's own high/low - a paper stop/limit order is assumed to fill exactly at its own
// level, not with extra favorable slippage), or null if neither has been touched yet. If a single
// bar's own range spans BOTH levels at once (a large bar engulfing both), the stop-loss is assumed to
// have been touched first - the standard, conservative convention, since OHLC alone can't say which
// one price actually reached first.
export function computeStopTargetHit(series, entryTimeMs, asOfMs, entryPrice, direction, slPoints, targetPoints) {
  const hasSl = slPoints > 0
  const hasTarget = targetPoints > 0
  if ((!hasSl && !hasTarget) || !series) return null
  const slLevel = direction === 'SELL' ? entryPrice + slPoints : entryPrice - slPoints
  const targetLevel = direction === 'SELL' ? entryPrice - targetPoints : entryPrice + targetPoints
  for (const p of series) {
    const t = new Date(p.time).getTime()
    if (t <= entryTimeMs) continue
    if (asOfMs != null && t > asOfMs) break
    const high = p.high ?? p.price
    const low = p.low ?? p.price
    if (high == null || low == null) continue
    const slHit = hasSl && (direction === 'SELL' ? high >= slLevel : low <= slLevel)
    const targetHit = hasTarget && (direction === 'SELL' ? low <= targetLevel : high >= targetLevel)
    if (slHit) return { kind: 'sl', fillPrice: slLevel }
    if (targetHit) return { kind: 'target', fillPrice: targetLevel }
  }
  return null
}

// SEBI periodically revises each index's own lot size - update this if it changes. This feature is
// paper trading only (no real order is ever placed), so a stale value here only skews the SIMULATED
// PnL's scale, not anything real.
export const PAPER_TRADE_LOT_SIZE = { NIFTY: 75, BANKNIFTY: 35, SENSEX: 20 }

// One simulated position: Buy (long) or Sell (short/write) CE/PE at whatever the live premium series
// shows right now, then Exit later - entirely client-side, no backend call, no real order.
export function PaperTradePanel({
  atmStrike, step, side, onSideChange, direction, onDirectionChange, strikeOffset, onStrikeOffsetChange,
  qtyLots, onQtyLotsChange, slPoints, onSlPointsChange, targetPoints, onTargetPointsChange,
  onPunch, canPunch, positions, onExit, onExitAll, onClearAll,
}) {
  const strikeOptions = useMemo(() => buildStrikeOffsetOptions(atmStrike, step), [atmStrike, step])

  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0)
  const hasOpenPosition = positions.some((p) => p.status === 'OPEN')

  const columns = [
    {
      title: 'Action', dataIndex: 'direction', key: 'direction', width: 60,
      render: (d, r) => <Tag color={d === 'BUY' ? 'success' : 'error'}>{d} {r.side}</Tag>,
    },
    { title: 'Strike', dataIndex: 'strike', key: 'strike', width: 70 },
    { title: 'Qty', dataIndex: 'qtyLots', key: 'qtyLots', width: 60, render: (q, r) => `${q}×${r.lotSize}` },
    { title: 'Entry', dataIndex: 'entryPrice', key: 'entryPrice', width: 65, render: (v) => v.toFixed(2) },
    { title: 'LTP', dataIndex: 'ltp', key: 'ltp', width: 65, render: (v) => v.toFixed(2) },
    {
      title: 'PnL', dataIndex: 'pnl', key: 'pnl', width: 85,
      render: (v) => <Text strong style={{ color: v >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{v >= 0 ? '+' : ''}{v.toFixed(0)}</Text>,
    },
    {
      title: '', key: 'action', width: 70,
      render: (_, r) => (r.status === 'OPEN'
        ? <Button size="small" onClick={() => onExit(r.id)}>Exit</Button>
        : <Tag color={r.exitReason === 'SL' ? 'error' : r.exitReason === 'Target' ? 'success' : 'default'}>{r.exitReason ?? 'Closed'}</Tag>),
    },
  ]

  return (
    <div style={{ width: '100%' }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap size={8}>
          <Segmented value={direction} onChange={onDirectionChange} options={[{ label: 'Buy', value: 'BUY' }, { label: 'Sell', value: 'SELL' }]} />
          <Segmented value={side} onChange={onSideChange} options={[{ label: 'CE', value: 'CE' }, { label: 'PE', value: 'PE' }]} />
          <Select value={strikeOffset} onChange={onStrikeOffsetChange} style={{ width: 160 }} options={strikeOptions} disabled={atmStrike == null} />
          <InputNumber value={qtyLots} onChange={(v) => onQtyLotsChange(v ?? 1)} min={1} step={1} style={{ width: 100 }} addonAfter="lots" />
          <InputNumber
            value={slPoints} onChange={(v) => onSlPointsChange(v ?? 0)} min={0} step={5} style={{ width: 110 }}
            addonBefore="SL" addonAfter="pts"
          />
          <InputNumber
            value={targetPoints} onChange={(v) => onTargetPointsChange(v ?? 0)} min={0} step={5} style={{ width: 130 }}
            addonBefore="Target" addonAfter="pts"
          />
          <Button type="primary" size="small" onClick={onPunch} disabled={!canPunch}>
            {direction === 'SELL' ? 'Sell' : 'Buy'}
          </Button>
        </Space>
        {positions.length > 0 && (
          <>
            {/* scroll.x - the panel itself is capped to fit a phone's viewport width (see
                DraggableFloatingPanel), narrower than these columns' own combined width, so the
                table needs to scroll horizontally within the panel rather than overflow it. */}
            <Table dataSource={positions} columns={columns} rowKey="id" size="small" pagination={false} scroll={{ x: 475, y: 220 }} />
            <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
              <Text strong style={{ color: totalPnl >= 0 ? UP_COLOR : DOWN_COLOR }}>
                Total PnL: {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)}
              </Text>
              <Space size={8}>
                <Button size="small" onClick={onExitAll} disabled={!hasOpenPosition}>Exit all</Button>
                <Button size="small" danger onClick={onClearAll}>Clear all</Button>
              </Space>
            </Space>
          </>
        )}
        <Text type="secondary" style={{ fontSize: 10 }}>
          Paper trade only - simulated against the live premium series, no real order is ever placed. Buy (long) or Sell (short/write),
          then Exit; lot size is a fixed per-underlying constant, not fetched live. SL/Target auto-exit an
          open position once its own premium has moved that many points against/in its favor (0 disables
          either), checked against every tick/minute bar's own high-low since entry - not just the latest
          price - so a real intra-bar touch is caught even if price reverses before the next check. Exit
          all closes every open position right now at its current price, without clearing the table the
          way Clear all does.
        </Text>
      </Space>
    </div>
  )
}

// Every DraggableFloatingPanel shares this one floor - small enough to still show a title/close
// button and at least a little content, never so small a caller's own inner layout (e.g. Paper
// Trade's own Buy/Sell row) breaks down.
const FLOATING_PANEL_MIN_WIDTH = 280
const FLOATING_PANEL_MIN_HEIGHT = 160

// A genuinely draggable AND resizable floating panel, rendered into a portal on document.body so it
// sits above every other element regardless of where its trigger lives in the tree. Position and
// size are both tracked as plain objects in the PARENT's own state ({x,y} and {width,height}) so
// both survive closing and reopening the panel - the same "caller owns the state, this component
// only ever reports a change" shape already established for `pos` before size was added, so a
// caller that doesn't care about resizing yet can simply not pass `size`/`onSizeChange` and get the
// same fixed-440px behavior as before.
export function DraggableFloatingPanel({ title, pos, onPosChange, size, onSizeChange, onClose, children }) {
  const dragRef = useRef(null)
  const resizeRef = useRef(null)
  const panelRef = useRef(null)
  // Whichever gesture's own window-level listener teardown is CURRENTLY registered (drag OR
  // resize, mouse OR touch - never more than one at once, since starting either kind of drag stops
  // propagation/is otherwise mutually exclusive) - so the unmount effect further below can force
  // that same teardown to run even if the gesture never got a natural mouseup/touchend first (the
  // panel closed mid-drag, or the whole page navigated away). Without this, closing the panel while
  // still holding a drag left its window 'mousemove'/'touchmove' listener attached indefinitely,
  // silently firing (and calling onPosChange/onSizeChange on an unmounted panel) on every mouse
  // movement anywhere on the page until whatever NEXT mouseup happened to occur, anywhere - a real,
  // if usually short-lived, leak.
  const activeGestureCleanupRef = useRef(null)

  useEffect(() => () => activeGestureCleanupRef.current?.(), [])
  // Undefined size (a caller that hasn't opted in) keeps the ORIGINAL fixed-and-viewport-clamped
  // width with no explicit height (grows to fit content) - resizing is opt-in, not a forced change
  // in behavior for an existing caller.
  const width = size?.width ?? null
  const height = size?.height ?? null

  // A fixed 440px panel is wider than most phone screens, and the caller's own initial `pos` is
  // computed once against whatever window.innerWidth happened to be at that moment - stale the
  // instant the viewport changes (device rotation, a resized browser window, or just a caller doing
  // its own math against a narrow screen). Re-clamping against this panel's OWN actual rendered
  // width/height (which the CSS width below already keeps within the viewport) on mount and resize
  // means it's never left partly or fully off-screen regardless of what `pos` it was handed.
  useEffect(() => {
    const clamp = () => {
      if (!panelRef.current) return
      const rect = panelRef.current.getBoundingClientRect()
      const maxX = Math.max(0, window.innerWidth - rect.width)
      const maxY = Math.max(0, window.innerHeight - rect.height)
      const clampedX = Math.min(Math.max(0, pos.x), maxX)
      const clampedY = Math.min(Math.max(0, pos.y), maxY)
      if (clampedX !== pos.x || clampedY !== pos.y) onPosChange({ x: clampedX, y: clampedY })
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.x, pos.y])

  const beginDrag = (clientX, clientY) => {
    dragRef.current = { startX: clientX, startY: clientY, origX: pos.x, origY: pos.y }
  }
  const dragTo = (clientX, clientY) => {
    if (!dragRef.current) return
    const dx = clientX - dragRef.current.startX
    const dy = clientY - dragRef.current.startY
    // Deliberately looser than the mount/resize clamp above (a fixed 80px/40px slack rather than the
    // panel's own full width/height) - lets the panel be dragged mostly off an edge and tucked out of
    // the way, same as before this fix, rather than only ever settling flush against the viewport.
    const maxX = Math.max(0, window.innerWidth - 80)
    const maxY = Math.max(0, window.innerHeight - 40)
    onPosChange({
      x: Math.min(Math.max(0, dragRef.current.origX + dx), maxX),
      y: Math.min(Math.max(0, dragRef.current.origY + dy), maxY),
    })
  }
  const endDrag = () => { dragRef.current = null }

  const onHeaderMouseDown = (e) => {
    beginDrag(e.clientX, e.clientY)
    const onMouseMove = (moveEvent) => dragTo(moveEvent.clientX, moveEvent.clientY)
    const onMouseUp = () => {
      endDrag()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      activeGestureCleanupRef.current = null
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    activeGestureCleanupRef.current = onMouseUp
  }

  // Touch's own counterpart to onHeaderMouseDown above - a phone/tablet never fires mouse events for
  // a finger drag, so without this the panel would be readable on mobile but simply un-repositionable.
  const onHeaderTouchStart = (e) => {
    const touch = e.touches[0]
    if (!touch) return
    beginDrag(touch.clientX, touch.clientY)
    const onTouchMove = (moveEvent) => {
      if (!dragRef.current) return
      moveEvent.preventDefault()
      const moveTouch = moveEvent.touches[0]
      if (moveTouch) dragTo(moveTouch.clientX, moveTouch.clientY)
    }
    const onTouchEnd = () => {
      endDrag()
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      activeGestureCleanupRef.current = null
    }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    activeGestureCleanupRef.current = onTouchEnd
  }

  // Resize is opt-in (onSizeChange provided) - a caller still on the old fixed-width API simply
  // never renders the handle at all, rather than resizing into a `size` no one is listening for.
  const beginResize = (clientX, clientY) => {
    if (!panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    resizeRef.current = { startX: clientX, startY: clientY, origWidth: rect.width, origHeight: rect.height }
  }
  const resizeTo = (clientX, clientY) => {
    if (!resizeRef.current || !panelRef.current) return
    const dx = clientX - resizeRef.current.startX
    const dy = clientY - resizeRef.current.startY
    // Capped against the panel's own CURRENT position (pos.x/pos.y), not the full viewport width -
    // growing further than the remaining room to the right/bottom edge would just push the panel's
    // own far edge off-screen instead of actually growing it any further, the same clipping mount/
    // resize clamp above already prevents for POSITION.
    const maxWidth = Math.max(FLOATING_PANEL_MIN_WIDTH, window.innerWidth - pos.x - 8)
    const maxHeight = Math.max(FLOATING_PANEL_MIN_HEIGHT, window.innerHeight - pos.y - 8)
    onSizeChange({
      width: Math.min(Math.max(FLOATING_PANEL_MIN_WIDTH, resizeRef.current.origWidth + dx), maxWidth),
      height: Math.min(Math.max(FLOATING_PANEL_MIN_HEIGHT, resizeRef.current.origHeight + dy), maxHeight),
    })
  }
  const endResize = () => { resizeRef.current = null }

  const onResizeHandleMouseDown = (e) => {
    e.stopPropagation() // Never also start a HEADER drag - the two gestures share no pixels, but bubbling would otherwise reach the same window-level listeners twice.
    beginResize(e.clientX, e.clientY)
    // A fast/sloppy mouse move during the drag otherwise selects whatever text (the panel's own
    // instructions, a page label underneath) the cursor happens to pass over mid-drag - the header
    // drag already prevents this on itself via userSelect: 'none', but that only covers the header;
    // a resize drag's cursor travels over the panel's own BODY content instead.
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    const onMouseMove = (moveEvent) => resizeTo(moveEvent.clientX, moveEvent.clientY)
    const onMouseUp = () => {
      endResize()
      document.body.style.userSelect = prevUserSelect
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      activeGestureCleanupRef.current = null
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    activeGestureCleanupRef.current = onMouseUp
  }
  const onResizeHandleTouchStart = (e) => {
    e.stopPropagation()
    const touch = e.touches[0]
    if (!touch) return
    beginResize(touch.clientX, touch.clientY)
    const onTouchMove = (moveEvent) => {
      if (!resizeRef.current) return
      moveEvent.preventDefault()
      const moveTouch = moveEvent.touches[0]
      if (moveTouch) resizeTo(moveTouch.clientX, moveTouch.clientY)
    }
    const onTouchEnd = () => {
      endResize()
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      activeGestureCleanupRef.current = null
    }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    activeGestureCleanupRef.current = onTouchEnd
  }

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000,
        width: width != null ? `${width}px` : 'min(440px, calc(100vw - 24px))',
        height: height != null ? `${height}px` : undefined,
        maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)',
        display: 'flex', flexDirection: 'column',
        background: '#1f1f1f', border: `1px solid ${BORDER_COLOR}`, borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.55)',
      }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        onTouchStart={onHeaderTouchStart}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: '0 0 auto',
          padding: '8px 12px', cursor: 'move', touchAction: 'none', userSelect: 'none',
          borderBottom: `1px solid ${BORDER_COLOR}`,
        }}
      >
        <Text strong style={{ fontSize: 'clamp(12px, 3.2vw, 13px)' }}>{title}</Text>
        <Button type="text" size="small" onClick={onClose} style={{ padding: '0 4px' }}>✕</Button>
      </div>
      <div style={{ padding: 12, overflow: 'auto', flex: '1 1 auto', minHeight: 0 }}>{children}</div>
      {onSizeChange && (
        <div
          onMouseDown={onResizeHandleMouseDown}
          onTouchStart={onResizeHandleTouchStart}
          title="Drag to resize"
          style={{
            position: 'absolute', right: 0, bottom: 0, width: 22, height: 22,
            cursor: 'nwse-resize', touchAction: 'none',
            // A plain corner-notch look via a diagonal gradient rather than an icon font/SVG asset -
            // three faint parallel lines, the universal "drag to resize" affordance.
            background: `linear-gradient(135deg, transparent 0 40%, ${BORDER_COLOR} 40% 46%, transparent 46% 60%, ${BORDER_COLOR} 60% 66%, transparent 66% 80%, ${BORDER_COLOR} 80% 86%, transparent 86%)`,
          }}
        />
      )}
    </div>,
    document.body,
  )
}

// A small colored delta label for a one-minute OI change.
function OiChange({ value }) {
  if (value == null || value === 0) return <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: AXIS_COLOR }}>·</Text>
  const up = value > 0
  return (
    <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: up ? UP_COLOR : DOWN_COLOR }}>
      {up ? '▲' : '▼'}{formatOiMillions(Math.abs(value))}
    </Text>
  )
}

// Cumulative OI change since the day's very first revealed point. `suspect` means the raw delta
// looks implausible against current OI - but it is ALWAYS shown, never hidden, just marked with a
// "?" so a reading worth double-checking is never confused with "no data at all" (a real report,
// "this calculation is incorrect", once traced back to this exact figure being suppressed instead of
// flagged).
function SinceOpenChange({ value, suspect = false }) {
  if (value == null) return null
  if (value === 0) return <Text style={{ fontSize: 'clamp(6px, 1.8vw, 8px)', color: AXIS_COLOR }}>open ·</Text>
  const up = value > 0
  return (
    <Tooltip title={`${up ? '+' : ''}${value.toLocaleString()} since today's open${suspect ? ' - flagged: the live tick feed and today\'s opening (REST) reading disagree by more than looks plausible for this strike. Logged to the browser console with the actual numbers.' : ''}`}>
      <Text style={{ fontSize: 'clamp(6px, 1.8vw, 8px)', color: up ? UP_COLOR : DOWN_COLOR, whiteSpace: 'nowrap' }}>
        open {formatOiMillions(value, { signed: true })}{suspect ? ' ⚠' : ''}
      </Text>
    </Tooltip>
  )
}

function OiChangeStack({ changeValue, sinceOpenValue, sinceOpenSuspect = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
      <OiChange value={changeValue} />
      <SinceOpenChange value={sinceOpenValue} suspect={sinceOpenSuspect} />
    </div>
  )
}

// The right-hand OI/IV ladder: every strike in the fetched band gets its own row, a CE bar
// extending right and a PE bar extending left from a shared center scale, both sides' IV printed
// alongside. The row(s) carrying the MOST OI on each side are called out as the current
// resistance (CE)/support (PE) read.
export function OiLadder({ rows, atmStrike }) {
  if (rows.length === 0) return <Empty description="No OI/IV data yet." />

  const maxOi = Math.max(1, ...rows.map((r) => r.ceOi ?? 0), ...rows.map((r) => r.peOi ?? 0))
  const resistanceStrike = rows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)?.strike
  const supportStrike = rows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)?.strike

  return (
    // Every row packs several fixed-width pieces (bars, OI text, IV text) into the 10/4/10 split
    // below - shrinking that split on a narrow phone would squash or wrap those pieces into an
    // unreadable mess, so instead this scrolls horizontally at its own natural width (minWidth)
    // rather than trying to reflow. touchAction/WebkitOverflowScrolling make that scroll a normal
    // touch swipe on a phone, not just a desktop scrollbar drag.
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 500 }}>
      <Row style={{ fontSize: 'clamp(9px, 2.4vw, 11px)', color: AXIS_COLOR, marginBottom: 4 }}>
        <Col span={10} style={{ textAlign: 'right', paddingRight: 6 }}>PE OI (support, in M)</Col>
        <Col span={4} style={{ textAlign: 'center' }}>Strike</Col>
        <Col span={10} style={{ paddingLeft: 6 }}>CE OI (resistance, in M)</Col>
      </Row>
      {rows.map((row) => {
        const isAtm = atmStrike != null && row.strike === atmStrike
        const isResistance = row.strike === resistanceStrike && (row.ceOi ?? 0) > 0
        const isSupport = row.strike === supportStrike && (row.peOi ?? 0) > 0
        return (
          <Row
            key={row.strike}
            align="middle"
            style={{
              background: isAtm ? '#ffffff12' : 'transparent',
              borderTop: isResistance ? `1px solid ${DOWN_COLOR}` : isSupport ? `1px solid ${UP_COLOR}` : '1px solid transparent',
              borderBottom: isResistance ? `1px solid ${DOWN_COLOR}` : isSupport ? `1px solid ${UP_COLOR}` : '1px solid transparent',
              padding: '1px 0',
            }}
          >
            <Col span={10} style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, opacity: row.peStale ? 0.45 : 1 }}>
              <OiChangeStack changeValue={row.peOiChange} sinceOpenValue={row.peOiSinceOpen} sinceOpenSuspect={row.peOiSinceOpenSuspect} />
              <Text style={{ fontSize: 'clamp(8px, 2.2vw, 10px)', color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.pePrice != null ? `${row.pePrice.toFixed(2)}` : ''}
                {row.peIv != null ? ` · IV ${row.peIv.toFixed(1)}` : ''}
                {row.peStale ? ' ⚠' : ''}
              </Text>
              <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: AXIS_COLOR, width: 'clamp(24px, 7vw, 34px)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {row.peOi != null ? formatOiMillions(row.peOi) : ''}
              </Text>
              <div style={{ width: 'clamp(44px, 13vw, 70px)', display: 'flex', justifyContent: 'flex-end' }}>
                <Tooltip title={row.peOi != null ? `PE OI: ${row.peOi.toLocaleString()}${row.pePrice != null ? `, LTP ${row.pePrice.toFixed(2)}` : ''}${row.peOiChange != null ? ` (${row.peOiChange >= 0 ? '+' : ''}${row.peOiChange.toLocaleString()} in the last min)` : ''}${row.peOiSinceOpen != null ? ` (${row.peOiSinceOpen >= 0 ? '+' : ''}${row.peOiSinceOpen.toLocaleString()} since open)` : ''}${row.peStale && row.peAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.peAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.peOi ?? 0) / maxOi) * 100}%`, minWidth: row.peOi ? 2 : 0, height: 14,
                    background: isSupport ? UP_COLOR : `${UP_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
            </Col>
            <Col span={4} style={{ textAlign: 'center' }}>
              <Text strong={isAtm} style={{ fontSize: 'clamp(10px, 2.8vw, 12px)', color: isAtm ? '#fff' : undefined }}>{row.strike.toLocaleString()}</Text>
            </Col>
            <Col span={10} style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: row.ceStale ? 0.45 : 1 }}>
              <div style={{ width: 'clamp(44px, 13vw, 70px)' }}>
                <Tooltip title={row.ceOi != null ? `CE OI: ${row.ceOi.toLocaleString()}${row.cePrice != null ? `, LTP ${row.cePrice.toFixed(2)}` : ''}${row.ceOiChange != null ? ` (${row.ceOiChange >= 0 ? '+' : ''}${row.ceOiChange.toLocaleString()} in the last min)` : ''}${row.ceOiSinceOpen != null ? ` (${row.ceOiSinceOpen >= 0 ? '+' : ''}${row.ceOiSinceOpen.toLocaleString()} since open)` : ''}${row.ceStale && row.ceAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.ceAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.ceOi ?? 0) / maxOi) * 100}%`, minWidth: row.ceOi ? 2 : 0, height: 14,
                    background: isResistance ? DOWN_COLOR : `${DOWN_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
              <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: AXIS_COLOR, width: 'clamp(24px, 7vw, 34px)', whiteSpace: 'nowrap' }}>
                {row.ceOi != null ? formatOiMillions(row.ceOi) : ''}
              </Text>
              <OiChangeStack changeValue={row.ceOiChange} sinceOpenValue={row.ceOiSinceOpen} sinceOpenSuspect={row.ceOiSinceOpenSuspect} />
              <Text style={{ fontSize: 'clamp(8px, 2.2vw, 10px)', color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.cePrice != null ? `${row.cePrice.toFixed(2)}` : ''}
                {row.ceIv != null ? ` · IV ${row.ceIv.toFixed(1)}` : ''}
                {row.ceStale ? ' ⚠' : ''}
              </Text>
            </Col>
          </Row>
        )
      })}
    </div>
    </div>
  )
}

// Same reasoning as OiReplayPage's own ChartErrorBoundary - a lightweight-charts assertion or bad
// data shape should degrade to a message, not blank the whole page.
export class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('OI Replay chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the ladder and stats above are still available." />
    }
    return this.props.children
  }
}

export { OI_STALE_MS }
