import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { Alert, Button, Card, Checkbox, Col, DatePicker, Empty, InputNumber, Row, Select, Slider, Space, Switch, Tag, TimePicker, Tooltip, Typography, notification } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'
import * as signalR from '@microsoft/signalr'
import {
  NavBar, TIMEFRAME_OPTIONS, usePersistedState, RECONNECT_RETRY_POLICY, onLiveBatch, syncSignalRGroups, joinAllSignalRGroups,
  checkForNewDeploy, UP_COLOR, DOWN_COLOR, AXIS_COLOR, useAuth } from './shared.jsx'
import { aggregateBars, analyzeBars, findWalls, replayView, replayRange, liquiditySignals, orderFlowBias, aggression, sweepSignals, pullStackSignals, autoBigLots, liquidityMap, heatmapFetchRow, rebucketColumns, rowsNest } from './orderFlowMath.js'
import { TapeCard } from './OrderFlowTape.jsx'
import { StrategyScanner } from './StrategyScanner.jsx'
import { useDayOi } from './useDayOi.js'
import { oiBiasParts, oiSummary, suddenOiWalls, vwapOf } from './strategyEngine.js'
import { suddenWallText } from './suddenOi.js'
import { chime, speak, telegram } from './alerts.js'
import { LiquidityMapCard } from './LiquidityMap.jsx'
import { alignToBars, sessionVwapFromBars } from './chartVwap.js'
import { ProfilesCard } from './ProfilesCard.jsx'
import { PriceAlertsBar, usePriceAlerts } from './PriceAlerts.jsx'
import { ProfileAlertsBar, usePreviousSpotProfile, useProfileAlerts } from './ProfileAlerts.jsx'
import { ServerScannerCard } from './ServerScanner.jsx'
import { fetchPreviousSession, sessionVolumeProfile, tpoProfile, tpoRowFor } from './profiles.js'
import { withBackfill } from './cvdBackfill.js'
import { TAPE_PRINTS, applyOrderFlowPush, mergePrints, orderFlowFromSnapshot, toColumn, withFineHeatmap } from './liveFeeds.js'
import { FootprintChart, DepthHeatmap, CumulativeDeltaChart, BookLadder, formatVolume } from './OrderFlowCharts.jsx'
import { DomDrawer, useNarrow } from './DomDrawer.jsx'
import { useReplaySync, useReplaySyncEnabled, ReplaySyncControl, withSpeedOption, SYNC_DRIFT_MS } from './replaySync.jsx'

const { Title, Text } = Typography

// Order Flow - footprint (bid x ask), delta / cumulative delta, stacked imbalances, absorption,
// exhaustion, the depth heatmap, icebergs and big orders for a FUTURES contract (the nearest by
// default, or any listed one), live from Dhan's tick feed and market depth (200 levels where Dhan
// offers it). See OrderFlowEngine on the server for how trades and their aggressor side are inferred,
// and orderFlowMath.js for the analysis.
//
// Like the OI Replay: Go Live follows the contract live; pick a date and Load day to replay it. A day
// the server saw live (today, or the last few days in its memory) replays EXACTLY - footprint,
// heatmap, prints, icebergs and book as they were known at the replay clock. Any other day is
// ESTIMATED from Dhan's 1-minute candles (Dhan has no historical tick or depth data - see
// OrderFlowEstimator on the server) and labelled as such. Sync (replaySync.jsx) keeps the replay in
// step with the OI Replay in another tab.

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const DEFAULT_ROW_SIZES = { NIFTY: 1, BANKNIFTY: 5, SENSEX: 5 }
const ROW_SIZE_OPTIONS = [0.5, 1, 2, 5, 10, 20].map((v) => ({ value: v, label: `${v} pt row` }))
const speedOption = (v) => ({ value: v, label: `${Math.round(v * 10) / 10}x` })
// 30/60/120/240/600 are OI Replay's own speeds (0.5x-10x there = minutes per second), so a synced
// replay runs at exactly the same pace.
const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60, 120, 240, 300, 600].map(speedOption)
const REPLAY_TICK_MS = 200
const REPLAY_HEATMAP_COLUMNS = 1500
// A sudden OI wall is only ALERTED (chime / voice / popup / Telegram) when the strike's OI grew by more than this
// share inside the window; smaller ones are still listed in Signals.
const OI_ALERT_MIN_PCT = 0.2
const ICE_SENT_KEY = 'optionanalytics.orderFlow.iceTelegramSent.v1'
const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
const IST_HHMMSS = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })

// One SignalR connection for the page's lifetime; `group` (the live contract's, or none) follows the
// selection.
function useOrderFlowHub(group, onLive) {
  const [state, setState] = useState('connecting')
  const connectionRef = useRef(null)
  const groupsRef = useRef([])
  const liveRef = useRef(onLive)
  liveRef.current = onLive

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
    connectionRef.current = connection
    onLiveBatch(connection, { orderFlowLive: (payload) => liveRef.current?.(payload) })
    connection.onreconnecting(() => setState('reconnecting'))
    connection.onreconnected(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current); checkForNewDeploy() })
    connection.onclose(() => setState('disconnected'))
    connection.start()
      .then(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current) })
      .catch((err) => { if (err?.name !== 'AbortError') { console.error('Order flow live connection failed:', err); setState('disconnected') } })
    return () => { connectionRef.current = null; connection.stop() }
  }, [])

  useEffect(() => {
    const groups = group ? [group] : []
    syncSignalRGroups(connectionRef.current, groupsRef.current, groups)
    groupsRef.current = groups
  }, [group])

  return state
}

// The combined read: bias, confidence, and what drove it (see orderFlowBias).
function OrderFlowRead({ bias }) {
  const color = bias.bias === 'Bullish' ? UP_COLOR : bias.bias === 'Bearish' ? DOWN_COLOR : AXIS_COLOR
  return (
    <Card size="small" title="Order flow read">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <Text strong style={{ fontSize: 20, color }}>{bias.bias}</Text>
        <Text type="secondary">{bias.parts.length ? `${bias.confidence}% confidence · score ${bias.score > 0 ? '+' : ''}${bias.score}` : 'not enough data yet'}</Text>
      </div>
      {bias.parts.map((p) => (
        <div key={p.name} style={{ display: 'grid', gridTemplateColumns: '1fr 70px', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 3 }}>
          <span>
            {p.name} <Text type="secondary" style={{ fontSize: 11 }}>· {p.detail}</Text>
          </span>
          <span style={{ position: 'relative', height: 8, background: '#ffffff12', borderRadius: 4 }}>
            <span style={{
              position: 'absolute', top: 0, bottom: 0, borderRadius: 4, background: p.score >= 0 ? UP_COLOR : DOWN_COLOR,
              left: p.score >= 0 ? '50%' : `${50 + p.score * 50}%`, width: `${Math.abs(p.score) * 50}%`,
            }} />
            <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: AXIS_COLOR }} />
          </span>
        </div>
      ))}
      <Text type="secondary" style={{ fontSize: 10 }}>
        Weighted: cumulative delta 30, options OI over the whole chain 25 (since open 15 + last 15 min 10: put vs call writing, PCR), futures OI 20 (since open 10 + 15 min 10: build-up / covering / unwinding), recent delta 15, stacked imbalances 15, absorption/exhaustion 15, aggression 15, liquidity signals 15, big orders 10, sweeps 10, pulling/stacking 10 - over the parts that have data. Confidence rises when they agree. A read, not advice.
      </Text>
    </Card>
  )
}

// What every mark on the footprint means.
function FootprintLegend({ estimated, bigLabel }) {
  const item = (swatch, label) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 14, whiteSpace: 'nowrap' }}>{swatch}{label}</span>
  )
  const box = (bg, border) => <span style={{ width: 12, height: 10, background: bg, border: border ? `1.5px solid ${border}` : 'none', borderRadius: 2 }} />
  const pill = (bg, text) => <span style={{ background: bg, color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '0 4px', lineHeight: '14px' }}>{text}</span>
  const dot = (color, size) => <span style={{ width: size, height: size, borderRadius: '50%', background: `${color}cc`, border: '1.5px solid #fff' }} />
  return (
    <div style={{ fontSize: 11, color: AXIS_COLOR, marginBottom: 6, lineHeight: '20px' }}>
      {item(box('#ef535055'), 'bid (sell) volume')}
      {item(box('#26a69a55'), 'ask (buy) volume')}
      {!estimated && item(box('#26a69a', null), 'buy imbalance')}
      {!estimated && item(box('#ef5350', null), 'sell imbalance')}
      {!estimated && item(box('#8e44d6', null), 'stacked sell imbalance (bid side)')}
      {!estimated && item(box('#f2f2f2', null), 'stacked buy imbalance (ask side)')}
      {!estimated && item(box('transparent', '#f5c542'), 'POC (most traded)')}
      {item(pill(UP_COLOR, 'ABS'), 'absorption')}
      {item(pill('#9254de', 'EXH'), 'exhaustion')}
      {item(<span style={{ display: 'inline-flex', gap: 2 }}>{dot(UP_COLOR, 9)}{dot(DOWN_COLOR, 13)}</span>, `${bigLabel} (size = quantity)`)}
      {item(<span style={{ fontWeight: 700 }}>Δ / ΣΔ</span>, 'delta / cumulative delta under each bar')}
    </div>
  )
}

