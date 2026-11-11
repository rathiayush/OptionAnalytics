import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Segmented, Select, Space, Tag, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, POLL_HEADERS, UP_COLOR, fromChartTime, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useChartUserControl } from './oiShared.jsx'
import { useChartHeight, useFitHeight } from './DashboardCard.jsx'
import { FoldText } from './FoldText.jsx'
import { DeltaProfilePrimitive, PANEL_SHARE } from './deltaProfilePrimitive.js'
import { OPTION_DELTA_SIDES, barsUpTo, deltaProfileLevels, futuresDeltaProfileOf, optionDeltaMinutes, optionDeltaProfileOf, rowAt } from './deltaProfile.js'
import { PREV_PROFILE } from './profileColors.js'
import { EXTRA_WEEKDAYS, cachedDay, footprintBars, loadFuturesDay, loadOptionDay, optionDayKey, walkPastSessions } from './deltaProfileDays.js'
import { MAX_PROFILE_DAYS, PROFILE_ROWS, PROFILE_ROW_CHOICES, pastSessionsNeeded, profileSessions } from './profileZones.js'
import { PAPER_TRADE_LOT_SIZE } from './scannerCore.js'

// OI Replay's two DELTA PROFILE cards (asked for - "like volume profile and market profile we need to build delta profile:
// the delta profile of option data on the spot chart, and also on the futures chart - add two more components on OI
// Replay"): the candles with, at the right, how much traded at each price (VOLUME) and who was the aggressor there
// (DELTA - buyers minus sellers) - deltaProfile.js works them out, deltaProfilePrimitive.js draws them. Both follow the
// replay clock (nothing after it) and live. "Previous day" / "Days" (asked for - "a checkbox to see the previous day's
// delta, and N days too"): the profile of the sessions before the day, or the day so far with the N - 1 before it - a
// composite - over the day's candles (deltaProfileDays.js loads them).

