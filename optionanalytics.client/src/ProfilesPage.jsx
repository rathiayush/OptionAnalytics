import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, DatePicker, Empty, InputNumber, Row, Segmented, Select, Slider, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { CaretRightOutlined, PauseOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { CandlestickSeries, CrosshairMode, LineSeries } from 'lightweight-charts'
import {
  NavBar, usePersistedState, POLL_HEADERS, UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  toChartTime, istTimeFormatter, istTickMarkFormatter, istDateKey,
} from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { VolumeProfilePrimitive } from './volumeProfilePrimitive.js'
import { TpoProfilePrimitive, ZoneBoxesPrimitive } from './profilePrimitives.js'
import {
  FETCH_ROWS, MAX_PROFILE_DAYS, PROFILE_ROWS, PROFILE_ROW_CHOICES, barsKnownAt, candlesOf, compositeMarketProfile, dayVolumeProfile,
  lastPeriodRunningAt, marketProfileZones, pastSessionsNeeded, profileSessions, volumeZones,
} from './profileZones.js'
import { useFollowReplayClock } from './replaySync.jsx'
import { FoldText } from './FoldText.jsx'
import { alignToBars, sessionVwapFromBars } from './chartVwap.js'

// The Profiles page: a whole page for the volume profile and the market profile (TPO) of an index - its SPOT in
// the top row and its near FUTURES below, one card each, over that instrument's candles in the timeframe picked,
// with the profile's levels and its ZONES drawn as boxes (profileZones.js) and, ticked, the day's VWAP:
//   Volume profile - POC, VAH / VAL; boxes where the most volume traded (each with its HVN) and where it was
//     thin (each with its LVN); the profile's bars at the right edge (buy / sell).
//   Market profile - the TPO letters at the right edge (A = 09:15, a letter each 30 minutes); boxes where the
//     market accepted price (the value area and its busiest rows) and where it did not (single prints inside
//     the range, buying / selling tails at its extremes); POC, VAH / VAL and the initial balance.
//
// LIVE (today, refreshed every REFRESH_MS) or a PAST DAY at a clock - and by default it FOLLOWS OI Replay in
// another tab (replaySync.jsx's clock channel, one way): the same index and day, live or at OI Replay's replay
// clock, so the profiles replay along with it. Nothing after the clock is in either profile (barsKnownAt).
// The futures are the Order Flow server's futures day (footprint rows - the buy and sell at each price), the same
// the Order Flow page replays; a past day the server did not record comes estimated from 1-minute candles. The
// spot is the index's 1-minute bars with its own volume (GET /api/oi-replay/{u}/spot-day - today the spot feed's
// memory, a past day kept on disk; live refreshed from the feed's memory, /api/spot/{u}/volume-candles, so a
// refresh never asks Dhan). Index volume has no buy / sell side: the spot's bars are one colour.

const { Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const TIMEFRAMES = [1, 3, 5, 15, 30]
const REFRESH_MS = 15_000
const CHART_HEIGHT = 560
// The right part of the time axis left empty for the profile drawn there (a share of the plot).
const PROFILE_ROOM = { vp: 0.3, tpo: 0.28 }
const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const fmtClock = (ms) => (ms == null ? '' : istTimeFormatter(toChartTime(ms)))

const STORE = {
  underlying: 'optionanalytics.profiles.underlying',
  timeframe: 'optionanalytics.profiles.timeframe',
  rows: 'optionanalytics.profiles.rows',
  of: 'optionanalytics.profiles.of',
  days: 'optionanalytics.profiles.days',
  follow: 'optionanalytics.profiles.followOiReplay',
  vwap: 'optionanalytics.profiles.vwap',
}

// The boxes' colours: the volume profile's busy areas green, thin ones red; the market profile's accepted
// areas teal, single prints orange, tails magenta. The value area is a faint dashed frame on both.
const BOX = {
  value: { fill: 'rgba(155,140,255,0.045)', stroke: 'rgba(155,140,255,0.55)', dashed: true, labelColor: '#b9adff' },
  high: { fill: 'rgba(82,196,26,0.15)', stroke: 'rgba(115,209,61,0.75)', labelColor: '#95de64' },
  low: { fill: 'rgba(245,34,45,0.14)', stroke: 'rgba(255,77,79,0.75)', labelColor: '#ff7875' },
  accepted: { fill: 'rgba(54,207,201,0.18)', stroke: 'rgba(54,207,201,0.8)', labelColor: '#5cdbd3' },
  acceptedValue: { fill: 'rgba(54,207,201,0.05)', stroke: 'rgba(54,207,201,0.5)', dashed: true, labelColor: '#87e8de' },
  single: { fill: 'rgba(255,122,69,0.2)', stroke: 'rgba(255,122,69,0.85)', labelColor: '#ff9c6e' },
  tail: { fill: 'rgba(235,47,150,0.18)', stroke: 'rgba(235,47,150,0.85)', labelColor: '#ff85c0' },
}
const LINE = { poc: '#fadb14', va: '#9b8cff', ib: '#faad14' }
const VWAP_COLOR = '#e072e8'

// ---- data ------------------------------------------------------------------------------------------------

const dayUrl = {
  futures: (u, d) => `/api/order-flow/${u}/day/${d}?rowSize=${FETCH_ROWS[u] ?? 1}&minTradeLots=100000&heatmapColumns=50`,
  spot: (u, d) => `/api/oi-replay/${u}/spot-day?date=${d}`,
}
const byTime = (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()

/** One instrument's day ("futures" | "spot"): { loading, error, at, day: { key, bars, source, contract } }. Live,
 *  refreshed every REFRESH_MS - a page timer, sent with the X-Poll header: the futures day again (the live engine's
 *  memory), the spot from the spot feed's memory (merged in by minute) - neither refresh reaches Dhan. */
function useInstrumentDay(kind, underlying, dateKey, live) {
  const [state, setState] = useState({ loading: false, error: null, day: null, at: null })
  useEffect(() => {
    if (!underlying || !dateKey) return undefined
    let cancelled = false
    const key = `${kind}|${underlying}|${dateKey}`
    setState((s) => ({ loading: true, error: null, day: s.day?.key === key ? s.day : null, at: s.at }))
    const fail = (err) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: err.message })) }
    const load = () => fetch(dayUrl[kind](underlying, dateKey))
      .then((r) => (r.ok ? r.json() : r.json().catch(() => ({})).then((b) => Promise.reject(new Error(b?.error ?? `HTTP ${r.status}`)))))
      .then((body) => {
        if (cancelled) return
        if (kind === 'spot' && !body.success) throw new Error(body.error ?? 'no spot candles')
        setState({ loading: false, error: null, at: Date.now(), day: { key, bars: body.bars ?? [], source: body.source, contract: body.meta?.contractSymbol } })
      })
      .catch(fail)
    const refresh = kind === 'futures'
      ? () => fetch(dayUrl.futures(underlying, dateKey), { headers: POLL_HEADERS })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body) => { if (!cancelled) setState({ loading: false, error: null, at: Date.now(), day: { key, bars: body.bars ?? [], source: body.source, contract: body.meta?.contractSymbol } }) })
        .catch(fail)
      : () => fetch(`/api/spot/${underlying}/volume-candles`, { headers: POLL_HEADERS })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((feed) => {
          if (cancelled) return
          const today = (feed ?? []).filter((b) => istDateKey(b.time) === dateKey)
          setState((s) => {
            const merged = new Map((s.day?.key === key ? s.day.bars : []).map((b) => [new Date(b.time).getTime(), b]))
            for (const b of today) merged.set(new Date(b.time).getTime(), b)
            return { loading: false, error: null, at: Date.now(), day: { key, bars: [...merged.values()].sort(byTime), source: s.day?.source ?? 'feed' } }
          })
        })
        .catch(() => { /* the next refresh tries again; what was loaded stays */ })
    load()
    const id = live ? setInterval(refresh, REFRESH_MS) : null
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [kind, underlying, dateKey, live])
  return state
}

