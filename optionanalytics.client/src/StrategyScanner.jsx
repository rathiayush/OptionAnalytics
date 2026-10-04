import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, InputNumber, Popconfirm, Progress, Row, Segmented, Space, Switch, Table, Tag, Tooltip, Typography, notification } from 'antd'
import { SoundOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import {
  STRATEGIES, STRATEGY_BY_ID, buildOiContext, evaluateStrategies, simulateOutcome, strategyStats, topFifteen, MIN_TRADES_TO_RANK, oiSummary, optionOiText,
  DEFAULT_TRAIL, LAST_ENTRY, SQUARE_OFF, fmtHm, exitLabel,
} from './strategyEngine.js'
import { aggregateBars, analyzeBars, findWalls, liquiditySignals, pullStackSignals, replayView } from './orderFlowMath.js'

const { Text } = Typography
const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const MIN = 60_000
// One alert per strategy and direction at most every 20 minutes - a setup that stays true is one trade.
const COOLDOWN_MS = 20 * MIN
const SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'
const HISTORY_KEY = 'optionanalytics.strategyScanner.history.v1'
const MAX_DAYS_KEPT = 60
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full / blocked */ }
}

let audioCtx = null
function unlockAudio() {
  try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.() } catch { /* no audio */ }
}
function chime(up) {
  try {
    unlockAudio()
    const ctx = audioCtx
    const notes = up ? [660, 880, 1100] : [1100, 880, 660]
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const at = ctx.currentTime + i * 0.16
      osc.type = 'triangle'
      osc.frequency.value = f
      gain.gain.setValueAtTime(0.001, at)
      gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.15)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.16)
    })
  } catch { /* audio blocked - the notification still shows */ }
}
function speak(text) {
  try {
    if (!window.speechSynthesis) return
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    window.speechSynthesis.speak(u)
  } catch { /* no speech */ }
}

// 1-minute analyzed bars that had COMPLETED by `nowMs`.
function completedBars(minuteBars, nowMs, rowSize, lotSize, estimated) {
  const done = (minuteBars ?? []).filter((b) => msOf(b.time) + MIN <= nowMs)
  return analyzeBars(aggregateBars(done, 1), { rowSize, minVolume: lotSize, estimated })
}

function upTo(prints, ms) {
  if (!prints?.length) return prints
  let lo = 0
  let hi = prints.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (msOf(prints[mid].time) <= ms) lo = mid + 1; else hi = mid }
  return prints.slice(0, lo)
}

// The trailing stop a new setup gets from the scanner's settings (null = a fixed stop).
const trailFor = (cfg) => (cfg.trail?.on === false ? null : { startR: cfg.trail?.startR ?? DEFAULT_TRAIL.startR, gapR: cfg.trail?.gapR ?? DEFAULT_TRAIL.gapR })
const trailText = (trail) => (trail ? `trailing SL: after +${trail.startR}R the stop follows ${trail.gapR}R behind the best price` : 'fixed SL')

