import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Row, Segmented, Select, Slider, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { CaretRightOutlined, PauseOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import {
  NavBar, usePersistedState, POLL_HEADERS, UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  toChartTime, istTimeFormatter, istTickMarkFormatter, istDateKey,
} from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { VolumeProfilePrimitive } from './volumeProfilePrimitive.js'
import { TpoProfilePrimitive, ZoneBoxesPrimitive } from './profilePrimitives.js'
import { fetchPreviousSession } from './profiles.js'
import {
  FETCH_ROWS, PROFILE_ROWS, PROFILE_ROW_CHOICES, barsKnownAt, candlesOf, dayMarketProfile, dayVolumeProfile,
  lastPeriodRunningAt, marketProfileZones, volumeZones,
} from './profileZones.js'
import { useFollowReplayClock } from './replaySync.jsx'
import { FoldText } from './FoldText.jsx'

// The Profiles page: a whole page for the volume profile and the market profile (TPO) of an index's near
// futures - one card each, over the futures candles in the timeframe picked, with the profile's levels and
// its ZONES drawn as boxes (profileZones.js):
//   Volume profile - POC, VAH / VAL; boxes where the most volume traded (each with its HVN) and where it was
//     thin (each with its LVN); the profile's bars at the right edge (buy / sell).
//   Market profile - the TPO letters at the right edge (A = 09:15, a letter each 30 minutes); boxes where the
//     market accepted price (the value area and its busiest rows) and where it did not (single prints inside
//     the range, buying / selling tails at its extremes); POC, VAH / VAL and the initial balance.
//
// LIVE (today, refreshed every REFRESH_MS) or a PAST DAY at a clock - and by default it FOLLOWS OI Replay in
// another tab (replaySync.jsx's clock channel, one way): the same index and day, live or at OI Replay's replay
// clock, so the profiles replay along with it. Nothing after the clock is in either profile (barsKnownAt).
// The data is the Order Flow server's futures day (footprint rows - the buy and sell at each price), the same
// the Order Flow page replays; a past day the server did not record comes estimated from 1-minute candles.

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
  follow: 'optionanalytics.profiles.followOiReplay',
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

// ---- data ------------------------------------------------------------------------------------------------

/** The futures day from the Order Flow server, in the footprint's own rows; live, refreshed every REFRESH_MS
 *  (a page timer - the X-Poll header, so the server keeps it to market hours). */
function useFuturesDay(underlying, dateKey, live) {
  const [state, setState] = useState({ loading: false, error: null, day: null, at: null })
  useEffect(() => {
    if (!underlying || !dateKey) return undefined
    let cancelled = false
    const row = FETCH_ROWS[underlying] ?? 1
    setState((s) => ({ loading: true, error: null, day: s.day?.key === `${underlying}|${dateKey}` ? s.day : null, at: s.at }))
    const load = (poll) => fetch(`/api/order-flow/${underlying}/day/${dateKey}?rowSize=${row}&minTradeLots=100000&heatmapColumns=50`, poll ? { headers: POLL_HEADERS } : undefined)
      .then((r) => (r.ok ? r.json() : r.json().catch(() => ({})).then((b) => Promise.reject(new Error(b?.error ?? `HTTP ${r.status}`)))))
      .then((body) => {
        if (cancelled) return
        setState({ loading: false, error: null, at: Date.now(), day: { key: `${underlying}|${dateKey}`, bars: body.bars ?? [], source: body.source, contract: body.meta?.contractSymbol, lastPrice: body.meta?.lastPrice } })
      })
      .catch((err) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: err.message })) })
    load(false)
    const id = live ? setInterval(() => load(true), REFRESH_MS) : null
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [underlying, dateKey, live])
  return state
}

/** The trading day before `dateKey` (a week back at most), only while it is asked for. */
function usePreviousSession(underlying, dateKey, wanted) {
  const [state, setState] = useState({ loading: false, day: null })
  useEffect(() => {
    if (!wanted || !underlying || !dateKey) return undefined
    let cancelled = false
    setState({ loading: true, day: null })
    fetchPreviousSession(underlying, dateKey, FETCH_ROWS[underlying] ?? 1)
      .then((day) => { if (!cancelled) setState({ loading: false, day }) })
      .catch(() => { if (!cancelled) setState({ loading: false, day: null }) })
    return () => { cancelled = true }
  }, [underlying, dateKey, wanted])
  return state
}

// ---- the chart -------------------------------------------------------------------------------------------

/** Futures candles with a profile drawn at the right edge (`drawProfile(primitive)` sets it), zone boxes and
 *  price lines. The time axis keeps `room` of the plot empty on the right, so the newest candles never sit
 *  under the profile; wheel / drag take over the view, a double-click hands it back. */