// A past day never changes: kept here once fetched (this tab only), so changing "Days", the row or "Profile of" asks
// the server nothing again. Only what came back is kept - a failure is asked again next time.
const PAST_DAY_CACHE = new Map()
const PAST_DAY_CACHE_MAX = 120
async function fetchPastDay(kind, underlying, dateKey) {
  const key = `${kind}|${underlying}|${dateKey}`
  if (PAST_DAY_CACHE.has(key)) return PAST_DAY_CACHE.get(key)
  const r = await fetch(dayUrl[kind](underlying, dateKey))
  let day = null
  if (r.ok) {
    const body = await r.json()
    // The spot answers 200 with success false for a day with no candles (a holiday - or a failure: not kept).
    if (kind === 'spot' && !body.success) return { date: dateKey, bars: [], source: null }
    day = { date: dateKey, bars: barsKnownAt(body.bars, null), source: body.source }
  } else if (r.status === 404) {
    // No futures day there (a holiday) is an answer too: an empty session.
    day = { date: dateKey, bars: [], source: null }
  } else {
    throw new Error(`HTTP ${r.status}`)
  }
  PAST_DAY_CACHE.set(key, day)
  if (PAST_DAY_CACHE.size > PAST_DAY_CACHE_MAX) PAST_DAY_CACHE.delete(PAST_DAY_CACHE.keys().next().value)
  return day
}

/** The `count` trading sessions of one instrument before `dateKey`, oldest first: weekdays walked back one at a time
 *  (one request at a time - a past day the server does not hold is fetched from Dhan the first time), a day with no
 *  minutes (a holiday) stepped over, `count` + 10 weekdays at most. Sessions come in as they load. */