const todayKey = () => dayjs().format('YYYY-MM-DD')

async function fetchJson(url) {
  const r = await fetch(url)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status})`)
  return body
}

export default function OrderFlowPage() {
  const [underlying, setUnderlying] = usePersistedState('optionanalytics.orderFlow.underlying', 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.orderFlow.timeframe', 1)
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.orderFlow.rowSizes', DEFAULT_ROW_SIZES)
  const [imbalanceRatio, setImbalanceRatio] = usePersistedState('optionanalytics.orderFlow.imbalanceRatio', 3)
  const [stackedCount, setStackedCount] = usePersistedState('optionanalytics.orderFlow.stackedCount', 3)
  const [largeLots, setLargeLots] = usePersistedState('optionanalytics.orderFlow.largeLots', 10)
  // Big order: 'auto' (default) - the top 2.5% of the day's prints (autoBigLots) - or the fixed lots above.
  const [bigMode, setBigMode] = usePersistedState('optionanalytics.orderFlow.bigMode', 'auto')
  // What the server scanner needs from this page's own settings to read the order flow the same way.
  const orderFlowSettings = useMemo(() => ({ rowSizes, bigMode, largeLots }), [rowSizes, bigMode, largeLots])
  // What the server is asked for: in auto mode every print of 5+ lots (the page picks the big ones).
  const fetchLots = bigMode === 'auto' ? 5 : largeLots
  const [showLots, setShowLots] = usePersistedState('optionanalytics.orderFlow.showLots', true)
  // Telegram for a HEAVY iceberg (live view only): a hidden order that has traded at least this many lots in total.
  // (The server marks a level an iceberg from 5 lots; those small ones are only shown on the chart.)
  const [iceAlertOn, setIceAlertOn] = usePersistedState('optionanalytics.orderFlow.iceAlertOn', true)
  const [iceAlertLots, setIceAlertLots] = usePersistedState('optionanalytics.orderFlow.iceAlertLots', 100)
  const [showProfile, setShowProfile] = usePersistedState('optionanalytics.orderFlow.showProfile', true)
  const [showVwap, setShowVwap] = usePersistedState('optionanalytics.orderFlow.showVwap', true)
  const [replaySpeed, setReplaySpeed] = usePersistedState('optionanalytics.orderFlow.replaySpeed', 60)
  const rowSize = rowSizes?.[underlying] ?? DEFAULT_ROW_SIZES[underlying] ?? 1
  // The liquidity heatmap's own price rows per index (the dropdown on its card; null = the footprint's). Only its
  // picture: the scanner, the liquidity reads and the book keep the footprint's rows (withFineHeatmap).
  const [heatRowSizes, setHeatRowSizes] = usePersistedState('optionanalytics.orderFlow.heatRowSizes', {})
  const heatRowPick = heatRowSizes?.[underlying] ?? null
  const heatRow = heatRowPick ?? rowSize
  const heatFetchRow = heatmapFetchRow(rowSize, heatRow)
  const heatRowQuery = heatFetchRow !== rowSize ? `&heatmapRowSize=${heatFetchRow}` : ''
  const narrow = useNarrow()
  const [domOpen, setDomOpen] = useState(false)

  // ---- What is shown: Go Live (a contract, live) or Load day (a date, replayed) ----
  const [mode, setMode] = useState('live')
  const [expiry, setExpiry] = useState(null) // null = the nearest contract
  const [contracts, setContracts] = useState([])
  const [pickerDate, setPickerDate] = useState(() => dayjs())
  const [replayDate, setReplayDate] = useState(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [exactDays, setExactDays] = useState(() => new Set())
  const isReplay = mode === 'replay'
  // Live (Dhan) trading from the strategy scanner: admins, today's live view only.
  const auth = useAuth()
  const canTradeLive = auth?.user?.role === 'Admin' && !isReplay

  const changeUnderlying = (value) => { setUnderlying(value); setExpiry(null) }

  // The contracts listed on the picked date - for a past date that includes contracts that have since
  // expired (the server reads NSE's contract archive), so a backtest replays the real front month.
  const pickerKey = pickerDate.format('YYYY-MM-DD')
  const contractsDate = pickerKey < todayKey() ? pickerKey : null
  useEffect(() => {
    let cancelled = false
    setContracts([])
    fetchJson(`/api/order-flow/${underlying}/contracts${contractsDate ? `?date=${contractsDate}` : ''}`)
      .then((list) => {
        if (cancelled) return
        setContracts(list)
        // A month that was not listed on this date falls back to the front month.
        setExpiry((current) => (current && !list.some((c) => c.expiry === current) ? null : current))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [underlying, contractsDate])

  // The days the server can replay exactly - marked in the date picker.
  useEffect(() => {
    let cancelled = false
    fetchJson(`/api/order-flow/${underlying}/days`)
      .then((days) => { if (!cancelled) setExactDays(new Set(days.map((d) => d.date))) })
      .catch(() => { if (!cancelled) setExactDays(new Set()) })
    return () => { cancelled = true }
  }, [underlying, reloadNonce])

  const expiryQuery = expiry ? `&expiry=${expiry}` : ''

  // ---- Live ----
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const contextRef = useRef({ securityId: null, rowSize })
  contextRef.current = { securityId: data?.meta?.securityId ?? null, rowSize }

  useEffect(() => {
    if (isReplay) return undefined
    let cancelled = false
    setData(null)
    setLoading(true)
    setError(null)
    // Only prints of the "large" size are needed - fetching every print would cap at the server's
    // newest 5000 and lose the morning's large ones on a busy day.
    fetchJson(`/api/order-flow/${underlying}?rowSize=${rowSize}&minTradeLots=${fetchLots}&heatmapColumns=900${heatRowQuery}${expiryQuery}`)
      .then((body) => {
        if (cancelled) return
        setData(withFineHeatmap(orderFlowFromSnapshot(body), heatFetchRow, rowSize))
      })
      .catch((err) => { if (!cancelled) { setError(err.message); setData(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isReplay, underlying, expiryQuery, rowSize, heatFetchRow, heatRowQuery, fetchLots, reloadNonce])

  const handleLive = (payload) => {
    const { securityId, rowSize: rows } = contextRef.current
    if (payload?.meta?.securityId !== securityId) return
    setData((prev) => applyOrderFlowPush(prev, payload, rows))
  }
  // ---- Time & Sales tape: every print (not only big ones) - live: the latest, then each push's new
  // prints; replay: the prints up to the replay clock, fetched as the clock moves.
  const [tape, setTape] = useState({ prints: [], error: null, key: null })
  useEffect(() => {
    if (isReplay) return undefined
    let cancelled = false
    setTape({ prints: [], error: null, key: 'live' })
    fetchJson(`/api/order-flow/${underlying}/tape?count=${TAPE_PRINTS}${expiryQuery}`)
      .then((body) => { if (!cancelled) setTape((prev) => ({ key: 'live', error: body.error, prints: mergePrints(body.prints ?? [], prev.prints) })) })
      .catch((err) => { if (!cancelled) setTape((prev) => ({ ...prev, error: err.message })) })
    return () => { cancelled = true }
  }, [isReplay, underlying, expiryQuery, reloadNonce])
  const handleLiveTape = (payload) => {
    if (payload?.meta?.securityId !== contextRef.current.securityId || !payload.trades?.length) return
    setTape((prev) => (prev.key === 'live' ? { ...prev, prints: mergePrints(prev.prints, payload.trades) } : prev))
  }
  const onLive = (payload) => { handleLive(payload); handleLiveTape(payload) }

  const liveGroup = isReplay ? null : data?.meta?.expiry ? `of:${underlying}:${data.meta.expiry}` : data ? `of:${underlying}` : null
  const connectionState = useOrderFlowHub(liveGroup, onLive)

  // ---- Replay of a loaded day ----
  const [replayDay, setReplayDay] = useState(null)
  const [replayError, setReplayError] = useState(null)
  const [replayLoading, setReplayLoading] = useState(false)
  const [replayMs, setReplayMs] = useState(null)
  const [playing, setPlaying] = useState(false)
  const range = useMemo(() => replayRange(replayDay), [replayDay])

  useEffect(() => {
    if (!isReplay || !replayDate) { setReplayDay(null); return undefined }
    let cancelled = false
    setReplayLoading(true)
    setReplayError(null)
    setPlaying(false)
    fetchJson(`/api/order-flow/${underlying}/day/${replayDate}?rowSize=${rowSize}&minTradeLots=${fetchLots}&heatmapColumns=${REPLAY_HEATMAP_COLUMNS}${heatRowQuery}${expiryQuery}`)
      .then((body) => {
        if (cancelled) return
        const day = withFineHeatmap({
          meta: body.meta, minuteBars: body.bars, trades: body.trades, icebergs: body.icebergs, heatmap: body.heatmap.map(toColumn),
          sweeps: body.sweeps ?? [], source: body.source, note: body.note, date: replayDate, underlying,
          backfill: body.backfill ?? [], recordedFrom: body.recordedFrom ?? null,
        }, heatFetchRow, rowSize)
        setReplayDay(day)
        // Keep the clock where it was when only the rows / print size changed; a new day starts at its open.
        setReplayMs((ms) => {
          const next = replayRange(day)
          if (!next) return null
          return ms != null && ms >= next.start && ms <= next.end ? ms : next.start
        })
      })
      .catch((err) => { if (!cancelled) { setReplayError(err.message); setReplayDay(null) } })
      .finally(() => { if (!cancelled) setReplayLoading(false) })
    return () => { cancelled = true }
  }, [isReplay, underlying, replayDate, expiryQuery, rowSize, heatFetchRow, heatRowQuery, fetchLots, reloadNonce])

  useEffect(() => {
    if (!playing || !range) return undefined
    const id = setInterval(() => {
      setReplayMs((ms) => {
        const next = Math.min(range.end, (ms ?? range.start) + REPLAY_TICK_MS * replaySpeed)
        if (next >= range.end) setPlaying(false)
        return next
      })
    }, REPLAY_TICK_MS)
    return () => clearInterval(id)
  }, [playing, range, replaySpeed])

  const tapeClockRef = useRef({ fetchedAt: 0, timer: null })
  useEffect(() => {
    if (!isReplay || !replayDate || replayMs == null || replayDay?.source === 'estimated') return undefined
    const state = tapeClockRef.current
    const key = `${underlying}-${replayDate}-${expiry ?? ''}`
    let cancelled = false
    const run = () => {
      state.fetchedAt = Date.now()
      fetchJson(`/api/order-flow/${underlying}/tape?date=${replayDate}&until=${encodeURIComponent(new Date(replayMs).toISOString())}&count=${TAPE_PRINTS}${expiryQuery}`)
        .then((body) => { if (!cancelled) setTape({ key, error: body.error, prints: body.prints ?? [] }) })
        .catch((err) => { if (!cancelled) setTape({ key, error: err.message, prints: [] }) })
    }
    // While playing, at most one fetch every 1.5s; a jump or a pause fetches right away.
    const wait = playing ? Math.max(0, 1500 - (Date.now() - state.fetchedAt)) : 150
    const timer = setTimeout(run, wait)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [isReplay, underlying, replayDate, expiry, expiryQuery, replayMs, playing, replayDay?.source])

  const goLive = () => { setMode('live'); setPlaying(false); setReloadNonce((n) => n + 1) }
  // Load day (re)starts the replay at the open - as the OI Replay does, so a synced pair start together.
  const loadDay = (dateKey = pickerDate.format('YYYY-MM-DD')) => {
    setPlaying(false)
    setReplayMs(null)
    setReplayDate(dateKey)
    setMode('replay')
    setReloadNonce((n) => n + 1)
  }

  // ---- Sync with the OI Replay (another tab) ----
  const [syncEnabled, setSyncEnabled] = useReplaySyncEnabled()
  const [syncMismatch, setSyncMismatch] = useState(null)
  const pendingSyncRef = useRef(null)
  const applySync = (msg) => {
    pendingSyncRef.current = null
    if (!UNDERLYINGS.includes(msg.underlying)) return
    if (msg.type === 'day') {
      setSyncMismatch(null)
      if (msg.underlying !== underlying) changeUnderlying(msg.underlying)
      // The other page went live: so does this one.
      if (msg.live) {
        if (isReplay || msg.underlying !== underlying) { setPickerDate(dayjs()); goLive() }
        return
      }
      if (!msg.date) return
      // The user picked (or reloaded) a day there: load it here too - the same day as well, so a Load
      // day refresh reaches both pages. Its clock follows once it has loaded.
      setPickerDate(dayjs(msg.date))
      loadDay(msg.date)
      pendingSyncRef.current = { ...msg, type: 'state', reason: 'user', ms: null, playing: false }
      return
    }
    if (!msg.date) return
    if (msg.underlying !== underlying || msg.date !== replayDate || !isReplay) {
      // A heartbeat never moves this page to another day - only the user's pick there (or the reply
      // when joining) does, so a heartbeat already in flight cannot pull it back to the old day.
      if (msg.reason === 'tick') return
      // Follow the other page onto its day - any day loads (exact or estimated).
      pendingSyncRef.current = msg
      if (msg.underlying !== underlying) changeUnderlying(msg.underlying)
      setPickerDate(dayjs(msg.date))
      setReplayDate(msg.date)
      setMode('replay')
      return
    }
    if (replayError) { setSyncMismatch(`Could not load ${msg.date}`); return }
    if (!replayDay || replayDay.date !== msg.date || replayDay.underlying !== msg.underlying || !range) { pendingSyncRef.current = msg; return }
    setSyncMismatch(null)
    if (msg.speed > 0) setReplaySpeed(msg.speed)
    let ms = replayMs ?? range.start
    if (msg.ms != null && (msg.reason !== 'tick' || Math.abs(ms - msg.ms) > SYNC_DRIFT_MS)) {
      ms = Math.max(range.start, Math.min(range.end, msg.ms))
      setReplayMs(ms)
    }
    setPlaying(Boolean(msg.playing) && ms < range.end)
  }
  const sync = useReplaySync({
    enabled: syncEnabled, active: isReplay, kind: 'of',
    state: { underlying, date: isReplay ? replayDate : null, ms: replayMs, playing, speed: replaySpeed, live: !isReplay },
    onRemote: applySync,
  })
  // The user picked a day here (or went live): load it, and the OI Replay loads the same.
  const loadAndAnnounce = (dateKey) => {
    loadDay(dateKey)
    sync.announceDay({ underlying, date: dateKey })
  }
  // A sync that had to wait for the day to load.
  useEffect(() => {
    if (pendingSyncRef.current) applySync(pendingSyncRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayDay, replayError])

  // Everything below draws `view`: the live data, or the replayed day as of the replay clock.
  const view = useMemo(() => (isReplay ? replayView(replayDay, replayMs) : data), [isReplay, replayDay, replayMs, data])
  const estimated = view?.source === 'estimated'
  // A day rebuilt from TrueData's tick history (server TrueData:Enabled): real classified ticks - full
  // footprint and tape - but TrueData has no NSE depth, so no book / heatmap: the scanner treats it like
  // any day without depth (DOM / heatmap confirmation waived, aggression from each minute's split).
  const rebuilt = view?.source === 'truedata'
  const noDepth = estimated || rebuilt

  const lotSize = view?.meta?.lotSize ?? 1
  const bars = useMemo(
    () => analyzeBars(aggregateBars(view?.minuteBars ?? [], timeframe), { rowSize, minVolume: lotSize, imbalanceRatio, stackedCount, estimated }),
    [view?.minuteBars, timeframe, rowSize, lotSize, imbalanceRatio, stackedCount, estimated],
  )
  // Delta / cumulative delta from the 09:15 open: when the server started recording after the open, the
  // minutes before are an estimate from candles (display only - see cvdBackfill.js).
  const shown = useMemo(() => withBackfill(bars, view?.backfill, timeframe), [bars, view?.backfill, timeframe])
  // Session VWAP of the futures: from the 1-minute bars (the precise one), read at each footprint bar
  // (alignToBars - on the bar's own time) for the footprint, and minute by minute for the heatmap.
  const vwapMinutes = useMemo(() => sessionVwapFromBars((view?.minuteBars ?? []).map((b) => ({
    time: Math.floor(new Date(b.time).getTime() / 1000) + 19800, high: b.high, low: b.low, close: b.close, volume: (b.buy ?? 0) + (b.sell ?? 0),
  }))) ?? [], [view?.minuteBars])
  const footprintVwap = useMemo(() => {
    if (!showVwap || !vwapMinutes.length) return null
    const chartBars = bars.map((b) => ({ time: Math.floor(new Date(b.time).getTime() / 1000) + 19800 }))
    const byTime = new Map(alignToBars(vwapMinutes, chartBars).map((p) => [p.time, p.value]))
    return chartBars.map((b) => byTime.get(b.time) ?? null)
  }, [showVwap, vwapMinutes, bars])
  const heatmapVwap = useMemo(() => (showVwap ? vwapMinutes.map((p) => ({ t: (p.time - 19800) * 1000 + 59_000, value: p.value })) : null), [showVwap, vwapMinutes])
  // Volume profile levels always from the PREVIOUS session (POC, VAH, VAL, HVN, LVN); market profile
  // (TPO) from the previous session plus today's developing one.
  const sessionDate = isReplay ? replayDate : todayKey()
  const [prevSession, setPrevSession] = useState({ key: null, data: null, loading: false })
  useEffect(() => {
    if (!sessionDate) return undefined
    let cancelled = false
    const key = `${underlying}:${sessionDate}:${rowSize}:${expiryQuery}`
    setPrevSession({ key, data: null, loading: true })
    fetchPreviousSession(underlying, sessionDate, rowSize, expiryQuery).then((data) => { if (!cancelled) setPrevSession({ key, data, loading: false }) })
    return () => { cancelled = true }
  }, [underlying, sessionDate, rowSize, expiryQuery])
  const prevVp = useMemo(() => (prevSession.data ? sessionVolumeProfile(prevSession.data.bars) : null), [prevSession.data])
  const tpoRow = tpoRowFor(underlying, rowSize)
  const prevTpo = useMemo(() => (prevSession.data ? tpoProfile(prevSession.data.bars, tpoRow) : null), [prevSession.data, tpoRow])
  const todayTpo = useMemo(() => tpoProfile(view?.minuteBars ?? [], tpoRow), [view?.minuteBars, tpoRow])
  // Today's running (developing) volume profile - up to the clock on a replay - in its own colours.
  const todayVp = useMemo(() => (view?.minuteBars?.length ? sessionVolumeProfile(view.minuteBars) : null), [view?.minuteBars])
  // The previous session's high / low too: the stops resting beyond them are what a breakout trap runs.
  const prevRange = useMemo(() => {
    const bars = (prevSession.data?.bars ?? []).filter((b) => b.high > 0 && b.low > 0)
    return bars.length ? { prevHigh: Math.max(...bars.map((b) => b.high)), prevLow: Math.min(...bars.map((b) => b.low)) } : null
  }, [prevSession.data])
  const scannerProfile = useMemo(() => (prevVp?.poc != null ? { vp: prevVp, tpoPrev: prevTpo, ...prevRange } : null), [prevVp, prevTpo, prevRange])
  const profile = showProfile ? prevVp : null
  const walls = useMemo(() => findWalls(view?.book), [view?.book])
  const activeIcebergs = useMemo(() => new Set((view?.icebergs ?? []).filter((i) => !i.endedAt).map((i) => i.price)), [view?.icebergs])
  // Each heavy iceberg is sent once, the moment its traded quantity reaches the threshold (kept per day, so
  // a refresh does not send it again).
  const iceSentRef = useRef(null)
  useEffect(() => {
    if (isReplay || !iceAlertOn || !(lotSize > 0) || view?.meta?.underlying !== underlying) return
    const day = IST_DATE.format(new Date())
    if (iceSentRef.current?.day !== day) {
      let keys = []
      try { const saved = JSON.parse(localStorage.getItem(ICE_SENT_KEY) ?? 'null'); if (saved?.day === day) keys = saved.keys ?? [] } catch { /* convenience only */ }
      iceSentRef.current = { day, keys: new Set(keys), primed: null }
    }
    const sent = iceSentRef.current.keys
    // The first look after the page opens: icebergs that already ended are history, not news.
    const opening = iceSentRef.current.primed !== underlying
    if (view?.icebergs) iceSentRef.current.primed = underlying
    let changed = false
    for (const i of view?.icebergs ?? []) {
      if (!(i.traded >= iceAlertLots * lotSize)) continue
      const key = `${underlying}-${i.isBid ? 'b' : 'a'}-${i.price}-${i.startedAt}`
      if (sent.has(key)) continue
      sent.add(key)
      changed = true
      if (opening && i.endedAt) continue
      telegram(`Heavy iceberg ${underlying}: hidden ${i.isBid ? 'BUYER at the bid' : 'SELLER at the offer'} ${i.price} - ${formatVolume(i.traded, lotSize, true)} lots traded there (${formatVolume(i.maxDisplayed, lotSize, true)} shown at most)${i.refills > 0 ? `, ${i.refills} refills` : ''}${i.endedAt ? ' - ended' : ' - still active'}`)
    }
    if (changed) { try { localStorage.setItem(ICE_SENT_KEY, JSON.stringify({ day, keys: [...sent] })) } catch { /* convenience only */ } }
  }, [view?.icebergs, view?.meta?.underlying, underlying, isReplay, iceAlertOn, iceAlertLots, lotSize])
  const bigLabel = estimated ? 'Volume spike' : 'Big order'
  const nowMs = isReplay ? replayMs ?? Date.now() : view?.heatmap?.at(-1)?.t ?? Date.now()
  // Tape reading: aggression from the Time & Sales prints, sweeps from the server, pulling/stacking
  // off the heatmap.
  const tapePrints = useMemo(() => (isReplay ? tape.prints.filter((p) => new Date(p.time).getTime() <= (replayMs ?? 0)) : tape.prints), [isReplay, tape.prints, replayMs])
  // Big order threshold: auto from the prints so far (never ones after the replay clock), else 10 lots
  // until there are enough prints to judge.
  const autoLots = useMemo(() => autoBigLots(tapePrints, lotSize), [tapePrints, lotSize])
  const bigLots = bigMode === 'auto' ? autoLots ?? 10 : largeLots
  const largeTrades = useMemo(() => (view?.trades ?? []).filter((t) => t.quantity >= bigLots * lotSize), [view?.trades, bigLots, lotSize])
  const priceAlerts = usePriceAlerts(underlying, view?.meta?.lastPrice, !isReplay)
  // Liquidity signals off the heatmap (magnet, wall absorption, exhaustion into a wall, spoofing) -
  // they need market depth, so none for an estimated day. The last hour of columns is plenty.
  const liquidity = useMemo(
    () => (estimated ? [] : liquiditySignals({ columns: (view?.heatmap ?? []).slice(-1800), trades: largeTrades, minuteBars: view?.minuteBars ?? [], rowSize, lotSize })),
    [estimated, view?.heatmap, largeTrades, view?.minuteBars, rowSize, lotSize],
  )
  const tapeNow = isReplay ? replayMs ?? Date.now() : Math.max(nowMs, tapePrints.length ? new Date(tapePrints.at(-1).time).getTime() : 0)
  const aggressionNow = useMemo(() => (estimated ? null : aggression(tapePrints, tapeNow, undefined, view?.minuteBars)), [estimated, tapePrints, tapeNow, view?.minuteBars])
  const sweeps = useMemo(() => sweepSignals(view?.sweeps, lotSize), [view?.sweeps, lotSize])
  const pullStack = useMemo(
    () => (estimated ? { signals: [], pressure: null } : pullStackSignals({ columns: (view?.heatmap ?? []).slice(-1800), rowSize, lotSize })),
    [estimated, view?.heatmap, rowSize, lotSize],
  )
  // The heatmap's picture in its own rows: the finer copy fetched for them, else the footprint-row heatmap -
  // re-bucketed when the picked rows are a whole number of it (until a refetch lands, the rows it has).
  const heatShown = useMemo(() => {
    const fine = view?.heatFine && rowsNest(heatRow, view.heatFineRow) ? { columns: view.heatFine, row: view.heatFineRow } : null
    const source = fine ?? { columns: view?.heatmap ?? [], row: rowSize }
    if (source.row === heatRow || !rowsNest(heatRow, source.row)) return source
    return { columns: rebucketColumns(source.columns, heatRow), row: heatRow }
  }, [view?.heatFine, view?.heatFineRow, view?.heatmap, heatRow, rowSize])
  // The heatmap's STACK / PULL pills can be hidden (a box on the card, remembered) - the read, bias and signal list keep them.
  const [heatPullStack, setHeatPullStack] = usePersistedState('optionanalytics.orderFlow.heatPullStack', true)
  const heatSignals = useMemo(() => [...liquidity, ...(heatPullStack ? pullStack.signals : []), ...sweeps], [liquidity, heatPullStack, pullStack.signals, sweeps])
  // The day's options + futures OI: part of the order flow read, and what the strategy scanner reads.
  const { oi: dayOi, error: dayOiError } = useDayOi(underlying, isReplay ? replayDate : todayKey(), isReplay)
  const oiMinute = Math.floor((nowMs ?? 0) / 60_000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const oiParts = useMemo(() => (dayOi && nowMs ? oiBiasParts(dayOi, nowMs) : []), [dayOi, oiMinute])
  // The OI picture and the sudden OI walls on the whole chain (suddenOi.js), once a minute.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const oiNow = useMemo(() => (dayOi && nowMs ? oiSummary(dayOi, nowMs) : null), [dayOi, oiMinute])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sudden = useMemo(() => (dayOi && nowMs ? suddenOiWalls(dayOi, nowMs) : []), [dayOi, oiMinute])
  const lastPrice = view?.meta?.lastPrice
  // Futures minus index: an option strike in futures terms (the footprint and heatmap are futures).
  const basis = oiNow?.spot > 0 && lastPrice > 0 ? Math.round(lastPrice - oiNow.spot) : null
  // Alerts at the previous session's volume / market profile levels, futures and spot separately.
  const prevSpotVp = usePreviousSpotProfile(underlying, sessionDate)
  const profileAlerts = useProfileAlerts({ underlying, vp: prevVp, tpo: prevTpo, tpoRow, futuresPrice: lastPrice, spotPrice: oiNow?.spot, basis, spotVp: prevSpotVp, live: !isReplay })
  const suddenLevels = useMemo(() => (basis == null ? [] : sudden.map((w) => ({
    price: Math.round((w.strike + basis) / rowSize) * rowSize, color: w.side === 'PE' ? '#73d13d' : '#ff7875',
    label: `${w.side === 'PE' ? 'PUT' : 'CALL'} ${w.strike} +${(w.add / 1e5).toFixed(1)}L 5m`,
  }))), [sudden, basis, rowSize])
  // Each sudden wall once in the Signals list (again after 30 minutes), and - live - an alert: a chime,
  // the words (Voice on), a notification and Telegram (the scanner's switches).
  const suddenKey = `${underlying}-${isReplay ? replayDate : 'live'}`
  const suddenLogRef = useRef([])
  const [suddenLog, setSuddenLog] = useState([])
  useEffect(() => { suddenLogRef.current = []; setSuddenLog([]) }, [suddenKey])
  useEffect(() => {
    if (!nowMs) return
    const kept = suddenLogRef.current.filter((p) => p.t <= nowMs) // a replay clock moved back
    const fresh = sudden.filter((w) => !kept.some((p) => p.side === w.side && p.strike === w.strike && nowMs - p.t < 30 * 60_000))
    if (!fresh.length && kept.length === suddenLogRef.current.length) return
    const log = [...kept, ...fresh.map((w) => ({ ...w, t: nowMs, basis }))]
    suddenLogRef.current = log
    setSuddenLog(log)
    if (isReplay || !fresh.length) return
    // Only a big change is worth an alert (chime, voice, popup, Telegram): the strike's OI up by more than
    // OI_ALERT_MIN_PCT in the window. The rest still show in the Signals list.
    const alertable = fresh.filter((w) => w.pct > OI_ALERT_MIN_PCT)
    if (!alertable.length) return
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('optionanalytics.strategyScanner.settings')) ?? {} } catch { /* none */ }
    if (cfg.alerts === false) return
    for (const w of alertable.slice(0, 3)) {
      const fut = basis != null ? ` (futures ~${Math.round(w.strike + basis)})` : ''
      if (cfg.sound !== false) chime(w.side === 'PE')
      if (cfg.voice !== false) speak(`Sudden ${w.side === 'PE' ? 'put' : 'call'} wall ${w.strike}.`)
      if (cfg.telegram !== false) telegram(`🧱 Sudden OI wall - ${underlying} ${suddenWallText(w)}${fut}: ${w.side === 'PE' ? 'support' : 'resistance'}`)
      notification.open({
        key: `sudden-${w.side}${w.strike}-${nowMs}`, placement: 'topRight', duration: 12,
        message: <span style={{ color: w.side === 'PE' ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>🧱 Sudden {w.side === 'PE' ? 'PUT' : 'CALL'} OI wall {w.strike} · {w.side === 'PE' ? 'support' : 'resistance'}</span>,
        description: <span style={{ fontSize: 12 }}>{suddenWallText(w)}{fut}</span>,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sudden])
  // The heatmap read as a liquidity map, with what lines up at each wall.
  const mapLevels = useMemo(() => {
    const out = []
    if (basis != null) {
      if (oiNow?.support != null) out.push({ price: oiNow.support + basis, kind: 'oi', label: `PUT OI wall ${oiNow.support}` })
      if (oiNow?.resistance != null) out.push({ price: oiNow.resistance + basis, kind: 'oi', label: `CALL OI wall ${oiNow.resistance}` })
      for (const w of sudden) out.push({ price: w.strike + basis, kind: 'suddenOi', label: `sudden ${w.side === 'PE' ? 'PUT' : 'CALL'} OI ${w.strike} +${(w.add / 1e5).toFixed(1)}L` })
    }
    if (prevVp?.poc != null) {
      out.push({ price: prevVp.poc, kind: 'poc', label: 'prev. POC' }, { price: prevVp.vah, kind: 'vah', label: 'prev. VAH' }, { price: prevVp.val, kind: 'val', label: 'prev. VAL' })
      if (prevVp.hvnTop != null) out.push({ price: prevVp.hvnTop, kind: 'hvn', label: `HVN ${prevVp.hvnTop}` })
    }
    const vwap = vwapOf(view?.minuteBars ?? [], nowMs)
    if (vwap) out.push({ price: vwap, kind: 'vwap', label: `VWAP ${vwap.toFixed(1)}` })
    if (prevRange) out.push({ price: prevRange.prevHigh, kind: 'prevHigh', label: 'prev. day high' }, { price: prevRange.prevLow, kind: 'prevLow', label: 'prev. day low' })
    for (const i of view?.icebergs ?? []) if (!i.endedAt) out.push({ price: i.price, kind: 'iceberg', label: `iceberg (${i.isBid ? 'bid' : 'offer'})` })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oiNow, sudden, basis, prevVp, prevRange, view?.icebergs, oiMinute])
  const priceRow = lastPrice > 0 ? Math.round(lastPrice / rowSize) : null
  const liqMap = useMemo(
    () => (estimated || !view?.heatmap?.length ? null : liquidityMap({ columns: view.heatmap, minuteBars: view?.minuteBars ?? [], rowSize, lotSize, price: lastPrice, nowMs, extraLevels: mapLevels })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [estimated, view?.heatmap, view?.minuteBars?.length, rowSize, lotSize, priceRow, mapLevels],
  )
  const heatMarks = useMemo(() => {
    const marks = []
    for (const z of liqMap?.zones ?? []) if (z.kind === 'low') marks.push({ band: true, low: z.low, high: z.high, color: '#597ef7', label: 'THIN' })
    for (const w of liqMap?.support.slice(0, 3) ?? []) marks.push({ price: w.price, color: '#52c41a', label: `S ${w.price}` })
    for (const w of liqMap?.resistance.slice(0, 3) ?? []) marks.push({ price: w.price, color: '#ff4d4f', label: `R ${w.price}` })
    for (const l of suddenLevels) marks.push({ price: l.price, color: '#faad14', label: l.label, dash: [2, 3], width: 2 })
    return marks
  }, [liqMap, suddenLevels])
  const bias = useMemo(
    () => orderFlowBias({ bars, liquidity, bigTrades: largeTrades, nowMs, aggressionNow, sweeps: view?.sweeps ?? [], pullStack: pullStack.signals, extra: oiParts }),
    [bars, liquidity, largeTrades, nowMs, aggressionNow, view?.sweeps, pullStack.signals, oiParts],
  )

  const signals = useMemo(() => {
    const list = []
    for (const bar of bars.slice(-120)) {
      for (const z of bar.stacked) {
        list.push({ key: `s-${bar.time}-${z.side}-${z.low}`, time: bar.time, bullish: z.side === 'buy', type: 'Stacked imbalance',
          text: `${z.side === 'buy' ? 'Buy' : 'Sell'} stack ${z.low}–${z.high} (${z.rows} rows) - ${z.side === 'buy' ? 'support' : 'resistance'}` })
      }
      for (const a of bar.absorption) {
        list.push({ key: `a-${bar.time}-${a.side}`, time: bar.time, bullish: a.side === 'buy', type: 'Absorption',
          text: a.text ?? (a.side === 'buy' ? `Selling absorbed at ${a.price} (${formatVolume(a.volume, lotSize, showLots)} hit the bid, bar closed off the low)` : `Buying absorbed at ${a.price} (${formatVolume(a.volume, lotSize, showLots)} lifted, bar closed off the high)`) })
      }
      for (const e of bar.exhaustion) {
        list.push({ key: `e-${bar.time}-${e.side}`, time: bar.time, bullish: e.side === 'buy', type: 'Exhaustion',
          text: e.text ?? (e.side === 'sell' ? `Buying exhausted at the high ${e.price}` : `Selling exhausted at the low ${e.price}`) })
      }
    }
    for (const i of view?.icebergs ?? []) {
      list.push({ key: `i-${i.id}`, time: new Date(i.detectedAt).getTime(), bullish: i.isBid, type: 'Iceberg',
        text: `${i.isBid ? 'Hidden buyer at bid' : 'Hidden seller at offer'} ${i.price}: ${formatVolume(i.traded, lotSize, showLots)} traded vs ${formatVolume(i.maxDisplayed, lotSize, showLots)} shown${i.endedAt ? ' (ended)' : ' - active'}` })
    }
    for (const l of [...liquidity, ...pullStack.signals.slice(-60), ...sweeps.slice(-60)]) {
      list.push({ key: l.key, time: l.t, bullish: l.bullish, type: l.kind, text: l.text, confidence: l.confidence })
    }
    for (const w of suddenLog) {
      list.push({ key: `so-${w.side}${w.strike}-${w.t}`, time: w.t, bullish: w.side === 'PE', type: 'Sudden OI wall',
        text: `${suddenWallText(w)}${w.basis != null ? ` - futures ~${Math.round(w.strike + w.basis)}` : ''} (${w.side === 'PE' ? 'support' : 'resistance'})` })
    }
    // The newest big orders only - plenty to read, without pushing the rarer signals out of the list.
    for (const t of largeTrades.slice(-40)) {
      list.push({ key: `t-${t.seq}`, time: new Date(t.time).getTime(), bullish: t.buy, type: bigLabel,
        text: estimated
          ? `${formatVolume(t.quantity, lotSize, true)} lots traded in the minute to ${IST_HHMMSS.format(new Date(t.time)).slice(0, 5)} (est. ${t.buy ? 'buying' : 'selling'}), closed ${t.price}`
          : `${t.buy ? 'Buy' : 'Sell'} ${formatVolume(t.quantity, lotSize, true)} lots at ${t.price}` })
    }
    return list.sort((a, b) => b.time - a.time).slice(0, 200)
  }, [bars, view?.icebergs, largeTrades, lotSize, showLots, estimated, bigLabel, liquidity, pullStack.signals, sweeps, suddenLog])

  // Filter the Signals list: by type, by direction, by minimum confidence (kept across reloads).
  const [signalTypes, setSignalTypes] = usePersistedState('optionanalytics.orderFlow.signalTypes', [])
  const [signalSide, setSignalSide] = usePersistedState('optionanalytics.orderFlow.signalSide', 'all')
  const [signalMinConfidence, setSignalMinConfidence] = usePersistedState('optionanalytics.orderFlow.signalMinConfidence', 0)
  const signalTypeOptions = useMemo(() => [...new Set(signals.map((x) => x.type))].sort().map((t) => ({ value: t, label: t })), [signals])
  const shownSignals = useMemo(() => signals.filter((x) => (signalTypes.length === 0 || signalTypes.includes(x.type))
    && (signalSide === 'all' || (signalSide === 'bullish') === Boolean(x.bullish))
    // A signal with no confidence of its own (a stack, an iceberg, a big order) is not hidden by this.
    && (!(signalMinConfidence > 0) || x.confidence == null || x.confidence >= signalMinConfidence)), [signals, signalTypes, signalSide, signalMinConfidence])

  const meta = view?.meta
  const lastBar = bars.at(-1)
  const dayKey = `${underlying}-${timeframe}-${rowSize}-${isReplay ? replayDate : 'live'}-${meta?.securityId ?? ''}`
  const jump = (minutes) => { setReplayMs((ms) => (range ? Math.max(range.start, Math.min(range.end, (ms ?? range.start) + minutes * 60_000)) : ms)); sync.userAction() }
  // Go to a minute: the replay shows everything up to and including that minute's bar (the clock is
  // the end of that minute - same as picking that minute on the OI Replay, so a synced pair agree).
  const goToMinute = (value) => {
    if (!value || !range || !replayDate) return
    const ms = Date.parse(`${replayDate}T${value.format('HH:mm')}:00+05:30`) + 60_000
    setPlaying(false)
    setReplayMs(Math.max(range.start, Math.min(range.end, ms)))
    sync.userAction()
  }
  const shownMinute = replayMs != null ? IST_HHMMSS.format(new Date(Math.max(replayMs - 60_000, range?.start ?? 0))).slice(0, 5) : null
  const contractOptions = [
    { value: 'nearest', label: 'Nearest (auto)' },
    ...contracts.map((c) => ({
      value: c.expiry,
      label: `${dayjs(c.expiry).format('DD MMM YYYY')} · ${c.tradingSymbol}${c.expiry < todayKey() ? ' (expired)' : ''}`,
    })),
  ]

  return (
    <div style={{ maxWidth: 2600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card
          size="small" title="Order Flow - futures"
          extra={(
            <Tooltip title="Depth of market - the nearest contract's full 200-level book in a side panel (live)">
              <Button onClick={() => setDomOpen(true)}>DOM</Button>
            </Tooltip>
          )}
        >
          <Space wrap size={10} align="center">
            <Button type={isReplay ? 'default' : 'primary'} onClick={() => { goLive(); sync.announceDay({ underlying, live: true }) }} loading={!isReplay && loading}>● Go Live</Button>
            <Select
              value={underlying} style={{ width: 130 }} options={UNDERLYINGS.map((u) => ({ value: u, label: `${u} FUT` }))}
              onChange={(v) => { changeUnderlying(v); sync.announceDay(isReplay ? { underlying: v, date: replayDate } : { underlying: v, live: true }) }}
            />
            <Tooltip title="Futures contract on the picked date - the front month, or any month listed then (expired ones included for past dates)">
              <Select value={expiry ?? 'nearest'} onChange={(v) => setExpiry(v === 'nearest' ? null : v)} style={{ width: 230 }} options={contractOptions} />
            </Tooltip>
            {/* With Sync on, picking a date loads it straight away - here and on the OI Replay. */}
            <DatePicker
              value={pickerDate} allowClear={false} format="DD MMM YYYY" style={{ width: 140 }}
              onChange={(d) => { if (!d) return; setPickerDate(d); if (syncEnabled) loadAndAnnounce(d.format('YYYY-MM-DD')) }}
              disabledDate={(d) => d.isAfter(dayjs(), 'day') || ((d.day() === 0 || d.day() === 6) && !exactDays.has(d.format('YYYY-MM-DD')))}
              cellRender={(current, info) => {
                if (info.type !== 'date') return info.originNode
                const exact = exactDays.has(current.format('YYYY-MM-DD'))
                return (
                  <div className="ant-picker-cell-inner" style={{ position: 'relative' }} title={exact ? 'Exact replay (the server has this day)' : undefined}>
                    {current.date()}
                    {exact && <span style={{ position: 'absolute', bottom: 1, left: '50%', width: 4, height: 4, marginLeft: -2, borderRadius: 2, background: UP_COLOR }} />}
                  </div>
                )
              }}
            />
            <Button type={isReplay ? 'primary' : 'default'} onClick={() => loadAndAnnounce(pickerDate.format('YYYY-MM-DD'))} loading={replayLoading}>Load day</Button>
            <ReplaySyncControl enabled={syncEnabled} onChange={setSyncEnabled} sync={sync} kind="of" mismatch={syncMismatch} />
          </Space>
          <Space wrap size={12} align="center" style={{ marginTop: 10 }}>
            <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
            <Select value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [underlying]: v })} style={{ width: 120 }} options={ROW_SIZE_OPTIONS} />
            <Tooltip title="Diagonal imbalance: buying at a price vs selling one row below (and the mirror) must be at least this many times larger.">
              <InputNumber value={imbalanceRatio} onChange={(v) => setImbalanceRatio(v ?? 3)} min={1.5} max={10} step={0.5} style={{ width: 140 }} addonBefore="Imbalance" addonAfter="x" disabled={estimated} />
            </Tooltip>
            <InputNumber value={stackedCount} onChange={(v) => setStackedCount(v ?? 3)} min={2} max={8} style={{ width: 130 }} addonBefore="Stack" addonAfter="rows" disabled={estimated} />
            <Tooltip title={bigMode === 'auto'
              ? `Auto: a big order is a print only the top 2.5% of today's prints reach${autoLots ? ` - ${autoLots} lots now` : ' (10 lots until there are enough prints)'}. It follows the day: bigger at the open and on expiry, smaller on a quiet afternoon.`
              : 'Fixed: every print of at least this many lots is a big order.'}>
              <Space.Compact>
                <Select value={bigMode} onChange={setBigMode} style={{ width: 150 }} options={[{ value: 'auto', label: 'Big order: Auto' }, { value: 'fixed', label: 'Big order: Fixed' }]} />
                <InputNumber value={bigMode === 'auto' ? bigLots : largeLots} onChange={(v) => setLargeLots(v ?? 10)} min={1} disabled={bigMode === 'auto'} style={{ width: 110 }} addonAfter="lots" aria-label="Big order lots" />
              </Space.Compact>
            </Tooltip>
            <Tooltip title="Telegram when an iceberg (a hidden order that keeps refilling at one price) has traded at least this many lots in total - big ones only; the small ones just show on the chart. Live view only, once per iceberg.">
              <Space.Compact>
                <Space size={4} style={{ marginRight: 8 }}><Switch size="small" checked={iceAlertOn} onChange={setIceAlertOn} aria-label="Telegram heavy icebergs" /><Text style={{ fontSize: 12 }}>Iceberg Telegram</Text></Space>
                <InputNumber value={iceAlertLots} onChange={(v) => setIceAlertLots(v ?? 100)} min={5} max={100000} disabled={!iceAlertOn} style={{ width: 118 }} addonBefore="from" addonAfter="lots" aria-label="Heavy iceberg lots" />
              </Space.Compact>
            </Tooltip>
            <Space size={4}><Switch size="small" checked={showLots} onChange={setShowLots} /><Text style={{ fontSize: 12 }}>Volume in lots</Text></Space>
            <Space size={4}><Switch size="small" checked={showProfile} onChange={setShowProfile} /><Text style={{ fontSize: 12 }}>Volume profile</Text></Space>
            <Checkbox checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}><Text style={{ fontSize: 12 }}>VWAP</Text></Checkbox>
          </Space>
          {isReplay && (
            <div style={{ marginTop: 12, padding: 10, border: '1px solid #ffffff1f', borderRadius: 6 }}>
              <Space wrap size={10} align="center">
                <Button
                  type="primary" icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />} disabled={!range}
                  onClick={() => { if (!playing && range && replayMs >= range.end) setReplayMs(range.start); setPlaying(!playing); sync.userAction() }}
                >
                  {playing ? 'Pause' : 'Play'}
                </Button>
                <Select value={replaySpeed} onChange={(v) => { setReplaySpeed(v); sync.userAction() }} style={{ width: 84 }} options={withSpeedOption(REPLAY_SPEEDS, replaySpeed, speedOption)} />
                <Space.Compact>
                  <Button disabled={!range} onClick={() => jump(-15)}>−15m</Button>
                  <Button disabled={!range} onClick={() => jump(-1)}>−1m</Button>
                  <Button disabled={!range} onClick={() => jump(1)}>+1m</Button>
                  <Button disabled={!range} onClick={() => jump(15)}>+15m</Button>
                </Space.Compact>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Go to</Text>
                  <TimePicker
                    format="HH:mm" minuteStep={1} allowClear={false} needConfirm={false} showNow={false} placeholder="HH:mm"
                    style={{ width: 96 }} disabled={!range} aria-label="Go to minute"
                    value={shownMinute ? dayjs().hour(Number(shownMinute.slice(0, 2))).minute(Number(shownMinute.slice(3, 5))).second(0) : null} onChange={goToMinute}
                    disabledTime={() => ({ disabledHours: () => [...Array(24).keys()].filter((h) => h < 9 || h > 15) })}
                  />
                </span>
                {replayMs != null && <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{IST_HHMMSS.format(new Date(replayMs))} IST</Text>}
                {replayLoading && <Text type="secondary">Loading…</Text>}
              </Space>
              {range && (
                <Slider
                  min={range.start} max={range.end} step={1000} value={replayMs ?? range.start}
                  onChange={(v) => { setReplayMs(v); sync.userAction() }} tooltip={{ formatter: (v) => IST_HHMMSS.format(new Date(v)) }}
                  style={{ margin: '12px 6px 0' }}
                />
              )}
            </div>
          )}
          <Space wrap size={8} style={{ marginTop: 10 }}>
            {isReplay
              ? <Tag color="purple">● Replay{replayDate ? ` · ${dayjs(replayDate).format('DD MMM YYYY')}${replayDate === todayKey() ? ' (today so far)' : ''}` : ''}</Tag>
              : (
                <Tag color={connectionState === 'connected' ? 'success' : connectionState === 'reconnecting' ? 'warning' : connectionState === 'connecting' ? 'processing' : 'error'}>
                  {connectionState === 'connected' ? '● Live' : connectionState === 'reconnecting' ? '● Reconnecting…' : connectionState === 'connecting' ? '● Connecting…' : '● Disconnected'}
                </Tag>
              )}
            {isReplay && replayDay && (
              <Tooltip title={noDepth ? replayDay.note : 'The server saw this day live - footprint, prints, heatmap and book replay exactly.'}>
                <Tag color={estimated ? 'orange' : rebuilt ? 'blue' : 'green'}>{estimated ? 'Estimated from 1-min candles' : rebuilt ? 'Rebuilt from TrueData ticks (no depth)' : 'Exact (tick data)'}</Tag>
              </Tooltip>
            )}
            {meta && <Tag>{meta.contractSymbol} · lot {meta.lotSize}</Tag>}
            {meta && !noDepth && <DepthBadge meta={meta} live={!isReplay} />}
            {meta?.lastPrice > 0 && <Text strong>{meta.lastPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>}
            {lastBar && (
              <Text style={{ fontSize: 12 }}>
                Δ <span style={{ color: lastBar.delta >= 0 ? UP_COLOR : DOWN_COLOR, fontWeight: 600 }}>{lastBar.delta >= 0 ? '+' : ''}{formatVolume(lastBar.delta, lotSize, showLots)}</span>
                {' · '}Cum Δ <span style={{ color: (shown.bars.at(-1)?.cvd ?? lastBar.cvd) >= 0 ? UP_COLOR : DOWN_COLOR, fontWeight: 600 }}>{(shown.bars.at(-1)?.cvd ?? lastBar.cvd) >= 0 ? '+' : ''}{formatVolume(shown.bars.at(-1)?.cvd ?? lastBar.cvd, lotSize, showLots)}</span>
                {showLots ? ' lots' : ''}
              </Text>
            )}
            {meta?.lastTradeAt && <Text type="secondary" style={{ fontSize: 12 }}>last trade {IST_HHMMSS.format(new Date(meta.lastTradeAt))}</Text>}
          </Space>
        </Card>

        {!isReplay && error && <Alert type="warning" showIcon message={error} />}
        {isReplay && replayError && <Alert type="warning" showIcon message={replayError} />}
        {isReplay && estimated && <Alert type="info" showIcon message="Estimated order flow" description={replayDay?.note} />}
        {isReplay && rebuilt && <Alert type="info" showIcon message="Order flow rebuilt from TrueData's tick history" description={replayDay?.note} />}

        <Row gutter={[16, 16]}>
          <Col xs={24} xl={17}>
            <Card size="small" title={`Footprint · ${timeframe} min · ${rowSize} pt rows${estimated ? ' · estimated' : ''}`} extra={!narrow && <Text type="secondary" style={{ fontSize: 11 }}>bid (sell) × ask (buy) · drag to move it anywhere · wheel: bar width · Shift+wheel or price axis: row height · double-click: reset</Text>}>
              <PriceAlertsBar {...priceAlerts} lastPrice={meta?.lastPrice} live={!isReplay} />
              <ProfileAlertsBar {...profileAlerts} live={!isReplay} />
              <FootprintLegend estimated={estimated} bigLabel={bigLabel} />
              <FootprintChart
                bars={shown.bars} rowSize={rowSize} lotSize={lotSize} showLots={showLots} lastPrice={meta?.lastPrice} height={narrow ? 480 : 660}
                profile={profile} runningProfile={showProfile ? todayVp : null} trades={largeTrades} timeframe={timeframe} bigLabel={bigLabel} alerts={priceAlerts.alerts} levels={suddenLevels} vwap={footprintVwap}
              />
              {profile?.poc != null && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Volume profile of the previous session ({prevSession.data?.date}): POC {profile.poc} · value area {profile.val}–{profile.vah} (70% of volume)
                  {profile.hvnTop != null ? ` · HVN ${profile.hvnTop}` : ''}{profile.lvnTop != null ? ` · LVN ${profile.lvnTop}` : ''}
                  {todayVp?.poc != null ? ` · today (running, pink / teal lines): POC ${todayVp.poc} · VA ${todayVp.val}–${todayVp.vah}` : ''}
                </Text>
              )}
            </Card>
            {/* Under the footprint, in reading order: the liquidity heatmap and its read (the map), delta,
                then the volume / market profiles - the column on the right (read, DOM, tape, signals) runs long. */}
            <Space direction="vertical" size={16} style={{ width: '100%', marginTop: 16 }}>
                {/* What the heatmap shows - in one line under it. */}
                <Card
                  size="small" title="Liquidity heatmap"
                  extra={(
                    <Space size={12} wrap>
                      {!narrow && <Text type="secondary" style={{ fontSize: 11 }}>resting bids/offers over time (brighter = more) · big dots = big orders · magenta = icebergs</Text>}
                      {!estimated && (
                        <Tooltip title="Price points per heatmap row - only this picture changes: the footprint keeps its own rows, and the liquidity read, signals and scanner read the book in the footprint's rows as before.">
                          <Select size="small" value={heatRowPick ?? 'same'} style={{ width: 150 }}
                            onChange={(v) => setHeatRowSizes({ ...(heatRowSizes ?? {}), [underlying]: v === 'same' ? null : v })}
                            options={[{ value: 'same', label: `Footprint (${rowSize} pt)` }, ...ROW_SIZE_OPTIONS.map((o) => ({ value: o.value, label: `${o.value} pt rows` }))]} />
                        </Tooltip>
                      )}
                      {!estimated && (
                        <Tooltip title="Show the STACK (liquidity added) and PULL (liquidity pulled) pills on the heatmap. Hiding them only clears the picture - the read, the bias and the signals list still use them.">
                          <Checkbox checked={heatPullStack} onChange={(e) => setHeatPullStack(e.target.checked)}>Stack / pull</Checkbox>
                        </Tooltip>
                      )}
                    </Space>
                  )}
                >
                  {estimated
                    ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No liquidity heatmap for an estimated day - it needs market depth, which Dhan does not keep. Days the server saw live have it." />
                    : <DepthHeatmap columns={heatShown.columns} rowSize={heatShown.row} trades={largeTrades} icebergs={view?.icebergs} signals={heatSignals} marks={heatMarks} vwap={heatmapVwap} lotSize={lotSize} showLots={showLots} height={narrow ? 320 : 440} />}
                  {!estimated && (
                    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                      How to read: time runs left to right, price bottom to top. The colour is the size of resting limit orders at that price
                      (blue = little, yellow to red = a lot) - bids below the price line, offers above. A bright band that price stops at and that STAYS = a real
                      wall (support / resistance); one that vanishes as price gets near = pulled / spoofed (not real). Price eating through a
                      bright band = absorption won - the move usually continues. Dots = big trades (bigger = larger), magenta = icebergs
                      (hidden size refilling). Drawn on it: S / R = the support / resistance walls that stay, blue bands = low-liquidity
                      (thin) zones, dotted gold = sudden OI walls. The liquidity map below reads it for you.
                    </Text>
                  )}
                </Card>

                <Card size="small" title="Liquidity map · support / resistance, zones, confluence, what is happening now" extra={!narrow && <Text type="secondary" style={{ fontSize: 11 }}>from the heatmap, OI walls, profiles and VWAP</Text>}>
                  <LiquidityMapCard map={liqMap} sudden={sudden} basis={basis} estimated={estimated} />
                </Card>

                <Card size="small" title={`Delta & cumulative delta · ${timeframe} min`}
                  extra={shown.priorCount > 0 && <Tooltip title="The server started recording after the 09:15 open, so the minutes before it are estimated from Dhan's 1-minute candles (dimmed bars). Everything after is exact tick data."><Tag color="orange">09:15 → start estimated</Tag></Tooltip>}>
                  <CumulativeDeltaChart bars={shown.chartBars} dayKey={dayKey} lotSize={lotSize} showLots={showLots} height={narrow ? 200 : 260} />
                </Card>

                <ProfilesCard prevDate={prevSession.data?.date} prevVp={prevVp} todayVp={todayVp} prevTpo={prevTpo} todayTpo={todayTpo} lastPrice={meta?.lastPrice}
                  loading={prevSession.loading} estimatedPrev={prevSession.data?.source === 'estimated'} lotSize={lotSize} showLots={showLots} height={narrow ? 340 : 440} />
            </Space>
          </Col>
          <Col xs={24} xl={7}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <OrderFlowRead bias={bias} />
              <Card size="small" title={`Market depth${meta && !estimated ? ` (${meta.depthLevels} levels)` : ''}`}>
                {estimated
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No market depth for an estimated day - Dhan keeps no depth history." />
                  : <BookLadder book={view?.book} walls={walls} icebergPrices={activeIcebergs} lotSize={lotSize} showLots={showLots} />}
              </Card>
              <TapeCard
                prints={tapePrints} aggression={aggressionNow} pressure={pullStack.pressure} sweeps={view?.sweeps} lotSize={lotSize}
                largeLots={bigLots} error={tape.error} estimated={estimated}
              />
              <Card size="small" title={`Signals${shownSignals.length !== signals.length ? ` · ${shownSignals.length}/${signals.length}` : ''}`} styles={{ body: { maxHeight: 360, overflowY: 'auto' } }}
                extra={(
                  <Space size={6} wrap style={{ justifyContent: 'flex-end' }}>
                    <Select
                      mode="multiple" size="small" allowClear maxTagCount="responsive" placeholder="All types" style={{ minWidth: 150, maxWidth: 240 }}
                      value={signalTypes} onChange={setSignalTypes} options={signalTypeOptions} aria-label="Signal types"
                    />
                    <Select
                      size="small" value={signalSide} onChange={setSignalSide} style={{ width: 96 }} aria-label="Signal direction"
                      options={[{ value: 'all', label: 'Both' }, { value: 'bullish', label: 'Bullish' }, { value: 'bearish', label: 'Bearish' }]}
                    />
                    <InputNumber size="small" min={0} max={100} step={10} value={signalMinConfidence} onChange={(v) => setSignalMinConfidence(v ?? 0)} style={{ width: 118 }} addonBefore="≥" addonAfter="%" aria-label="Minimum confidence" />
                  </Space>
                )}>
                {signals.length === 0 ? <Text type="secondary">No signals yet.</Text> : shownSignals.length === 0 ? <Text type="secondary">No signals match the filter.</Text> : shownSignals.map((s) => (
                  <div key={s.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '3px 0', borderBottom: '1px solid #ffffff0d' }}>
                    <Text type="secondary" style={{ fontSize: 11, minWidth: 58 }}>{IST_HHMMSS.format(new Date(s.time))}</Text>
                    <Tag color={s.bullish ? 'green' : 'red'} style={{ margin: 0, fontSize: 11 }}>{s.type}</Tag>
                    <span>
                      {s.text}
                      {s.confidence != null && <Tag color={s.confidence >= 70 ? 'gold' : 'default'} style={{ marginLeft: 6, fontSize: 10 }}>{s.confidence}% confidence</Tag>}
                    </span>
                  </div>
                ))}
              </Card>
            </Space>
          </Col>
        </Row>

        <StrategyScanner
          underlying={underlying} isReplay={isReplay} date={isReplay ? replayDate : todayKey()} view={view} replayDay={replayDay} replayMs={replayMs} range={range}
          tapePrints={tapePrints} liquidity={liquidity} pullStack={pullStack.signals} rowSize={rowSize} lotSize={lotSize} largeLots={bigLots} estimated={noDepth}
          profile={scannerProfile} oi={dayOi} oiError={dayOiError} canTradeLive={canTradeLive}
          isAdmin={auth?.user?.role === 'Admin'} orderFlowSettings={orderFlowSettings}
        />

        <ServerScannerCard isAdmin={auth?.user?.role === 'Admin'} focus={underlying} />

        <Text type="secondary" style={{ fontSize: 11, color: AXIS_COLOR }}>
          Trades are inferred from Dhan's tick feed: the rise in the day's volume between two ticks is the volume traded, at the tick's price, and
          its side comes from the book just before it - at or above the best offer = buyers aggressive, at or below the best bid = sellers
          aggressive, otherwise by tick direction. Dhan itself says its WebSocket is event-based snapshot data delivered second by second, not tick-by-tick, so several trades between two snapshots count as one print (at the last price, on one side) - the footprint rows and delta can therefore differ from a tick-by-tick chart such as GoCharting. Imbalance compares diagonally (buying
          at a price vs selling one row below); a stack is that many imbalanced rows in a row. Absorption = heavy aggression at a bar's
          extreme that failed to push price on (A); exhaustion = almost nothing traded at the extreme (E). An iceberg is a level that keeps
          trading more than twice the most it ever showed while staying in the book. Walls are levels at least 4x the book's median size.
          The volume profile is the traded volume per row over the bars shown, with its point of control (POC) and the 70% value area
          (VAH-VAL). Load day replays any date: exactly when the server saw it live (today, or the last few days in its memory - green dot in
          the calendar; nothing is stored on disk), otherwise estimated from Dhan&apos;s 1-minute candles, since Dhan keeps no historical tick or depth
          data: delta from each minute&apos;s price move, volume spread over its range, absorption = a high-volume minute that failed to move
          price, exhaustion = a new high/low on thin volume, big dots = volume spikes. The heatmap&apos;s book is 200 levels a side for NSE futures,
          5 for SENSEX.
        </Text>
        <DomDrawer open={domOpen} onClose={() => setDomOpen(false)} underlying={underlying} />
      </Space>
    </div>
  )
}