function fmtR(r) {
  return r == null ? '-' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`
}

/**
 * The strategy scanner on the Order Flow page: runs the OI + order flow playbook's 10 strategies on the
 * live data (or at the replay clock), alerts with a sound, the strategy's name spoken and a notification
 * for the chosen ones (the top 5 by default), scores every setup by what the futures did next, and
 * ranks the strategies over every day scored so far. "Scan day" runs a whole loaded day at once.
 */
export function StrategyScanner({ underlying, isReplay, date, view, replayDay, replayMs, range, tapePrints, liquidity, pullStack, rowSize, lotSize, largeLots, estimated, profile }) {
  const [settings, setSettings] = useState(() => {
    const saved = { alerts: true, sound: true, voice: true, pick: 'top15', custom: [], trail: { on: true, ...DEFAULT_TRAIL }, ...readJson(SETTINGS_KEY, {}) }
    // Older saved settings used 'top5' (from when there were only the first 10).
    return saved.pick === 'top5' ? { ...saved, pick: 'top15' } : saved
  })
  useEffect(() => writeJson(SETTINGS_KEY, settings), [settings])
  const [history, setHistory] = useState(() => readJson(HISTORY_KEY, {}))
  const [oiRun, setOiRun] = useState(null)
  const [oiError, setOiError] = useState(null)
  const [expiryDate, setExpiryDate] = useState(null)
  const [fired, setFired] = useState([])
  const [scan, setScan] = useState(null) // { progress, error }
  const dayKey = `${underlying}:${date}`
  const firedRef = useRef([])
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  // OI for the day - the same data OI Replay loads. Live: refreshed every 5 minutes (OI moves slowly;
  // the strategies read 10-45 minute OI changes).
  useEffect(() => {
    if (!date) return undefined
    let cancelled = false
    const flag = underlying === 'BANKNIFTY' ? 'MONTH' : 'WEEK'
    const load = () => {
      const params = new URLSearchParams({ date, timeframeMinutes: '1', expiryFlag: flag, ...(isReplay ? {} : { forceLive: 'true' }) })
      fetch(`/api/oi-replay/${underlying}/run?${params}`)
        .then((r) => r.json())
        .then((body) => {
          if (cancelled) return
          if (!body?.success) { setOiError(body?.error ?? 'OI data unavailable'); return }
          setOiRun(body)
          setOiError(null)
        })
        .catch((err) => { if (!cancelled) setOiError(err.message) })
    }
    setOiRun(null)
    load()
    fetch(`/api/oi-replay/${underlying}/expiries`).then((r) => r.json()).then((b) => {
      if (!cancelled) setExpiryDate(underlying === 'BANKNIFTY' ? b?.month ?? null : b?.week ?? null)
    }).catch(() => {})
    const id = isReplay ? null : setInterval(load, 2 * MIN)
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [underlying, date, isReplay])
  const oi = useMemo(() => buildOiContext(oiRun, expiryDate), [oiRun, expiryDate])

  // A new day / underlying / mode starts a fresh list (the day's saved results are in `history`).
  useEffect(() => { firedRef.current = []; setFired([]) }, [dayKey, isReplay])

  const stats = useMemo(() => strategyStats(Object.values(history).flatMap((d) => d.setups ?? [])), [history])
  const top = useMemo(() => topFifteen(stats), [stats])
  const alertIds = settings.pick === 'top15' ? top.ids : settings.pick === 'oi5' ? top.oi.ids : settings.pick === 'profile5' ? top.profile.ids : settings.custom
  const alertIdsRef = useRef(alertIds)
  useEffect(() => { alertIdsRef.current = alertIds }, [alertIds])

  const liveNow = view?.heatmap?.at(-1)?.t ?? (view?.meta?.lastTradeAt ? msOf(view.meta.lastTradeAt) : Date.now())
  const nowMs = isReplay ? replayMs : liveNow
  const minuteKey = nowMs ? Math.floor(nowMs / 10_000) : 0 // evaluate every 10 s of market time
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const oiNow = useMemo(() => (oi && nowMs ? oiSummary(oi, nowMs) : null), [oi, minuteKey])

  useEffect(() => {
    if (!oi || !view?.minuteBars?.length || !nowMs) return
    // The replay clock went back: forget setups after it so they can fire again.
    if (isReplay && firedRef.current.some((f) => f.t > nowMs)) {
      firedRef.current = firedRef.current.filter((f) => f.t <= nowMs)
      setFired(firedRef.current)
    }
    // An exact day's tape must have caught up with the clock (a replay jump fetches it afresh) -
    // judging aggression on a stale tape would be judging the wrong minute.
    if (!estimated && !(tapePrints?.length && msOf(tapePrints.at(-1).time) >= nowMs - 3 * MIN)) return
    const bars = completedBars(view.minuteBars, nowMs, rowSize, lotSize, estimated)
    if (bars.length < 5) return
    const setups = evaluateStrategies({
      nowMs, price: view.meta?.lastPrice || bars.at(-1).close, bars, minuteBars: view.minuteBars, prints: estimated ? null : tapePrints,
      book: view.book, walls: findWalls(view.book), liquidity, pullStack, sweeps: view.sweeps, icebergs: view.icebergs, oi, estimated, lotSize, bigLots: largeLots, profile,
    })
    const fresh = setups.filter((s) => !firedRef.current.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS))
      .map((s) => ({ ...s, trail: trailFor(settingsRef.current) }))
    if (!fresh.length) return
    firedRef.current = [...firedRef.current, ...fresh]
    setFired(firedRef.current)
    const cfg = settingsRef.current
    for (const s of fresh) {
      if (!cfg.alerts || !alertIdsRef.current.includes(s.id)) continue
      const meta = STRATEGY_BY_ID[s.id]
      if (cfg.sound) chime(s.side === 'LONG')
      if (cfg.voice) speak(`${meta.short}. ${s.side === 'LONG' ? 'Long' : 'Short'}.`)
      notification.open({
        key: `${s.id}-${s.t}`, placement: 'topRight', duration: 12,
        message: <span style={{ color: s.side === 'LONG' ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>#{meta.no} {meta.name} · {s.side}</span>,
        description: (
          <div style={{ fontSize: 12 }}>
            <div>{IST_HHMM.format(new Date(s.t))} · futures {s.entry.toFixed(1)} · stop {s.stop.toFixed(1)} · target {s.target.toFixed(1)} · {s.confidence}%</div>
            <div>{trailText(s.trail)}{s.trail ? ` (from ${(s.entry + (s.side === 'LONG' ? 1 : -1) * s.trail.startR * Math.abs(s.entry - s.stop)).toFixed(1)})` : ''} · closed by {fmtHm(SQUARE_OFF)} at the latest</div>
            {Object.entries(s.checks).map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}
          </div>
        ),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oi, minuteKey, view?.minuteBars?.length, estimated, tapePrints?.at(-1)?.seq, profile])

  // Outcomes for today's setups so far; saved into the day's history as they resolve.
  const withOutcome = useMemo(
    () => fired.map((s) => ({ ...s, outcome: simulateOutcome(s, view?.minuteBars ?? [], nowMs ?? 0) })),
    [fired, view?.minuteBars, nowMs],
  )

  // Every alerted setup is followed to its end: when its target, stop-loss (fixed or trailed) or time
  // stop / the 15:10 cut-off is hit, another alert says so (sound, the name spoken, a notification), and
  // while it runs, each time the trailing stop moves up by half a risk unit or more an alert gives the new
  // stop - a hands-free day-trading loop.
  const closedRef = useRef(new Set())
  const trailAlertRef = useRef(new Map())
  useEffect(() => { closedRef.current = new Set(); trailAlertRef.current = new Map() }, [dayKey, isReplay])
  useEffect(() => {
    const cfg = settingsRef.current
    for (const s of withOutcome) {
      const key = `${s.id}-${s.t}`
      if (s.outcome.status === 'open' && s.outcome.trailed && !closedRef.current.has(key)) {
        const risk = Math.abs(s.entry - s.stop)
        const last = trailAlertRef.current.get(key) ?? s.stop
        if (Math.abs(s.outcome.stop - last) < 0.5 * risk - 1e-9) continue
        trailAlertRef.current.set(key, s.outcome.stop)
        if (!cfg.alerts || !alertIdsRef.current.includes(s.id)) continue
        const meta = STRATEGY_BY_ID[s.id]
        const dir = s.side === 'LONG' ? 1 : -1
        const locked = (dir * (s.outcome.stop - s.entry)) / risk
        const what = Math.abs(locked) < 0.005 ? 'to breakeven' : `to ${s.outcome.stop.toFixed(1)}`
        if (cfg.sound) chime(true)
        if (cfg.voice) speak(`Trail stop ${Math.abs(locked) < 0.005 ? 'to breakeven' : ''}. ${meta.short}.`)
        notification.open({
          key: `${key}-trail`, placement: 'topRight', duration: 12,
          message: <span style={{ fontWeight: 700 }}>Move SL {what} · #{meta.no} {meta.name} · {s.side}</span>,
          description: (
            <div style={{ fontSize: 12 }}>
              entry {s.entry.toFixed(1)} · new stop <b>{s.outcome.stop.toFixed(1)}</b> (was {last.toFixed(1)}) · locks {fmtR(locked)} · target {s.target.toFixed(1)}
            </div>
          ),
        })
        continue
      }
      if (s.outcome.status === 'open' || closedRef.current.has(key)) continue
      closedRef.current.add(key)
      if (!cfg.alerts || !alertIdsRef.current.includes(s.id)) continue
      const meta = STRATEGY_BY_ID[s.id]
      const hit = exitLabel(s.outcome)
      const good = s.outcome.r > 0
      if (cfg.sound) chime(good)
      if (cfg.voice) speak(`${hit}. ${meta.short}. ${good ? 'Plus' : 'Minus'} ${Math.abs(s.outcome.r).toFixed(1)} R.`)
      notification.open({
        key: `${key}-exit`, placement: 'topRight', duration: 15,
        message: <span style={{ color: good ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>{hit} · #{meta.no} {meta.name} · {s.side}</span>,
        description: (
          <div style={{ fontSize: 12 }}>
            entry {s.entry.toFixed(1)} at {IST_HHMM.format(new Date(s.t))} · {s.outcome.exitAt ? `exit ${IST_HHMM.format(new Date(s.outcome.exitAt))} · ` : ''}
            stop {s.outcome.trailed ? `${s.outcome.stop.toFixed(1)} (trailed from ${s.stop.toFixed(1)})` : s.stop.toFixed(1)} · target {s.target.toFixed(1)} · <b>{fmtR(s.outcome.r)}</b>
          </div>
        ),
      })
    }
  }, [withOutcome])
  useEffect(() => {
    if (!withOutcome.length || !date) return
    setHistory((prev) => {
      const prior = prev[dayKey]
      // A scanned day keeps its full-day scan; live / replay results only fill a day not scanned.
      if (prior?.scanned) return prev
      const next = { ...prev, [dayKey]: { underlying, date, estimated, setups: withOutcome } }
      writeJson(HISTORY_KEY, trimHistory(next))
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withOutcome.map((s) => `${s.id}${s.t}${s.outcome.status}`).join()])

  // ---- Scan day: the whole loaded day, minute by minute -------------------------------------------
  const scanDay = async () => {
    if (!replayDay || !range || !oi) return
    setScan({ progress: 0 })
    try {
      let prints = null
      if (!estimated) {
        const body = await fetch(`/api/order-flow/${underlying}/tape?date=${date}&count=60000`).then((r) => r.json())
        prints = body?.prints ?? []
      }
      const found = []
      const start = range.start + 15 * MIN
      const steps = Math.max(1, Math.floor((range.end - start) / MIN))
      for (let i = 0; i <= steps; i++) {
        const clock = start + i * MIN
        const v = replayView(replayDay, clock)
        const bars = completedBars(v.minuteBars, clock, rowSize, lotSize, estimated)
        if (bars.length >= 5) {
          const cols = v.heatmap.slice(-300)
          const liq = estimated ? [] : liquiditySignals({ columns: cols, trades: v.trades, minuteBars: v.minuteBars, rowSize, lotSize })
          const ps = estimated ? { signals: [] } : pullStackSignals({ columns: cols.slice(-60), rowSize, lotSize })
          const setups = evaluateStrategies({
            nowMs: clock, price: v.meta.lastPrice || bars.at(-1).close, bars, minuteBars: v.minuteBars, prints: prints ? upTo(prints, clock) : null,
            book: v.book, liquidity: liq, pullStack: ps.signals, sweeps: v.sweeps, icebergs: v.icebergs, oi, estimated, lotSize, bigLots: largeLots, profile,
          })
          for (const s of setups) {
            if (!found.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS)) found.push({ ...s, trail: trailFor(settingsRef.current) })
          }
        }
        if (i % 10 === 0) {
          setScan({ progress: Math.round((i / steps) * 100) })
          await new Promise((r) => setTimeout(r, 0))
        }
      }
      const setups = found.map((s) => ({ ...s, outcome: simulateOutcome(s, replayDay.minuteBars, range.end + MIN, true) }))
      setHistory((prev) => {
        const next = { ...prev, [dayKey]: { underlying, date, estimated, scanned: true, setups } }
        writeJson(HISTORY_KEY, trimHistory(next))
        return next
      })
      setScan({ progress: 100, done: setups.length })
    } catch (err) {
      setScan({ error: err.message })
    }
  }

  const dayResults = history[dayKey]?.scanned ? history[dayKey].setups : withOutcome
  const days = Object.values(history)
  const statRows = stats.map((s) => ({ ...s, key: s.id, top: alertIds.includes(s.id) }))
  const statColumns = [
    { title: '#', dataIndex: 'no', width: 34 },
    {
      title: 'Strategy', dataIndex: 'name',
      render: (name, r) => <span>{r.top && <Tag color="gold" style={{ marginRight: 4 }}>alert</Tag>}{name}{r.group === 'profile' && <Tag style={{ marginLeft: 4, fontSize: 10 }}>profile</Tag>}</span>,
    },
    { title: 'Trades', dataIndex: 'trades', width: 64 },
    { title: 'Win %', dataIndex: 'winRate', width: 66, render: (v) => (v == null ? '-' : `${Math.round(v * 100)}%`) },
    { title: 'Avg R', dataIndex: 'avgR', width: 72, render: (v) => <span style={{ color: v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined }}>{fmtR(v)}</span> },
    { title: 'Total R', dataIndex: 'totalR', width: 76, render: (v, r) => (r.trades ? fmtR(v) : '-') },
    { title: 'Best', dataIndex: 'bestR', width: 64, render: (v, r) => (r.trades ? fmtR(v) : '-') },
    { title: 'PF', dataIndex: 'profitFactor', width: 56, render: (v) => (v == null ? '-' : v === Infinity ? '∞' : v.toFixed(2)) },
  ]
  const toggleCustom = (id, on) => setSettings((s) => ({ ...s, custom: on ? [...new Set([...s.custom, id])] : s.custom.filter((x) => x !== id) }))

  return (
    <Card
      size="small" title="Strategy scanner · OI, order flow, volume & market profile (15 strategies)"
      extra={(
        <Space size={10} wrap>
          <Space size={4}><Switch size="small" checked={settings.alerts} onChange={(v) => { unlockAudio(); setSettings((s) => ({ ...s, alerts: v })) }} /><Text style={{ fontSize: 12 }}>Alerts</Text></Space>
          <Space size={4}><Switch size="small" checked={settings.sound} onChange={(v) => { unlockAudio(); setSettings((s) => ({ ...s, sound: v })) }} /><Text style={{ fontSize: 12 }}>Sound</Text></Space>
          <Space size={4}><Switch size="small" checked={settings.voice} onChange={(v) => setSettings((s) => ({ ...s, voice: v }))} /><Text style={{ fontSize: 12 }}>Speak name</Text></Space>
          <Button size="small" icon={<SoundOutlined />} onClick={() => { unlockAudio(); chime(true); speak('Alerts are on') }}>Test</Button>
        </Space>
      )}
    >
      {oiError && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`OI for ${date} could not be loaded - the strategies need it: ${oiError}`} />}
      {oiNow && (
        <div style={{ fontSize: 12, marginBottom: 8, padding: '6px 8px', border: '1px solid #ffffff1f', borderRadius: 6, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }} aria-label="OI now">
          <span><Text strong style={{ fontSize: 12 }}>Options OI</Text>{' '}
            <span style={{ color: oiNow.options?.lean > 0.002 ? UP_COLOR : oiNow.options?.lean < -0.002 ? DOWN_COLOR : undefined }}>
              {oiNow.options?.lean > 0.002 ? 'put writing leads (bullish)' : oiNow.options?.lean < -0.002 ? 'call writing leads (bearish)' : 'balanced'}
            </span> · {optionOiText(oiNow.options)}</span>
          <span>Walls: support <b style={{ color: UP_COLOR }}>{oiNow.support ?? '-'}</b>{oiNow.supportChg != null ? ` (${oiNow.supportChg >= 0 ? '+' : ''}${(oiNow.supportChg / 1e5).toFixed(1)}L)` : ''}
            {' '}· resistance <b style={{ color: DOWN_COLOR }}>{oiNow.resistance ?? '-'}</b>{oiNow.resistanceChg != null ? ` (${oiNow.resistanceChg >= 0 ? '+' : ''}${(oiNow.resistanceChg / 1e5).toFixed(1)}L)` : ''}
            {' '}· max pain <b>{oiNow.maxPain ?? '-'}</b></span>
          <span><Text strong style={{ fontSize: 12 }}>Futures OI</Text> {oiNow.futures?.regime
            ? `${oiNow.futures.regime} (price ${(oiNow.futures.pricePct * 100).toFixed(2)}%, OI ${(oiNow.futures.oiPct * 100).toFixed(2)}% in 15m)` : '-'}</span>
        </div>
      )}
      {estimated && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Estimated day: no tape, book or heatmap - tape checks use each minute's estimated buy/sell split and the DOM / Heatmap confirmation is waived. Results are marked est." />}
      <Row gutter={[16, 12]}>
        <Col xs={24} xl={10}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space wrap size={8}>
              <Text style={{ fontSize: 12 }}>Alert on</Text>
              <Segmented size="small" value={settings.pick} onChange={(v) => setSettings((s) => ({ ...s, pick: v }))}
                options={[
                  { value: 'top15', label: `Top 15${top.measured ? ' (measured)' : ''}` },
                  { value: 'oi5', label: 'Top 5 OI + flow' },
                  { value: 'profile5', label: 'Top 5 profile' },
                  { value: 'custom', label: 'My choice' },
                ]} />
            </Space>
            <Space wrap size={8} aria-label="Exits">
              <Space size={4}><Switch size="small" checked={settings.trail?.on !== false} onChange={(v) => setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, on: v } }))} /><Text style={{ fontSize: 12 }}>Trailing SL</Text></Space>
              {settings.trail?.on !== false && (
                <>
                  <Text style={{ fontSize: 12 }}>after +</Text>
                  <InputNumber size="small" min={0.25} max={5} step={0.25} style={{ width: 70 }} value={settings.trail?.startR ?? DEFAULT_TRAIL.startR} aria-label="Trail starts at R"
                    onChange={(v) => v != null && setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, startR: v } }))} />
                  <Text style={{ fontSize: 12 }}>R, follow</Text>
                  <InputNumber size="small" min={0.25} max={5} step={0.25} style={{ width: 70 }} value={settings.trail?.gapR ?? DEFAULT_TRAIL.gapR} aria-label="Trail distance in R"
                    onChange={(v) => v != null && setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, gapR: v } }))} />
                  <Text style={{ fontSize: 12 }}>R behind</Text>
                </>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>Entries 09:30-{fmtHm(LAST_ENTRY)} · every trade closed by <b>{fmtHm(SQUARE_OFF)}</b></Text>
            </Space>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
              {STRATEGIES.map((s) => (
                <Checkbox key={s.id} checked={alertIds.includes(s.id)} disabled={settings.pick !== 'custom'} onChange={(e) => toggleCustom(s.id, e.target.checked)} style={{ fontSize: 12 }}>
                  {s.no}. {s.short}
                </Checkbox>
              ))}
            </div>
            <Space wrap size={8}>
              <Tooltip title={isReplay ? 'Runs all 10 strategies over the whole loaded day and scores every setup - adds the day to the stats' : 'Load a past day (Load day) to scan it'}>
                <Button type="primary" size="small" onClick={scanDay} disabled={!isReplay || !replayDay || !oi || (scan && scan.progress < 100 && !scan.error)}>Scan day</Button>
              </Tooltip>
              {scan && !scan.error && scan.progress < 100 && <Progress percent={scan.progress} size="small" style={{ width: 140, margin: 0 }} />}
              {scan?.done != null && <Text type="secondary" style={{ fontSize: 12 }}>{scan.done} setup(s) scored for {date}</Text>}
              {scan?.error && <Text type="danger" style={{ fontSize: 12 }}>{scan.error}</Text>}
              <Popconfirm title="Clear every saved strategy result?" onConfirm={() => { setHistory({}); writeJson(HISTORY_KEY, {}) }}>
                <Button size="small" danger>Reset stats</Button>
              </Popconfirm>
            </Space>
            <div style={{ maxHeight: 260, overflowY: 'auto' }} aria-label="Strategy setups">
              {dayResults.length === 0
                ? <Text type="secondary" style={{ fontSize: 12 }}>{oi ? 'No setup yet today.' : 'Loading OI…'}</Text>
                : [...dayResults].reverse().map((s) => {
                  const meta = STRATEGY_BY_ID[s.id]
                  const o = s.outcome
                  return (
                    <Tooltip key={`${s.id}-${s.t}`} title={<div style={{ fontSize: 12 }}>{Object.entries(s.checks).map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}</div>}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, padding: '3px 0', borderBottom: '1px solid #ffffff0d' }}>
                        <Text type="secondary" style={{ fontSize: 11, minWidth: 38 }}>{IST_HHMM.format(new Date(s.t))}</Text>
                        <Tag color={s.side === 'LONG' ? 'green' : 'red'} style={{ margin: 0, fontSize: 11 }}>{s.side}</Tag>
                        <span style={{ flex: 1 }}>#{meta.no} {meta.short} <Text type="secondary" style={{ fontSize: 11 }}>@ {s.entry.toFixed(1)} · SL {o.trailed ? <>{s.stop.toFixed(1)} → <b>{o.stop.toFixed(1)}</b></> : s.stop.toFixed(1)}{s.trail ? ' (trail)' : ''} · T {s.target.toFixed(1)} · {s.confidence}%{s.estimated ? ' · est.' : ''}</Text></span>
                        <Tooltip title={exitLabel(o)}>
                          <Tag color={o.status === 'win' ? 'success' : o.status === 'loss' ? 'error' : o.status === 'flat' ? 'default' : 'processing'} style={{ margin: 0, fontSize: 11 }}>
                            {o.status === 'open' ? `open ${fmtR(o.r)}` : `${o.status} ${fmtR(o.r)}${o.squareOff ? ` (${fmtHm(SQUARE_OFF)})` : o.timeStop ? ' (time)' : o.stopHit && o.trailed ? ' (trail)' : ''}`}
                          </Tag>
                        </Tooltip>
                      </div>
                    </Tooltip>
                  )
                })}
            </div>
          </Space>
        </Col>
        <Col xs={24} xl={14}>
          <Table size="small" pagination={false} columns={statColumns} dataSource={statRows} scroll={{ x: 560 }} />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {days.length} day(s) scored ({days.filter((d) => d.estimated).length} estimated). Ranked by average R per trade (win rate × size of the wins), shrunk for small samples;
            {' '}a strategy needs {MIN_TRADES_TO_RANK}+ trades to be ranked - until enough are, the playbook&apos;s picks fill each group's top 5 (OI + order flow, and profile). A strategy losing on average is never alerted. Every alert carries its stop-loss and target, a trailing-SL alert gives each new stop, and another alert follows when the stop, target or the {fmtHm(SQUARE_OFF)} cut-off ends the trade. Outcomes are the FUTURES move to
            {' '}the setup&apos;s stop (trailed as set when it fired) / target / time stop, closed by {fmtHm(SQUARE_OFF)} at the latest (stop counted first when one minute touches both), not option P&amp;L; past results do not promise future ones.
          </Text>
        </Col>
      </Row>
    </Card>
  )
}

function trimHistory(history) {
  const keys = Object.keys(history).sort((a, b) => (history[a].date < history[b].date ? 1 : -1))
  return Object.fromEntries(keys.slice(0, MAX_DAYS_KEPT).map((k) => [k, history[k]]))
}