function usePastSessions(kind, underlying, dateKey, count) {
  const [state, setState] = useState({ key: null, loading: false, sessions: [], error: null })
  const want = `${kind}|${underlying}|${dateKey}|${count}`
  useEffect(() => {
    if (!underlying || !dateKey || count <= 0) return undefined
    let cancelled = false
    setState({ key: want, loading: true, sessions: [], error: null })
    ;(async () => {
      const found = []
      let day = dayjs(dateKey)
      let error = null
      for (let tries = 0; found.length < count && tries < count + 10;) {
        day = day.subtract(1, 'day')
        if (day.day() === 0 || day.day() === 6) continue
        tries++
        try {
          const session = await fetchPastDay(kind, underlying, day.format('YYYY-MM-DD'))
          if (cancelled) return
          if (session.bars.length) {
            found.unshift(session)
            setState({ key: want, loading: found.length < count, sessions: [...found], error: null })
          }
        } catch (err) {
          if (cancelled) return
          error = err.message
        }
      }
      if (!cancelled) setState({ key: want, loading: false, sessions: found, error: found.length < count ? error : null })
    })()
    return () => { cancelled = true }
  }, [want]) // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === want ? state : { loading: count > 0, sessions: [], error: null }
}

// ---- the chart -------------------------------------------------------------------------------------------

/** Candles with a profile drawn at the right edge (`drawProfile(primitive)` sets it), zone boxes and
 *  price lines. The time axis keeps `room` of the plot empty on the right, so the newest candles never sit
 *  under the profile; wheel / drag take over the view, a double-click hands it back. */
function ProfileChart({ candles, vwap = null, makePrimitive, drawProfile, zones, lines, priceRange, room, height = CHART_HEIGHT, resetKey }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const vwapRef = useRef(null)
  const profileRef = useRef(null)
  const boxesRef = useRef(null)
  const linesRef = useRef([])
  const rangeRef = useRef(priceRange)
  rangeRef.current = priceRange
  const userMovedRef = useRef(false)
  const countRef = useRef(0)

  const fit = useCallback(() => {
    const chart = chartRef.current
    const n = countRef.current
    if (!chart || n === 0) return
    chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: n - 0.5 + Math.max(6, Math.ceil(n * room / (1 - room))) })
  }, [room])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const chart = createZoomableChart(element, {
      width: element.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR, scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, shiftVisibleRangeOnNewBar: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      // The price scale holds the whole profile too - a previous session's can reach past today's candles.
      autoscaleInfoProvider: (original) => {
        const base = original()
        const r = rangeRef.current
        if (!r) return base
        const lo = Math.min(base?.priceRange?.minValue ?? r.low, r.low)
        const hi = Math.max(base?.priceRange?.maxValue ?? r.high, r.high)
        return { ...(base ?? {}), priceRange: { minValue: lo, maxValue: hi } }
      },
    })
    // The day's VWAP - its points are the candles' own times (alignToBars), so it adds nothing to the time axis.
    vwapRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP', crosshairMarkerVisible: false })
    boxesRef.current = new ZoneBoxesPrimitive()
    series.attachPrimitive(boxesRef.current)
    profileRef.current = makePrimitive()
    series.attachPrimitive(profileRef.current)
    chartRef.current = chart
    seriesRef.current = series

    const observer = new ResizeObserver(([entry]) => chart.applyOptions({ width: Math.floor(entry.contentRect.width) }))
    observer.observe(element)
    // The viewer moved the view (wheel, drag): leave it there. A double-click fits the day again.
    const visible = () => chart.timeScale().getVisibleLogicalRange()
    let before = null
    const press = () => { before = visible() }
    const release = () => {
      const after = visible()
      if (before && after && (Math.abs(after.from - before.from) > 0.5 || Math.abs(after.to - before.to) > 0.5)) userMovedRef.current = true
      before = null
    }
    const wheel = () => { userMovedRef.current = true }
    const reset = () => { userMovedRef.current = false; requestAnimationFrame(() => { chart.priceScale('right').applyOptions({ autoScale: true }); fit() }) }
    element.addEventListener('pointerdown', press, true)
    window.addEventListener('pointerup', release, true)
    element.addEventListener('wheel', wheel, { passive: true, capture: true })
    element.addEventListener('dblclick', reset, true)
    return () => {
      observer.disconnect()
      element.removeEventListener('pointerdown', press, true)
      window.removeEventListener('pointerup', release, true)
      element.removeEventListener('wheel', wheel, { capture: true })
      element.removeEventListener('dblclick', reset, true)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      vwapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { chartRef.current?.applyOptions({ height }) }, [height])
  // A new day, index or timeframe: the view is the chart's again.
  useEffect(() => { userMovedRef.current = false }, [resetKey])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    series.setData(candles.map((c) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })))
    countRef.current = candles.length
    if (!userMovedRef.current) fit()
  }, [candles, fit])

  useEffect(() => { vwapRef.current?.setData(vwap ?? []) }, [vwap])
  useEffect(() => { if (profileRef.current) drawProfile(profileRef.current) }, [drawProfile])
  useEffect(() => { boxesRef.current?.setZones(zones) }, [zones])
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const line of linesRef.current) series.removePriceLine(line)
    linesRef.current = (lines ?? []).filter((l) => Number.isFinite(l.price)).map((l) => series.createPriceLine({
      price: l.price, color: l.color, title: l.title, lineWidth: l.width ?? 1, lineStyle: l.style ?? 0, axisLabelVisible: true,
    }))
  }, [lines])
  // A new profile range: fit the prices to it again (unless the viewer is holding the view).
  useEffect(() => { if (!userMovedRef.current) chartRef.current?.priceScale('right').applyOptions({ autoScale: true }) }, [priceRange])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}