const { Text } = Typography
const TIMEFRAMES = [1, 3, 5, 15]
// The fewest candle widths the time axis spans - early in a replay one candle is not drawn a fifth of the chart wide.
const MIN_SPAN = 30
// Lots, compact: 1.2K, 3.4L (lakh), 1.1Cr - a delta signed.
function lots(v, signed = false) {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a < 0.5) return '0'
  const text = a >= 1e7 ? `${(a / 1e7).toFixed(2)}Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(2)}L` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : `${Math.round(a)}`
  return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}${text}`
}
const NONE = []
const deltaColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const price = (v) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—')

// 1-minute candles (chart time) into `minutes`-minute candles.
function candlesOf(bars, minutes) {
  if (!(minutes > 1)) return bars
  const size = minutes * 60
  const out = []
  for (const b of bars) {
    const t = Math.floor(b.time / size) * size
    const last = out.at(-1)
    if (last?.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close })
  }
  return out
}

// The volume profile's levels drawn as price lines (asked for - "draw the volume profile's LVN, HVN, POC, VAL, VAH as
// well"), as the Profiles page and OI Replay's entry charts draw theirs: POC solid, VAH / VAL dashed, ONE HVN and ONE LVN
// dotted - each labelled on the price axis. Across the candles; the profile's panel stands over them on the right.
const LEVEL_LINES = [
  { key: 'poc', title: 'POC', color: PREV_PROFILE.poc, width: 2, style: 0 },
  { key: 'vah', title: 'VAH', color: PREV_PROFILE.va, width: 1, style: 2 },
  { key: 'val', title: 'VAL', color: PREV_PROFILE.va, width: 1, style: 2 },
  { key: 'hvn', title: 'HVN', color: PREV_PROFILE.hvn, width: 1, style: 1 },
  { key: 'lvn', title: 'LVN', color: PREV_PROFILE.lvn, width: 1, style: 1 },
]

/** The candles and the profile beside them, `levels` (deltaProfileLevels - null: no lines) as price lines.
 *  `onHover(price | null)` - the price under the crosshair. */
function DeltaProfileChart({ candles, profile, levels = null, dayKey, onHover, height: givenHeight = 380 }) {
  const height = useFitHeight(givenHeight)
  const heightRef = useRef(height)
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const primitiveRef = useRef(null)
  const hoverRef = useRef(onHover)
  useEffect(() => { hoverRef.current = onHover })
  // The profile's price range - the price scale holds it too: the sessions before the day can reach past its candles.
  const rangeRef = useRef(null)
  const linesRef = useRef([])
  useEffect(() => {
    if (!containerRef.current) return undefined
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: heightRef.current,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      autoscaleInfoProvider: (original) => {
        const base = original()
        const r = rangeRef.current
        if (!r) return base
        const lo = Math.min(base?.priceRange?.minValue ?? r.low, r.low)
        const hi = Math.max(base?.priceRange?.maxValue ?? r.high, r.high)
        return { ...(base ?? {}), priceRange: { minValue: lo, maxValue: hi } }
      },
    })
    seriesRef.current = series
    const primitive = new DeltaProfilePrimitive()
    primitiveRef.current = primitive
    series.attachPrimitive(primitive)
    chart.subscribeCrosshairMove((param) => {
      const p = param?.point ? series.coordinateToPrice(param.point.y) : null
      hoverRef.current?.(Number.isFinite(p) ? p : null)
    })
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      primitiveRef.current = null
      linesRef.current = []
    }
  }, [])
  useChartHeight(chartRef, height)
  // Dragged or zoomed: the view is the viewer's until a double-click (or a new day) hands it back.
  const userControlRef = useChartUserControl(chartRef, dayKey)
  useEffect(() => {
    const chart = chartRef.current
    seriesRef.current?.setData(candles)
    if (!chart || !candles.length || userControlRef.current) return
    // The whole day, with the panel's share of the plot left empty on the right - the candles stand beside the profile,
    // not under it - and at least MIN_SPAN candle widths. Set as the options and fitted here: the shared fit reads the
    // visible range back at once, and the chart applies a change a frame later.
    const n = candles.length
    chart.timeScale().applyOptions({ rightOffset: Math.max(Math.round((n * PANEL_SHARE) / (1 - PANEL_SHARE)) + 2, MIN_SPAN - n) })
    chart.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, dayKey])
  useEffect(() => {
    primitiveRef.current?.setProfile(profile)
    const rows = profile?.rows ?? []
    const range = rows.length ? { low: rows[0].price, high: rows.at(-1).price + profile.rowSize } : null
    const old = rangeRef.current
    rangeRef.current = range
    // A new range: fit the prices to it again, unless the viewer took the view.
    if ((old?.low !== range?.low || old?.high !== range?.high) && !userControlRef.current) chartRef.current?.priceScale('right').applyOptions({ autoScale: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const line of linesRef.current) series.removePriceLine(line)
    linesRef.current = LEVEL_LINES.filter((l) => Number.isFinite(levels?.[l.key])).map((l) => series.createPriceLine({
      price: levels[l.key], color: l.color, title: l.title, lineWidth: l.width, lineStyle: l.style, axisLabelVisible: true,
    }))
  }, [levels])
  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// The levels in words, coloured as their lines - with the rows that saw the most buying and selling.
function LevelsLine({ levels, show }) {
  if (!levels) return null
  const at = (v) => price(v)
  return (
    <Space wrap size={[10, 0]} style={{ fontSize: 12 }}>
      {show ? (
        <>
          <span style={{ color: PREV_PROFILE.poc }}>POC {at(levels.poc)}</span>
          <span style={{ color: PREV_PROFILE.va }}>VAH {at(levels.vah)} · VAL {at(levels.val)}</span>
          <span style={{ color: PREV_PROFILE.hvn }}>HVN {at(levels.hvn)}</span>
          <span style={{ color: PREV_PROFILE.lvn }}>LVN {at(levels.lvn)}</span>
        </>
      ) : null}
      <span style={{ color: UP_COLOR }}>most bought {at(levels.buy)}</span>
      <span style={{ color: DOWN_COLOR }}>most sold {at(levels.sell)}</span>
    </Space>
  )
}

// The "Levels" tick (both cards): the volume profile's POC / VAH / VAL / HVN / LVN lines on the chart - on by default.
function useLevelsShown() {
  const [shown, setShown] = usePersistedState('optionanalytics.oiReplay.deltaProfileLevels', true)
  const on = shown !== false
  return [on, <Checkbox key="levels" checked={on} onChange={(e) => setShown(e.target.checked)}>Levels</Checkbox>]
}

// The row under the crosshair, in words.
function HoverLine({ profile, hoverPrice, unit, lotSize, deltaWord }) {
  const row = rowAt(profile, hoverPrice)
  if (!row) return <Text type="secondary" style={{ fontSize: 11 }}>Point at the chart to read a price row.</Text>
  return (
    <Text style={{ fontSize: 12 }}>
      {price(row.price)} – {price(row.price + profile.rowSize)}: volume {lots(row.volume / lotSize)} {unit} · {deltaWord}{' '}
      <Text strong style={{ fontSize: 12, color: deltaColor(row.delta) }}>{lots(row.delta / lotSize, true)}</Text>
      {row.price === profile.poc ? <Tag color="gold" style={{ marginLeft: 6 }}>POC</Tag> : null}
    </Text>
  )
}

function useRowSize(underlying) {
  const [rows, setRows] = usePersistedState('optionanalytics.oiReplay.deltaProfileRows', PROFILE_ROWS)
  const choices = PROFILE_ROW_CHOICES[underlying] ?? [5]
  const row = choices.includes(rows?.[underlying]) ? rows[underlying] : PROFILE_ROWS[underlying] ?? choices[0]
  const select = (
    <Tooltip title="Points a price row">
      <Select size="small" value={row} onChange={(v) => setRows({ ...(rows ?? PROFILE_ROWS), [underlying]: v })} style={{ width: 82 }}
        options={choices.map((r) => ({ value: r, label: `${r} pts` }))} aria-label="Row size" />
    </Tooltip>
  )
  return [row, select]
}

const IDLE = { loading: false, sessions: NONE, error: null }

/**
 * The `count` sessions before `dateKey` of `kind` ('options' - of the `flag` series - or 'futures'), oldest first, as they
 * come in: { loading, sessions [{ date, items, candles }], error: { date, message } | null, retry }. `count` 0 = none.
 */
function usePastDeltaSessions(kind, underlying, dateKey, count, flag = '') {
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  const want = count > 0 && underlying && dateKey ? `${kind}|${underlying}|${flag}|${dateKey}|${count}|${attempt}` : null
  const [state, setState] = useState({ key: null, ...IDLE })
  useEffect(() => {
    if (!want) return undefined
    let cancelled = false
    // Until the walk's first session the hook answers "loading" for this key (state.key differs) - nothing to set here.
    const load = kind === 'options'
      ? (date) => cachedDay(optionDayKey(underlying, flag, date), () => loadOptionDay(underlying, date, flag))
      : (date) => cachedDay(`futures|${underlying}|${date}`, () => loadFuturesDay(underlying, date))
    walkPastSessions(dateKey, count, load, {
      cancelled: () => cancelled,
      onSession: (sessions) => { if (!cancelled) setState({ key: want, loading: true, sessions, error: null }) },
    }).then(({ sessions, error }) => { if (!cancelled) setState({ key: want, loading: false, sessions, error }) })
    return () => { cancelled = true }
  }, [want]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!want) return { ...IDLE, retry }
  return state.key === want ? { loading: state.loading, sessions: state.sessions, error: state.error, retry } : { loading: true, sessions: NONE, error: null, retry }
}

// "Previous day" / "Days" of one card (kept per card): unticked = the day so far and the N - 1 sessions before it,
// ticked = the N sessions before the day (profileSessions - the Profiles page's own rule). 1 day, unticked = the day alone.
const DAY_CHOICES = Array.from({ length: MAX_PROFILE_DAYS }, (_, i) => i + 1)
function useSessionChoice(id) {
  const [prev, setPrev] = usePersistedState(`optionanalytics.oiReplay.${id}Prev`, false)
  const [days, setDays] = usePersistedState(`optionanalytics.oiReplay.${id}Days`, 1)
  const dayCount = DAY_CHOICES.includes(days) ? days : 1
  const of = prev === true ? 'previous' : 'today'
  const control = (
    <Space size={6} align="center">
      <Checkbox checked={of === 'previous'} onChange={(e) => setPrev(e.target.checked)}>{dayCount > 1 ? 'Previous days' : 'Previous day'}</Checkbox>
      <Select size="small" value={dayCount} onChange={setDays} style={{ width: 88 }} aria-label="Days in the profile"
        options={DAY_CHOICES.map((n) => ({ value: n, label: n === 1 ? '1 day' : `${n} days` }))} />
    </Space>
  )
  return { of, dayCount, pastCount: pastSessionsNeeded(dayCount, of), control }
}

const dayText = (d) => dayjs(d).format('DD MMM')
// What the profile is of, the days before still loading, a day that could not be loaded (Retry) - nothing for the day alone.
function SessionsLine({ choice, past, dates, standIn }) {
  if (choice.of === 'today' && choice.dayCount === 1) return null
  const found = past.sessions.length
  const cover = dates.length ? (dates.length === 1 ? dayjs(dates[0]).format('ddd DD MMM YYYY') : `${dayText(dates[0])} – ${dayjs(dates.at(-1)).format('DD MMM YYYY')} (${dates.length} sessions)`) : null
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {cover ? <>Profile of {cover}</> : null}
        {past.loading ? `${cover ? ' · ' : ''}loading the days before… ${found} of ${choice.pastCount}` : null}
        {!past.loading && !past.error && found < choice.pastCount ? ` · only ${found} session${found === 1 ? '' : 's'} found in the ${choice.pastCount + EXTRA_WEEKDAYS} weekdays before` : null}
        {standIn ? ` · no minute of the day yet - the candles are ${dayjs(standIn.date).format('DD MMM')}'s` : null}
      </Text>
      {past.error ? (
        <Alert type="warning" showIcon style={{ padding: '4px 8px' }}
          message={`Could not load ${dayjs(past.error.date).format('DD MMM YYYY')}: ${past.error.message}`}
          action={<Button size="small" onClick={past.retry}>Retry</Button>} />
      ) : null}
    </Space>
  )
}

