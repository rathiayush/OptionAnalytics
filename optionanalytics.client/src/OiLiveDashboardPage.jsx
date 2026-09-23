import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Card, Button, Row, Col, Tag, Tooltip, Empty, Alert } from 'antd'
import * as signalR from '@microsoft/signalr'
import { createChart, LineSeries, CrosshairMode } from 'lightweight-charts'
import {
  NavBar, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState, istDateKey, toBar,
  toChartTime, CE_COLOR, PE_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR, istTimeFormatter, istTickMarkFormatter,
} from './shared.jsx'
import {
  groupByStrike, latestAtOrBefore, aggregateBars, buildStrikeOffsetOptions, buildPremiumCandles,
  ReplayChart, EmaChart, PremiumCandleChart, PaperTradePanel, DraggableFloatingPanel,
  OiLadder, ChartErrorBoundary, PAPER_TRADE_LOT_SIZE, OI_STALE_MS,
} from './oiShared.jsx'

const { Text, Title } = Typography

// "Live OI Dashboard" - a SEPARATE page from OI Replay, deliberately. OI Replay's own "today, live"
// mode kept getting stuck (see its own git history) because it forced live data through a "replay
// clock" (visibleCount/asOfMs slicing) built for scrubbing a HISTORICAL day - live data has no
// "position" to scrub to, it only ever has "now", and threading it through that abstraction anyway
// kept reintroducing bugs across many rounds of fixes. This page instead copies the Dashboard page's
// (App.jsx) own proven live pattern: connect once, replace/append state directly from each tick, no
// time cursor anywhere. OI Replay itself is UNTOUCHED by this file - every helper/component used
// here comes from oiShared.jsx (a copy, not an edit of OiReplayPage.jsx), so nothing about this page
// can regress historical replay.
const LIVE_FEED_COMBOS = new Set(['NIFTY:WEEK', 'NIFTY:MONTH', 'BANKNIFTY:MONTH', 'SENSEX:WEEK', 'SENSEX:MONTH'])
const STEP_BY_UNDERLYING = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 }

// "Since open" OI deltas on this page diff TWO INDEPENDENT Dhan pipelines that have never been
// cross-validated against each other anywhere in this app: "current" OI comes from the live
// WebSocket tick feed (OiReplayLiveFeedService -> DhanTickPacketParser's Full-packet OI field),
// while "day open" comes from the on-demand /charts/rollingoption REST call (DhanRollingOptionData
// Service) that forceLive routes load() through. Both nominally describe the SAME real exchange
// contract's OI, so they should never disagree by much - a swing far larger than the strike's own
// current OI is a sign one of the two pipelines misreported it, not a real multi-million intraday
// unwind, and showing it as a precise number would mislead a reader into trusting a figure this app
// cannot itself vouch for. See ladderRows below, where a swing past this multiple of current OI is
// suppressed (shown as no data) rather than displayed.
const SINCE_OPEN_SANITY_MULTIPLE = 3

// Modeled directly on App.jsx's own useHub: ONE connection, opened on mount and never torn down or
// rebuilt - no `enabled` gate, no dependency on underlying/expiryFlag (the SAME hub broadcasts ticks
// for every underlying; this page just filters client-side in its own handlers, same as every
// consumer of oiReplayTick/futuresTick already does). This is the exact fix for the "reconnect churn"
// OiReplayPage's own useOiReplayLiveFeed was exposed to (its effect depends on `[enabled]`, which can
// flip during a fetch and tear the socket down at the worst moment) - this hook has no such flag.
function useOiLiveHub(onSpotUpdate, onOiReplayTick, onReconnected, onCdvUpdate, onCdvBarClosed) {
  const spotRef = useRef(onSpotUpdate)
  const tickRef = useRef(onOiReplayTick)
  const reconnectedRef = useRef(onReconnected)
  const cdvRef = useRef(onCdvUpdate)
  const cdvBarClosedRef = useRef(onCdvBarClosed)
  spotRef.current = onSpotUpdate
  tickRef.current = onOiReplayTick
  reconnectedRef.current = onReconnected
  cdvRef.current = onCdvUpdate
  cdvBarClosedRef.current = onCdvBarClosed

  const [connectionState, setConnectionState] = useState('connecting')

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    connection.on('spotUpdate', (snapshot) => spotRef.current(snapshot))
    connection.on('oiReplayTick', (tick) => tickRef.current(tick))
    // Same CDV/OBV events App.jsx's own useHub already listens for, off the SAME shared hub -
    // CdvHostedService broadcasts these regardless of which page is open, so nothing extra needs
    // subscribing server-side for this page to receive them too.
    connection.on('cdvUpdate', (snapshot) => cdvRef.current?.(snapshot))
    connection.on('cdvBarClosed', (point) => cdvBarClosedRef.current?.(point))
    connection.onreconnecting(() => setConnectionState('reconnecting'))
    connection.onreconnected(() => { setConnectionState('connected'); reconnectedRef.current?.() })
    connection.onclose(() => setConnectionState('disconnected'))
    connection.start()
      .then(() => setConnectionState('connected'))
      .catch((err) => {
        // React StrictMode double-mounts every effect once in development - the first connection's
        // start() gets aborted by this effect's own cleanup before negotiation finishes on the
        // second mount. Not a real failure.
        if (err?.name === 'AbortError') return
        console.error('Live OI Dashboard connection failed:', err)
        setConnectionState('disconnected')
      })

    return () => { connection.stop() }
  }, [])

  return connectionState
}