function ProfileChart({ candles, makePrimitive, drawProfile, zones, lines, priceRange, room, height = CHART_HEIGHT, resetKey }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
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

// ---- the page --------------------------------------------------------------------------------------------

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

export default function ProfilesPage() {
  const [underlying, setUnderlying] = usePersistedState(STORE.underlying, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORE.timeframe, 5)
  const [rows, setRows] = usePersistedState(STORE.rows, PROFILE_ROWS)
  const [profileOf, setProfileOf] = usePersistedState(STORE.of, 'today')
  const [follow, setFollow] = usePersistedState(STORE.follow, true)
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
  const futures = useFuturesDay(index, effectiveDate, live)
  const previous = usePreviousSession(index, effectiveDate, profileOf === 'previous')
  const day = futures.day?.key === `${index}|${effectiveDate}` ? futures.day : null

  // The span a past day's own slider runs over: the first minute's start to the last minute's end.
  const sessionBars = useMemo(() => barsKnownAt(day?.bars, null), [day])
  const span = sessionBars.length ? { start: new Date(sessionBars[0].time).getTime() + 60_000, end: new Date(sessionBars.at(-1).time).getTime() + 60_000 } : null
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

  const known = useMemo(() => barsKnownAt(day?.bars, clock), [day, clock])
  const profileBars = useMemo(
    () => (profileOf === 'previous' ? barsKnownAt(previous.day?.bars, null) : known),
    [profileOf, previous.day, known],
  )
  const candles = useMemo(() => candlesOf(known, timeframe), [known, timeframe])

  const vp = useMemo(() => dayVolumeProfile(profileBars, row), [profileBars, row])
  const vz = useMemo(() => volumeZones(vp, row), [vp, row])
  const tpo = useMemo(() => dayMarketProfile(profileBars, row), [profileBars, row])
  const running = profileOf === 'today' && lastPeriodRunningAt(known, clock)
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

  const vpRange = useMemo(() => (vp.rows.length ? { low: vp.rows[0].price, high: vp.rows.at(-1).price + row } : null), [vp, row])
  const tpoRange = useMemo(() => (tpo?.rows?.length ? { low: tpo.rows[0].price, high: tpo.rows.at(-1).price + row } : null), [tpo, row])
  const drawVp = useCallback((p) => p.setProfile(vp.rows.length ? vp : null, row), [vp, row])
  const singlePrices = useMemo(() => {
    const set = []
    for (const z of [...mz.singles, ...mz.tails]) for (let p = z.low; p < z.high - 1e-9; p = Math.round((p + row) * 100) / 100) set.push(p)
    return set
  }, [mz, row])
  const drawTpo = useCallback((p) => p.setProfile(tpo, singlePrices), [tpo, singlePrices])
  const makeVp = useCallback(() => new VolumeProfilePrimitive(), [])
  const makeTpo = useCallback(() => new TpoProfilePrimitive(), [])
  const resetKey = `${index}|${effectiveDate}|${timeframe}|${profileOf}`

  const profileDate = profileOf === 'previous' ? previous.day?.date : effectiveDate
  const estimated = profileOf === 'previous' ? previous.day?.source === 'estimated' : day?.source === 'estimated'
  const asOf = live ? (futures.at ? `live · updated ${new Date(futures.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}` : 'live') : clock ? `as of ${fmtClock(clock)}` : ''
  const noData = !futures.loading && day && sessionBars.length === 0

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
                <Segmented size="small" value={profileOf} onChange={setProfileOf} options={[{ value: 'today', label: live ? 'Today so far' : 'This day so far' }, { value: 'previous', label: 'Previous session' }]} />
              </Space>
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
                {index} futures{day?.contract ? ` (${day.contract})` : ''} · {effectiveDate} {asOf && `· ${asOf}`}
                {profileOf === 'previous' && (previous.loading ? ' · loading the previous session…' : profileDate ? ` · profile of ${profileDate}` : ' · no previous session found in the last week')}
              </Text>
              {estimated && <Tag color="orange" style={{ margin: 0 }}>estimated from 1-minute candles</Tag>}
              {futures.loading && <Tag style={{ margin: 0 }}>loading…</Tag>}
            </Space>
            {futures.error && <Alert type="warning" showIcon message={`The futures day is not available: ${futures.error}`} />}
            {noData && <Alert type="info" showIcon message={live ? 'No trading today yet - the profiles start with the first minute after 09:15.' : 'No futures minutes for this day.'} />}
          </Space>
        </Card>

        <Row gutter={[14, 14]}>
          <Col xs={24} xl={12}>
            <Card
              size="small"
              title="Volume profile"
              extra={<Text type="secondary" style={{ fontSize: 11 }}>double-click: fit</Text>}
            >
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space size={[12, 2]} wrap style={{ fontSize: 12 }}>
                  <span style={{ color: LINE.poc }}>POC {fmt(vp.poc == null ? null : vp.poc + row / 2)}</span>
                  <span style={{ color: LINE.va }}>VAH {fmt(vp.vah == null ? null : vp.vah + row)} · VAL {fmt(vp.val)}</span>
                  <span style={{ color: BOX.high.labelColor }}>HVN {vz.hvn.length ? vz.hvn.map(fmt).join(', ') : '—'}</span>
                  <span style={{ color: BOX.low.labelColor }}>LVN {vz.lvn.length ? vz.lvn.map(fmt).join(', ') : '—'}</span>
                </Space>
                <Legend items={[['high', 'Highest volume (HVN area)'], ['low', 'Thin volume (LVN area)'], ['value', 'Value area']]} />
                <ProfileChart
                  candles={candles} makePrimitive={makeVp} drawProfile={drawVp} zones={vpZones} lines={vpLines}
                  priceRange={vpRange} room={PROFILE_ROOM.vp} resetKey={resetKey}
                />
                <FoldText id="profiles.vp" label="how to read the volume profile" className="oa-note">
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    The bars at the right are the volume traded at each price ({row}-point rows; green bought at the offer, red sold at the
                    bid). POC = the price that traded the most; VAH / VAL = the band holding 70% of the volume. GREEN boxes are where the
                    most volume traded - prices the market agreed on, which tend to hold price (support / resistance, a magnet when price
                    is near); each names its HVN, its busiest row. RED boxes are where volume was thin inside the range - prices the market
                    moved through fast, which it tends to cross fast again: a break into one often runs to the far side. A thin edge at the
                    day&apos;s high or low is not a box (price only got there briefly). Busy = at least 1.3x the average row, thin = 0.6x or
                    less (smoothed over three rows).
                  </Text>
                </FoldText>
              </Space>
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card
              size="small"
              title="Market profile (TPO)"
              extra={<Text type="secondary" style={{ fontSize: 11 }}>double-click: fit</Text>}
            >
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space size={[12, 2]} wrap style={{ fontSize: 12 }}>
                  <span style={{ color: LINE.poc }}>POC {fmt(tpo ? tpo.poc + row / 2 : null)}</span>
                  <span style={{ color: LINE.va }}>VAH {fmt(tpo ? tpo.vah + row : null)} · VAL {fmt(tpo?.val)}</span>
                  <span style={{ color: LINE.ib }}>IB {tpo?.ib ? `${fmt(tpo.ib.low)} – ${fmt(tpo.ib.high)}` : '—'}</span>
                  <span style={{ color: BOX.single.labelColor }}>Single prints {mz.singles.length ? mz.singles.map((z) => `${fmt(z.low)}–${fmt(z.high)}`).join(', ') : '—'}</span>
                  <span style={{ color: BOX.tail.labelColor }}>Tails {mz.tails.length ? mz.tails.map((z) => `${z.side} ${fmt(z.low)}–${fmt(z.high)}`).join(', ') : '—'}</span>
                </Space>
                <Legend items={[['accepted', 'Most time spent - accepted'], ['acceptedValue', 'Value area'], ['single', 'Single prints'], ['tail', 'Tail (rejected)']]} />
                <ProfileChart
                  candles={candles} makePrimitive={makeTpo} drawProfile={drawTpo} zones={mpZones} lines={mpLines}
                  priceRange={tpoRange} room={PROFILE_ROOM.tpo} resetKey={resetKey}
                />
                <FoldText id="profiles.tpo" label="how to read the market profile" className="oa-note">
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Each letter at the right is a 30-minute period that traded at that price ({row}-point rows): A = 09:15, B = 09:45, C =
                    10:15 and so on (A and B, the initial balance, in amber; blocks instead of letters when the rows are too thin to read).
                    The more letters on a row, the more TIME the market spent there. TEAL boxes are where it spent the most - prices it
                    accepted (the busiest rows, with the value area, 70% of the TPOs, as a dashed frame): expect rotation there. ORANGE boxes
                    are single prints inside the range - one period only, a fast one-sided move; price often comes back to fill them, and
                    they act as support / resistance until it does. MAGENTA boxes are tails - single prints at the day&apos;s high (selling
                    tail) or low (buying tail), where the auction was rejected. &quot;Forming&quot; = made by the period still running: it
                    can still be filled in.
                  </Text>
                </FoldText>
              </Space>
            </Card>
          </Col>
        </Row>
      </Space>
    </div>
  )
}