// The day's candles, or - none of the day yet (live before the open) - the latest session before it as a stand-in, so the
// profile has a price scale to stand on.
function useCandles(dayBars, past, timeframe) {
  const standIn = !dayBars?.length && past.sessions.length ? past.sessions.at(-1) : null
  const candles = useMemo(() => {
    const bars = standIn ? standIn.candles.map((b) => ({ time: toChartTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })) : dayBars ?? NONE
    return candlesOf(bars, TIMEFRAMES.includes(timeframe) ? timeframe : 5)
  }, [dayBars, standIn, timeframe])
  return { candles, standIn }
}

/**
 * The OPTIONS' delta profile on the SPOT chart: `cePoints` / `pePoints` (the run's option bars, live ones added),
 * `spotBars` (the page's 1-minute spot bars in chart time, up to the clock), `asOfMs` (the clock), `underlying`, `date`
 * (the day shown, YYYY-MM-DD), `expiryFlag` (the run's series - the days before are of the same), `dayKey`.
 */
export function OptionDeltaProfileCard({ cePoints, pePoints, spotBars, asOfMs, underlying, date, expiryFlag, dayKey }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.oiReplay.optionDeltaTf', 5)
  const [side, setSide] = usePersistedState('optionanalytics.oiReplay.optionDeltaSide', 'net')
  const shownSide = OPTION_DELTA_SIDES.some((s) => s.value === side) ? side : 'net'
  const [rowSize, rowSelect] = useRowSize(underlying)
  const choice = useSessionChoice('optionDelta')
  const flag = expiryFlag || (underlying === 'BANKNIFTY' ? 'MONTH' : 'WEEK')
  const past = usePastDeltaSessions('options', underlying, date, choice.pastCount, flag)
  const [hover, setHover] = useState(null)
  const lotSize = PAPER_TRADE_LOT_SIZE[underlying] ?? 1
  const spotMs = useMemo(() => (spotBars ?? []).map((b) => ({ time: fromChartTime(b.time) * 1000, open: b.open, high: b.high, low: b.low, close: b.close })), [spotBars])
  const todayMinutes = useMemo(() => (choice.of === 'previous' ? NONE : optionDeltaMinutes(cePoints, pePoints, spotMs, { asOfMs })), [cePoints, pePoints, spotMs, asOfMs, choice.of])
  const sessions = useMemo(() => profileSessions({ today: todayMinutes, past: past.sessions.map((d) => d.items), days: choice.dayCount, of: choice.of }), [todayMinutes, past.sessions, choice.dayCount, choice.of])
  const profile = useMemo(() => optionDeltaProfileOf(sessions, { rowSize, side: shownSide }), [sessions, rowSize, shownSide])
  const levels = useMemo(() => deltaProfileLevels(profile), [profile])
  const [levelsOn, levelsTick] = useLevelsShown()
  const dates = [...past.sessions.map((d) => d.date), ...(choice.of === 'today' && todayMinutes.length ? [date] : [])]
  const { candles, standIn } = useCandles(spotBars, past, timeframe)
  const deltaWord = shownSide === 'net' ? 'net Δ (+ bullish)' : `${shownSide.toUpperCase()} Δ (+ bought)`
  const soFar = choice.of === 'today' && choice.dayCount === 1
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Space wrap size={[8, 6]} align="center">
        <Segmented size="small" value={shownSide} onChange={setSide} options={OPTION_DELTA_SIDES} />
        <Segmented size="small" value={timeframe} onChange={setTimeframe} options={TIMEFRAMES.map((v) => ({ value: v, label: `${v}m` }))} />
        {rowSelect}
        {choice.control}
        {levelsTick}
      </Space>
      <SessionsLine choice={choice} past={past} dates={dates} standIn={standIn} />
      {profile.rows.length && candles.length ? (
        <>
          <Text style={{ fontSize: 12 }}>
            Net Δ{soFar ? ' so far' : ''} <Text strong style={{ fontSize: 12, color: deltaColor(profile.totals.net) }}>{lots(profile.totals.net / lotSize, true)}</Text> lots
            {' '}(CE <span style={{ color: deltaColor(profile.totals.ce) }}>{lots(profile.totals.ce / lotSize, true)}</span> · PE{' '}
            <span style={{ color: deltaColor(-profile.totals.pe) }}>{lots(profile.totals.pe / lotSize, true)}</span>) · POC {price(levels?.poc ?? profile.poc)}
          </Text>
          <LevelsLine levels={levels} show={levelsOn} />
          <DeltaProfileChart candles={candles} profile={profile} levels={levelsOn ? levels : null} dayKey={`${dayKey}|${rowSize}|${shownSide}|${choice.of}|${choice.dayCount}`} onHover={setHover} />
          <HoverLine profile={profile} hoverPrice={hover} unit="lots" lotSize={lotSize} deltaWord={deltaWord} />
        </>
      ) : past.loading ? <Text type="secondary">Loading the days before…</Text>
        : <Alert type="info" showIcon message={choice.of === 'previous' ? 'No option bars with volume in the sessions before this day.' : 'No option bars with volume up to this minute yet.'} />}
      <FoldText id="oiReplay.optionDeltaProfile" label="how to read this" className="oa-note">
        <Text type="secondary" style={{ fontSize: 12 }}>
          The spot candles with, at the right, the OPTIONS&apos; flow laid on the spot price rows they traded at: VOLUME = the
          CE + PE volume of every strike loaded (ATM ± 10) in the minutes spot spent in that row, DELTA = buyers minus sellers
          there. Options carry no trade-by-trade side, so each strike&apos;s 1-minute bar gives one as the dashboard&apos;s
          Option CDV does - from where its close sits in its range - and each strike counts by its delta at that minute&apos;s
          spot (near ATM nearly in full, far out of the money barely), in lots. NET = CE Δ − PE Δ: green = calls bought / puts
          sold at that spot level (bullish), red = puts bought / calls sold (bearish); CE or PE alone shows that side&apos;s own
          buying (+) and selling (−). The amber row is the POC - where the most option volume traded - and its band across the
          candles; the value area&apos;s bars are brighter. Only the minutes up to the replay clock count; live, as they trade.
          DAYS: the day so far with the sessions before it added up (a composite - where the option flow sat over several
          days); &quot;Previous day&quot; ticked = the sessions BEFORE the day only (each its own expiry&apos;s options, as
          its replay shows them), drawn over the day&apos;s candles - yesterday&apos;s delta levels against today&apos;s price.
          A day not loaded before comes from the server&apos;s disk, or Dhan once. LEVELS: the volume profile&apos;s POC
          (solid), VAH / VAL (dashed - the value area, 70% of the volume) and ONE HVN / LVN (dotted - the busiest row of
          the busy areas beside the POC, the thinnest of the thin areas inside the range), as the Profiles page draws them;
          &quot;most bought / sold&quot; = the rows with the largest buying / selling. The Signal backtest reads the same levels.
        </Text>
      </FoldText>
    </Space>
  )
}