// How many of a strike's own most-recent points ever get kept in memory. This page never scrubs
// backward and is meant to run for an entire session with no restart ("absolutely live without
// stopping" - the whole point) - without a cap, a busy strike's array grows forever, and re-copying
// (and re-scanning, in ladderRows below) an ever-larger array on EVERY single tick is exactly what
// froze the tab solid ("Page Unresponsive") after running for a while: the cost of handling one more
// tick kept climbing with the total number ever received, not staying flat the way a live feed needs
// it to. 1500 points comfortably covers several hours of even a very actively-ticking strike while
// keeping every tick's own cost constant regardless of how long the page has been open. Today's OPEN
// reading is captured separately (see dayOpenByStrike) precisely so trimming here can never lose it.
const MAX_POINTS_PER_STRIKE = 1500

// Appends a point to one strike's own array, or replaces the last entry if it lands in the exact
// same second (a still-forming reading updating in place) - the same "replace in place / append"
// merge shape every live series in this app already uses. Carries the previous entry's own IV
// forward when the new point doesn't have one (a live tick never carries IV - see
// OiReplayLiveFeedService's own doc comment - only the initial REST seed does). Trims from the FRONT
// once over MAX_POINTS_PER_STRIKE - the oldest points are the ones this page cares about least, since
// "today's open" is tracked separately and never needs to survive in this array at all.
function appendPoint(map, strike, point) {
  const next = new Map(map)
  const existing = next.get(strike) ?? []
  const withIv = { ...point, impliedVolatility: point.impliedVolatility ?? existing[existing.length - 1]?.impliedVolatility ?? null }
  const updated = existing.length > 0 && new Date(existing[existing.length - 1].time).getTime() === new Date(point.time).getTime()
    ? [...existing.slice(0, -1), withIv]
    : [...existing, withIv]
  next.set(strike, updated.length > MAX_POINTS_PER_STRIKE ? updated.slice(-MAX_POINTS_PER_STRIKE) : updated)
  return next
}

// Every strike/side's OI at the very first point the initial seed fetch ever saw - derived from the
// SAME grouped (and correctly time-sorted) Map ceSeries/peSeries themselves get seeded from, then
// captured into its own Map and never touched again, so it survives appendPoint's own trimming no
// matter how long the page has been open or how much a strike's own rolling window has since moved
// past its own opening reading.
function buildDayOpenByStrike(grouped) {
  const map = new Map()
  for (const [strike, points] of grouped) if (points.length > 0) map.set(strike, points[0])
  return map
}

// Merges one live spot bar into the day's own bar array - replace-by-timestamp if it's the same
// still-forming minute, append if it's a genuinely new one. Same shape as App.jsx's own
// mergeLiveBar, just against chart-time (already-shifted) values.
function mergeBar(bars, bar) {
  if (bars.length > 0 && bars[bars.length - 1].time === bar.time) return [...bars.slice(0, -1), bar]
  if (bars.length === 0 || bar.time > bars[bars.length - 1].time) return [...bars, bar]
  return bars
}

