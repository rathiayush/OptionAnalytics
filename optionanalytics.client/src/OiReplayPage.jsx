import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Card, Button, Statistic, Row, Col, DatePicker, Alert, Empty, Tooltip, Slider, Tag, InputNumber, Switch } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined, SoundOutlined } from '@ant-design/icons'
import { createChart, CandlestickSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import {
  UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  istTimeFormatter, istTickMarkFormatter, toBar, toChartTime, fromChartTime, istDateKey,
  NavBar, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState,
} from './shared.jsx'

const { Text, Title } = Typography

// The (underlying, expiryFlag) combos OiReplayLiveFeedService actually tracks live on the backend -
// BANKNIFTY has no weekly expiry (same rule the rest of this page and Expired Backtest enforce), so
// a live feed for that combo will simply never arrive; kept in sync with that service's own list by
// hand since the two sides have no shared source of truth to derive it from automatically.
const LIVE_FEED_COMBOS = new Set(['NIFTY:WEEK', 'NIFTY:MONTH', 'BANKNIFTY:MONTH'])

// Connects to the same SignalR hub the live dashboard already uses (App.jsx's own useHub), for two
// events: "spotUpdate" (SpotFeedHostedService's existing push - the underlying's own currently-
// forming 1-minute bar, reused as-is rather than building a second live-spot pipeline) and
// "oiReplayTick" (OiReplayLiveFeedService's new push - one option leg's live price/OI). Both
// callbacks are read through refs (same pattern as App.jsx's useHub) so the connection itself only
// needs to open/close when `enabled` changes, never when underlying/expiryFlag/the callbacks
// themselves change identity across a re-render.
function useOiReplayLiveFeed(enabled, onSpotUpdate, onOiReplayTick, onReconnected) {
  const spotRef = useRef(onSpotUpdate)
  const tickRef = useRef(onOiReplayTick)
  const reconnectedRef = useRef(onReconnected)
  spotRef.current = onSpotUpdate
  tickRef.current = onOiReplayTick
  reconnectedRef.current = onReconnected

  useEffect(() => {
    if (!enabled) return
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    connection.on('spotUpdate', (snapshot) => spotRef.current(snapshot))
    connection.on('oiReplayTick', (tick) => tickRef.current(tick))
    connection.onreconnected(() => reconnectedRef.current?.())
    connection.start().catch((err) => {
      // Same StrictMode double-mount as App.jsx's useHub - the first connection's start() gets
      // aborted by this effect's own cleanup before negotiation finishes on the second mount.
      if (err?.name === 'AbortError') return
      console.error('OI Replay live feed connection failed:', err)
    })

    return () => { connection.stop() }
  }, [enabled])
}

// One entry per distinct strike this side ever reported, its own points sorted ascending by time -
// built once per fetched run (see useMemo below), not recomputed on every replay tick. Grouping by
// strike here is what lets the replay loop below look up "this strike's latest reading at or before
// time T" as a simple per-strike scan instead of re-filtering the whole flat point list every tick.
function groupByStrike(points) {
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
// yet as of this point in the replay. Linear scan from the end: a real day's own per-strike series
// is at most a few hundred points, and this runs once per strike per tick, so this is nowhere near
// hot enough to need a binary search.
function latestAtOrBefore(sortedPoints, asOfMs) {
  for (let i = sortedPoints.length - 1; i >= 0; i--) {
    const t = new Date(sortedPoints[i].time).getTime()
    if (t <= asOfMs) return sortedPoints[i]
  }
  return null
}

// Client-side counterpart to the backend's own BacktestUtil.AggregateCandles - buckets native
// 1-minute bars (already chart-time-shifted by toBar/toChartTime) into timeframeMinutes candles.
// Deliberately does NOT drop a trailing incomplete bucket the way the backend does for a finished
// backtest: here the whole point is to show the CURRENTLY FORMING candle live as 1-minute ticks
// keep arriving, the same way a real charting terminal's current bar updates mid-formation. Safe to
// bucket the already-IST-shifted time directly - the shift (5.5 hours) divides evenly into every
// offered timeframe (1/3/5/15 min), so it lands on the exact same bucket boundaries plain UTC would.
function aggregateBars(oneMinBars, timeframeMinutes) {
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

// A short beep via the Web Audio API - no asset file needed. Lazily creates (and reuses) one
// AudioContext, created on first call rather than at module load, since most browsers refuse to
// start an AudioContext before any user gesture on the page - by the time this can fire (a replay
// tick), the user has already clicked Load/Start, which satisfies that.
let sharedAudioCtx = null
function playBeep() {
  try {
    sharedAudioCtx ??= new (window.AudioContext || window.webkitAudioContext)()
    const ctx = sharedAudioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.35)
  } catch {
    // Audio unavailable/blocked - the visual alert banner still shows either way, so this is not
    // the only way the user finds out.
  }
}

// The classic Max Pain read: the strike where option WRITERS (as a whole, both legs) would owe the
// least if the underlying settled there today - candidates are exactly the strikes this run actually
// has OI for, since anywhere else is not a real strike price to consider.
function computeMaxPain(rows) {
  if (rows.length === 0) return null
  let best = null
  let bestPain = Infinity
  for (const candidate of rows) {
    let pain = 0
    for (const row of rows) {
      if (row.ceOi) pain += row.ceOi * Math.max(0, candidate.strike - row.strike)
      if (row.peOi) pain += row.peOi * Math.max(0, row.strike - candidate.strike)
    }
    if (pain < bestPain) { bestPain = pain; best = candidate.strike }
  }
  return best
}

// How many strikes on EACH side get an actual line drawn on the chart - the ladder already shows
// every strike; the chart would just be noise at that density, so only the strongest few (by OI)
// per side earn a line there. Support/resistance is a relative-strength read anyway. Also the
// MINIMUM count ReplayChart's own ATM-centered window widens to find - see that component's own
// doc comment on why "at least 5, always" needed an adaptive window rather than a fixed one.
const CHART_LEVELS_PER_SIDE = 5

// The widest ReplayChart's own candidate window is ever allowed to grow to hunt for
// CHART_LEVELS_PER_SIDE strikes with real OI - matches the backend's own StrikeBandSteps (the
// fetched band's own half-width), since a window wider than that would just be band strikes that
// were never actually fetched.
const CHART_MAX_WINDOW_STEPS = 10

// How big a since-PREVIOUS-CANDLE OI/price move has to be before FuturesChart marks it as a real
// regime shift rather than noise - a futures contract's own total OI is a totally different scale
// from a single option strike's (tens of millions vs a single strike's few million), so this is
// its own dedicated threshold rather than reusing the options ladder's per-strike alertThreshold.
// PRICE_STEP_FACTOR is a fraction of the underlying's own strike step (already a sensible "is this
// a real move" unit elsewhere on this page), not a fixed point value, so it scales automatically
// between NIFTY (step 50) and BANKNIFTY (step 100).
const FUTURES_REGIME_OI_THRESHOLD = 50_000
const FUTURES_REGIME_PRICE_STEP_FACTOR = 0.2

// latestAtOrBefore always returns the newest point at-or-before "now", even if that point is from
// an hour ago - if NiftyDataCollector's own backfill for a strike/side simply has no newer rows yet
// (a real gap in the stored data, not a rendering bug), the ladder/chart would otherwise silently
// keep repeating that same last-known reading forever, looking exactly like "the page froze" with
// nothing in the UI to say why. Anything older than this, relative to the replay's current time, is
// flagged stale (dimmed + a "no update since HH:MM" tooltip) instead of being shown as if live.
const OI_STALE_MS = 5 * 60_000

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Linear interpolation between a light and a dark shade, t in [0,1] - t=0 is the lightest (weakest
// OI among the levels actually drawn), t=1 the darkest (heaviest, "hardest" wall). Used for both
// the resistance (red) and support (green) lines below with their own two endpoints.
function shade(lightHex, darkHex, t) {
  const [lr, lg, lb] = hexToRgb(lightHex)
  const [dr, dg, db] = hexToRgb(darkHex)
  const r = Math.round(lr + (dr - lr) * t)
  const g = Math.round(lg + (dg - lg) * t)
  const b = Math.round(lb + (db - lb) * t)
  return `rgb(${r}, ${g}, ${b})`
}

const RESISTANCE_LIGHT = '#ffb3b3'
const RESISTANCE_DARK = '#7a0000'
const SUPPORT_LIGHT = '#b3f0c2'
const SUPPORT_DARK = '#0a5c1f'

// Candlestick chart that reveals `bars` progressively as the replay advances - a single visibleCount
// controls exactly how many of the (already-loaded) day's bars are shown, so playback needs no
// further data fetch, just a local re-render. Also draws the strongest OI levels on each side as
// horizontal price lines directly on the chart (darker = heavier OI = a "harder" level) - the same
// data the ladder shows in table form, here as the market-structure read on the price chart itself.
function ReplayChart({ bars, ladderRows, dayKey, atmStrike, step, height = 440 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const priceLinesRef = useRef([])

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
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      priceLinesRef.current = [] // the series they belonged to is gone along with the chart
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
  }, [bars])

  // Re-fit once when a brand new day/timeframe first loads (dayKey changes) - deliberately NOT on
  // every tick (bars itself is a fresh array reference every tick as the replay reveals/reaggregates
  // more of it), which would fight the user's own pan/zoom/scroll during playback - the actual
  // "should be able to zoom in/out" ask depends on this NOT resetting the view underneath them.
  useEffect(() => {
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

  // Redraws the strongest CHART_LEVELS_PER_SIDE (5) resistance (CE OI) / support (PE OI) lines on
  // every tick, since OI itself changes as the replay advances AND which strikes even qualify
  // shifts as ATM moves - always clears the previous set first rather than trying to diff/reuse
  // handles, since "top 5" can change entirely from one tick to the next.
  //
  // Candidates are ranked within a window CENTERED ON ATM (not the day's own realized high/low),
  // widened one strike-step at a time until at least CHART_LEVELS_PER_SIDE candidates qualify (or
  // the fetched band - +-10 steps - is exhausted) - two real problems this fixes together:
  //   1. A day-range-based window is fixed for the whole day and doesn't move with price, so once
  //      ATM has drifted away from where the day opened, "the 5 strongest levels" silently stopped
  //      being the 5 strongest levels NEAR PRICE - the user's own "as soon as price shifts you add
  //      or remove new ones" ask.
  //   2. A FIXED window width (even an ATM-centered one) still under-fills to fewer than 5 lines
  //      whenever a quiet stretch or a data gap leaves too few non-zero strikes inside it - this
  //      widens just as far as actually needed to reach 5, rather than an always-maximal band that
  //      would reintroduce the original "candle axis squashed by a far-away strike" bug (see
  //      CHART_MAX_WINDOW_STEPS's own comment) or an always-narrow one that under-fills.
  useEffect(() => {
    if (!seriesRef.current) return
    for (const line of priceLinesRef.current) seriesRef.current.removePriceLine(line)
    priceLinesRef.current = []
    if (!ladderRows || ladderRows.length === 0 || atmStrike == null || !step) return

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

    // ONE shared scale across BOTH sides, not one independently computed per side - drawing R and
    // S lines with their own separate min/max meant a 33M PE level could render THINNER than a
    // 17M CE level (each was only ranked against its own side's other four candidates), which is
    // exactly backwards and misleading to read at a glance. A strike's line thickness/darkness on
    // this chart now means the same thing everywhere on it, CE or PE.
    const allOi = [...ceTop.map((r) => r.ceOi), ...peTop.map((r) => r.peOi)]
    const maxOi = allOi.length > 0 ? Math.max(...allOi) : 0
    const minOi = allOi.length > 0 ? Math.min(...allOi) : 0
    const span = maxOi - minOi

    const drawSide = (top, key, ivKey, staleKey, sinceOpenKey, lightColor, darkColor, labelPrefix) => {
      for (const row of top) {
        const t = span > 0 ? (row[key] - minOi) / span : 1
        // A stale level (see OI_STALE_MS) is a real OI reading, just a frozen one - still worth
        // drawing (it's the last known wall), but visually muted and labeled so it doesn't look
        // like a live, currently-updating level when the underlying data has stopped arriving.
        const stale = row[staleKey]
        // Day's open OI backed out from the already-computed since-open delta (current - delta =
        // open) rather than a second lookup - shown right in the on-chart label (a price line's
        // title renders directly on the chart, not just on hover) so a wall's CURRENT weight is
        // always read against where it started the day, without leaving the chart for the ladder.
        const openOi = row[sinceOpenKey] != null ? row[key] - row[sinceOpenKey] : null
        const line = seriesRef.current.createPriceLine({
          price: row.strike,
          color: stale ? `${shade(lightColor, darkColor, t)}80` : shade(lightColor, darkColor, t),
          lineWidth: 1 + Math.round(t * 2), // thicker as OI (and darkness) increases too
          lineStyle: stale ? 1 : 2, // dotted when stale, dashed when live
          axisLabelVisible: true,
          title: `${labelPrefix} ${row.strike} (${formatOiMillions(row[key])} OI${row[ivKey] != null ? `, IV ${row[ivKey].toFixed(1)}` : ''}${openOi != null ? `, open ${formatOiMillions(openOi, { signed: true })}` : ''})${stale ? ' [STALE]' : ''}`,
        })
        priceLinesRef.current.push(line)
      }
    }

    drawSide(ceTop, 'ceOi', 'ceIv', 'ceStale', 'ceOiSinceOpen', RESISTANCE_LIGHT, RESISTANCE_DARK, 'R')
    drawSide(peTop, 'peOi', 'peIv', 'peStale', 'peOiSinceOpen', SUPPORT_LIGHT, SUPPORT_DARK, 'S')
  }, [ladderRows, atmStrike, step])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Colors for the futures regime read - Long Buildup/Short Covering are bullish (price+OI both
// rising, or OI unwinding as price rises - fresh longs or shorts closing out), Short Buildup/Long
// Unwinding are bearish (the mirror image) - same UP_COLOR/DOWN_COLOR sentiment convention as
// everywhere else on this page, not the CE/PE-type colors.
const FUTURES_REGIME_INFO = {
  'Long Buildup': { bias: 'Bullish', color: UP_COLOR, blurb: 'Price rising with OI rising - fresh long positions being added.' },
  'Short Covering': { bias: 'Bullish', color: UP_COLOR, blurb: 'Price rising with OI falling - shorts buying back to close, not fresh buying.' },
  'Short Buildup': { bias: 'Bearish', color: DOWN_COLOR, blurb: 'Price falling with OI rising - fresh short positions being added.' },
  'Long Unwinding': { bias: 'Bearish', color: DOWN_COLOR, blurb: 'Price falling with OI falling - longs exiting, not fresh selling.' },
  Neutral: { bias: 'Neutral', color: AXIS_COLOR, blurb: 'No significant price/OI move yet.' },
}

// The classic futures 4-quadrant read: price direction x OI direction. Unlike an option strike
// (where OI sits AT a level and a wall is a relative-strength read), a future has exactly one
// instrument, so its own OI change is a direct, unambiguous read on aggregate conviction - no
// "relative to what" question the way an option chain's OI needs.
function classifyFuturesRegime(priceDelta, oiDelta, priceThreshold, oiThreshold) {
  if (oiDelta == null || Math.abs(oiDelta) < oiThreshold || Math.abs(priceDelta) < priceThreshold) return 'Neutral'
  if (oiDelta > 0) return priceDelta > 0 ? 'Long Buildup' : 'Short Buildup'
  return priceDelta > 0 ? 'Short Covering' : 'Long Unwinding'
}

// Candlestick chart for the day's futures contract - same reveal-as-replay-advances shape as
// ReplayChart - PLUS an OI overlay line (own left-hand price scale, so it never competes with the
// candles' own right-hand price axis) and regime-change markers (Long Buildup/Short Buildup/Short
// Covering/Long Unwinding - see classifyFuturesRegime) stamped directly on the candle where each
// shift actually started, the "show me when what happened" read for a future's own OI - unlike an
// option strike, a future has no strike chain to draw S/R walls for, so this chart's OI story is
// entirely about ITS OWN change over time rather than a level.
function FuturesChart({ bars, oiLine, markers, dayKey, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const oiSeriesRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      leftPriceScale: { visible: true, borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    // Own (left) price scale and a thin, semi-transparent line - OI's own numbers (lakhs/crores)
    // are a totally different scale than price, so sharing the right-hand axis with candles would
    // otherwise squash one or the other into a flat line.
    oiSeriesRef.current = chart.addSeries(LineSeries, {
      color: `${AXIS_COLOR}cc`, lineWidth: 2, priceScaleId: 'left', priceLineVisible: false, lastValueVisible: true,
      title: 'OI (M)',
    })
    // The plotted values are already OI/1e6 (see the caller's own futuresOiLine) - format the axis
    // itself to 2 decimals instead of lightweight-charts' own default (which would otherwise round
    // a value like 12.34 down to whole numbers and make small OI moves invisible on the axis).
    chart.priceScale('left').applyOptions({ mode: 0 })
    oiSeriesRef.current.applyOptions({ priceFormat: { type: 'custom', formatter: (v) => v.toFixed(2) } })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      oiSeriesRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
  }, [bars])

  useEffect(() => {
    if (!oiSeriesRef.current) return
    oiSeriesRef.current.setData(oiLine)
  }, [oiLine])

  useEffect(() => {
    seriesRef.current?.setMarkers(markers ?? [])
  }, [markers])

  useEffect(() => {
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// The right-hand OI/IV ladder: every strike in the fetched band gets its own row (never just the
// single heaviest one - see this page's own "there could be multiple [levels]" request), a CE bar
// extending right and a PE bar extending left from a shared center scale, both sides' IV printed
// alongside. The row(s) actually carrying the MOST OI on each side are called out as the current
// resistance (CE)/support (PE) read, since a wall only means something relative to the rest of the
// chain, not in isolation.
function OiLadder({ rows, atmStrike }) {
  if (rows.length === 0) return <Empty description="No stored OI/IV data yet at this point in the replay." />

  const maxCeOi = Math.max(1, ...rows.map((r) => r.ceOi ?? 0))
  const maxPeOi = Math.max(1, ...rows.map((r) => r.peOi ?? 0))
  const resistanceStrike = rows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)?.strike
  const supportStrike = rows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)?.strike

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Row style={{ fontSize: 11, color: AXIS_COLOR, marginBottom: 4 }}>
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
              <OiChangeStack changeValue={row.peOiChange} sinceOpenValue={row.peOiSinceOpen} />
              <Text style={{ fontSize: 10, color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.pePrice != null ? `${row.pePrice.toFixed(2)}` : ''}
                {row.peIv != null ? ` · IV ${row.peIv.toFixed(1)}` : ''}
                {row.peStale ? ' ⚠' : ''}
              </Text>
              <Text style={{ fontSize: 9, color: AXIS_COLOR, width: 34, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {row.peOi != null ? formatOiMillions(row.peOi) : ''}
              </Text>
              <div style={{ width: 70, display: 'flex', justifyContent: 'flex-end' }}>
                <Tooltip title={row.peOi != null ? `PE OI: ${row.peOi.toLocaleString()}${row.pePrice != null ? `, LTP ${row.pePrice.toFixed(2)}` : ''}${row.peOiChange != null ? ` (${row.peOiChange >= 0 ? '+' : ''}${row.peOiChange.toLocaleString()} in the last min)` : ''}${row.peOiSinceOpen != null ? ` (${row.peOiSinceOpen >= 0 ? '+' : ''}${row.peOiSinceOpen.toLocaleString()} since open)` : ''}${row.peStale && row.peAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.peAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.peOi ?? 0) / maxPeOi) * 100}%`, minWidth: row.peOi ? 2 : 0, height: 14,
                    background: isSupport ? UP_COLOR : `${UP_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
            </Col>
            <Col span={4} style={{ textAlign: 'center' }}>
              <Text strong={isAtm} style={{ fontSize: 12, color: isAtm ? '#fff' : undefined }}>{row.strike.toLocaleString()}</Text>
            </Col>
            <Col span={10} style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: row.ceStale ? 0.45 : 1 }}>
              <div style={{ width: 70 }}>
                <Tooltip title={row.ceOi != null ? `CE OI: ${row.ceOi.toLocaleString()}${row.cePrice != null ? `, LTP ${row.cePrice.toFixed(2)}` : ''}${row.ceOiChange != null ? ` (${row.ceOiChange >= 0 ? '+' : ''}${row.ceOiChange.toLocaleString()} in the last min)` : ''}${row.ceOiSinceOpen != null ? ` (${row.ceOiSinceOpen >= 0 ? '+' : ''}${row.ceOiSinceOpen.toLocaleString()} since open)` : ''}${row.ceStale && row.ceAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.ceAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.ceOi ?? 0) / maxCeOi) * 100}%`, minWidth: row.ceOi ? 2 : 0, height: 14,
                    background: isResistance ? DOWN_COLOR : `${DOWN_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
              <Text style={{ fontSize: 9, color: AXIS_COLOR, width: 34, whiteSpace: 'nowrap' }}>
                {row.ceOi != null ? formatOiMillions(row.ceOi) : ''}
              </Text>
              <OiChangeStack changeValue={row.ceOiChange} sinceOpenValue={row.ceOiSinceOpen} />
              <Text style={{ fontSize: 10, color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.cePrice != null ? `${row.cePrice.toFixed(2)}` : ''}
                {row.ceIv != null ? ` · IV ${row.ceIv.toFixed(1)}` : ''}
                {row.ceStale ? ' ⚠' : ''}
              </Text>
            </Col>
          </Row>
        )
      })}
    </div>
  )
}

// Same reasoning as ExpiredBacktestPage's own ChartErrorBoundary - a lightweight-charts assertion or
// bad data shape should degrade to a message, not blank the whole page (the stats/ladder above are
// still useful even if the chart itself can't render). Must be a class component; React has no hook
// equivalent for catching a child's render/effect errors.
class ChartErrorBoundary extends Component {
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

// A small colored delta label for a one-minute OI change - green/up for building, red/down for
// unwinding, dash for no change or not-yet-available (first minute of the day, no prior reading).
function OiChange({ value }) {
  if (value == null || value === 0) return <Text style={{ fontSize: 9, color: AXIS_COLOR }}>·</Text>
  const up = value > 0
  return (
    <Text style={{ fontSize: 9, color: up ? UP_COLOR : DOWN_COLOR }}>
      {up ? '▲' : '▼'}{formatOiMillions(Math.abs(value))}
    </Text>
  )
}

// OI, everywhere on this page, always in millions - the user's own explicit "show all the tags in
// million for OI" ask, so every OI figure (a level's own OI, a per-minute/since-open/since-previous-
// candle change, a whole-band total) reads in the SAME unit and is directly comparable at a glance,
// rather than mixing raw comma-grouped numbers in some places and K/M-switching ones in others.
// signed=true prefixes a delta with +/- (a "change" reads oddly without a sign); an absolute level
// never needs one. withUnit=false drops the trailing "M" for a context that already labels the unit
// itself (an axis/column header, most concretely).
function formatOiMillions(n, { signed = false, withUnit = true } = {}) {
  if (n == null) return '—'
  const millions = n / 1_000_000
  const sign = signed && millions > 0 ? '+' : ''
  return `${sign}${millions.toFixed(2)}${withUnit ? 'M' : ''}`
}

// Cumulative OI change since the day's very first revealed candle - same up/down coloring as
// OiChange (the last-minute delta) but visually distinct ("open" tag and a tooltip with the exact
// figure) so it's never confused with the single-tick number sitting right next to it - this is
// the whole day's drift, per the user's own "change in OI since days open".
function SinceOpenChange({ value }) {
  if (value == null) return null
  if (value === 0) return <Text style={{ fontSize: 8, color: AXIS_COLOR }}>open ·</Text>
  const up = value > 0
  return (
    <Tooltip title={`${up ? '+' : ''}${value.toLocaleString()} since today's open`}>
      <Text style={{ fontSize: 8, color: up ? UP_COLOR : DOWN_COLOR, whiteSpace: 'nowrap' }}>
        open {formatOiMillions(value, { signed: true })}
      </Text>
    </Tooltip>
  )
}

function OiChangeStack({ changeValue, sinceOpenValue }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
      <OiChange value={changeValue} />
      <SinceOpenChange value={sinceOpenValue} />
    </div>
  )
}

function biasColor(bias) {
  return bias === 'Bullish' ? 'success' : bias === 'Bearish' ? 'error' : 'default'
}

const SPEED_OPTIONS = [
  { value: 2000, label: '0.5x' },
  { value: 1000, label: '1x' },
  { value: 500, label: '2x' },
  { value: 250, label: '4x' },
  { value: 100, label: '10x' },
]

// Candle-by-candle replay of one trading day - spot chart on the left, an OI/IV ladder across the
// whole fetched strike band on the right, updating together as playback advances. A past day's data
// comes from NiftyDataCollector's own TimescaleDB, falling back to a direct Dhan REST call when
// that's not fresh enough (see OiReplayService's own doc comment); TODAY additionally stays live
// via OiReplayLiveFeedService's WebSocket-fed ticks (see useOiReplayLiveFeed below) once the
// initial snapshot has loaded, rather than only ever showing whatever was true at load time.
export default function OiReplayPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 5)
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  const [date, setDate] = useState(null)
  const [speedMs, setSpeedMs] = useState(500)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const [visibleCount, setVisibleCount] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timerRef = useRef(null)

  // The live "tail" beyond whatever the initial REST snapshot carried - only ever appended to while
  // isToday is true (see below), reset on every fresh load() so switching days never carries a
  // previous day's live ticks forward.
  const [liveBars, setLiveBars] = useState([])
  const [liveCePoints, setLiveCePoints] = useState([])
  const [livePePoints, setLivePePoints] = useState([])
  const caughtUpLenRef = useRef(0)

  // BANKNIFTY has no weekly expiry - NSE discontinued it (same rule Expired Backtest enforces).
  // Corrected right in the underlying picker's own onChange below, not a separate effect - this
  // is a direct response to that one user action, not a value derived from external state.
  const selectUnderlying = (value) => {
    setUnderlying(value)
    if (value === 'BANKNIFTY' && expiryFlag === 'WEEK') setExpiryFlag('MONTH')
  }

  const canLoad = Boolean(underlying && date)
  const isToday = Boolean(date && date.format('YYYY-MM-DD') === istDateKey(new Date()))
  const liveFeedSupported = LIVE_FEED_COMBOS.has(`${underlying}:${expiryFlag}`)

  const load = () => {
    if (!canLoad) return
    setPlaying(false)
    setLoading(true)
    setError(null)
    setLiveBars([])
    setLiveCePoints([])
    setLivePePoints([])
    const params = new URLSearchParams({
      date: date.format('YYYY-MM-DD'),
      timeframeMinutes: String(timeframe),
      expiryFlag,
    })
    fetch(`/api/oi-replay/${underlying}/run?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => {
        if (!body?.success) throw new Error(body?.error || 'This run did not succeed.')
        setResult(body)
        const initialLen = body.spotCandlesOneMinute?.length ?? 0
        setVisibleCount(initialLen > 0 ? 1 : 0)
        // Seeds the auto-follow effect below with "caught up" meaning THIS length, not 0 - so
        // loading a fresh day (even today) always starts the replay at its own beginning rather
        // than the auto-follow effect immediately yanking visibleCount to the end because 1 >= 0.
        caughtUpLenRef.current = initialLen
      })
      .catch((err) => {
        console.error('Failed to load OI replay data:', err)
        setResult(null)
        setError(err.message || 'Failed to load this day.')
      })
      .finally(() => setLoading(false))
  }

  // The TRUE replay clock - native 1-minute bars, so every derived read (ladder, OI change, Market
  // Read, Day Accumulation, alerts) advances one real minute per tick regardless of which timeframe
  // the CHART itself displays. The chart's own candles are a re-aggregation of a slice of this,
  // computed separately below - the two used to be the same array, which meant everything on the
  // page only updated once per whole displayed candle (once every 5 or 15 real minutes on a coarser
  // timeframe) instead of continuously. While isToday, this also folds in liveBars - the initial
  // REST snapshot's own bars, with the live feed's tail merged on top (replacing the still-forming
  // final minute in place as it updates, appending once a new minute actually starts).
  const oneMinBars = useMemo(() => {
    const base = (result?.spotCandlesOneMinute ?? []).map(toBar)
    if (!isToday || liveBars.length === 0) return base
    const merged = base.slice()
    for (const bar of liveBars) {
      if (merged.length > 0 && merged[merged.length - 1].time === bar.time) merged[merged.length - 1] = bar
      else if (merged.length === 0 || bar.time > merged[merged.length - 1].time) merged.push(bar)
    }
    return merged
  }, [result, liveBars, isToday])
  const ceByStrike = useMemo(
    () => groupByStrike(isToday ? [...(result?.cePoints ?? []), ...liveCePoints] : (result?.cePoints ?? [])),
    [result, liveCePoints, isToday],
  )
  const peByStrike = useMemo(
    () => groupByStrike(isToday ? [...(result?.pePoints ?? []), ...livePePoints] : (result?.pePoints ?? [])),
    [result, livePePoints, isToday],
  )

  // Live feed wiring - see useOiReplayLiveFeed's own doc comment. Only connects once an initial
  // snapshot has actually loaded (this is a "keep it fresh from here" layer on top of that fetch,
  // not a replacement for it) and only for a combo OiReplayLiveFeedService actually tracks.
  const handleSpotUpdate = (snapshot) => {
    if (!isToday || snapshot?.underlying !== underlying || !snapshot?.currentBar) return
    const bar = toBar(snapshot.currentBar)
    setLiveBars((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].time === bar.time) {
        const next = prev.slice()
        next[next.length - 1] = bar
        return next
      }
      return [...prev, bar]
    })
  }
  const handleOiReplayTick = (tick) => {
    if (!isToday || tick?.underlying !== underlying || tick?.expiryFlag !== expiryFlag) return
    const isCall = tick.side === 'CE'
    // The live feed carries no IV (Dhan's tick stream doesn't - see OiReplayLiveFeedService's own
    // doc comment) - carry forward whatever the initial REST fetch last saw for this strike/side
    // rather than showing a blank once live ticks start arriving.
    const sourcePoints = isCall ? result?.cePoints : result?.pePoints
    const known = (sourcePoints ?? []).filter((p) => p.strike === tick.strike && p.impliedVolatility != null)
    const lastKnownIv = known.length > 0 ? known[known.length - 1].impliedVolatility : null
    const point = { time: tick.time, strike: tick.strike, openInterest: tick.openInterest, impliedVolatility: lastKnownIv, price: tick.price }
    if (isCall) setLiveCePoints((prev) => [...prev, point])
    else setLivePePoints((prev) => [...prev, point])
  }
  const handleLiveReconnected = () => { if (isToday) load() }
  useOiReplayLiveFeed(isToday && liveFeedSupported && Boolean(result), handleSpotUpdate, handleOiReplayTick, handleLiveReconnected)

  // Auto-follow: once the user is caught up to the tail of what's loaded, a newly-arrived live bar
  // (oneMinBars.length growing) keeps visibleCount pinned to the end automatically - the whole point
  // of "today" being live rather than a fixed-length replay. A user who paused and scrubbed BACK to
  // review an earlier point is deliberately left alone; the new bar just waits at the tail for them.
  useEffect(() => {
    setVisibleCount((c) => {
      const wasCaughtUp = c >= caughtUpLenRef.current
      caughtUpLenRef.current = oneMinBars.length
      return isToday && wasCaughtUp ? oneMinBars.length : c
    })
  }, [oneMinBars.length, isToday])

  // Playback loop - a single interval that advances visibleCount by one NATIVE MINUTE per tick,
  // self-stopping at the end of the day's own bars rather than needing a separate "are we done"
  // effect.
  useEffect(() => {
    if (!playing) return
    timerRef.current = setInterval(() => {
      setVisibleCount((c) => {
        if (c >= oneMinBars.length) { setPlaying(false); return c }
        return c + 1
      })
    }, speedMs)
    return () => clearInterval(timerRef.current)
  }, [playing, speedMs, oneMinBars.length])

  const currentBar = oneMinBars[visibleCount - 1] ?? null
  // oneMinBars' own .time is chart time (shifted +5.5h by toChartTime, for the chart library's own
  // display trick) - ceByStrike/peByStrike's points are the RAW, unshifted times straight off the
  // wire. Comparing a shifted value against unshifted ones directly (as this used to) skews every
  // lookup forward by a fixed 5.5 hours - once real time-of-day passes 10:00 IST, that skew alone
  // pushes the lookup past 15:30 (market close), so every strike's "latest reading" permanently
  // resolves to the day's very last point from then on - the exact "ladder/chart goes static right
  // at 10:00 every time" bug. fromChartTime converts back to real time before use here.
  const asOfMs = currentBar ? fromChartTime(currentBar.time) * 1000 : null

  // The chart's own displayed candles - the visible slice of 1-minute bars, re-aggregated to
  // whatever timeframe is selected, recomputed fresh each tick so the LAST (currently forming)
  // candle updates live exactly like a real charting terminal's current bar does.
  const displayBars = useMemo(
    () => aggregateBars(oneMinBars.slice(0, visibleCount), timeframe),
    [oneMinBars, visibleCount, timeframe],
  )
  const dayStartMs = oneMinBars[0] ? fromChartTime(oneMinBars[0].time) * 1000 : null

  // Futures - always a live-Dhan-only series from the backend (see OiReplayService's own doc
  // comment: no futures data exists in NiftyDataCollector's database at all), so unlike
  // oneMinBars/ceByStrike/peByStrike this never gets a "today, live WS" tail merged in - it is
  // simply whatever OiReplayService's own single live call returned for the whole day.
  const futuresBarsChart = useMemo(() => (result?.futuresBars ?? []).map(toBar), [result])
  // Raw (unshifted) points, time-ascending, for latestAtOrBefore-style stat lookups - same
  // real-time-vs-chart-time distinction as ceByStrike/peByStrike above (see asOfMs's own comment).
  const futuresPointsRaw = useMemo(
    () => [...(result?.futuresBars ?? [])].sort((a, b) => new Date(a.time) - new Date(b.time)),
    [result],
  )
  const displayFuturesBars = useMemo(() => {
    if (asOfMs == null) return []
    const cutoff = toChartTime(asOfMs)
    return aggregateBars(futuresBarsChart.filter((b) => b.time <= cutoff), timeframe)
  }, [futuresBarsChart, asOfMs, timeframe])
  const currentFutures = useMemo(
    () => (asOfMs != null ? latestAtOrBefore(futuresPointsRaw, asOfMs) : null),
    [futuresPointsRaw, asOfMs],
  )
  const futuresOpen = futuresPointsRaw[0] ?? null
  const futuresOiSinceOpen = currentFutures?.openInterest != null && futuresOpen?.openInterest != null
    ? currentFutures.openInterest - futuresOpen.openInterest
    : null
  const futuresVolumeSoFar = useMemo(() => {
    if (asOfMs == null) return null
    return futuresPointsRaw
      .filter((p) => new Date(p.time).getTime() <= asOfMs)
      .reduce((sum, p) => sum + (p.volume ?? 0), 0)
  }, [futuresPointsRaw, asOfMs])
  // Basis = futures price - spot price - positive ("premium") usually reads bullish sentiment,
  // negative ("discount") bearish, though on an index the gap is mostly just cost-of-carry drifting
  // toward zero as expiry nears, not a pure sentiment read the way it can be on an individual stock.
  // Both prices are already real (non-time) values, so no chart-time/real-time conversion applies.
  const futuresBasis = currentFutures?.close != null && currentBar?.close != null
    ? currentFutures.close - currentBar.close
    : null

  // The OI overlay line drawn on FuturesChart's own left price scale - one point per DISPLAYED
  // candle (not native 1-min), each carrying whatever OI was current as of that candle's own
  // close, so the line reveals in step with the candles rather than at a different resolution.
  // Plotted value is OI/1e6 (not the raw count) so the left axis itself reads in clean millions,
  // same "show all the tags in million" convention as every other OI figure on this page.
  const futuresOiLine = useMemo(() => {
    if (!result?.futuresOiAvailable) return []
    return displayFuturesBars
      .map((bar) => {
        const point = latestAtOrBefore(futuresPointsRaw, fromChartTime(bar.time) * 1000)
        return point?.openInterest != null ? { time: bar.time, value: point.openInterest / 1_000_000 } : null
      })
      .filter(Boolean)
  }, [displayFuturesBars, futuresPointsRaw, result])

  // Every row carries its OI both ONE MINUTE AGO (native resolution regardless of the chart's own
  // timeframe - "change every min" was explicit) AND at the DAY'S OPEN, alongside the current
  // reading - the ladder shows both a tick-to-tick delta and a since-open delta per strike, not
  // just the Day OI Accumulation card's own whole-band totals.
  const ladderRows = useMemo(() => {
    if (asOfMs == null) return []
    const priorMs = asOfMs - 60_000
    const strikes = new Set([...ceByStrike.keys(), ...peByStrike.keys()])
    const rows = [...strikes].map((strike) => {
      const ce = latestAtOrBefore(ceByStrike.get(strike) ?? [], asOfMs)
      const pe = latestAtOrBefore(peByStrike.get(strike) ?? [], asOfMs)
      const cePrior = latestAtOrBefore(ceByStrike.get(strike) ?? [], priorMs)
      const pePrior = latestAtOrBefore(peByStrike.get(strike) ?? [], priorMs)
      const ceOpen = dayStartMs != null ? latestAtOrBefore(ceByStrike.get(strike) ?? [], dayStartMs) : null
      const peOpen = dayStartMs != null ? latestAtOrBefore(peByStrike.get(strike) ?? [], dayStartMs) : null
      const ceAsOfMs = ce ? new Date(ce.time).getTime() : null
      const peAsOfMs = pe ? new Date(pe.time).getTime() : null
      return {
        strike,
        ceOi: ce?.openInterest ?? null, ceIv: ce?.impliedVolatility ?? null, cePrice: ce?.price ?? null,
        peOi: pe?.openInterest ?? null, peIv: pe?.impliedVolatility ?? null, pePrice: pe?.price ?? null,
        ceOiChange: ce?.openInterest != null && cePrior?.openInterest != null ? ce.openInterest - cePrior.openInterest : null,
        peOiChange: pe?.openInterest != null && pePrior?.openInterest != null ? pe.openInterest - pePrior.openInterest : null,
        ceOiSinceOpen: ce?.openInterest != null && ceOpen?.openInterest != null ? ce.openInterest - ceOpen.openInterest : null,
        peOiSinceOpen: pe?.openInterest != null && peOpen?.openInterest != null ? pe.openInterest - peOpen.openInterest : null,
        // "Stale" = the newest reading we have for this strike/side is already more than
        // OI_STALE_MS behind the replay's own current time - the stored data has stopped arriving,
        // not that the market itself has gone quiet (see OI_STALE_MS's own doc comment).
        ceAsOfMs, peAsOfMs,
        ceStale: ceAsOfMs != null && asOfMs - ceAsOfMs > OI_STALE_MS,
        peStale: peAsOfMs != null && asOfMs - peAsOfMs > OI_STALE_MS,
      }
    })
    return rows.sort((a, b) => b.strike - a.strike)
  }, [ceByStrike, peByStrike, asOfMs, dayStartMs])

  const step = result?.step || 50
  const atmStrike = currentBar ? Math.round(currentBar.close / step) * step : null

  // Regime-change markers stamped on the exact candle where a Long Buildup/Short Buildup/Short
  // Covering/Long Unwinding stretch actually started - "show me when what happened" on the chart
  // itself, not just a single end-of-day verdict. Compares each displayed candle against the PRIOR
  // one (not the day's open) so this reflects the CURRENT regime, and only emits a marker when the
  // classification actually changes (a run of 10 "still Long Buildup" candles in a row would
  // otherwise draw 10 markers on top of each other).
  const futuresRegimeMarkers = useMemo(() => {
    if (!result?.futuresOiAvailable || displayFuturesBars.length < 2) return []
    const priceThreshold = step * FUTURES_REGIME_PRICE_STEP_FACTOR
    const markers = []
    let prevRegime = 'Neutral'
    let prevClose = displayFuturesBars[0].close
    let prevOi = latestAtOrBefore(futuresPointsRaw, fromChartTime(displayFuturesBars[0].time) * 1000)?.openInterest ?? null

    for (let i = 1; i < displayFuturesBars.length; i++) {
      const bar = displayFuturesBars[i]
      const oi = latestAtOrBefore(futuresPointsRaw, fromChartTime(bar.time) * 1000)?.openInterest ?? null
      if (oi == null || prevOi == null) { prevClose = bar.close; prevOi = oi; continue }

      const regime = classifyFuturesRegime(bar.close - prevClose, oi - prevOi, priceThreshold, FUTURES_REGIME_OI_THRESHOLD)
      if (regime !== 'Neutral' && regime !== prevRegime) {
        const info = FUTURES_REGIME_INFO[regime]
        const bullish = info.bias === 'Bullish'
        markers.push({
          time: bar.time,
          position: bullish ? 'belowBar' : 'aboveBar',
          color: info.color,
          shape: bullish ? 'arrowUp' : 'arrowDown',
          text: regime,
        })
      }
      if (regime !== 'Neutral') prevRegime = regime
      prevClose = bar.close
      prevOi = oi
    }
    return markers
  }, [displayFuturesBars, futuresPointsRaw, step, result])

  // The single "as of right now" verdict for the table/read box - same 4-quadrant classification
  // as the chart markers, just measured since the DAY'S OPEN rather than the previous candle, so
  // it reads as "today's overall futures story so far" rather than "what just happened".
  const futuresRegimeSinceOpen = useMemo(() => {
    if (!result?.futuresOiAvailable || currentFutures?.close == null || futuresOpen?.close == null || futuresOiSinceOpen == null) return null
    const priceDelta = currentFutures.close - futuresOpen.close
    const regime = classifyFuturesRegime(priceDelta, futuresOiSinceOpen, step * FUTURES_REGIME_PRICE_STEP_FACTOR, FUTURES_REGIME_OI_THRESHOLD)
    return { regime, priceDelta, oiDelta: futuresOiSinceOpen, ...FUTURES_REGIME_INFO[regime] }
  }, [currentFutures, futuresOpen, futuresOiSinceOpen, step, result])

  // PCR (Put-Call Ratio, total PE OI / total CE OI across the whole fetched band) and Max Pain -
  // the two standard derived reads a real OI chain gets used for beyond "where's the wall" (per the
  // user's own "and other things whatever you want to deduce").
  const { pcr, totalCeOi, totalPeOi } = useMemo(() => {
    const totalCe = ladderRows.reduce((s, r) => s + (r.ceOi ?? 0), 0)
    const totalPe = ladderRows.reduce((s, r) => s + (r.peOi ?? 0), 0)
    return { pcr: totalCe > 0 ? totalPe / totalCe : null, totalCeOi: totalCe, totalPeOi: totalPe }
  }, [ladderRows])

  const maxPain = useMemo(() => computeMaxPain(ladderRows), [ladderRows])

  // Every strike/side's OI at the very first revealed bar of the day - the fixed reference point
  // "day accumulation" and the top-movers list below both compare the CURRENT ladder against, so
  // both read "since the open", not "since the last minute" (that's what OiChange already covers).
  // (dayStartMs itself is declared above, before ladderRows, since the ladder now also needs it.)
  const dayStartByStrike = useMemo(() => {
    if (dayStartMs == null) return new Map()
    const map = new Map()
    for (const strike of new Set([...ceByStrike.keys(), ...peByStrike.keys()])) {
      const ce = latestAtOrBefore(ceByStrike.get(strike) ?? [], dayStartMs)
      const pe = latestAtOrBefore(peByStrike.get(strike) ?? [], dayStartMs)
      map.set(strike, {
        ceOi: ce?.openInterest ?? null, peOi: pe?.openInterest ?? null,
        ceIv: ce?.impliedVolatility ?? null, peIv: pe?.impliedVolatility ?? null,
      })
    }
    return map
  }, [ceByStrike, peByStrike, dayStartMs])

  // Whole-day accumulation (same Price+OI combination logic as the per-tick "OI buildup" in
  // Market Read, just measured from the DAY'S OPEN to right now instead of the last single minute)
  // plus the two strike/side pairs that have added the most OI and the two that have shed the most,
  // across the whole fetched band - "continuously" read as "net change since the open", not a
  // strict every-single-minute streak (this app has no per-minute streak tracker, and a streak that
  // reverses for one minute then resumes is still the same real accumulation story).
  const dayOiSummary = useMemo(() => {
    if (!currentBar || oneMinBars.length === 0 || dayStartByStrike.size === 0) return null

    let ceStartTotal = 0
    let peStartTotal = 0
    const movers = []
    for (const row of ladderRows) {
      const start = dayStartByStrike.get(row.strike)
      if (row.ceOi != null && start?.ceOi != null) {
        ceStartTotal += start.ceOi
        movers.push({ strike: row.strike, side: 'CE', change: row.ceOi - start.ceOi })
      }
      if (row.peOi != null && start?.peOi != null) {
        peStartTotal += start.peOi
        movers.push({ strike: row.strike, side: 'PE', change: row.peOi - start.peOi })
      }
    }
    const ceDayChange = totalCeOi - ceStartTotal
    const peDayChange = totalPeOi - peStartTotal
    const dayPriceChange = currentBar.close - oneMinBars[0].open

    let dayBias = 'Neutral'
    let dayReason = 'No clear net accumulation pattern for the day so far'
    if (dayPriceChange > 0 && peDayChange > 0 && peDayChange >= ceDayChange) { dayBias = 'Bullish'; dayReason = `Net put writing since the open (${formatOiMillions(peDayChange, { signed: true })} PE OI) while price is up ${dayPriceChange.toFixed(0)} pts - support built through the day` }
    else if (dayPriceChange < 0 && ceDayChange > 0 && ceDayChange >= peDayChange) { dayBias = 'Bearish'; dayReason = `Net call writing since the open (${formatOiMillions(ceDayChange, { signed: true })} CE OI) while price is down ${Math.abs(dayPriceChange).toFixed(0)} pts - resistance built through the day` }
    else if (dayPriceChange > 0 && ceDayChange < 0) { dayBias = 'Bullish'; dayReason = `Net call unwinding since the open (${formatOiMillions(ceDayChange, { signed: true })} CE OI) as price rose ${dayPriceChange.toFixed(0)} pts - short covering, not fresh support` }
    else if (dayPriceChange < 0 && peDayChange < 0) { dayBias = 'Bearish'; dayReason = `Net put unwinding since the open (${formatOiMillions(peDayChange, { signed: true })} PE OI) as price fell ${Math.abs(dayPriceChange).toFixed(0)} pts - long unwinding, not fresh resistance` }

    const added = [...movers].filter((m) => m.change > 0).sort((a, b) => b.change - a.change).slice(0, 2)
    const removed = [...movers].filter((m) => m.change < 0).sort((a, b) => a.change - b.change).slice(0, 2)

    return { dayBias, dayReason, ceDayChange, peDayChange, added, removed }
  }, [currentBar, oneMinBars, ladderRows, dayStartByStrike, totalCeOi, totalPeOi])

  // Smart alert: whenever a strike NEAR ATM shows a one-minute OI shift past this threshold, flag
  // it and beep - the "someone just loaded/unwound a huge quantity" event this app can't otherwise
  // call out on its own. "Near ATM" is +-3 strike-steps (the same handful of strikes a real trader
  // actually watches tick to tick, not the whole +-10 band the ladder shows). Checked once PER
  // REPLAY TICK (native 1-minute), not once per render, so it beeps at most once per real minute
  // rather than repeatedly while a breach's own row re-renders for unrelated reasons.
  const [alertThreshold, setAlertThreshold] = useState(1_000_000)
  const [soundEnabled, setSoundEnabled] = useState(true)

  const activeAlerts = useMemo(() => {
    if (atmStrike == null || ladderRows.length === 0) return []
    const nearAtm = ladderRows.filter((r) => Math.abs(r.strike - atmStrike) <= step * 3)
    const breaches = []
    for (const r of nearAtm) {
      if (r.ceOiChange != null && Math.abs(r.ceOiChange) >= alertThreshold) breaches.push({ strike: r.strike, side: 'CE', change: r.ceOiChange })
      if (r.peOiChange != null && Math.abs(r.peOiChange) >= alertThreshold) breaches.push({ strike: r.strike, side: 'PE', change: r.peOiChange })
    }
    return breaches
  }, [ladderRows, atmStrike, step, alertThreshold])

  // The beep is the one genuine side effect here (activeAlerts above is a plain derived value) -
  // fires at most once per NEW replay tick that has a breach, not once per render, so it doesn't
  // re-beep for the same tick if something unrelated causes a re-render.
  const lastAlertedTickRef = useRef(-1)
  useEffect(() => {
    if (visibleCount === lastAlertedTickRef.current) return
    lastAlertedTickRef.current = visibleCount
    if (activeAlerts.length > 0 && soundEnabled) playBeep()
  }, [visibleCount, activeAlerts, soundEnabled])

  // Synthesizes PCR + OI buildup + IV skew into one heuristic read - three independent votes
  // (Bullish/Bearish/Neutral), combined into an overall bias and a candidate strike/side. This is a
  // rule-of-thumb reading of the SAME numbers already shown above, not a prediction - all three
  // signals can (and often do) disagree, which is exactly what "Mixed" reports honestly rather than
  // forcing a call either way.
  const marketRead = useMemo(() => {
    if (!currentBar || ladderRows.length === 0 || atmStrike == null) return null

    // PCR: conventional NSE-desk reading - a high PCR means more puts written relative to calls,
    // which (writers being confident enough to sell there) reads as support/bullish; a low PCR the
    // mirror. Thresholds are naive, not calibrated against real outcomes - a starting point, not
    // a validated signal.
    const pcrBias = pcr == null ? 'Neutral' : pcr > 1.2 ? 'Bullish' : pcr < 0.8 ? 'Bearish' : 'Neutral'

    const resistance = ladderRows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)
    const support = ladderRows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)

    // OI buildup near ATM (+-2 steps), combined with the spot move over the last 5 revealed bars -
    // the classic "Price + OI" combination read: rising price + rising Put OI = fresh put WRITING
    // (bullish, support being defended); falling price + rising Call OI = fresh call writing
    // (bearish, resistance being defended); the two unwind variants are the same move without fresh
    // OI backing it - weaker, "covering" rather than a defended level.
    const nearAtm = ladderRows.filter((r) => Math.abs(r.strike - atmStrike) <= step * 2)
    const ceChangeSum = nearAtm.reduce((s, r) => s + (r.ceOiChange ?? 0), 0)
    const peChangeSum = nearAtm.reduce((s, r) => s + (r.peOiChange ?? 0), 0)
    const priorBar = oneMinBars[Math.max(0, visibleCount - 6)]
    const priceChange = priorBar ? currentBar.close - priorBar.close : 0

    let oiBuildup = 'No clear buildup pattern near ATM yet'
    let oiBias = 'Neutral'
    if (priceChange > 0 && peChangeSum > 0 && peChangeSum >= ceChangeSum) { oiBuildup = 'Put writing near ATM as price rises - support being defended'; oiBias = 'Bullish' }
    else if (priceChange < 0 && ceChangeSum > 0 && ceChangeSum >= peChangeSum) { oiBuildup = 'Call writing near ATM as price falls - resistance being defended'; oiBias = 'Bearish' }
    else if (priceChange > 0 && ceChangeSum < 0) { oiBuildup = 'Call unwinding as price rises - short covering, no fresh support built'; oiBias = 'Bullish' }
    else if (priceChange < 0 && peChangeSum < 0) { oiBuildup = 'Put unwinding as price falls - long unwinding, no fresh resistance built'; oiBias = 'Bearish' }

    // IV skew at ATM - read as a CHANGE since the day's open, not an absolute level. NIFTY/
    // BANKNIFTY (like almost every equity index) structurally has PE IV > CE IV almost all the
    // time - a permanent downside-protection premium baked into the vol surface, not a sentiment
    // signal. Thresholding the raw level (an earlier version of this did) reads "Bearish" on
    // nearly every normal day regardless of what's actually happening, which is exactly the bug
    // report this fixes. WIDENING skew (PE getting richer relative to CE as the day goes on) means
    // downside fear building - that is the real signal; narrowing means it is easing.
    const atmRow = ladderRows.find((r) => r.strike === atmStrike) ?? nearAtm[0] ?? null
    const skew = atmRow && atmRow.peIv != null && atmRow.ceIv != null ? atmRow.peIv - atmRow.ceIv : null
    const startAtm = dayStartByStrike.get(atmStrike)
    const skewAtOpen = startAtm && startAtm.peIv != null && startAtm.ceIv != null ? startAtm.peIv - startAtm.ceIv : null
    const skewChange = skew != null && skewAtOpen != null ? skew - skewAtOpen : null
    const ivBias = skewChange == null ? 'Neutral' : skewChange > 0.5 ? 'Bearish' : skewChange < -0.5 ? 'Bullish' : 'Neutral'

    const votes = [pcrBias, oiBias, ivBias]
    const bullCount = votes.filter((v) => v === 'Bullish').length
    const bearCount = votes.filter((v) => v === 'Bearish').length
    const overall = bullCount > bearCount ? 'Bullish' : bearCount > bullCount ? 'Bearish' : 'Mixed / Neutral'

    // BUY: direction-following - the nearest OTM strike in whichever way the overall vote leans.
    // SELL: the wall on the side the overall vote does NOT expect to be tested - selling premium
    // against a level the move is unlikely to reach is the safer side of that same read (sell CE at
    // resistance when the bias is bearish/mixed - upside isn't expected to be tested; sell PE at
    // support when bullish/mixed - downside isn't expected to be tested).
    const buySide = overall === 'Bullish' ? 'CE' : overall === 'Bearish' ? 'PE' : null
    const buyStrike = overall === 'Bullish' ? atmStrike + step : overall === 'Bearish' ? atmStrike - step : null
    const sellSide = overall === 'Bearish' ? 'CE' : 'PE'
    const sellStrike = sellSide === 'CE' ? resistance?.strike ?? null : support?.strike ?? null

    const suggestedStrike = buyStrike ?? atmStrike
    const suggestedSide = buySide ?? 'No clear edge - consider staying flat'

    // "Are we okay right now" - a plain proximity-to-wall check, independent of the bullish/bearish
    // vote above: even a clear directional read is riskier to act on right this second if price is
    // already sitting on top of a wall (the next tick either breaks it or gets rejected hard).
    // Threshold is half a strike-step - close enough to matter, not so tight it never fires.
    const wallThreshold = step * 0.5
    const distToResistance = resistance ? resistance.strike - currentBar.close : null
    const distToSupport = support ? currentBar.close - support.strike : null
    const nearResistance = distToResistance != null && distToResistance >= 0 && distToResistance <= wallThreshold
    const nearSupport = distToSupport != null && distToSupport >= 0 && distToSupport <= wallThreshold
    const safetyOk = !nearResistance && !nearSupport
    const safetyReason = nearResistance
      ? `Price is only ${distToResistance.toFixed(0)} pts below the resistance wall at ${resistance.strike} - a break needs conviction, a rejection is live risk right now.`
      : nearSupport
        ? `Price is only ${distToSupport.toFixed(0)} pts above the support wall at ${support.strike} - a break needs conviction, a bounce is live risk right now.`
        : `Price is clear of both the resistance wall (${resistance ? `${resistance.strike}, ${(resistance.strike - currentBar.close).toFixed(0)} pts away` : 'none'}) and the support wall (${support ? `${support.strike}, ${(currentBar.close - support.strike).toFixed(0)} pts away` : 'none'}) right now.`

    return {
      pcrBias, resistance, support, oiBuildup, oiBias, skew, skewChange, ivBias,
      atmCeIv: atmRow?.ceIv, atmPeIv: atmRow?.peIv, overall, suggestedStrike, suggestedSide,
      buySide, buyStrike, sellSide, sellStrike,
      safetyOk, safetyReason,
    }
  }, [currentBar, ladderRows, pcr, atmStrike, step, oneMinBars, visibleCount, dayStartByStrike])

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="OI Replay">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Plays a stored trading day back candle by candle, with the nearest-expiry OI/IV ladder across the whole
              strike band alongside it. Reads only from your NiftyDataCollector database - this page never calls Dhan live.
            </Text>
            <Space wrap size={12}>
              <Select value={underlying} onChange={selectUnderlying} style={{ width: 130 }} options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }]} />
              <Select
                value={expiryFlag} onChange={setExpiryFlag} style={{ width: 130 }}
                options={[{ value: 'WEEK', label: 'Weekly', disabled: underlying === 'BANKNIFTY' }, { value: 'MONTH', label: 'Monthly' }]}
              />
              <DatePicker value={date} onChange={setDate} format="DD MMM YYYY" placeholder="Trading day" />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              <Button type="primary" onClick={load} loading={loading} disabled={!canLoad}>Load day</Button>
            </Space>
            {error && <Alert type="error" showIcon message={error} />}
          </Space>
        </Card>

        {result && (
          <>
            <Card size="small">
              <Row gutter={24}>
                <Col><Statistic title="Spot" value={currentBar?.close ?? '—'} precision={2} /></Col>
                <Col><Statistic title="ATM" value={atmStrike ?? '—'} /></Col>
                <Col><Statistic title="PCR (PE OI / CE OI)" value={pcr != null ? pcr : '—'} precision={2}
                  valueStyle={{ color: pcr == null ? undefined : pcr > 1 ? UP_COLOR : DOWN_COLOR }} /></Col>
                <Col><Statistic title="Max Pain" value={maxPain ?? '—'} /></Col>
                <Col><Statistic title="Total CE OI (M)" value={formatOiMillions(totalCeOi, { withUnit: false })} valueStyle={{ color: DOWN_COLOR }} /></Col>
                <Col><Statistic title="Total PE OI (M)" value={formatOiMillions(totalPeOi, { withUnit: false })} valueStyle={{ color: UP_COLOR }} /></Col>
              </Row>
            </Card>

            {marketRead && (
              <Card size="small" title="Market Read">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Alert
                    type={marketRead.safetyOk ? 'success' : 'warning'}
                    showIcon
                    message={marketRead.safetyOk ? 'Are we okay right now? Yes - clear of major walls.' : 'Are we okay right now? Caution - sitting right at a wall.'}
                    description={marketRead.safetyReason}
                  />
                  <Row gutter={24}>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>PCR read</Text>
                      <Tag color={biasColor(marketRead.pcrBias)} style={{ fontSize: 12 }}>{marketRead.pcrBias}</Tag>
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>OI buildup (near ATM)</Text>
                      <Tag color={biasColor(marketRead.oiBias)} style={{ fontSize: 12 }}>{marketRead.oiBias}</Tag>
                      <div style={{ fontSize: 11, color: AXIS_COLOR, marginTop: 2 }}>{marketRead.oiBuildup}</div>
                    </Col>
                    <Col span={8}>
                      <Tooltip title={
                        <span>
                          Real use case: at 9:20am, say CE and PE at ATM both show IV 12% (skew 0). By 11am,
                          price hasn't moved much but PE IV has climbed to 14% while CE stays near 12%
                          (skew widened to +2). That means traders are actively bidding up PUT premiums -
                          buying downside protection or outright puts - even though price itself looks calm.
                          That is often an early warning of a selloff building BEFORE it shows in price. If
                          the widening continues, expect more downside volatility soon; if it reverses and
                          narrows back, the fear is fading and price is more likely to hold or rally.
                        </span>
                      }>
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', textDecoration: 'underline dotted' }}>
                          IV skew trend (PE − CE, at ATM)
                        </Text>
                      </Tooltip>
                      <Tag color={biasColor(marketRead.ivBias)} style={{ fontSize: 12 }}>{marketRead.ivBias}</Tag>
                      <div style={{ fontSize: 11, color: AXIS_COLOR, marginTop: 2 }}>
                        {marketRead.skew != null
                          ? `Now ${marketRead.skew >= 0 ? '+' : ''}${marketRead.skew.toFixed(1)} (CE ${marketRead.atmCeIv?.toFixed(1)}, PE ${marketRead.atmPeIv?.toFixed(1)})${marketRead.skewChange != null ? `, ${marketRead.skewChange >= 0 ? 'widened' : 'narrowed'} ${Math.abs(marketRead.skewChange).toFixed(1)} since open` : ''}`
                          : 'IV not available at ATM yet'}
                      </div>
                    </Col>
                  </Row>
                  <Alert
                    type={marketRead.overall === 'Bullish' ? 'success' : marketRead.overall === 'Bearish' ? 'error' : 'info'}
                    showIcon
                    message={`Overall bias: ${marketRead.overall}`}
                    description={
                      marketRead.overall === 'Mixed / Neutral'
                        ? 'PCR, OI buildup and IV skew trend don’t agree right now - no clean directional edge to act on.'
                        : `Buy: ${marketRead.buyStrike} ${marketRead.buySide}. Sell: ${marketRead.sellStrike ?? '—'} ${marketRead.sellSide} (the wall on the side this move isn't expected to reach).`
                    }
                  />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Heuristic reading of the same PCR/OI/IV numbers shown above - three independent, naively-thresholded votes, not a signal or advice. Always cross-check against price action itself. IV skew is read as a CHANGE since the open, not its raw level - index options almost always price puts richer than calls (a permanent structural premium, not a daily sentiment signal), so only the trend is informative.
                  </Text>
                </Space>
              </Card>
            )}

            {dayOiSummary && (
              <Card size="small" title="Day OI Accumulation (since today's open)">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Alert
                    type={dayOiSummary.dayBias === 'Bullish' ? 'success' : dayOiSummary.dayBias === 'Bearish' ? 'error' : 'info'}
                    showIcon
                    message={`Day so far: ${dayOiSummary.dayBias}`}
                    description={dayOiSummary.dayReason}
                  />
                  <Row gutter={24}>
                    <Col span={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>CE OI since open</Text>
                      <Text style={{ fontSize: 13, color: dayOiSummary.ceDayChange >= 0 ? DOWN_COLOR : UP_COLOR }}>
                        {formatOiMillions(dayOiSummary.ceDayChange, { signed: true })}
                      </Text>
                    </Col>
                    <Col span={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>PE OI since open</Text>
                      <Text style={{ fontSize: 13, color: dayOiSummary.peDayChange >= 0 ? UP_COLOR : DOWN_COLOR }}>
                        {formatOiMillions(dayOiSummary.peDayChange, { signed: true })}
                      </Text>
                    </Col>
                    <Col span={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>Top 2 OI added</Text>
                      {dayOiSummary.added.length === 0
                        ? <Text style={{ fontSize: 11, color: AXIS_COLOR }}>None yet</Text>
                        : dayOiSummary.added.map((m) => (
                          <div key={`${m.strike}-${m.side}`} style={{ fontSize: 11 }}>
                            <Tag color={m.side === 'CE' ? 'error' : 'success'} style={{ fontSize: 10, marginRight: 4 }}>{m.side}</Tag>
                            {m.strike} <span style={{ color: m.side === 'CE' ? DOWN_COLOR : UP_COLOR }}>{formatOiMillions(m.change, { signed: true })}</span>
                          </div>
                        ))}
                    </Col>
                    <Col span={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>Top 2 OI removed</Text>
                      {dayOiSummary.removed.length === 0
                        ? <Text style={{ fontSize: 11, color: AXIS_COLOR }}>None yet</Text>
                        : dayOiSummary.removed.map((m) => (
                          <div key={`${m.strike}-${m.side}`} style={{ fontSize: 11 }}>
                            <Tag color={m.side === 'CE' ? 'error' : 'success'} style={{ fontSize: 10, marginRight: 4 }}>{m.side}</Tag>
                            {m.strike} <span style={{ color: m.side === 'CE' ? UP_COLOR : DOWN_COLOR }}>{formatOiMillions(m.change, { signed: true })}</span>
                          </div>
                        ))}
                    </Col>
                  </Row>
                </Space>
              </Card>
            )}

            <Row gutter={16}>
              <Col span={15}>
                <Card size="small" title="Spot (replaying)">
                  {/* Playback controls, literally inside the same card as the chart, right above
                      the canvas itself - the user's own "this bar should be near to chart just on
                      top of chart, it is too far right now" (a separate card above it, even
                      directly adjacent, still wasn't close enough). */}
                  <Space align="center" size={16} wrap style={{ marginBottom: 8 }}>
                    <Button
                      icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                      onClick={() => setPlaying((p) => !p)}
                      disabled={oneMinBars.length === 0 || visibleCount >= oneMinBars.length}
                    >
                      {playing ? 'Pause' : 'Start'}
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={() => { setPlaying(false); setVisibleCount(oneMinBars.length > 0 ? 1 : 0) }}>Reset</Button>
                    <Text type="secondary" style={{ fontSize: 12 }}>Speed</Text>
                    <Select value={speedMs} onChange={setSpeedMs} style={{ width: 90 }} options={SPEED_OPTIONS} />
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <Slider
                        min={0} max={Math.max(0, oneMinBars.length - 1)} value={visibleCount - 1}
                        onChange={(v) => { setPlaying(false); setVisibleCount(v + 1) }}
                        tooltip={{ formatter: (v) => oneMinBars[v] ? istTimeFormatter(oneMinBars[v].time) : '' }}
                      />
                    </div>
                    <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {currentBar ? `${istTimeFormatter(currentBar.time)} (${visibleCount}/${oneMinBars.length})` : '—'}
                    </Text>
                    {isToday && liveFeedSupported && (
                      <Tooltip title="Streaming live ticks from Dhan's WebSocket feed on top of today's snapshot (price + OI - IV stays at the last REST-fetched value)">
                        <Tag color="success">● LIVE</Tag>
                      </Tooltip>
                    )}
                  </Space>
                  <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Alert when a strike near ATM shifts by</Text>
                    <InputNumber
                      value={alertThreshold} onChange={(v) => setAlertThreshold(v ?? 0)}
                      min={0} step={100000} style={{ width: 140 }}
                      formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                      parser={(v) => v.replace(/,/g, '')}
                    />
                    <Text type="secondary" style={{ fontSize: 12 }}>OI in one minute</Text>
                    <Switch
                      checked={soundEnabled} onChange={setSoundEnabled}
                      checkedChildren={<SoundOutlined />} unCheckedChildren="Muted"
                    />
                  </Space>
                  {activeAlerts.length > 0 && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 8 }}
                      message="Large OI shift near ATM"
                      description={activeAlerts.map((a) => `${a.side} ${a.strike}: ${formatOiMillions(a.change, { signed: true })} in the last minute (${a.change >= 0 ? 'loading' : 'unwinding'})`).join(' · ')}
                    />
                  )}
                  {oneMinBars.length > 0
                    ? (
                      <ChartErrorBoundary key={`${underlying}-${result.date}-${timeframe}`}>
                        <ReplayChart
                          bars={displayBars}
                          ladderRows={ladderRows}
                          dayKey={`${underlying}-${result.date}-${timeframe}`}
                          atmStrike={atmStrike}
                          step={step}
                          height={460}
                        />
                      </ChartErrorBoundary>
                    )
                    : <Empty description="No spot candles for this day." />}
                </Card>
              </Col>
              <Col span={9}>
                <Card size="small" title="OI / IV ladder (nearest expiry, as of the current candle)" bodyStyle={{ maxHeight: 460, overflowY: 'auto' }}>
                  <OiLadder rows={ladderRows} atmStrike={atmStrike} />
                </Card>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={24}>
                <Card
                  size="small"
                  title="Futures (nearest listed contract - always live from Dhan, never stored)"
                  extra={
                    <Space size={8}>
                      {futuresRegimeSinceOpen && futuresRegimeSinceOpen.regime !== 'Neutral' && (
                        <Tag color={futuresRegimeSinceOpen.bias === 'Bullish' ? 'success' : 'error'}>{futuresRegimeSinceOpen.regime}</Tag>
                      )}
                      {result.futuresExpiry ? <Tag>{result.futuresExpiry} expiry</Tag> : null}
                    </Space>
                  }
                >
                  {result.futuresError && (
                    <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={result.futuresError} />
                  )}
                  {!result.futuresOiAvailable && result.futuresBars?.length > 0 && (
                    <Alert type="info" showIcon style={{ marginBottom: 12 }}
                      message="Dhan did not return an Open Interest series for this futures contract - the OI figures and Long/Short read below are unavailable, not zero/neutral." />
                  )}
                  {displayFuturesBars.length > 0 ? (
                    <>
                      {futuresRegimeSinceOpen && (
                        <Alert
                          style={{ marginBottom: 12 }}
                          type={futuresRegimeSinceOpen.bias === 'Bullish' ? 'success' : futuresRegimeSinceOpen.bias === 'Bearish' ? 'error' : 'info'}
                          showIcon
                          message={`Since open: ${futuresRegimeSinceOpen.regime} (${futuresRegimeSinceOpen.bias})`}
                          description={`${futuresRegimeSinceOpen.blurb} Price ${futuresRegimeSinceOpen.priceDelta >= 0 ? '+' : ''}${futuresRegimeSinceOpen.priceDelta.toFixed(1)} pts, OI ${formatOiMillions(futuresRegimeSinceOpen.oiDelta, { signed: true })} since today's open.`}
                        />
                      )}
                      <Row gutter={24} style={{ marginBottom: 12 }}>
                        <Col>
                          <Statistic title="Futures LTP" value={currentFutures?.close ?? '—'} precision={currentFutures?.close != null ? 2 : undefined} />
                        </Col>
                        <Col>
                          <Statistic
                            title="Basis (Fut - Spot)"
                            value={futuresBasis != null ? `${futuresBasis >= 0 ? '+' : ''}${futuresBasis.toFixed(2)}` : '—'}
                            valueStyle={{ color: futuresBasis == null ? undefined : futuresBasis >= 0 ? UP_COLOR : DOWN_COLOR }}
                          />
                        </Col>
                        <Col>
                          <Statistic title="Futures OI (M)" value={result.futuresOiAvailable ? formatOiMillions(currentFutures?.openInterest, { withUnit: false }) : 'N/A'} />
                        </Col>
                        <Col>
                          <Statistic
                            title="OI since open"
                            value={result.futuresOiAvailable ? formatOiMillions(futuresOiSinceOpen, { signed: true }) : 'N/A'}
                            valueStyle={{ color: futuresOiSinceOpen == null ? undefined : futuresOiSinceOpen >= 0 ? UP_COLOR : DOWN_COLOR }}
                          />
                        </Col>
                        <Col>
                          <Statistic title="Volume so far" value={futuresVolumeSoFar != null ? futuresVolumeSoFar.toLocaleString() : '—'} />
                        </Col>
                        <Col>
                          <Statistic
                            title="Regime (since open)"
                            value={result.futuresOiAvailable ? (futuresRegimeSinceOpen?.regime ?? '—') : 'N/A'}
                            valueStyle={{ fontSize: 16, color: futuresRegimeSinceOpen?.color }}
                          />
                        </Col>
                      </Row>
                      <ChartErrorBoundary key={`futures-${underlying}-${result.date}-${timeframe}`}>
                        <FuturesChart
                          bars={displayFuturesBars}
                          oiLine={futuresOiLine}
                          markers={futuresRegimeMarkers}
                          dayKey={`futures-${underlying}-${result.date}-${timeframe}`}
                          height={320}
                        />
                      </ChartErrorBoundary>
                      {result.futuresOiAvailable && (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          Grey line (left axis) is Open Interest. Arrows mark where a Long Buildup/Short Buildup/Short Covering/Long Unwinding stretch began - green/up = bullish, red/down = bearish.
                        </Text>
                      )}
                    </>
                  ) : (
                    <Empty description={result.futuresError || 'No futures data for this day.'} />
                  )}
                </Card>
              </Col>
            </Row>
          </>
        )}

        {!result && !loading && (
          <Card size="small">
            <Empty description="Pick a stored trading day and click Load day." />
          </Card>
        )}
      </Space>
    </div>
  )
}