const HHMMSS = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })

/** Which market depth the page has: the book that has ARRIVED (meta.depthLevels) and, live, the
 *  connection the contract is on (meta.depthFeed) - so a 200-level connection that is open but has no
 *  book yet (market closed) or that Dhan refused is told apart from a contract with no deeper depth. */
function DepthBadge({ meta, live }) {
  const feed = live ? meta.depthFeed : null
  const got = meta.depthLevels
  const last = feed?.lastBookAt ? ` Last book ${HHMMSS.format(new Date(feed.lastBookAt))} IST.` : ''
  let color = got >= 200 ? 'green' : got >= 20 ? 'blue' : 'orange'
  let label = `${got}-level depth`
  let tip = got >= 200 ? "Dhan's full market depth: 200 levels a side." : got >= 20 ? "Dhan's 20-level depth." : 'The 5 levels in each market feed packet.'
  if (feed && feed.levels > got) {
    if (feed.connected) {
      color = 'cyan'
      label = `${feed.levels}-level connected · waiting for the book`
      tip = `The ${feed.levels}-level depth connection is open, but no book has arrived on it yet - Dhan streams the book while the market trades (09:15-15:30 IST, trading days). Until then the market feed's 5 levels are shown.${last}${feed.note ? ` ${feed.note}` : ''}`
    } else {
      color = 'orange'
      label = `${feed.levels}-level not connected`
      tip = `The ${feed.levels}-level depth connection is not open - reconnecting.${feed.note ? ` ${feed.note}` : ''}${last} Showing the market feed's ${got} levels meanwhile.`
    }
  } else if (feed?.note) {
    tip = `${tip} ${feed.note}${last}`
  } else if (last) {
    tip += last
  }
  return (
    <Tooltip title={tip}>
      <Tag color={color} aria-label="Depth status">{label}</Tag>
    </Tooltip>
  )
}