// The futures' Order Flow day with its footprint (buy / sell at each price, in lots), the minutes it did not record filled
// from its estimate - loaded once, live again every minute (a page timer - POLL_HEADERS). `date` null = not wanted.
function useFuturesFootprintDay(underlying, date, isLive, rowSize) {
  const [state, setState] = useState({ key: null, bars: NONE, error: null })
  const key = `${underlying}|${date}|${rowSize}`
  useEffect(() => {
    if (!underlying || !date) return undefined
    let cancelled = false
    const load = (poll) => fetch(`/api/order-flow/${underlying}/day/${date}?rowSize=${rowSize}&minTradeLots=100000&heatmapColumns=50&backfillBars=true`, poll ? { headers: POLL_HEADERS } : undefined)
      .then((r) => (r.ok ? r.json() : r.json().catch(() => null).then((b) => Promise.reject(new Error(b?.error ?? `HTTP ${r.status}`)))))
      .then((body) => { if (!cancelled) setState({ key, bars: footprintBars(body), error: null }) })
      .catch((err) => { if (!cancelled) setState((s) => (s.key === key ? { ...s, error: err.message } : { key, bars: NONE, error: err.message })) })
    load(false)
    const id = isLive ? setInterval(() => load(true), 60_000) : null
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [underlying, date, isLive, rowSize, key])
  if (!date) return { key, bars: NONE, error: null }
  return state.key === key ? state : { key, bars: NONE, error: null, loading: true }
}

/**
 * The FUTURES' delta profile: the footprint's buy and sell at each price (the Order Flow server's), on the futures
 * candles - `futuresBars` (the page's 1-minute futures bars in chart time, up to the clock), `asOfMs`, `underlying`,
 * `date` (the day shown), `isLive`, `dayKey`.
 */
export function FuturesDeltaProfileCard({ futuresBars, asOfMs, underlying, date, isLive, dayKey }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.oiReplay.futuresDeltaTf', 5)
  const [rowSize, rowSelect] = useRowSize(underlying)
  const choice = useSessionChoice('futuresDelta')
  const past = usePastDeltaSessions('futures', underlying, date, choice.pastCount)
  const [hover, setHover] = useState(null)
  const day = useFuturesFootprintDay(underlying, choice.of === 'previous' ? null : date, isLive, rowSize)
  const todayBars = useMemo(() => (choice.of === 'previous' ? NONE : barsUpTo(day.bars, asOfMs)), [day.bars, asOfMs, choice.of])
  const sessions = useMemo(() => profileSessions({ today: todayBars, past: past.sessions.map((d) => d.items), days: choice.dayCount, of: choice.of }), [todayBars, past.sessions, choice.dayCount, choice.of])
  const profile = useMemo(() => futuresDeltaProfileOf(sessions, { rowSize }), [sessions, rowSize])
  const levels = useMemo(() => deltaProfileLevels(profile), [profile])
  const [levelsOn, levelsTick] = useLevelsShown()
  const dates = [...past.sessions.map((d) => d.date), ...(choice.of === 'today' && todayBars.length ? [date] : [])]
  const { candles, standIn } = useCandles(futuresBars, past, timeframe)
  const soFar = choice.of === 'today' && choice.dayCount === 1
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Space wrap size={[8, 6]} align="center">
        <Segmented size="small" value={timeframe} onChange={setTimeframe} options={TIMEFRAMES.map((v) => ({ value: v, label: `${v}m` }))} />
        {rowSelect}
        {choice.control}
        {levelsTick}
        {profile.estimatedMinutes > 0 && (
          <Tooltip title="Minutes the server did not record live (a restart, or a day older than the 30 it keeps): their buy / sell is an estimate from Dhan's 1-minute candles, spread over the candle's range.">
            <Tag color="orange" style={{ margin: 0 }}>{profile.estimatedMinutes === profile.minutes ? 'estimated from 1-min candles' : `${profile.estimatedMinutes} of ${profile.minutes} min estimated`}</Tag>
          </Tooltip>
        )}
      </Space>
      <SessionsLine choice={choice} past={past} dates={dates} standIn={standIn} />
      {day.error && !day.bars.length ? <Alert type="warning" showIcon message="The futures footprint is not available" description={day.error} /> : null}
      {profile.rows.length && candles.length ? (
        <>
          <Text style={{ fontSize: 12 }}>
            Δ{soFar ? ' so far' : ''} <Text strong style={{ fontSize: 12, color: deltaColor(profile.delta) }}>{lots(profile.delta, true)}</Text> lots · volume {lots(profile.volume)} lots · POC {price(levels?.poc ?? profile.poc)}
          </Text>
          <LevelsLine levels={levels} show={levelsOn} />
          <DeltaProfileChart candles={candles} profile={profile} levels={levelsOn ? levels : null} dayKey={`${dayKey}|${rowSize}|${choice.of}|${choice.dayCount}`} onHover={setHover} />
          <HoverLine profile={profile} hoverPrice={hover} unit="lots" lotSize={1} deltaWord="Δ" />
        </>
      ) : day.loading || past.loading ? <Text type="secondary">{past.loading && !day.loading ? 'Loading the days before…' : 'Loading the futures footprint…'}</Text>
        : !day.error ? <Text type="secondary">{choice.of === 'previous' ? 'No futures footprint in the sessions before this day.' : 'No futures footprint up to this minute yet.'}</Text> : null}
      <FoldText id="oiReplay.futuresDeltaProfile" label="how to read this" className="oa-note">
        <Text type="secondary" style={{ fontSize: 12 }}>
          The near futures&apos; candles with, at the right, the day&apos;s footprint added up by price row: VOLUME = the lots
          traded there, DELTA = bought at the ask minus sold at the bid (the Order Flow server reads each trade&apos;s aggressor
          side from Dhan&apos;s feed). Green = buyers lifted the offer there, red = sellers hit the bid there - heavy volume met
          by red is a level sellers defended, by green one buyers did. The amber row is the POC - the big volume node - and its
          band across the candles; the value area&apos;s bars are brighter. Only the minutes up to the replay clock count;
          live, read again each minute. Minutes the server did not record live are estimated from 1-minute candles (tagged).
          DAYS: the day so far with the sessions before it added up (a composite - the levels several days defended);
          &quot;Previous day&quot; ticked = the sessions BEFORE the day only (each day&apos;s own near futures), drawn over the
          day&apos;s candles - yesterday&apos;s delta levels against today&apos;s price. The server keeps about a year (252 trading days) of
          what it recorded; an older day is its estimate from 1-minute candles. LEVELS: the volume profile&apos;s POC (solid), VAH /
          VAL (dashed) and ONE HVN / LVN (dotted), as the Profiles page draws them; &quot;most bought / sold&quot; = the rows
          with the largest buying / selling.
        </Text>
      </FoldText>
    </Space>
  )
}