// Same last-value-per-bucket idea as aggregateBars (oiShared.jsx) but for a running-total LINE
// series (CDV/OBV) instead of OHLC bars - a coarser bucket's meaningful value is simply its latest
// sample, not an open/high/low/close.
function aggregateLinePoints(points, minutes) {
  if (minutes <= 1 || points.length === 0) return points
  const bucketSeconds = minutes * 60
  const buckets = new Map()
  for (const p of points) buckets.set(Math.floor(p.time / bucketSeconds) * bucketSeconds, { ...p, time: Math.floor(p.time / bucketSeconds) * bucketSeconds })
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

function toCdvBar(p) {
  return { time: toChartTime(p.time), ceCdv: p.ceCdv, peCdv: p.peCdv }
}

// Dedupes/sorts before handing points to lightweight-charts, which throws if two consecutive
// points share a time or aren't strictly ascending - same defensive last line as App.jsx's own
// sanitizeSeries, kept for a duplicate time (the more recent value).
function sanitizeLine(points) {
  if (points.length === 0) return points
  const sorted = [...points].sort((a, b) => a.time - b.time)
  const result = []
  for (const p of sorted) {
    if (result.length > 0 && result[result.length - 1].time === p.time) result[result.length - 1] = p
    else result.push(p)
  }
  return result
}

// Two-line running-total chart - CE vs PE - reused for both CDV and OBV. A trimmed-down copy of
// App.jsx's own CeVsPeChart: no previous-day dashed overlay (this page has no multi-day concept at
// all, unlike the Dashboard's CDV chart) and no crossover markers, just the two live lines.
function CeVsPeLineChart({ ceSeries, peSeries, height = 280 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const ceRef = useRef(null)
  const peRef = useRef(null)
  const hasFitRef = useRef(false)
  const sanitizedCe = useMemo(() => sanitizeLine(ceSeries), [ceSeries])
  const sanitizedPe = useMemo(() => sanitizeLine(peSeries), [peSeries])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    ceRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, title: 'CE', priceLineVisible: false })
    peRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, title: 'PE', priceLineVisible: false })
    hasFitRef.current = false

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      ceRef.current = null
      peRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!ceRef.current || !peRef.current) return
    const preservedRange = hasFitRef.current ? chartRef.current?.timeScale().getVisibleRange() : null
    ceRef.current.setData(sanitizedCe)
    peRef.current.setData(sanitizedPe)
    if (!hasFitRef.current && (sanitizedCe.length > 0 || sanitizedPe.length > 0)) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
    } else if (preservedRange) {
      try { chartRef.current?.timeScale().setVisibleRange(preservedRange) } catch { /* empty */ }
    }
  }, [sanitizedCe, sanitizedPe])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