// ---- one instrument's two cards --------------------------------------------------------------------------

const zoneLabel = {
  high: (z) => `${z.poc ? 'POC area' : 'HVN'} ${fmt(z.node)} · ${Math.round(z.share * 100)}% of volume`,
  low: (z) => `LVN ${fmt(z.node)} · thin volume`,
  single: (z) => `Single prints${z.forming ? ' (forming)' : ''}`,
  tail: (z) => `${z.side === 'selling' ? 'Selling' : 'Buying'} tail${z.forming ? ' (forming)' : ''}`,
  accepted: (z) => (z.poc ? 'Most time spent (POC)' : 'Time spent - accepted'),
}

function Legend({ items }) {
  return (
    <Space size={[10, 4]} wrap>
      {items.map(([key, label]) => (
        <span key={label} style={{ fontSize: 11, color: AXIS_COLOR, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 14, height: 10, background: BOX[key].fill, border: `1px ${BOX[key].dashed ? 'dashed' : 'solid'} ${BOX[key].stroke}`, display: 'inline-block' }} />
          {label}
        </span>
      ))}
    </Space>
  )
}

const volumeOf = (b) => b.volume ?? (b.buy ?? 0) + (b.sell ?? 0)

/** The volume profile card and the market profile card of ONE instrument (the spot, or the futures): `known` - its
 *  bars of the day known at the clock; `past` - its sessions before the day ({ date, bars }, oldest first). `neutral`:
 *  the volume has no buy / sell side (the index's) - its bars are one colour. */