export default function OiLiveDashboardPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 15)
  const [chartBTimeframe, setChartBTimeframe] = useState(3)
  const [chartBEma1, setChartBEma1] = useState(9)
  const [chartBEma2, setChartBEma2] = useState(15)
  const [chartCTimeframe, setChartCTimeframe] = useState(1)
  const [chartCEma1, setChartCEma1] = useState(9)
  const [chartCEma2, setChartCEma2] = useState(15)

  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // The live state itself - an array of every 1-minute bar today has had so far, and a Map per side
  // of every strike's own points, ascending by time. No "as of" cursor anywhere: since this page
  // never scrubs backward, "the latest reading" is always just the last element, and "today's open"
  // is always just the first - see ladderRows below.
  const [oneMinBars, setOneMinBars] = useState([])
  const [ceSeries, setCeSeries] = useState(new Map())
  const [peSeries, setPeSeries] = useState(new Map())
  // Today's own opening OI per strike/side, captured once at load() and never mutated afterward -
  // see buildDayOpenByStrike's own doc comment for why this is separate from ceSeries/peSeries.
  const [ceDayOpen, setCeDayOpen] = useState(new Map())
  const [peDayOpen, setPeDayOpen] = useState(new Map())

  const [cePremiumOffset, setCePremiumOffset] = useState(0)
  const [pePremiumOffset, setPePremiumOffset] = useState(0)

  // CDV/OBV - chain-wide CE/PE aggregates (not tied to any one strike, unlike the premium charts
  // above), reusing CdvHostedService's own always-on tracking rather than anything OiReplayService
  // computes. One shared timeframe dropdown controls both charts, deliberately unlike chart B/C's
  // own independent pickers above - the user asked for CDV and OBV to move together, not apart.
  //
  // Deliberately NOT matched to this page's own WEEK/MONTH expiryFlag: CdvHostedService tracks only
  // the nearest few listed expiries per underlying (3 for NIFTY/SENSEX, 2 for BANKNIFTY - see its
  // own Underlyings table), not "nearest weekly + nearest monthly" specifically, so there is no
  // reliable way to classify which of those tracked dates IS the weekly vs. the monthly from this
  // page alone (CDV's own /expiries endpoint exposes only its tracked subset, not the full listed
  // chain OiReplayLiveFeedService's own classification needs). Always following CDV's own nearest/
  // default tracked expiry instead is simpler AND always correct (never a silent mismatch), and is
  // also the one expiry its SignalR broadcast actually keeps live - see cdvExpiry below, shown next
  // to the charts so a switch to the OTHER expiry type is never silently misread as agreement.
  const [cdvTimeframe, setCdvTimeframe] = useState(3)
  const [cdvSeries, setCdvSeries] = useState([])
  const [obvCeSeries, setObvCeSeries] = useState([])
  const [obvPeSeries, setObvPeSeries] = useState([])
  const [cdvExpiry, setCdvExpiry] = useState(null)

  const [paperSide, setPaperSide] = useState('CE')
  const [paperDirection, setPaperDirection] = useState('BUY')
  const [paperStrikeOffset, setPaperStrikeOffset] = useState(0)
  const [paperQtyLots, setPaperQtyLots] = useState(10)
  const [paperPositions, setPaperPositions] = useState([])
  const [paperPanelOpen, setPaperPanelOpen] = useState(false)
  const [paperPanelPos, setPaperPanelPos] = useState(() => ({ x: Math.max(24, window.innerWidth - 480), y: 140 }))

  const liveFeedSupported = LIVE_FEED_COMBOS.has(`${underlying}:${expiryFlag}`)

  const load = () => {
    if (!underlying) return
    setLoading(true)
    setError(null)
    // forceLive: this page has no scenario where preferring possibly-stale stored data over a live
    // Dhan call makes sense - it only ever asks for today, and OiReplayService's own stored-first
    // default (with the live top-up disabled in local dev - see its own doc comment) is what left
    // this page's backfill incomplete/stale when tested locally, exactly like OI Replay's own
    // historical-review page would in the same environment. OI Replay itself keeps its existing
    // default (omits this param) since stored-first genuinely is the right choice for reviewing a
    // past, already-closed day.
    const params = new URLSearchParams({ date: istDateKey(new Date()), timeframeMinutes: '1', expiryFlag, forceLive: 'true' })
    fetch(`/api/oi-replay/${underlying}/run?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => {
        if (!body?.success) throw new Error(body?.error || 'This run did not succeed.')
        setResult(body)
        setOneMinBars((body.spotCandlesOneMinute ?? []).map(toBar))
        const ceGrouped = groupByStrike(body.cePoints ?? [])
        const peGrouped = groupByStrike(body.pePoints ?? [])
        setCeSeries(ceGrouped)
        setPeSeries(peGrouped)
        setCeDayOpen(buildDayOpenByStrike(ceGrouped))
        setPeDayOpen(buildDayOpenByStrike(peGrouped))
        setPaperPositions([])
      })
      .catch((err) => {
        console.error('Failed to load Live OI Dashboard data:', err)
        setResult(null)
        setError(err.message || 'Failed to load today.')
      })
      .finally(() => setLoading(false))
  }

  // CDV/OBV's own seed - separate from load() above since it hits CdvController, not
  // OiReplayController, and follows CDV's own nearest/default tracked expiry rather than this
  // page's WEEK/MONTH expiryFlag - see cdvExpiry's own doc comment above for why.
  const loadCdv = () => {
    if (!underlying) return
    fetch(`/api/cdv/${underlying}/expiries`)
      .then((r) => r.json())
      .then((data) => setCdvExpiry(data?.selected ?? null))
      .catch((err) => console.error('Failed to load CDV expiry:', err))
    fetch(`/api/cdv/${underlying}/series`)
      .then((r) => r.json())
      .then((data) => setCdvSeries((data ?? []).map(toCdvBar)))
      .catch((err) => console.error('Failed to load CDV series:', err))
    fetch(`/api/cdv/${underlying}/obv-series`)
      .then((r) => r.json())
      .then((data) => {
        setObvCeSeries((data?.ce ?? []).map((p) => ({ time: toChartTime(p.time), value: p.obv })))
        setObvPeSeries((data?.pe ?? []).map((p) => ({ time: toChartTime(p.time), value: p.obv })))
      })
      .catch((err) => console.error('Failed to load OBV series:', err))
  }

  // Fresh seed whenever the underlying changes - loadCdv follows CDV's own tracked expiry, not
  // expiryFlag, so it does not need to re-run when only expiryFlag changes.
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [underlying, expiryFlag])
  useEffect(() => { loadCdv() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [underlying])

  const handleSpotUpdate = (snapshot) => {
    if (snapshot?.underlying !== underlying || !snapshot?.currentBar) return
    setOneMinBars((prev) => mergeBar(prev, toBar(snapshot.currentBar)))
  }

  const handleOiReplayTick = (tick) => {
    if (tick?.underlying !== underlying || tick?.expiryFlag !== expiryFlag) return
    const point = { time: tick.time, strike: tick.strike, openInterest: tick.openInterest, impliedVolatility: null, price: tick.price }
    if (tick.side === 'CE') setCeSeries((prev) => appendPoint(prev, tick.strike, point))
    else setPeSeries((prev) => appendPoint(prev, tick.strike, point))
  }

  // A dropped-then-restored connection can miss ticks entirely while it was down - re-fetch the
  // whole snapshot to resync rather than silently trusting whatever partial state accumulated.
  const handleReconnected = () => { load(); loadCdv() }

  // No expiryFlag guard here, unlike handleOiReplayTick above - CDV/OBV always follow CDV's own
  // tracked expiry (see cdvExpiry's own doc comment), which is exactly what this push describes.
  const handleCdvUpdate = (incoming) => {
    if (incoming?.underlying !== underlying || !incoming?.currentBar) return
    setCdvSeries((prev) => mergeBar(prev, toCdvBar(incoming.currentBar)))
  }

  const handleCdvBarClosed = (point) => {
    if (point?.underlying !== underlying) return
    const time = toChartTime(point.time)
    if (point.obvCe != null) setObvCeSeries((prev) => mergeBar(prev, { time, value: point.obvCe }))
    if (point.obvPe != null) setObvPeSeries((prev) => mergeBar(prev, { time, value: point.obvPe }))
  }

  const connectionState = useOiLiveHub(handleSpotUpdate, handleOiReplayTick, handleReconnected, handleCdvUpdate, handleCdvBarClosed)

  const step = result?.step || STEP_BY_UNDERLYING[underlying] || 50
  const currentBar = oneMinBars[oneMinBars.length - 1] ?? null
  const atmStrike = currentBar ? Math.round(currentBar.close / step) * step : null

  const displayBars = useMemo(() => aggregateBars(oneMinBars, timeframe), [oneMinBars, timeframe])

  // A plain tick, unrelated to any live data - exists ONLY so ladderRows' staleness check below
  // re-evaluates on a real clock instead of purely as a side effect of the next incoming tick. Without
  // it, ladderRows (a useMemo keyed on ceSeries/peSeries/day-open) only ever recomputes `now` when a
  // NEW OI tick arrives for SOME strike - so if the feed goes quiet for a stretch (the backend's own
  // Dhan feed watchdog re-subscribing/reconnecting after a brief silent patch - see
  // DhanMarketFeedClient's own stall detector - is a normal, self-healing occurrence, not a page bug),
  // every row that should have gone stale during that silence instead sits frozen showing "fresh"
  // right up until the FIRST tick after the gap finally arrives, at which point `now` jumps forward to
  // the real current time in one shot and every affected row flips to [STALE] all at once - exactly
  // the "sometimes automatically getting stale" symptom. Ticking this independently of any live data
  // makes staleness track wall-clock time continuously instead.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  // Every strike either side has ever reported, current OI/IV/price plus a one-minute-ago and a
  // day-open reference - "now" and "a minute ago" are plain Date.now() reads (this page has no
  // concept of any other "now"), and "day-open" is simply each array's own first element, since the
  // seed fetch already starts from market open.
  const ladderRows = useMemo(() => {
    const now = Date.now()
    const priorMs = now - 60_000
    const strikes = new Set([...ceSeries.keys(), ...peSeries.keys()])
    const rows = [...strikes].map((strike) => {
      const ceArr = ceSeries.get(strike) ?? []
      const peArr = peSeries.get(strike) ?? []
      const ce = ceArr[ceArr.length - 1] ?? null
      const pe = peArr[peArr.length - 1] ?? null
      const cePrior = latestAtOrBefore(ceArr, priorMs)
      const pePrior = latestAtOrBefore(peArr, priorMs)
      const ceOpen = ceDayOpen.get(strike) ?? null
      const peOpen = peDayOpen.get(strike) ?? null
      const ceAsOfMs = ce ? new Date(ce.time).getTime() : null
      const peAsOfMs = pe ? new Date(pe.time).getTime() : null
      const ceOiSinceOpenRaw = ce?.openInterest != null && ceOpen?.openInterest != null ? ce.openInterest - ceOpen.openInterest : null
      const peOiSinceOpenRaw = pe?.openInterest != null && peOpen?.openInterest != null ? pe.openInterest - peOpen.openInterest : null
      // See SINCE_OPEN_SANITY_MULTIPLE's own doc comment - a delta this far out of proportion to the
      // strike's own current OI is treated as an untrustworthy reading, not a real move, and hidden
      // rather than shown as a precise-looking number.
      const ceOiSinceOpen = ceOiSinceOpenRaw != null && ce.openInterest > 0 && Math.abs(ceOiSinceOpenRaw) > ce.openInterest * SINCE_OPEN_SANITY_MULTIPLE
        ? null : ceOiSinceOpenRaw
      const peOiSinceOpen = peOiSinceOpenRaw != null && pe.openInterest > 0 && Math.abs(peOiSinceOpenRaw) > pe.openInterest * SINCE_OPEN_SANITY_MULTIPLE
        ? null : peOiSinceOpenRaw
      return {
        strike,
        ceOi: ce?.openInterest ?? null, ceIv: ce?.impliedVolatility ?? null, cePrice: ce?.price ?? null,
        peOi: pe?.openInterest ?? null, peIv: pe?.impliedVolatility ?? null, pePrice: pe?.price ?? null,
        ceOiChange: ce?.openInterest != null && cePrior?.openInterest != null ? ce.openInterest - cePrior.openInterest : null,
        peOiChange: pe?.openInterest != null && pePrior?.openInterest != null ? pe.openInterest - pePrior.openInterest : null,
        ceOiSinceOpen, peOiSinceOpen,
        ceAsOfMs, peAsOfMs,
        ceStale: ceAsOfMs != null && now - ceAsOfMs > OI_STALE_MS,
        peStale: peAsOfMs != null && now - peAsOfMs > OI_STALE_MS,
      }
    })
    return rows.sort((a, b) => b.strike - a.strike)
    // nowTick is intentionally unused inside - it exists purely to force this memo to recompute on a
    // real clock tick, not just when new tick data arrives. See nowTick's own doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceSeries, peSeries, ceDayOpen, peDayOpen, nowTick])

  const cePremiumStrike = atmStrike != null ? atmStrike + cePremiumOffset * step : null
  const pePremiumStrike = atmStrike != null ? atmStrike + pePremiumOffset * step : null
  const cePremiumCandles = useMemo(() => buildPremiumCandles(ceSeries.get(cePremiumStrike)), [ceSeries, cePremiumStrike])
  const pePremiumCandles = useMemo(() => buildPremiumCandles(peSeries.get(pePremiumStrike)), [peSeries, pePremiumStrike])
  const premiumStrikeOptions = useMemo(() => buildStrikeOffsetOptions(atmStrike, step), [atmStrike, step])

  const cdvCePoints = useMemo(() => aggregateLinePoints(cdvSeries.map((p) => ({ time: p.time, value: p.ceCdv })), cdvTimeframe), [cdvSeries, cdvTimeframe])
  const cdvPePoints = useMemo(() => aggregateLinePoints(cdvSeries.map((p) => ({ time: p.time, value: p.peCdv })), cdvTimeframe), [cdvSeries, cdvTimeframe])
  const obvCePoints = useMemo(() => aggregateLinePoints(obvCeSeries, cdvTimeframe), [obvCeSeries, cdvTimeframe])
  const obvPePoints = useMemo(() => aggregateLinePoints(obvPeSeries, cdvTimeframe), [obvPeSeries, cdvTimeframe])

  const paperStrike = atmStrike != null ? atmStrike + paperStrikeOffset * step : null
  const paperEntryPreview = useMemo(() => {
    const series = (paperSide === 'CE' ? ceSeries : peSeries).get(paperStrike)
    return series?.[series.length - 1] ?? null
  }, [paperSide, paperStrike, ceSeries, peSeries])

  const handlePaperPunch = () => {
    if (paperStrike == null || paperEntryPreview?.price == null) return
    setPaperPositions((prev) => [...prev, {
      id: `${Date.now()}-${Math.random()}`,
      side: paperSide, direction: paperDirection, strike: paperStrike, qtyLots: paperQtyLots,
      lotSize: PAPER_TRADE_LOT_SIZE[underlying] ?? 1,
      entryPrice: paperEntryPreview.price, status: 'OPEN', exitPrice: null,
    }])
  }

  const handlePaperExit = (id) => {
    setPaperPositions((prev) => prev.map((p) => {
      if (p.id !== id || p.status !== 'OPEN') return p
      const series = (p.side === 'CE' ? ceSeries : peSeries).get(p.strike)
      const point = series?.[series.length - 1] ?? null
      return { ...p, status: 'CLOSED', exitPrice: point?.price ?? p.entryPrice }
    }))
  }

  const handlePaperClearAll = () => setPaperPositions([])

  const enrichedPaperPositions = useMemo(() => paperPositions.map((p) => {
    const series = (p.side === 'CE' ? ceSeries : peSeries).get(p.strike)
    const livePoint = p.status === 'OPEN' ? series?.[series.length - 1] : null
    const ltp = p.status === 'OPEN' ? (livePoint?.price ?? p.entryPrice) : p.exitPrice
    const priceDelta = p.direction === 'SELL' ? p.entryPrice - ltp : ltp - p.entryPrice
    return { ...p, ltp, pnl: priceDelta * p.qtyLots * p.lotSize }
  }), [paperPositions, ceSeries, peSeries])
  const paperOpenCount = enrichedPaperPositions.filter((p) => p.status === 'OPEN').length
  const paperTotalPnl = enrichedPaperPositions.reduce((sum, p) => sum + p.pnl, 0)

  const dayKey = `${underlying}-${expiryFlag}`

  return (
    <div style={{ maxWidth: 2600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Live OI Dashboard">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Always today, always live - ticks straight off the same feed OI Replay uses, with no
              playback position to get stuck at. To review a past day instead, use OI Replay.
            </Text>
            <Space wrap size={12}>
              <Select
                value={underlying} onChange={setUnderlying} style={{ width: 130 }}
                options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }, { value: 'SENSEX', label: 'SENSEX' }]}
              />
              <Select
                value={expiryFlag} onChange={setExpiryFlag} style={{ width: 130 }}
                options={[{ value: 'WEEK', label: 'Weekly', disabled: underlying === 'BANKNIFTY' }, { value: 'MONTH', label: 'Monthly' }]}
              />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              <Tooltip title={
                connectionState === 'connected' ? "Streaming live ticks from Dhan's WebSocket feed (price + OI - IV stays at the last REST-fetched value)"
                  : connectionState === 'reconnecting' ? 'Connection dropped - automatically retrying.'
                    : connectionState === 'connecting' ? 'Connecting to the live feed…'
                      : 'Not connected - not receiving live ticks right now.'
              }>
                <Tag color={connectionState === 'connected' ? 'success' : connectionState === 'reconnecting' ? 'warning' : connectionState === 'connecting' ? 'processing' : 'error'}>
                  {connectionState === 'connected' ? '● LIVE' : connectionState === 'reconnecting' ? '● RECONNECTING' : connectionState === 'connecting' ? '● CONNECTING' : '● OFFLINE'}
                </Tag>
              </Tooltip>
              {paperTotalPnl !== 0 || paperOpenCount > 0 ? (
                <Tag color={paperTotalPnl >= 0 ? 'success' : 'error'} style={{ cursor: 'pointer' }} onClick={() => setPaperPanelOpen((o) => !o)}>
                  Paper PnL: {paperTotalPnl >= 0 ? '+' : ''}{paperTotalPnl.toFixed(0)}{paperOpenCount > 0 ? ` (${paperOpenCount} open)` : ''}
                </Tag>
              ) : (
                <Button size="small" onClick={() => setPaperPanelOpen((o) => !o)}>Paper Trade</Button>
              )}
            </Space>
            {!liveFeedSupported && (
              <Alert
                type="info" showIcon
                message={`Live tick-by-tick updates aren't wired up for ${underlying} ${expiryFlag === 'WEEK' ? 'Weekly' : 'Monthly'} - you'll see today's snapshot as of the last load, not a continuously ticking feed. NIFTY (Weekly/Monthly), BANKNIFTY (Monthly) and SENSEX (Weekly/Monthly) all stay live.`}
              />
            )}
            {liveFeedSupported && connectionState === 'disconnected' && (
              <Alert
                type="error" showIcon
                message="Not receiving live ticks right now - check the browser console for a SignalR connection error, and confirm the backend's own Dhan market-feed connection is up."
              />
            )}
            {error && <Alert type="error" showIcon message={error} />}
            {paperPanelOpen && (
              <DraggableFloatingPanel title="Paper trade" pos={paperPanelPos} onPosChange={setPaperPanelPos} onClose={() => setPaperPanelOpen(false)}>
                <PaperTradePanel
                  atmStrike={atmStrike} step={step}
                  side={paperSide} onSideChange={setPaperSide}
                  direction={paperDirection} onDirectionChange={setPaperDirection}
                  strikeOffset={paperStrikeOffset} onStrikeOffsetChange={setPaperStrikeOffset}
                  qtyLots={paperQtyLots} onQtyLotsChange={setPaperQtyLots}
                  onPunch={handlePaperPunch} canPunch={paperEntryPreview?.price != null}
                  positions={enrichedPaperPositions} onExit={handlePaperExit} onClearAll={handlePaperClearAll}
                />
              </DraggableFloatingPanel>
            )}
          </Space>
        </Card>

        <Row gutter={16}>
          <Col span={8}>
            <Card size="small" title="Spot (live)">
              {oneMinBars.length > 0 ? (
                <ChartErrorBoundary key={`${underlying}-${expiryFlag}-${timeframe}`}>
                  <ReplayChart bars={displayBars} ladderRows={ladderRows} dayKey={dayKey} atmStrike={atmStrike} step={step} height={560} />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No spot candles yet today.'} />
              )}
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small" title="Entry chart B (independent timeframe + EMA)">
              {oneMinBars.length > 0 ? (
                <ChartErrorBoundary key={`emaB-${underlying}-${expiryFlag}-${chartBTimeframe}`}>
                  <EmaChart
                    oneMinBars={oneMinBars} visibleCount={oneMinBars.length}
                    timeframe={chartBTimeframe} onTimeframeChange={setChartBTimeframe}
                    ema1Period={chartBEma1} onEma1PeriodChange={setChartBEma1}
                    ema2Period={chartBEma2} onEma2PeriodChange={setChartBEma2}
                    dayKey={`emaB-${dayKey}`} height={560}
                  />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No spot candles yet today.'} />
              )}
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small" title="Entry chart C (independent timeframe + EMA)">
              {oneMinBars.length > 0 ? (
                <ChartErrorBoundary key={`emaC-${underlying}-${expiryFlag}-${chartCTimeframe}`}>
                  <EmaChart
                    oneMinBars={oneMinBars} visibleCount={oneMinBars.length}
                    timeframe={chartCTimeframe} onTimeframeChange={setChartCTimeframe}
                    ema1Period={chartCEma1} onEma1PeriodChange={setChartCEma1}
                    ema2Period={chartCEma2} onEma2PeriodChange={setChartCEma2}
                    dayKey={`emaC-${dayKey}`} height={560}
                  />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No spot candles yet today.'} />
              )}
            </Card>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Card
              size="small"
              title={`CE premium ${cePremiumStrike ?? ''}`}
              extra={<Select value={cePremiumOffset} onChange={setCePremiumOffset} style={{ width: 150 }} options={premiumStrikeOptions} disabled={atmStrike == null} />}
            >
              {oneMinBars.length === 0
                ? <Empty description="No spot candles yet today." />
                : cePremiumCandles.length === 0
                  ? <Empty description={`No CE ${cePremiumStrike ?? ''} premium data yet today.`} />
                  : (
                    <ChartErrorBoundary key={`premium-ce-${underlying}-${expiryFlag}-${cePremiumOffset}`}>
                      <PremiumCandleChart bars={cePremiumCandles} dayKey={`premium-ce-${dayKey}-${cePremiumOffset}`} height={320} />
                    </ChartErrorBoundary>
                  )}
            </Card>
          </Col>
          <Col span={12}>
            <Card
              size="small"
              title={`PE premium ${pePremiumStrike ?? ''}`}
              extra={<Select value={pePremiumOffset} onChange={setPePremiumOffset} style={{ width: 150 }} options={premiumStrikeOptions} disabled={atmStrike == null} />}
            >
              {oneMinBars.length === 0
                ? <Empty description="No spot candles yet today." />
                : pePremiumCandles.length === 0
                  ? <Empty description={`No PE ${pePremiumStrike ?? ''} premium data yet today.`} />
                  : (
                    <ChartErrorBoundary key={`premium-pe-${underlying}-${expiryFlag}-${pePremiumOffset}`}>
                      <PremiumCandleChart bars={pePremiumCandles} dayKey={`premium-pe-${dayKey}-${pePremiumOffset}`} height={320} />
                    </ChartErrorBoundary>
                  )}
            </Card>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={24}>
            <Card
              size="small"
              title="CDV & OBV (chain-wide, live)"
              extra={<Select value={cdvTimeframe} onChange={setCdvTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />}
            >
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                Tracks CDV's own nearest expiry{cdvExpiry ? ` (${cdvExpiry})` : ''} independently of the
                Weekly/Monthly picker above - CDV only tracks a small rolling window of expiries, so it
                will not always be the same one the rest of this page is showing.
              </Text>
              <Row gutter={16}>
                <Col span={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>CDV (cumulative delta volume)</Text>
                  {cdvCePoints.length === 0 && cdvPePoints.length === 0 ? (
                    <Empty description={loading ? 'Loading…' : 'No CDV data yet today.'} />
                  ) : (
                    <ChartErrorBoundary key={`cdv-${underlying}-${expiryFlag}-${cdvTimeframe}`}>
                      <CeVsPeLineChart ceSeries={cdvCePoints} peSeries={cdvPePoints} height={280} />
                    </ChartErrorBoundary>
                  )}
                </Col>
                <Col span={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>OBV (on-balance volume)</Text>
                  {obvCePoints.length === 0 && obvPePoints.length === 0 ? (
                    <Empty description={loading ? 'Loading…' : 'No OBV data yet today.'} />
                  ) : (
                    <ChartErrorBoundary key={`obv-${underlying}-${expiryFlag}-${cdvTimeframe}`}>
                      <CeVsPeLineChart ceSeries={obvCePoints} peSeries={obvPePoints} height={280} />
                    </ChartErrorBoundary>
                  )}
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={24}>
            <Card size="small" title="OI / IV ladder (nearest expiry, live)" bodyStyle={{ maxHeight: 560, overflowY: 'auto' }}>
              <OiLadder rows={ladderRows} atmStrike={atmStrike} />
            </Card>
          </Col>
        </Row>
      </Space>
    </div>
  )
}