function ProfilePair({ name, known, past, dayCount, profileOf, clock, row, timeframe, showVwap, resetKey, neutral = false, empty = null }) {
  const sessions = useMemo(
    () => profileSessions({ today: known, past: past.map((d) => d.bars), days: dayCount, of: profileOf }),
    [known, past, dayCount, profileOf],
  )
  const profileBars = useMemo(() => sessions.flat(), [sessions])
  const candles = useMemo(() => candlesOf(known, timeframe), [known, timeframe])
  // The day's VWAP the way the server works it out (VwapCalculator): typical price x volume over the 1-minute bars,
  // then each candle's value at its last minute.
  const vwap = useMemo(() => {
    if (!showVwap || !candles.length) return null
    const minute = sessionVwapFromBars(known.map((b) => ({ time: toChartTime(b.time), high: b.high, low: b.low, close: b.close, volume: volumeOf(b) })))
    return minute ? alignToBars(minute, candles.map((c) => ({ time: toChartTime(c.time) }))) : null
  }, [showVwap, known, candles])

  const vp = useMemo(() => dayVolumeProfile(profileBars, row), [profileBars, row])
  const hasVolume = vp.rows.length > 0
  const vz = useMemo(() => volumeZones(vp, row), [vp, row])
  const tpo = useMemo(() => compositeMarketProfile(sessions, row), [sessions, row])
  // "Forming" is read for a profile of the day alone - in a composite an older session's letter is the same letter.
  const running = profileOf === 'today' && sessions.length === 1 && lastPeriodRunningAt(known, clock)
  const mz = useMemo(() => marketProfileZones(tpo, { lastPeriodRunning: running }), [tpo, running])

  const vpZones = useMemo(() => {
    const out = []
    if (vp.val != null) out.push({ ...BOX.value, low: vp.val, high: vp.vah + row, label: 'Value area (70% of volume)' })
    for (const z of vz.high) out.push({ ...BOX.high, low: z.low, high: z.high, label: zoneLabel.high(z) })
    for (const z of vz.low) out.push({ ...BOX.low, low: z.low, high: z.high, label: zoneLabel.low(z) })
    return out
  }, [vp, vz, row])
  const mpZones = useMemo(() => {
    const out = []
    if (mz.value) out.push({ ...BOX.acceptedValue, low: mz.value.low, high: mz.value.high, label: 'Value area - accepted (70% of TPOs)' })
    for (const z of mz.accepted) out.push({ ...BOX.accepted, low: z.low, high: z.high, label: zoneLabel.accepted(z) })
    for (const z of mz.singles) out.push({ ...BOX.single, low: z.low, high: z.high, label: zoneLabel.single(z) })
    for (const z of mz.tails) out.push({ ...BOX.tail, low: z.low, high: z.high, label: zoneLabel.tail(z) })
    return out
  }, [mz])
  const vpLines = useMemo(() => (vp.poc == null ? [] : [
    { price: vp.poc + row / 2, color: LINE.poc, title: 'POC', width: 2 },
    { price: vp.vah + row, color: LINE.va, title: 'VAH', style: 2 },
    { price: vp.val, color: LINE.va, title: 'VAL', style: 2 },
  ]), [vp, row])
  const mpLines = useMemo(() => (!tpo ? [] : [
    { price: tpo.poc + row / 2, color: LINE.poc, title: 'TPO POC', width: 2 },
    { price: tpo.vah + row, color: LINE.va, title: 'VAH', style: 2 },
    { price: tpo.val, color: LINE.va, title: 'VAL', style: 2 },
    ...(tpo.ib ? [{ price: tpo.ib.high, color: LINE.ib, title: 'IB high', style: 1 }, { price: tpo.ib.low, color: LINE.ib, title: 'IB low', style: 1 }] : []),
  ]), [tpo, row])
  const vpRange = useMemo(() => (hasVolume ? { low: vp.rows[0].price, high: vp.rows.at(-1).price + row } : null), [vp, row, hasVolume])
  const tpoRange = useMemo(() => (tpo?.rows?.length ? { low: tpo.rows[0].price, high: tpo.rows.at(-1).price + row } : null), [tpo, row])
  // The index's volume has no side: its rows drawn as one neutral bar each.
  const drawVp = useCallback((p) => p.setProfile(hasVolume ? (neutral ? { ...vp, rows: vp.rows.map((r) => ({ price: r.price, buy: 0, sell: 0, total: r.total })) } : vp) : null, row), [vp, row, neutral, hasVolume])
  const singlePrices = useMemo(() => {
    const set = []
    for (const z of [...mz.singles, ...mz.tails]) for (let p = z.low; p < z.high - 1e-9; p = Math.round((p + row) * 100) / 100) set.push(p)
    return set
  }, [mz, row])
  const drawTpo = useCallback((p) => p.setProfile(tpo, singlePrices), [tpo, singlePrices])
  const makeVp = useCallback(() => new VolumeProfilePrimitive(), [])
  const makeTpo = useCallback(() => new TpoProfilePrimitive(), [])
  const many = sessions.length > 1 ? ` · ${sessions.length} sessions` : ''
  const extra = <Text type="secondary" style={{ fontSize: 11 }}>double-click: fit</Text>

  return (
    <Row gutter={[14, 14]}>
      <Col xs={24} xl={12}>
        <Card size="small" title={`${name} · Volume profile${many}`} extra={extra}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Space size={[12, 2]} wrap style={{ fontSize: 12 }}>
              <span style={{ color: LINE.poc }}>POC {fmt(vp.poc == null ? null : vp.poc + row / 2)}</span>
              <span style={{ color: LINE.va }}>VAH {fmt(vp.vah == null ? null : vp.vah + row)} · VAL {fmt(vp.val)}</span>
              <span style={{ color: BOX.high.labelColor }}>HVN {vz.hvn.length ? vz.hvn.map(fmt).join(', ') : '—'}</span>
              <span style={{ color: BOX.low.labelColor }}>LVN {vz.lvn.length ? vz.lvn.map(fmt).join(', ') : '—'}</span>
            </Space>
            <Legend items={[['high', 'Highest volume (HVN area)'], ['low', 'Thin volume (LVN area)'], ['value', 'Value area']]} />
            {empty ?? (!hasVolume && profileBars.length > 0 && (
              <Alert type="info" showIcon message={`No ${name.toLowerCase()} volume for ${sessions.length > 1 ? 'these sessions' : 'this day'} - Dhan sends the index's own volume from January 2026. The market profile (time, not volume) still shows.`} />
            ))}
            {empty ? null : (
              <ProfileChart
                candles={candles} vwap={vwap} makePrimitive={makeVp} drawProfile={drawVp} zones={vpZones} lines={vpLines}
                priceRange={vpRange} room={PROFILE_ROOM.vp} resetKey={resetKey}
              />
            )}
            <FoldText id="profiles.vp" label="how to read the volume profile" className="oa-note">
              <Text type="secondary" style={{ fontSize: 11 }}>
                The bars at the right are the volume traded at each price ({row}-point rows; on the futures green bought at the
                offer, red sold at the bid - the index&apos;s own volume has no side, so the spot&apos;s are one colour). POC = the
                price that traded the most; VAH / VAL = the band holding 70% of the volume. GREEN boxes are where the most volume
                traded - prices the market agreed on, which tend to hold price (support / resistance, a magnet when price is near);
                each names its HVN, its busiest row. RED boxes are where volume was thin inside the range - prices the market moved
                through fast, which it tends to cross fast again: a break into one often runs to the far side. A thin edge at the
                day&apos;s high or low is not a box (price only got there briefly). Busy = at least 1.3x the average row, thin = 0.6x
                or less (smoothed over three rows). With Days above 1 it is every session&apos;s volume at each price added up - the
                levels several days agreed on. The pink line is the day&apos;s VWAP (the &quot;VWAP&quot; tick).
              </Text>
            </FoldText>
          </Space>
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card size="small" title={`${name} · Market profile (TPO)${many}`} extra={extra}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Space size={[12, 2]} wrap style={{ fontSize: 12 }}>
              <span style={{ color: LINE.poc }}>POC {fmt(tpo ? tpo.poc + row / 2 : null)}</span>
              <span style={{ color: LINE.va }}>VAH {fmt(tpo ? tpo.vah + row : null)} · VAL {fmt(tpo?.val)}</span>
              <span style={{ color: LINE.ib }}>IB {tpo?.ib ? `${fmt(tpo.ib.low)} – ${fmt(tpo.ib.high)}` : '—'}</span>
              <span style={{ color: BOX.single.labelColor }}>Single prints {mz.singles.length ? mz.singles.map((z) => `${fmt(z.low)}–${fmt(z.high)}`).join(', ') : '—'}</span>
              <span style={{ color: BOX.tail.labelColor }}>Tails {mz.tails.length ? mz.tails.map((z) => `${z.side} ${fmt(z.low)}–${fmt(z.high)}`).join(', ') : '—'}</span>
            </Space>
            <Legend items={[['accepted', 'Most time spent - accepted'], ['acceptedValue', 'Value area'], ['single', 'Single prints'], ['tail', 'Tail (rejected)']]} />
            {empty ?? (
              <ProfileChart
                candles={candles} vwap={vwap} makePrimitive={makeTpo} drawProfile={drawTpo} zones={mpZones} lines={mpLines}
                priceRange={tpoRange} room={PROFILE_ROOM.tpo} resetKey={resetKey}
              />
            )}
            <FoldText id="profiles.tpo" label="how to read the market profile" className="oa-note">
              <Text type="secondary" style={{ fontSize: 11 }}>
                Each letter at the right is a 30-minute period that traded at that price ({row}-point rows): A = 09:15, B = 09:45, C =
                10:15 and so on (A and B, the initial balance, in amber; blocks instead of letters when the rows are too thin to read).
                The more letters on a row, the more TIME the market spent there. TEAL boxes are where it spent the most - prices it
                accepted (the busiest rows, with the value area, 70% of the TPOs, as a dashed frame): expect rotation there. ORANGE
                boxes are single prints inside the range - one period only, a fast one-sided move; price often comes back to fill
                them, and they act as support / resistance until it does. MAGENTA boxes are tails - single prints at the day&apos;s
                high (selling tail) or low (buying tail), where the auction was rejected. &quot;Forming&quot; = made by the period
                still running: it can still be filled in. With Days above 1 every session&apos;s TPOs are added up (each session
                lettered from A; blocks instead of letters once a row holds too many to read) and the initial balance is the latest
                session&apos;s.
              </Text>
            </FoldText>
          </Space>
        </Card>
      </Col>
    </Row>
  )
}

// ---- the page --------------------------------------------------------------------------------------------

const msOf = (t) => new Date(t).getTime()
const updatedAt = (at) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })

export default function ProfilesPage() {
  const [underlying, setUnderlying] = usePersistedState(STORE.underlying, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORE.timeframe, 5)
  const [rows, setRows] = usePersistedState(STORE.rows, PROFILE_ROWS)
  const [profileOf, setProfileOf] = usePersistedState(STORE.of, 'today')
  // How many sessions the profiles cover - 1 is the day itself (or the one session before it).
  const [days, setDays] = usePersistedState(STORE.days, 1)
  const [follow, setFollow] = usePersistedState(STORE.follow, true)
  const [showVwap, setShowVwap] = usePersistedState(STORE.vwap, true)
  const todayKey = istDateKey(new Date())
  const [live, setLive] = useState(true)
  const [dateKey, setDateKey] = useState(todayKey)
  // A past day's own clock (epoch ms) - null = the whole day. OI Replay's while following it.
  const [clockMs, setClockMs] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const index = UNDERLYINGS.includes(underlying) ? underlying : 'NIFTY'
  const row = rows?.[index] > 0 ? rows[index] : PROFILE_ROWS[index]

  // Following OI Replay: its index, its day, its clock.
  const onClock = useCallback((msg) => {
    if (!UNDERLYINGS.includes(msg.underlying)) return
    setUnderlying(msg.underlying)
    if (msg.live) { setLive(true); setDateKey(istDateKey(new Date())); setClockMs(null); setPlaying(false); return }
    if (!msg.date) return // a day still loading there
    setLive(false)
    setDateKey(msg.date)
    setClockMs(msg.ms ?? null)
    setPlaying(false)
  }, [setUnderlying])
  const followed = useFollowReplayClock(follow, onClock)
  const following = follow && followed.connected

  const effectiveDate = live ? todayKey : dateKey
  const dayCount = Math.max(1, Math.min(MAX_PROFILE_DAYS, Math.round(days) || 1))
  const pastCount = pastSessionsNeeded(dayCount, profileOf)
  const futures = useInstrumentDay('futures', index, effectiveDate, live)
  const spot = useInstrumentDay('spot', index, effectiveDate, live)
  const futuresPast = usePastSessions('futures', index, effectiveDate, pastCount)
  const spotPast = usePastSessions('spot', index, effectiveDate, pastCount)
  const futuresDay = futures.day?.key === `futures|${index}|${effectiveDate}` ? futures.day : null
  const spotDay = spot.day?.key === `spot|${index}|${effectiveDate}` ? spot.day : null

  // The span a past day's own slider runs over: the first minute's start to the last minute's end, of either.
  const futuresSession = useMemo(() => barsKnownAt(futuresDay?.bars, null), [futuresDay])
  const spotSession = useMemo(() => barsKnownAt(spotDay?.bars, null), [spotDay])
  const ends = [futuresSession, spotSession].filter((b) => b.length)
  const span = ends.length ? { start: Math.min(...ends.map((b) => msOf(b[0].time))) + 60_000, end: Math.max(...ends.map((b) => msOf(b.at(-1).time))) + 60_000 } : null
  const clock = live ? null : clockMs ?? span?.end ?? null

  // Its own replay: a minute every 1 / speed seconds.
  useEffect(() => {
    if (!playing || live || following || !span) return undefined
    const id = setInterval(() => setClockMs((ms) => {
      const next = (ms ?? span.start) + 60_000
      if (next >= span.end) { setPlaying(false); return span.end }
      return next
    }), 1000 / speed)
    return () => clearInterval(id)
  }, [playing, live, following, span?.start, span?.end, speed]) // eslint-disable-line react-hooks/exhaustive-deps

  const futuresKnown = useMemo(() => barsKnownAt(futuresDay?.bars, clock), [futuresDay, clock])
  const spotKnown = useMemo(() => barsKnownAt(spotDay?.bars, clock), [spotDay, clock])
  const resetKey = `${index}|${effectiveDate}|${timeframe}|${profileOf}|${dayCount}`

  // What the profiles cover, in words: "2026-09-28 → 2026-10-02 (5 sessions)" - the futures' sessions (the spot's
  // are the same trading days).
  const usedPast = futuresPast.sessions.slice(-pastCount)
  const coverDates = [...usedPast.map((d) => d.date), ...(profileOf === 'today' && (futuresKnown.length || spotKnown.length) ? [effectiveDate] : [])]
  const coverText = coverDates.length === 0 ? '' : coverDates.length === 1 ? coverDates[0] : `${coverDates[0]} → ${coverDates.at(-1)} (${coverDates.length} sessions)`
  const estimated = (profileOf === 'today' && futuresDay?.source === 'estimated') || usedPast.some((d) => d.source === 'estimated')
  const asOf = live ? `live${futures.at ? ` · updated ${updatedAt(futures.at)}` : ''}` : clock ? `as of ${fmtClock(clock)}` : ''
  const loadingPast = futuresPast.loading || spotPast.loading
  // Nothing of the day yet: the cards say so - unless they show earlier sessions only, which they can without it.
  const emptyFor = (state, session, past, what) => {
    if (session.length || (profileOf === 'previous' && past.sessions.length)) return null
    if (state.loading) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Loading the ${what}…`} />
    if (state.error) return <Alert type="warning" showIcon message={`The ${what} is not available: ${state.error}`} />
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={live ? 'No trading today yet - the profiles start with the first minute after 09:15.' : `No ${what} minutes for this day.`} />
  }
  const pair = { dayCount, profileOf, clock, row, timeframe, showVwap, resetKey }

  return (
    <div style={{ padding: '16px 16px 32px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>Option Analytics</Typography.Title>
          <NavBar />
        </Space>

        <Card size="small" title="Volume & market profile">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={[12, 8]} align="center">
              <Tooltip title={following ? 'Following OI Replay - turn Follow off to pick here' : null}>
                <Segmented size="small" value={index} disabled={following} options={UNDERLYINGS} onChange={(v) => { setUnderlying(v); setPlaying(false) }} />
              </Tooltip>
              <Space size={4}>
                <Button size="small" type={live ? 'primary' : 'default'} disabled={following} onClick={() => { setLive(true); setClockMs(null); setPlaying(false) }}>Live</Button>
                <DatePicker
                  size="small" allowClear={false} disabled={following} value={dayjs(effectiveDate)}
                  disabledDate={(d) => d.isAfter(dayjs(), 'day') || d.day() === 0 || d.day() === 6}
                  onChange={(d) => { if (!d) return; setDateKey(d.format('YYYY-MM-DD')); setLive(false); setClockMs(null); setPlaying(false) }}
                />
              </Space>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Candles</Text>
                <Select size="small" value={timeframe} onChange={setTimeframe} style={{ width: 84 }} options={TIMEFRAMES.map((t) => ({ value: t, label: `${t} min` }))} />
              </Space>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Row</Text>
                <Select size="small" value={row} onChange={(v) => setRows({ ...(rows ?? PROFILE_ROWS), [index]: v })} style={{ width: 84 }} options={(PROFILE_ROW_CHOICES[index] ?? [5]).map((r) => ({ value: r, label: `${r} pts` }))} />
              </Space>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Profile of</Text>
                <Segmented size="small" value={profileOf} onChange={setProfileOf} options={[{ value: 'today', label: live ? 'Today so far' : 'This day so far' }, { value: 'previous', label: dayCount > 1 ? 'Previous sessions' : 'Previous session' }]} />
              </Space>
              <Tooltip title={`How many sessions the profiles are built from (a composite). 1 = the day alone. With "${live ? 'Today so far' : 'This day so far'}", the day so far and the sessions before it; with "Previous session", that many sessions before the day.`}>
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Days</Text>
                  <InputNumber size="small" min={1} max={MAX_PROFILE_DAYS} value={dayCount} onChange={(v) => { if (v >= 1) setDays(Math.round(v)) }} style={{ width: 64 }} />
                </Space>
              </Tooltip>
              <Tooltip title="The day's VWAP on every chart - typical price x volume over the 1-minute bars, as the server works it out (the spot's on the index's own volume).">
                <Checkbox checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}>VWAP</Checkbox>
              </Tooltip>
              <Tooltip title="Follow the OI Replay page open in another tab: the same index and day - live, or at its replay clock - so the profiles replay along with it. Nothing you do here moves OI Replay.">
                <Space size={4}>
                  <Switch size="small" checked={follow} onChange={setFollow} />
                  <Text style={{ fontSize: 12 }}>Follow OI Replay</Text>
                </Space>
              </Tooltip>
              {follow && (following
                ? <Tag color="cyan" style={{ margin: 0 }}>⇄ OI Replay · {followed.clock?.underlying} {followed.clock?.live ? 'live' : `${followed.clock?.date ?? 'loading'}${followed.clock?.ms ? ` ${fmtClock(followed.clock.ms)}` : ''}`}</Tag>
                : <Tag style={{ margin: 0 }}>OI Replay is not open - showing this page&apos;s own choice</Tag>)}
            </Space>
            {!live && !following && span && (
              <Space size={10} style={{ width: '100%' }} wrap>
                <Button size="small" icon={playing ? <PauseOutlined /> : <CaretRightOutlined />} onClick={() => { if (!playing && (clock ?? span.end) >= span.end) setClockMs(span.start); setPlaying((p) => !p) }} />
                <Select size="small" value={speed} onChange={setSpeed} style={{ width: 92 }} options={[1, 2, 5, 10].map((s) => ({ value: s, label: `${s} min/s` }))} />
                <Slider
                  style={{ flex: 1, minWidth: 220, margin: '0 8px' }} min={span.start} max={span.end} step={60_000} value={clock ?? span.end}
                  tooltip={{ formatter: (v) => fmtClock(v) }} onChange={(v) => { setPlaying(false); setClockMs(v) }}
                />
                <Text style={{ fontSize: 12 }}>{fmtClock(clock)}</Text>
              </Space>
            )}
            <Space size={8} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {index} spot and futures{futuresDay?.contract ? ` (${futuresDay.contract})` : ''} · {effectiveDate} {asOf && `· ${asOf}`}
                {(dayCount > 1 || profileOf === 'previous') && (coverText ? ` · profile of ${coverText}` : '')}
                {loadingPast && ` · loading sessions… ${usedPast.length} of ${pastCount}`}
                {!loadingPast && pastCount > usedPast.length && ` · only ${usedPast.length} earlier session${usedPast.length === 1 ? '' : 's'} found`}
              </Text>
              {estimated && <Tag color="orange" style={{ margin: 0 }}>futures {dayCount > 1 ? 'of some days ' : ''}estimated from 1-minute candles</Tag>}
              {(futures.loading || spot.loading) && <Tag style={{ margin: 0 }}>loading…</Tag>}
            </Space>
            {(futuresPast.error || spotPast.error) && <Alert type="warning" showIcon message={`Not every earlier session could be loaded: ${futuresPast.error ?? spotPast.error}`} />}
          </Space>
        </Card>

        <Text strong style={{ fontSize: 13 }}>Spot · {index} index</Text>
        <ProfilePair {...pair} name="Spot" known={spotKnown} past={spotPast.sessions.slice(-pastCount)} neutral empty={emptyFor(spot, spotSession, spotPast, 'spot')} />
        <Text strong style={{ fontSize: 13 }}>Futures · {futuresDay?.contract ?? `${index} near futures`}</Text>
        <ProfilePair {...pair} name="Futures" known={futuresKnown} past={futuresPast.sessions.slice(-pastCount)} empty={emptyFor(futures, futuresSession, futuresPast, 'futures day')} />
      </Space>
    </div>
  )
}
