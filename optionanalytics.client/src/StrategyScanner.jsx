import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, InputNumber, Modal, Popconfirm, Popover, Progress, Row, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, notification } from 'antd'
import { SettingOutlined, SoundOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { PAPER_TRADE_LOT_SIZE } from './oiShared.jsx'
import { liveTradingApi } from './LiveTrading.jsx'
import { chime, speak, telegram, unlockAudio } from './alerts.js'
import { notifyLiveTradeEvents, notifyTrade } from './tradeNotify.js'
import { loadTradeLevels, saveTradeLevels } from './tradeDefaults.js'
import { suddenWallText } from './suddenOi.js'
import { adaptiveStats } from './dayRegime.js'
import { chargeRates, tradeCharges } from './tradeCharges.js'
import {
  ACTIVE_STRATEGIES, STRATEGY_BY_ID, evaluateStrategies, simulateOutcome, strategyStats, topFifteen, MIN_TRADES_TO_RANK, oiSummary, optionOiText,
  DEFAULT_TRAIL, LAST_ENTRY, SQUARE_OFF, fmtHm, exitLabel, premiumAt, optionPnlPoints, optionTradeText, squareOffMs, optionStopTargetHit, RANGE_IDS, asReplayContext,
  coolOffGate, gradeOf, optionTradeAt, dayTypeAt, trailPoints, STRATEGY_FILTERS, strategyFilters, changedFilters,
} from './strategyEngine.js'
import { aggregateBars, analyzeBars, findWalls, liquiditySignals, pullStackSignals, replayRange, replayView } from './orderFlowMath.js'

const { Text } = Typography
const ALL_IDS = ACTIVE_STRATEGIES.map((s) => s.id)
const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const MIN = 60_000
// One alert per strategy and direction at most every 20 minutes - a setup that stays true is one trade.
const COOLDOWN_MS = 20 * MIN
const SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'
// v2: results saved before replays took the price at the clock (they entered every setup of a replayed
// day at one stale price) are not carried over.
const HISTORY_KEY = 'optionanalytics.strategyScanner.history.v2'
const PAPER_KEY = 'optionanalytics.strategyScanner.paper.v1'
// Today's fired setups (live), so a page refresh shows them again and does not re-alert them.
const FIRED_KEY = 'optionanalytics.strategyScanner.fired.v1'
// The trades box's Paper / Live (Dhan) choice, kept across reloads (Auto-place is NOT - it is confirmed again).
const TRADE_MODE_KEY = 'optionanalytics.strategyScanner.tradeMode'
// Paper trades whose exit has gone to Telegram, per day.
const TG_SENT_KEY = 'optionanalytics.strategyScanner.telegramSent.v1'

const MAX_DAYS_KEPT = 60
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full / blocked */ }
}

// 1-minute analyzed bars that had COMPLETED by `nowMs`.
function completedBars(minuteBars, nowMs, rowSize, lotSize, estimated) {
  const done = (minuteBars ?? []).filter((b) => msOf(b.time) + MIN <= nowMs)
  return analyzeBars(aggregateBars(done, 1), { rowSize, minVolume: lotSize, estimated })
}

// The futures price at the clock: the tape's last print (it has every print) when it is recent, else
// the view's own last price.
function priceAt(view, prints, ms, bars) {
  const p = prints?.at(-1)
  if (p && p.price > 0 && msOf(p.time) <= ms && msOf(p.time) >= ms - 2 * MIN) return p.price
  return view?.meta?.lastPrice || bars.at(-1).close
}

// A paper / live option trade's own premium stop-loss and target levels, as they stand.
function levelsText(r, settings) {
  const sell = r.action === 'SELL'
  const sl = r.slPts ?? settings.paperSl ?? 20
  const tg = r.targetPts ?? settings.paperTarget ?? 30
  const targetLevel = sell ? r.premium - tg : r.premium + tg
  // A SELL can make at most its whole premium: a target bigger than that is never reached.
  const trailGap = r.trailGap ?? settings.paperTrailGap ?? 0
  const trailStart = r.trailStart ?? settings.paperTrailStart ?? 0
  const parts = [sl > 0 && `SL ${(sell ? r.premium + sl : r.premium - sl).toFixed(1)}`, tg > 0 && (targetLevel > 0 ? `T ${targetLevel.toFixed(1)}` : `T unreachable (${tg} pts > premium)`),
    trailGap > 0 && `trail ${trailGap} pts after +${trailStart}`].filter(Boolean)
  return parts.length ? ` · ${parts.join(' / ')}` : ''
}

function upTo(prints, ms) {
  if (!prints?.length) return prints
  let lo = 0
  let hi = prints.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (msOf(prints[mid].time) <= ms) lo = mid + 1; else hi = mid }
  return prints.slice(0, lo)
}

// The trailing stop a new setup gets from the scanner's settings (null = a fixed stop).
// Trailing SL in futures (index) POINTS by default - "after +start pts, follow gap pts behind the best
// price" - set per underlying (its points move differently); or in R (x the trade's own risk).
const DEFAULT_TRAIL_PTS = { NIFTY: { start: 30, gap: 30 }, BANKNIFTY: { start: 75, gap: 75 }, SENSEX: { start: 100, gap: 100 } }
const FALLBACK_TRAIL_PTS = { start: 30, gap: 30 }
const trailUnit = (cfg) => (cfg.trail?.unit === 'R' ? 'R' : 'pts')
const trailPtsFor = (cfg, underlying) => {
  const key = String(underlying ?? '').toUpperCase()
  return { ...(DEFAULT_TRAIL_PTS[key] ?? FALLBACK_TRAIL_PTS), ...cfg.trail?.pts?.[key] }
}
const trailFor = (cfg, underlying) => {
  if (cfg.trail?.on === false) return null
  const pts = trailPtsFor(cfg, underlying)
  return {
    startR: cfg.trail?.startR ?? DEFAULT_TRAIL.startR, gapR: cfg.trail?.gapR ?? DEFAULT_TRAIL.gapR,
    ...(trailUnit(cfg) === 'pts' ? { unit: 'pts', startPts: pts.start, gapPts: pts.gap } : {}),
    ...(cfg.trail?.runner ? { runner: true } : {}),
  }
}
// The totals per underlying from the server's CSV files (every saved day, every device) - GET /api/scanner-log/summary.
const loadSummary = (set) => fetch('/api/scanner-log/summary').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.totals) set(j.totals) }).catch(() => { /* shown when it loads */ })
const ptsText = (v) => `${v >= 0 ? '+' : ''}${(v ?? 0).toFixed(1)} pts`
const trailText = (trail) => (trail
  ? `trailing SL: after +${trail.unit === 'pts' ? `${trail.startPts} pts` : `${trail.startR}R`} the stop follows ${trail.unit === 'pts' ? `${trail.gapPts} pts` : `${trail.gapR}R`} behind the best price${trail.runner ? ' - letting it run (no fixed target / time stop, out on the trail or at 15:10)' : ''}`
  : 'fixed SL')

function fmtR(r) {
  return r == null ? '-' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`
}

/**
 * The strategy scanner on the Order Flow page: runs the OI + order flow playbook's 10 strategies on the
 * live data (or at the replay clock), alerts with a sound, the strategy's name spoken and a notification
 * for the chosen ones (the top 5 by default), scores every setup by what the futures did next, and
 * ranks the strategies over every day scored so far. "Scan day" runs a whole loaded day at once.
 */
// A setup's hover: its levels in bold first, then every check (Confidence with its parts first).
function setupTip(s, o = null) {
  const meta = STRATEGY_BY_ID[s.id]
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>
        #{meta?.no} {meta?.name} · {s.side} @ {s.entry.toFixed(1)}
        <div><b>SL {s.stop.toFixed(1)}</b>{o?.trailed ? <> → <b>{o.stop.toFixed(1)}</b> (trailed)</> : ''} · <b>Target {s.target.toFixed(1)}</b> · <b>{s.confidence}% {s.grade ?? gradeOf(s.confidence)}</b></div>
      </div>
      {Object.entries(s.checks).map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}
    </div>
  )
}

export function StrategyScanner({ underlying, isReplay, date, view, replayDay, replayMs, range, tapePrints, liquidity, pullStack, rowSize, lotSize, largeLots, estimated, profile, oi, oiError, canTradeLive = false }) {
  const [settings, setSettings] = useState(() => {
    const saved = { alerts: true, sound: true, voice: true, telegram: true, pick: 'top15', custom: [], filters: {}, trail: { on: true, ...DEFAULT_TRAIL }, autoPaper: 'sell', paperLots: 1, paperSl: 20, paperTarget: 30, liveSlippage: 2, maxLiveTrades: 5, maxLiveLoss: 10000, ...readJson(SETTINGS_KEY, {}) }
    // Older saved settings used 'top5' (from when there were only the first 10).
    // Every alert paper-sells its option by default (settings saved before that default had 'off').
    if (!saved.autoPaperSellDefault) Object.assign(saved, { autoPaper: 'sell', autoPaperSellDefault: true })
    // The option Max SL / Target are per underlying (tradeDefaults.js - BANKNIFTY's premiums move ~2.5x
    // NIFTY's): this underlying's saved levels, else its defaults.
    const levels = loadTradeLevels('scanner', underlying)
    Object.assign(saved, { paperSl: levels.sl, paperTarget: levels.target, paperTrailStart: levels.trailStart, paperTrailGap: levels.trailGap })
    return saved.pick === 'top5' ? { ...saved, pick: 'top15' } : saved
  })
  useEffect(() => writeJson(SETTINGS_KEY, settings), [settings])
  // Another underlying: its own Max SL / Target (open trades keep the levels they have).
  useEffect(() => {
    const levels = loadTradeLevels('scanner', underlying)
    setSettings((s) => (s.paperSl === levels.sl && s.paperTarget === levels.target && s.paperTrailStart === levels.trailStart && s.paperTrailGap === levels.trailGap
      ? s : { ...s, paperSl: levels.sl, paperTarget: levels.target, paperTrailStart: levels.trailStart, paperTrailGap: levels.trailGap }))
  }, [underlying])
  const [history, setHistory] = useState(() => readJson(HISTORY_KEY, {}))
  const [fired, setFired] = useState([])
  const [scan, setScan] = useState(null) // { progress, error }
  const dayKey = `${underlying}:${date}`
  const firedRef = useRef([])
  // Setups held while price cools off after running too far too fast into them (coolOffGate).
  const pendingRef = useRef(new Map())
  const [cooling, setCooling] = useState([])
  // Squeezes the OI shows that have not fired yet, with what is still missing (input.watch).
  const [watch, setWatch] = useState([])
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  // Paper option trades punched from setups (by hand, or automatically on each alert), per day. Each
  // follows its setup: it is closed when the setup's stop / target / trailing SL / 15:10 cut-off ends
  // it, at that minute's premium - or by hand. Paper only: no order is ever sent.
  const [paperBook, setPaperBook] = useState(() => readJson(PAPER_KEY, {}))
  useEffect(() => writeJson(PAPER_KEY, trimPaper(paperBook)), [paperBook])
  // Live (Dhan) mode - admins, today's live view only; never remembered across reloads. In it the trades
  // box holds REAL trades: S / B (confirmed) place a super order, and "Auto-place on alert" (its own
  // confirmed switch, off by default) places one on every alert within the day's limits.
  const [tradeMode, setTradeModeState] = useState(() => { try { return localStorage.getItem(TRADE_MODE_KEY) === 'live' ? 'live' : 'paper' } catch { return 'paper' } })
  const setTradeMode = (mode) => { try { localStorage.setItem(TRADE_MODE_KEY, mode) } catch { /* convenience only */ } setTradeModeState(mode) }
  const [autoLive, setAutoLive] = useState(false)
  const liveModeRef = useRef({ mode: 'paper', auto: false })
  useEffect(() => { liveModeRef.current = { mode: canTradeLive ? tradeMode : 'paper', auto: canTradeLive && tradeMode === 'live' && autoLive } }, [canTradeLive, tradeMode, autoLive])
  // Not an admin / not today's live view (or still loading who you are): paper - the saved choice stays
  // for when live trading is available again. Auto-place always needs confirming again.
  useEffect(() => { if (!canTradeLive) setAutoLive(false) }, [canTradeLive])
  const paperBookRef = useRef(paperBook)
  useEffect(() => { paperBookRef.current = paperBook }, [paperBook])
  const liveLossRef = useRef(0)
  const placingRef = useRef(new Set())
  // Keys of live orders already placed - set the moment Dhan answers, before the paper book (and its
  // ref, updated after the next render) shows the position: a second alert for the same signal in
  // that gap must not place it again.
  const placedRef = useRef(new Set())
  useEffect(() => { placedRef.current = new Set() }, [dayKey])
  const sameSignal = (p, setup, trade) => p.strategy === setup.id && p.setupSide === setup.side && p.action === trade.action && Math.abs(setupTimeOf(p) - setup.t) < COOLDOWN_MS

  // The option a setup is traded with: ATM, or the strike the trader picked (ITM / OTM) - paper and live.
  const tradeOf = (setup, which) => optionTradeAt(oi, setup, which, settingsRef.current.moneyness ?? 0)
  const placeLive = async (setup, which) => {
    const trade = tradeOf(setup, which)
    const cfg = settingsRef.current
    const fail = (description) => notification.error({ message: 'Live order not placed', description, placement: 'topRight', duration: 10 })
    if (!trade) return fail('No option premium for this setup yet.')
    if (!oi?.expiry) return fail('The option expiry is not known yet (OI still loading).')
    if (!(cfg.paperSl > 0) || !(cfg.paperTarget > 0)) return fail('A live trade is a Dhan super order - set both Max SL and Target above 0.')
    const list = paperBookRef.current[dayKey]?.positions ?? []
    const key = `${setup.id}-${setup.t}-${which}`
    if (list.some((p) => sameSignal(p, setup, trade)) || placingRef.current.has(key) || placedRef.current.has(key)) return
    // Orders still on their way count too - two alerts in the same moment must not both pass the limit.
    // ...and so do orders Dhan took whose positions the book has not shown yet.
    const liveCount = list.filter((p) => p.live).length + placingRef.current.size + [...placedRef.current].filter((k) => !list.some((p) => p.key === k)).length
    if (liveCount >= (cfg.maxLiveTrades ?? 5)) return fail(`The day's limit of ${cfg.maxLiveTrades} live trades is reached.`)
    if (liveLossRef.current <= -(cfg.maxLiveLoss ?? 10000)) return fail(`The day's live loss limit (₹${(cfg.maxLiveLoss ?? 10000).toLocaleString('en-IN')}) is reached.`)
    placingRef.current.add(key)
    const lots = Math.max(1, cfg.paperLots ?? 1)
    // A trade Dhan took (all of it, or the slices before a rejection) is recorded, so the setup's exit
    // closes it - an untracked live position would never be exited by the scanner.
    const record = (result, note) => {
      placedRef.current.add(key)
      const position = {
        key, setupKey: `${setup.id}-${setup.t}`, setupT: setup.t, strategy: setup.id, setupSide: setup.side, adaptive: setup.adaptive ?? null, regime: setup.regime ?? null, action: trade.action, side: trade.side, strike: trade.strike,
        // The contract's real lot size from Dhan's contract list (the table is only a fallback).
        lots, lotSize: result.lotSize ?? PAPER_TRADE_LOT_SIZE[underlying] ?? 1, premium: result.prices?.limit ?? trade.premium, slPts: cfg.paperSl, targetPts: cfg.paperTarget, trailStart: cfg.paperTrailStart ?? 0, trailGap: cfg.paperTrailGap ?? 0,
        entryTime: nowMsRef.current ?? Date.now(), exitTime: null, exitPremium: null, exitReason: null,
        live: true, orderIds: result.orderIds ?? [], liveNote: note ?? result.message,
      }
      setPaperBook((prev) => ({ ...prev, [dayKey]: { date, positions: [...(prev[dayKey]?.positions ?? []), position] } }))
      return position
    }
    try {
      const result = await liveTradingApi.place({
        underlying, expiry: oi.expiry, strike: trade.strike, side: trade.side, direction: trade.action, lots,
        slippagePoints: cfg.liveSlippage ?? 2, stopLossPoints: cfg.paperSl, targetPoints: cfg.paperTarget,
        trailStartPoints: cfg.paperTrailGap > 0 ? cfg.paperTrailStart ?? 0 : 0, trailGapPoints: cfg.paperTrailGap ?? 0,
        // The server closes it itself at the setup's time stop (15:10 at the latest) - even with this page
        // closed; the page's own exits (stop, target, trailing SL) still close it sooner when they come.
        exitAtMs: Math.min(setup.timeStopMs ?? squareOffMs(setup.t), squareOffMs(setup.t)), exitReason: `time stop of #${STRATEGY_BY_ID[setup.id]?.no} ${STRATEGY_BY_ID[setup.id]?.short ?? setup.id}`,
      })
      const position = record(result)
      notifyTrade({ kind: 'entry', title: `LIVE ${trade.action} ${trade.strike} ${trade.side} x${lots} placed on Dhan`, text: result.message, sound: cfg.sound !== false })
      if (cfg.telegram !== false) telegram(`LIVE order placed: ${trade.action} ${underlying} ${trade.strike} ${trade.side} x${lots} lot(s) @ ~${position.premium.toFixed(1)} - #${STRATEGY_BY_ID[setup.id]?.no} ${STRATEGY_BY_ID[setup.id]?.name} ${setup.side}, futures ${setup.entry.toFixed(1)} (SL ${setup.stop.toFixed(1)}, target ${setup.target.toFixed(1)}); option SL ${cfg.paperSl} / target ${cfg.paperTarget} pts`)
    } catch (err) {
      if (err.result?.orderIds?.length) {
        // Part of it went through: keep it (so it is exited with its setup) and say so loudly.
        record(err.result, `PARTLY placed - ${err.message}`)
        notification.warning({ message: `LIVE order only partly placed: ${trade.action} ${trade.strike} ${trade.side}`, description: `${err.message} - the placed part is tracked and exits with its setup; check the Dhan panel.`, placement: 'topRight', duration: 0 })
        if (cfg.telegram !== false) telegram(`LIVE order PARTLY placed: ${trade.action} ${underlying} ${trade.strike} ${trade.side} - ${err.message}`)
      } else fail(err.message)
    } finally {
      placingRef.current.delete(key)
    }
  }

  const punchRef = useRef(null)
  punchRef.current = (setup, which, atMs, opts = {}) => {
    if (liveModeRef.current.mode === 'live') {
      const trade = tradeOf(setup, which)
      if (opts.auto) { placeLive(setup, which); return }
      Modal.confirm({
        title: `Place a REAL order on Dhan?`,
        content: trade ? `${trade.action} ${underlying} ${trade.strike} ${trade.side} x${settingsRef.current.paperLots ?? 1} lot(s) - a super order with SL ${settingsRef.current.paperSl} / target ${settingsRef.current.paperTarget} premium points.` : 'No option for this setup.',
        okText: 'Place order', okButtonProps: { danger: true }, cancelText: 'Cancel',
        onOk: () => placeLive(setup, which),
      })
      return
    }
    const trade = tradeOf(setup, which)
    if (!trade || !oi) return
    const at = atMs ?? setup.t
    const premium = premiumAt(oi, trade.side, trade.strike, at) ?? trade.premium
    const lots = Math.max(1, settingsRef.current.paperLots ?? 1)
    const already = (paperBookRef.current[dayKey]?.positions ?? []).some((p) => sameSignal(p, setup, trade))
    if (!already) {
      const meta = STRATEGY_BY_ID[setup.id]
      notifyTrade({ kind: 'entry', key: `paper-${setup.id}-${setup.t}-${which}`, sound: false,
        title: `Paper ${trade.action} ${trade.strike} ${trade.side} x${lots} @ ${premium.toFixed(1)}`,
        text: `#${meta?.no} ${meta?.name} ${setup.side} · option SL ${settingsRef.current.paperSl ?? 20} / target ${settingsRef.current.paperTarget ?? 30} pts` })
    }
    if (!already && !isReplay && settingsRef.current.telegram !== false) {
      const meta = STRATEGY_BY_ID[setup.id]
      telegram(`Paper ${trade.action} ${underlying} ${trade.strike} ${trade.side} x${lots} lot(s) @ ${premium.toFixed(1)} - #${meta?.no} ${meta?.name} ${setup.side}, futures ${setup.entry.toFixed(1)} (SL ${setup.stop.toFixed(1)}, target ${setup.target.toFixed(1)}); option SL ${settingsRef.current.paperSl ?? 20} / target ${settingsRef.current.paperTarget ?? 30} pts`)
    }
    setPaperBook((prev) => {
      const list = prev[dayKey]?.positions ?? []
      const key = `${setup.id}-${setup.t}-${which}`
      // ONE paper trade per signal: the same strategy, direction and side (buy / sell) within the
      // alert cooldown is the same signal - a replayed day re-fires its alerts a few seconds apart, and
      // must not open it again.
      if (list.some((p) => sameSignal(p, setup, trade))) return prev
      const position = {
        key, setupKey: `${setup.id}-${setup.t}`, setupT: setup.t, strategy: setup.id, setupSide: setup.side, adaptive: setup.adaptive ?? null, regime: setup.regime ?? null, action: trade.action, side: trade.side, strike: trade.strike,
        lots, lotSize: PAPER_TRADE_LOT_SIZE[underlying] ?? 1, premium, slPts: settingsRef.current.paperSl ?? 20, targetPts: settingsRef.current.paperTarget ?? 30,
        trailStart: settingsRef.current.paperTrailStart ?? 0, trailGap: settingsRef.current.paperTrailGap ?? 0, entryTime: at, exitTime: null, exitPremium: null, exitReason: null,
      }
      return { ...prev, [dayKey]: { date, positions: [...list, position] } }
    })
  }
  // A live trade's exit: its own super order cancelled (or its legs) and only its quantity closed on
  // Dhan - see LiveTradingService.ExitTradeAsync. Sent once; the row keeps what Dhan answered.
  const markPosition = (key, patch) => setPaperBook((prev) => {
    const day = prev[dayKey]
    if (!day) return prev
    return { ...prev, [dayKey]: { ...day, positions: day.positions.map((p) => (p.key === key ? { ...p, ...patch } : p)) } }
  })
  // A live trade's exit goes to Dhan once: the exit effect, the Exit button and the Dhan check can all
  // reach it in the same moment (before the row shows exitSent).
  const exitingRef = useRef(new Set())
  const exitLive = (row, reason) => {
    if (exitingRef.current.has(row.key)) return
    exitingRef.current.add(row.key)
    const atMs = row.exitTime ?? nowMsRef.current ?? Date.now()
    const premium = row.exitTime ? row.current : premiumAt(oi, row.side, row.strike, atMs) ?? row.current
    markPosition(row.key, { exitSent: true, exitError: null, exitTime: atMs, exitPremium: premium, exitReason: reason })
    if (settingsRef.current.telegram !== false) telegram(`LIVE exit: ${row.action === 'SELL' ? 'buy back' : 'sell'} ${underlying} ${row.strike} ${row.side} x${row.lots} - ${reason}${premium != null ? ` (~${Number(premium).toFixed(1)})` : ''}`)
    liveTradingApi.exitTrade(row.orderIds ?? [], settingsRef.current.liveSlippage ?? 2)
      .then((result) => markPosition(row.key, { liveNote: result.message }))
      .catch((err) => {
        exitingRef.current.delete(row.key) // failed: Exit can be pressed again
        markPosition(row.key, { exitError: err.message })
        notification.error({ message: `Live exit failed: ${row.strike} ${row.side}`, description: `${err.message} - check the Dhan panel and press Exit again.`, placement: 'topRight', duration: 0 })
      })
  }
  const exitPaper = (key) => setPaperBook((prev) => {
    const list = prev[dayKey]?.positions ?? []
    return {
      ...prev,
      [dayKey]: {
        date,
        positions: list.map((p) => {
          if (p.key !== key || p.exitTime) return p
          const now = premiumAt(oi, p.side, p.strike, nowMs)
          return now == null ? p : { ...p, exitTime: nowMs, exitPremium: now, exitReason: 'Exited by hand' }
        }),
      },
    }
  })

  // A new day / underlying / mode starts a fresh list (the day's saved results are in `history`).
  // Live: today's setups so far come back after a page refresh (and are not alerted again); a replay
  // starts empty.
  const restoredRef = useRef(new Set())
  useEffect(() => {
    const saved = !isReplay ? readJson(FIRED_KEY, {})[dayKey] ?? [] : []
    restoredRef.current = new Set(saved.map((f) => `${f.id}-${f.t}`))
    firedRef.current = saved
    pendingRef.current = new Map()
    setCooling([])
    setWatch([])
    setFired(saved)
  }, [dayKey, isReplay])
  useEffect(() => {
    if (isReplay || !date) return
    writeJson(FIRED_KEY, { [dayKey]: fired })
  }, [fired, isReplay, dayKey, date])

  const stats = useMemo(() => strategyStats(Object.values(history).flatMap((d) => d.setups ?? [])), [history])
  const top = useMemo(() => topFifteen(stats), [stats])
  const top15Ids = useMemo(() => [...top.ids, ...top.trial], [top])
  const alertIds = settings.pick === 'top15' ? top15Ids : settings.pick === 'oi5' ? top.oi.ids : settings.pick === 'profile5' ? top.profile.ids
    : settings.pick === 'range' ? RANGE_IDS : settings.pick === 'all' ? ALL_IDS : settings.custom
  const alertIdsRef = useRef(alertIds)
  useEffect(() => { alertIdsRef.current = alertIds }, [alertIds])

  const liveNow = view?.heatmap?.at(-1)?.t ?? (view?.meta?.lastTradeAt ? msOf(view.meta.lastTradeAt) : Date.now())
  const nowMs = isReplay ? replayMs : liveNow
  const minuteKey = nowMs ? Math.floor(nowMs / 10_000) : 0 // evaluate every 10 s of market time
  const nowMsRef = useRef(nowMs)
  useEffect(() => { nowMsRef.current = nowMs }, [nowMs])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const oiNow = useMemo(() => (oi && nowMs ? oiSummary(oi, nowMs) : null), [oi, minuteKey])
  // The day type at the clock (completed bars only) - shown, and tagged on every setup for the adaptive
  // what-if. Tracking only: it never stops a trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const regimeNow = useMemo(() => (nowMs && view?.minuteBars?.length ? dayTypeAt(oi, view.minuteBars, nowMs) : null), [oi, minuteKey, view?.minuteBars?.length])

  useEffect(() => {
    if (!oi || !view?.minuteBars?.length || !nowMs) return
    // The replay clock went back: forget setups after it so they can fire again.
    if (isReplay && firedRef.current.some((f) => f.t > nowMs)) {
      firedRef.current = firedRef.current.filter((f) => f.t <= nowMs)
      setFired(firedRef.current)
    }
    if (isReplay && [...pendingRef.current.values()].some((p) => p.setup.t > nowMs)) {
      pendingRef.current = new Map()
      setCooling([])
    }
    // An exact day's tape must have caught up with the clock (a replay jump fetches it afresh) -
    // judging aggression on a stale tape would be judging the wrong minute.
    if (!estimated && !(tapePrints?.length && msOf(tapePrints.at(-1).time) >= nowMs - 3 * MIN)) return
    const bars = completedBars(view.minuteBars, nowMs, rowSize, lotSize, estimated)
    if (bars.length < 5) return
    const price = priceAt(view, estimated ? null : tapePrints, nowMs, bars)
    const watchNow = []
    const setups = evaluateStrategies({
      nowMs, price, bars, minuteBars: view.minuteBars, prints: estimated ? null : tapePrints,
      book: view.book, walls: findWalls(view.book), liquidity, pullStack, sweeps: view.sweeps, icebergs: view.icebergs, oi, estimated, lotSize, bigLots: largeLots, profile, watch: watchNow, heatmap: view.heatmap, rowSize,
      filters: settingsRef.current.filters,
    })
    const watching = watchNow.filter((w) => w.missing.length)
    setWatch((prev) => (JSON.stringify(prev.map((w) => [w.id, w.side, w.missing])) === JSON.stringify(watching.map((w) => [w.id, w.side, w.missing])) ? prev : watching))
    const recentlyFired = (s) => firedRef.current.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS)
    // Price ran too far too fast into a setup: it is held and entered on the pullback / pause.
    const gate = coolOffGate(pendingRef.current, setups.filter((s) => !recentlyFired(s)), { nowMs, price, bars, oi })
    const held = [...pendingRef.current.values()].map((p) => p.setup)
    setCooling((prev) => (prev.map((x) => `${x.id}${x.side}${x.t}`).join() === held.map((x) => `${x.id}${x.side}${x.t}`).join() ? prev : held))
    const fresh = gate.fire.filter((s) => !recentlyFired(s))
      .map((s) => ({ ...s, trail: trailFor(settingsRef.current, underlying) }))
    if (!fresh.length) return
    firedRef.current = [...firedRef.current, ...fresh]
    setFired(firedRef.current)
    const cfg = settingsRef.current
    for (const s of fresh) {
      if (!cfg.alerts || !alertIdsRef.current.includes(s.id)) continue
      const meta = STRATEGY_BY_ID[s.id]
      // The moment it alerts, the option is punched (the sell side by default): on paper, or - in Live
      // mode with Auto-place on - as a real Dhan super order.
      const live = liveModeRef.current
      const side = cfg.autoPaper === 'buy' || cfg.autoPaper === 'sell' ? cfg.autoPaper : null
      const autoTrade = side && (live.mode !== 'live' || live.auto) ? tradeOf(s, side) : null
      if (autoTrade) punchRef.current?.(s, side, s.t, { auto: true })
      if (cfg.sound) chime(s.side === 'LONG')
      if (cfg.voice) speak(`${meta.short}. ${s.side === 'LONG' ? 'Long' : 'Short'}.${autoTrade ? ` ${autoTrade.action === 'SELL' ? 'Sold' : 'Bought'} ${autoTrade.strike} ${autoTrade.side === 'CE' ? 'call' : 'put'}.` : ''}`)
      notification.open({
        key: `${s.id}-${s.t}`, placement: 'topRight', duration: 12,
        message: <span style={{ color: s.side === 'LONG' ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>#{meta.no} {meta.name} · {s.side}</span>,
        description: (
          <div style={{ fontSize: 12 }}>
            <div style={{ fontSize: 13 }}>{IST_HHMM.format(new Date(s.t))} · futures {s.entry.toFixed(1)} · <b>SL {s.stop.toFixed(1)}</b> · <b>Target {s.target.toFixed(1)}</b> · <b>{s.confidence}% {s.grade ?? gradeOf(s.confidence)}</b></div>
            {s.signal && <div>Waited for the cool-off: signal at {IST_HHMM.format(new Date(s.signal.t))} @ {s.signal.entry.toFixed(1)}</div>}
            <div>{trailText(s.trail)}{s.trail ? ` (from ${(s.entry + (s.side === 'LONG' ? 1 : -1) * trailPoints(s.trail, Math.abs(s.entry - s.stop)).start).toFixed(1)})` : ''} · closed by {fmtHm(SQUARE_OFF)} at the latest</div>
            {s.options && (
              <div style={{ margin: '4px 0' }}>
                <b>Option:</b> {[optionTradeText(tradeOf(s, 'buy')), optionTradeText(tradeOf(s, 'sell'))].filter(Boolean).join(' · or ')}
                {autoTrade && <Text strong style={{ fontSize: 11, color: autoTrade.action === 'SELL' ? DOWN_COLOR : UP_COLOR }}> · {live.mode === 'live' ? 'LIVE order sent:' : 'paper'} {autoTrade.action === 'SELL' ? 'SOLD' : 'BOUGHT'} {autoTrade.strike} {autoTrade.side}</Text>}
                {!autoTrade && (
                  <span style={{ marginLeft: 6 }}>
                    {s.options.buy && <Button size="small" type="link" style={{ padding: '0 4px', height: 18 }} onClick={() => punchRef.current?.(s, 'buy', s.t)}>{live.mode === 'live' ? 'LIVE buy' : 'Paper buy'} {s.options.buy.side}</Button>}
                    {s.options.sell && <Button size="small" type="link" danger style={{ padding: '0 4px', height: 18 }} onClick={() => punchRef.current?.(s, 'sell', s.t)}>{live.mode === 'live' ? 'LIVE sell' : 'Paper sell'} {s.options.sell.side}</Button>}
                  </span>
                )}
              </div>
            )}
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
  useEffect(() => { closedRef.current = new Set(); trailAlertRef.current = new Map(); primedRef.current = new Set() }, [dayKey, isReplay])
  const primedRef = useRef(new Set())
  useEffect(() => {
    const cfg = settingsRef.current
    for (const s of withOutcome) {
      const key = `${s.id}-${s.t}`
      // Brought back after a refresh: what already happened to it was alerted before - only what
      // happens from now on is.
      if (restoredRef.current.has(key) && !primedRef.current.has(key)) {
        // ...judged once the day's bars are in (before that every outcome still reads "open").
        if (!view?.minuteBars?.length) continue
        primedRef.current.add(key)
        if (s.outcome.status !== 'open') closedRef.current.add(key)
        else if (s.outcome.trailed) trailAlertRef.current.set(key, s.outcome.stop)
        continue
      }
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
      // Telegram: a setup with an option trade is reported by that trade's own exit message (below).
      const traded = (paperBookRef.current[dayKey]?.positions ?? []).some((p) => p.setupKey === key || (p.strategy === s.id && p.setupSide === s.side && Math.abs(setupTimeOf(p) - s.t) < 2 * MIN))
      if (!isReplay && cfg.telegram !== false && !traded) {
        telegram(`${hit}: #${meta.no} ${meta.name} ${s.side} - entry ${s.entry.toFixed(1)}, out ${s.outcome.exitPrice != null ? s.outcome.exitPrice.toFixed(1) : '-'} (${good ? '+' : ''}${s.outcome.r.toFixed(2)}R)`)
      }
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
  }, [withOutcome, view?.minuteBars?.length, dayKey, isReplay])
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
    if (!oi || (isReplay && (!replayDay || !range))) return
    setScan({ progress: 0 })
    try {
      // Live: today so far - the day as the server holds it now (the live view keeps only its latest
      // heatmap), read minute by minute like a replay, outcomes followed up to now.
      let day = replayDay
      let dayRange = range
      let scanOi = oi
      const until = isReplay ? null : nowMsRef.current ?? Date.now()
      if (!isReplay) {
        const body = await fetch(`/api/order-flow/${underlying}/day/${date}?rowSize=${rowSize}&minTradeLots=${Math.min(5, largeLots)}&heatmapColumns=1500`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('today\'s order flow could not be loaded'))))
        day = {
          meta: body.meta, minuteBars: body.bars ?? [], trades: body.trades ?? [], icebergs: body.icebergs ?? [], sweeps: body.sweeps ?? [],
          heatmap: (body.heatmap ?? []).map((c) => ({ t: new Date(c.time).getTime(), bids: c.bids, asks: c.asks })), source: body.source,
        }
        dayRange = replayRange(day)
        if (!dayRange) throw new Error('no trading today yet')
        scanOi = asReplayContext(oi)
      }
      let prints = null
      if (!estimated) {
        const body = await fetch(`/api/order-flow/${underlying}/tape?date=${date}&count=60000`).then((r) => r.json())
        prints = body?.prints ?? []
      }
      const found = []
      const pending = new Map()
      // On whole minutes: each setup enters at the previous minute's close and its outcome counts from
      // the bar starting at its entry - the same as replaying to that minute.
      const start = Math.ceil((dayRange.start + 15 * MIN) / MIN) * MIN
      const steps = Math.max(1, Math.floor((dayRange.end - start) / MIN))
      for (let i = 0; i <= steps; i++) {
        const clock = start + i * MIN
        const v = replayView(day, clock)
        const bars = completedBars(v.minuteBars, clock, rowSize, lotSize, estimated)
        if (bars.length >= 5) {
          const cols = v.heatmap.slice(-300)
          const liq = estimated ? [] : liquiditySignals({ columns: cols, trades: v.trades, minuteBars: v.minuteBars, rowSize, lotSize })
          const ps = estimated ? { signals: [] } : pullStackSignals({ columns: cols.slice(-60), rowSize, lotSize })
          const clockPrints = prints ? upTo(prints, clock) : null
          const price = priceAt(v, clockPrints, clock, bars)
          const setups = evaluateStrategies({
            nowMs: clock, price, bars, minuteBars: v.minuteBars, prints: clockPrints,
            book: v.book, liquidity: liq, pullStack: ps.signals, sweeps: v.sweeps, icebergs: v.icebergs, oi: scanOi, estimated, lotSize, bigLots: largeLots, profile, heatmap: v.heatmap, rowSize,
            filters: settingsRef.current.filters,
          })
          const recentlyFound = (s) => found.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS)
          const gate = coolOffGate(pending, setups.filter((s) => !recentlyFound(s)), { nowMs: clock, price, bars, oi: scanOi })
          for (const s of gate.fire) {
            if (!recentlyFound(s)) found.push({ ...s, trail: trailFor(settingsRef.current, underlying) })
          }
        }
        if (i % 10 === 0) {
          setScan({ progress: Math.round((i / steps) * 100) })
          await new Promise((r) => setTimeout(r, 0))
        }
      }
      if (!isReplay) {
        // Today: the scan's setups join today's list (already over - not alerted), and keep being
        // followed live like the ones alerted.
        const merged = [...firedRef.current]
        for (const s of found) if (!merged.some((f) => f.id === s.id && f.side === s.side && Math.abs(s.t - f.t) < COOLDOWN_MS)) merged.push(s)
        merged.sort((a, b) => a.t - b.t)
        firedRef.current = merged
        for (const s of found) { restoredRef.current.add(`${s.id}-${s.t}`) }
        setFired(merged)
        setScan({ progress: 100, done: found.length, until })
        return
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
  // Today's signals as fired vs what an adaptive scanner would have taken (tracking only).
  const dayAdaptive = useMemo(() => adaptiveStats(dayResults), [dayResults])
  const dayTaken = dayResults.filter((s) => s.adaptive?.take).length
  const dayTagged = dayResults.filter((s) => s.adaptive).length
  const adaptiveView = settings.signalView === 'adaptive'
  const shownResults = adaptiveView ? dayResults.filter((s) => s.adaptive?.take !== false) : dayResults

  // The day's paper option positions, each closed by its setup's exit (or by hand), with P&L.
  const paperRows = useMemo(() => {
    // A position's setup: the alerted one (live / replay outcomes, followed up to the clock), else the
    // same strategy and side within two minutes in the day's list (a scanned day's setups are timed to
    // the minute, an alert to 10 s).
    const exact = new Map([...dayResults, ...withOutcome].map((s) => [`${s.id}-${s.t}`, s]))
    const setupOf = (p) => exact.get(p.setupKey) ?? [...withOutcome, ...dayResults]
      .filter((s) => s.id === p.strategy && s.side === p.setupSide && Math.abs(s.t - setupTimeOf(p)) < 2 * MIN)
      .sort((a, b) => Math.abs(a.t - p.entryTime) - Math.abs(b.t - p.entryTime))[0]
    const outcomeOf = (p) => setupOf(p)?.outcome
    // Paper trades are a what-if: every one of them - open or closed - is sized by the lots set now, so
    // the day's P&L is always at one size. A live (Dhan) trade keeps the quantity it was placed with.
    const paperLots = Math.max(1, settings.paperLots ?? 1)
    return (paperBook[dayKey]?.positions ?? []).filter((p) => !nowMs || p.entryTime <= nowMs).map((stored) => {
      // The adaptive call of the trade's signal (stored when punched; older trades look it up).
      const sig = stored.adaptive ? null : setupOf(stored)
      const tagged = { ...stored, adaptive: stored.adaptive ?? sig?.adaptive ?? null, regime: stored.regime ?? sig?.regime ?? null }
      const p = tagged.live ? tagged : { ...tagged, lots: paperLots }
      let exitTime = p.exitTime && p.exitTime <= (nowMs ?? Infinity) ? p.exitTime : null
      let exitPremium = exitTime ? p.exitPremium : null
      let exitReason = exitTime ? p.exitReason : null
      const o = outcomeOf(p)
      if (p.live && p.exitSent) {
        // A live trade whose exit has gone to Dhan keeps the exit it was sent with.
        const points = p.exitPremium == null ? null : p.action === 'BUY' ? p.exitPremium - p.premium : p.premium - p.exitPremium
        return { ...p, exitTime: p.exitTime, exitReason: p.exitReason, current: p.exitPremium, points, rupees: points == null ? null : points * p.lots * p.lotSize }
      }
      // The trade's own premium stop / target (positions from before they existed use today's setting),
      // checked up to the setup's exit - whichever comes first closes it.
      const setupExitAt = o && o.status !== 'open' ? (o.exitAt != null ? o.exitAt + MIN : squareOffMs(p.entryTime)) : Infinity
      const own = oi && setupExitAt > p.entryTime
        ? optionStopTargetHit(oi, p, p.entryTime, Math.min(setupExitAt, exitTime ?? Infinity, nowMs ?? Infinity), p.slPts ?? settings.paperSl ?? 20, p.targetPts ?? settings.paperTarget ?? 30,
          { start: p.trailStart ?? settings.paperTrailStart ?? 0, gap: p.trailGap ?? settings.paperTrailGap ?? 0 })
        : null
      if (own) { exitTime = own.at; exitPremium = own.premium; exitReason = own.reason }
      if (!exitTime && o && o.status !== 'open') {
        // Closed by its setup once the clock has passed the setup's exit (a scanned day's outcomes are
        // already known for the whole day; a trade still running when the data ended closes at 15:10).
        const exitAt = o.exitAt != null ? o.exitAt + MIN : squareOffMs(p.entryTime)
        if (exitAt <= p.entryTime) {
          // Punched after its setup had already ended (older positions): never a trade - flat at entry.
          exitTime = p.entryTime; exitPremium = p.premium; exitReason = 'Setup had already ended'
        } else {
          const at = nowMs == null || exitAt <= nowMs ? exitAt : null
          const premium = oi && at ? premiumAt(oi, p.side, p.strike, at) : null
          if (premium != null) { exitTime = at; exitPremium = premium; exitReason = exitLabel(o) }
        }
      }
      const now = exitTime ? { premium: exitPremium } : oi && nowMs ? { premium: premiumAt(oi, p.side, p.strike, nowMs) } : { premium: null }
      const points = now.premium == null ? null : p.action === 'BUY' ? now.premium - p.premium : p.premium - now.premium
      return { ...p, exitTime, exitReason, current: now.premium, points, rupees: points == null ? null : points * p.lots * p.lotSize }
    })
  }, [paperBook, dayKey, dayResults, withOutcome, oi, nowMs, settings.paperSl, settings.paperTarget, settings.paperTrailStart, settings.paperTrailGap, settings.paperLots])
  const paperRowsRef = useRef(paperRows)
  useEffect(() => { paperRowsRef.current = paperRows }, [paperRows])
  const paperTotal = paperRows.reduce((sum, r) => sum + (r.rupees ?? 0), 0)
  // The same trades as an adaptive scanner would have punched them (tracking only).
  // Costs: STT on the sell leg, brokerage per order, other per trade (tradeCharges.js) - net P&L, net per
  // lot and the points captured, for every trade and for the ones adaptive would have taken.
  const rates = chargeRates(settings.charges)
  const costsOf = (r) => tradeCharges(r, rates)
  const setRate = (key, v) => setSettings((x) => ({ ...x, charges: { ...chargeRates(x.charges), [key]: v } }))
  const rupee = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`
  const liveRows = paperRows.filter((r) => r.live)
  const liveTotal = liveRows.reduce((sum, r) => sum + (r.rupees ?? 0), 0)
  useEffect(() => { liveLossRef.current = liveTotal }, [liveTotal])

  // The day's record on the server - two CSV files, signals.csv and trades.csv, every day in each
  // (ScannerLogStore). Live - today's signals and option trades; a scanned past day - its signals (a
  // replay clock part-way through a day is not posted). Sent a few seconds after a signal appears or a
  // signal / trade closes - not on every tick of an open trade - and resent after a failure.
  const scannerLogRef = useRef({ sent: '', timer: null, latest: null })
  const [savedTotals, setSavedTotals] = useState(null)
  useEffect(() => { loadSummary(setSavedTotals) }, [])
  useEffect(() => {
    if (!date || !underlying) return
    if (isReplay && !history[dayKey]?.scanned) return
    const signals = dayResults.map((x) => {
      const o = x.outcome ?? {}
      const meta = STRATEGY_BY_ID[x.id]
      const closed = o.status && o.status !== 'open'
      return {
        time: x.t, strategyNo: meta?.no ?? null, strategyId: x.id, strategy: meta?.name ?? x.id, side: x.side, entry: x.entry, stop: x.stop, target: x.target,
        confidence: x.confidence ?? null, estimated: !!x.estimated, dayType: x.regime?.type ?? null, dayTypePrice: x.regime?.priceType ?? null,
        voteOi: x.regime?.votes?.oi ?? null, voteCvd: x.regime?.votes?.cvd ?? null, adaptiveTake: x.adaptive?.take ?? null,
        adaptivePriceOnly: x.adaptive?.priceOnly ?? null, adaptiveReason: x.adaptive?.reason ?? null, status: o.status ?? null, r: o.r ?? null,
        exitTime: closed ? o.exitAt ?? null : null, exitPrice: closed ? o.exitPrice ?? null : null, exitReason: closed ? exitLabel(o) : null,
      }
    })
    // Each trade names its signal: the exact one, else the same strategy and side within two minutes.
    const trades = isReplay ? [] : paperRows.map((r) => {
      const at = r.setupT ?? r.entryTime
      const sig = signals.find((x) => `${x.strategyId}-${x.time}` === r.setupKey)
        ?? signals.filter((x) => x.strategyId === r.strategy && x.side === r.setupSide && Math.abs(x.time - at) < 2 * MIN).sort((a, b) => Math.abs(a.time - at) - Math.abs(b.time - at))[0]
      return {
        key: r.key, entryTime: r.entryTime, exitTime: r.exitTime ?? null, live: !!r.live, action: r.action, option: r.side, strike: r.strike, lots: r.lots,
        lotSize: r.lotSize ?? null, entryPremium: r.premium, exitPremium: r.exitTime ? r.current ?? null : null, points: r.points ?? null, rupees: r.rupees ?? null,
        exitReason: r.exitReason ?? null, signalTime: sig?.time ?? at, strategyNo: STRATEGY_BY_ID[r.strategy]?.no ?? null, strategyId: r.strategy,
        signalSide: r.setupSide, dayType: r.regime?.type ?? null, adaptiveTake: r.adaptive?.take ?? null, adaptiveReason: r.adaptive?.reason ?? null,
        ...(() => { const c = tradeCharges(r, chargeRates(settingsRef.current.charges)); return c ? { stt: c.stt, brokerage: c.brokerage, otherCharges: c.other, netRupees: c.net, netPerLot: c.netPerLot } : {} })(),
      }
    })
    if (!signals.length && !trades.length) return
    const sig = JSON.stringify([dayKey, signals.map((x) => [x.strategyId, x.side, x.time, x.status, x.r]), trades.map((t) => [t.key, t.exitTime, t.exitTime ? t.points : null])])
    const st = scannerLogRef.current
    st.latest = { sig, body: { underlying, date, source: isReplay ? 'scan' : 'live', signals, trades } }
    if (sig === st.sent || st.timer) return
    st.timer = setTimeout(() => {
      st.timer = null
      const { sig: s2, body } = st.latest
      fetch('/api/scanner-log/day', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((res) => { if (res.ok) { st.sent = s2; loadSummary(setSavedTotals) } })
        .catch(() => { /* retried on the next change */ })
    }, 3000)
  }, [date, underlying, dayKey, isReplay, history, dayResults, paperRows])
  useEffect(() => () => clearTimeout(scannerLogRef.current.timer), [])
  // A live trade reaching its exit (its setup's stop / target / trailing SL / 15:10, or its own Max SL
  // / Target - which its super order legs also hold on Dhan) is closed on Dhan once. Only while this
  // page is open; the super order's own legs protect it either way.
  useEffect(() => {
    if (isReplay) return
    for (const r of paperRows) if (r.live && r.exitTime && !r.exitSent) exitLive(r, r.exitReason ?? 'Exit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperRows, isReplay])
  const tgPrimedRef = useRef(null)
  const exitNotifiedRef = useRef({ day: null, keys: new Set() })
  // A paper trade closing - its own Max SL / Target, or its setup's stop / target / trailing SL / time
  // exit - is announced once per trade: a notification with a chime (replays too) and, live, Telegram.
  // Kept per day, so a refresh does not announce it again. Live trades announce their exit when it goes
  // to Dhan (exitLive), and Dhan's own fills (SL / target legs) come as live trade events.
  useEffect(() => {
    if (!(oi && view?.minuteBars?.length) && tgPrimedRef.current !== dayKey) return // exits are not known yet
    const mem = exitNotifiedRef.current
    if (mem.day !== dayKey) {
      let stored = []
      if (!isReplay) { try { stored = JSON.parse(localStorage.getItem(TG_SENT_KEY) ?? '{}')[dayKey] ?? [] } catch { stored = [] } }
      exitNotifiedRef.current = { day: dayKey, keys: new Set(stored) }
    }
    const today = exitNotifiedRef.current.keys
    // The first look after the page opens: trades already closed by then are not news.
    const opening = tgPrimedRef.current !== dayKey
    if (opening) tgPrimedRef.current = dayKey
    const cfg = settingsRef.current
    let changed = false
    for (const r of paperRows) {
      if (r.live || !r.exitTime || !r.exitReason || today.has(r.key)) continue
      today.add(r.key)
      changed = true
      if (opening) continue
      const meta = STRATEGY_BY_ID[r.strategy]
      const result = `${r.action === 'SELL' ? 'sold' : 'bought'} ${underlying} ${r.strike} ${r.side} x${r.lots} @ ${r.premium.toFixed(1)} -> ${r.current != null ? r.current.toFixed(1) : '-'} = ${r.points != null ? `${r.points >= 0 ? '+' : ''}${r.points.toFixed(1)} pts, Rs ${Math.round(r.rupees).toLocaleString('en-IN')}` : '-'}`
      const reason = String(r.exitReason)
      const kind = /target/i.test(reason) ? 'target' : /\bSL\b|stop/i.test(reason) ? 'stopLoss' : 'exit'
      notifyTrade({ kind, good: (r.points ?? 0) >= 0, key: `paper-exit-${r.key}`, sound: cfg.sound !== false,
        title: `Paper exit - ${reason}`, text: `${result} (#${meta?.no} ${meta?.name})`,
        telegramText: !isReplay && cfg.telegram !== false ? `Paper exit - ${reason}: ${result} (#${meta?.no} ${meta?.name})` : null })
    }
    if (changed && !isReplay) { try { localStorage.setItem(TG_SENT_KEY, JSON.stringify({ [dayKey]: [...today] })) } catch { /* convenience only */ } }
  }, [paperRows, isReplay, dayKey, underlying, oi, view?.minuteBars?.length])

  // A live trade closed OUTSIDE this box - from the OI Replay's live panel, the Dhan app, or its own
  // super order's stop-loss / target filling on Dhan: once its super order has been seen pending on Dhan
  // and is then gone from the pending orders on two checks in a row, the row is closed here too (nothing
  // is sent - it is already closed there).
  const dhanSeenRef = useRef(new Map()) // row key -> { seen, missing }
  useEffect(() => {
    if (isReplay || !canTradeLive) return undefined
    const check = async () => {
      const open = paperRowsRef.current.filter((r) => r.live && !r.exitSent && r.orderIds?.length)
      if (!open.length) return
      const snap = await liveTradingApi.positions().catch(() => null)
      if (!snap?.dhanLoggedIn) return
      notifyLiveTradeEvents(snap.events, { sound: settingsRef.current.sound !== false })
      const pending = new Set((snap.pendingOrders ?? []).map((o) => String(o.orderId)))
      for (const r of open) {
        const st = dhanSeenRef.current.get(r.key) ?? { seen: false, missing: 0 }
        if (r.orderIds.some((id) => pending.has(String(id)))) { st.seen = true; st.missing = 0 } else if (st.seen) st.missing += 1
        dhanSeenRef.current.set(r.key, st)
        if (st.seen && st.missing >= 2) {
          const atMs = nowMsRef.current ?? Date.now()
          const premium = premiumAt(oi, r.side, r.strike, atMs) ?? r.current
          markPosition(r.key, { exitSent: true, exitError: null, exitTime: atMs, exitPremium: premium, exitReason: 'Closed on Dhan (OI panel / its SL or target)', liveNote: 'Its super order is no longer pending on Dhan.' })
        }
      }
    }
    const id = setInterval(check, 10_000)
    check()
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReplay, canTradeLive, dayKey])

  // A new Max SL / Target applies to every trade still OPEN now (and to new ones); closed trades keep the
  // levels they closed on. (Paper lots are applied to every paper trade in paperRows.)
  const levelsTimerRef = useRef(null)
  const changeLimits = (patch) => {
    setSettings((s) => ({ ...s, ...patch }))
    if (patch.paperSl != null || patch.paperTarget != null || patch.paperTrailStart != null || patch.paperTrailGap != null) {
      const cur = settingsRef.current
      saveTradeLevels('scanner', underlying, {
        sl: patch.paperSl ?? cur.paperSl, target: patch.paperTarget ?? cur.paperTarget,
        trailStart: patch.paperTrailStart ?? cur.paperTrailStart ?? 0, trailGap: patch.paperTrailGap ?? cur.paperTrailGap ?? 0,
      })
    }
    const openRows = paperRows.filter((r) => !r.exitTime)
    const open = new Set(openRows.map((r) => r.key))
    if (!open.size) return
    // Open LIVE trades: move their super order legs on Dhan too (once the typing stops).
    const trailChanged = patch.paperTrailStart != null || patch.paperTrailGap != null
    const liveOpen = patch.paperSl != null || patch.paperTarget != null || trailChanged ? openRows.filter((r) => r.live && r.orderIds?.length) : []
    if (liveOpen.length) {
      clearTimeout(levelsTimerRef.current)
      levelsTimerRef.current = setTimeout(() => {
        const cfg = settingsRef.current
        for (const r of liveOpen) {
          liveTradingApi.tradeLevels(r.orderIds, cfg.paperSl ?? 0, cfg.paperTarget ?? 0, { start: cfg.paperTrailStart ?? 0, gap: cfg.paperTrailGap ?? 0 })
            .then((result) => markPosition(r.key, { liveNote: result.message }))
            .catch((err) => notification.error({ message: `Could not move the SL / target on Dhan: ${r.strike} ${r.side}`, description: err.message, placement: 'topRight', duration: 10 }))
        }
      }, 900)
    }
    setPaperBook((prev) => {
      const day = prev[dayKey]
      if (!day) return prev
      return {
        ...prev,
        [dayKey]: {
          ...day,
          positions: day.positions.map((p) => (open.has(p.key) ? {
            ...p,
            ...(patch.paperSl != null ? { slPts: patch.paperSl } : {}),
            ...(patch.paperTarget != null ? { targetPts: patch.paperTarget } : {}),
            ...(patch.paperTrailStart != null ? { trailStart: patch.paperTrailStart } : {}),
            ...(patch.paperTrailGap != null ? { trailGap: patch.paperTrailGap } : {}),
          } : p)),
        },
      }
    })
  }
  const days = Object.values(history)
  const statRows = stats.map((s) => ({ ...s, key: s.id, top: alertIds.includes(s.id) }))
  const statColumns = [
    { title: '#', dataIndex: 'no', width: 34 },
    {
      title: 'Strategy', dataIndex: 'name',
      render: (name, r) => <span>{r.top && <Tag color="gold" style={{ marginRight: 4 }}>alert</Tag>}{name}{r.group === 'profile' && <Tag style={{ marginLeft: 4, fontSize: 10 }}>profile</Tag>}{r.group === 'range' && <Tag color="cyan" style={{ marginLeft: 4, fontSize: 10 }}>range</Tag>}{r.priority && <Tag color="purple" style={{ marginLeft: 4, fontSize: 10 }}>institutional</Tag>}{top.trial.includes(r.id) && <Tooltip title={`New - alerted beside the Top 15 until it has ${MIN_TRADES_TO_RANK} scored trades (live days are scored as their trades end), then ranked like the rest`}><Tag color="blue" style={{ marginLeft: 4, fontSize: 10 }}>on trial</Tag></Tooltip>}{filtersButton(r.id)}</span>,
    },
    { title: 'Trades', dataIndex: 'trades', width: 64 },
    { title: 'Win %', dataIndex: 'winRate', width: 66, render: (v) => (v == null ? '-' : `${Math.round(v * 100)}%`) },
    { title: 'Avg R', dataIndex: 'avgR', width: 72, render: (v) => <span style={{ color: v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined }}>{fmtR(v)}</span> },
    { title: 'Total R', dataIndex: 'totalR', width: 76, render: (v, r) => (r.trades ? fmtR(v) : '-') },
    { title: 'Best', dataIndex: 'bestR', width: 64, render: (v, r) => (r.trades ? fmtR(v) : '-') },
    { title: 'PF', dataIndex: 'profitFactor', width: 56, render: (v) => (v == null ? '-' : v === Infinity ? '∞' : v.toFixed(2)) },
  ]
  // Per-strategy filters (STRATEGY_FILTERS): edited in a dialog, saved with the scanner settings.
  const [filterFor, setFilterFor] = useState(null)
  const filtersButton = (id) => {
    if (!STRATEGY_FILTERS[id]) return null
    const edited = changedFilters(id, settings.filters?.[id]).length
    return (
      <Tooltip title={edited ? `${edited} filter(s) changed from the default` : 'Tune this strategy\'s filters'}>
        <Button size="small" type={edited ? 'primary' : 'default'} ghost={!!edited} icon={<SettingOutlined />} onClick={() => setFilterFor(id)}
          style={{ marginLeft: 6, height: 20, fontSize: 11, padding: '0 6px' }} aria-label={`Filters for ${STRATEGY_BY_ID[id].name}`}>
          {edited ? `Filters · ${edited}` : 'Filters'}
        </Button>
      </Tooltip>
    )
  }
  // The trailing SL's points for this underlying (kept per underlying with the scanner settings).
  const setTrailPts = (patch) => setSettings((s) => {
    const key = String(underlying ?? '').toUpperCase()
    const pts = { ...s.trail?.pts, [key]: { ...trailPtsFor(s, underlying), ...patch } }
    return { ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, pts } }
  })
  const toggleCustom = (id, on) => setSettings((s) => ({ ...s, custom: on ? [...new Set([...s.custom, id])] : s.custom.filter((x) => x !== id) }))

  return (
    <Card
      size="small" title={`Strategy scanner · OI, order flow, volume & market profile (${ACTIVE_STRATEGIES.length} strategies)`}
      extra={(
        <Space size={10} wrap>
          <Space size={4}><Switch size="small" checked={settings.alerts} onChange={(v) => { unlockAudio(); setSettings((s) => ({ ...s, alerts: v })) }} /><Text style={{ fontSize: 12 }}>Alerts</Text></Space>
          <Space size={4}><Switch size="small" checked={settings.sound} onChange={(v) => { unlockAudio(); setSettings((s) => ({ ...s, sound: v })) }} /><Text style={{ fontSize: 12 }}>Sound</Text></Space>
          <Space size={4}><Switch size="small" checked={settings.voice} onChange={(v) => setSettings((s) => ({ ...s, voice: v }))} /><Text style={{ fontSize: 12 }}>Speak name</Text></Space>
          <Tooltip title="Each trade punched (paper) or placed (live) today - and a live trade's exit - is also sent to the server's Telegram chat. Not for replays.">
            <Space size={4}><Switch size="small" checked={settings.telegram !== false} onChange={(v) => setSettings((s) => ({ ...s, telegram: v }))} aria-label="Telegram" /><Text style={{ fontSize: 12 }}>Telegram</Text></Space>
          </Tooltip>
          <Button size="small" icon={<SoundOutlined />} onClick={() => { unlockAudio(); chime(true); speak('Alerts are on') }}>Test</Button>
        </Space>
      )}
    >
      {oiError && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`OI for ${date} could not be loaded${isReplay ? '' : ' yet - retrying automatically'}${oi ? ' (showing the last loaded OI)' : ''} - the strategies need it: ${oiError}`} />}
      {oiNow && (
        <div style={{ fontSize: 12, marginBottom: 8, padding: '6px 8px', border: '1px solid #ffffff1f', borderRadius: 6, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }} aria-label="OI now">
          <span><Text strong style={{ fontSize: 12 }}>Options OI</Text>{' '}
            <span style={{ color: oiNow.options?.combined >= 0.25 ? UP_COLOR : oiNow.options?.combined <= -0.25 ? DOWN_COLOR : undefined }}>
              {oiNow.options?.combined >= 0.25 ? 'put writing leads (bullish)' : oiNow.options?.combined <= -0.25 ? 'call writing leads (bearish)' : 'balanced'}
            </span> · {optionOiText(oiNow.options)}</span>
          <span>Walls: support <b style={{ color: UP_COLOR }}>{oiNow.support ?? '-'}</b>{oiNow.supportChg != null ? ` (${oiNow.supportChg >= 0 ? '+' : ''}${(oiNow.supportChg / 1e5).toFixed(1)}L)` : ''}
            {' '}· resistance <b style={{ color: DOWN_COLOR }}>{oiNow.resistance ?? '-'}</b>{oiNow.resistanceChg != null ? ` (${oiNow.resistanceChg >= 0 ? '+' : ''}${(oiNow.resistanceChg / 1e5).toFixed(1)}L)` : ''}
            {' '}· max pain <b>{oiNow.maxPain ?? '-'}</b></span>
          <span><Text strong style={{ fontSize: 12 }}>Futures OI</Text> {oiNow.futures?.regime
            ? `${oiNow.futures.regime} (price ${(oiNow.futures.pricePct * 100).toFixed(2)}%, OI ${(oiNow.futures.oiPct * 100).toFixed(2)}% in 15m)` : '-'}</span>
          <span aria-label="Sudden OI walls now"><Text strong style={{ fontSize: 12 }}>Sudden OI walls (5m)</Text>{' '}
            {oiNow.sudden?.length ? oiNow.sudden.map((w) => (
              <Tooltip key={`${w.side}${w.strike}`} title={suddenWallText(w)}>
                <b style={{ color: w.side === 'PE' ? UP_COLOR : DOWN_COLOR, marginRight: 8 }}>{w.side === 'PE' ? 'PUT' : 'CALL'} {w.strike} +{(w.add / 1e5).toFixed(1)}L</b>
              </Tooltip>
            )) : <Text type="secondary" style={{ fontSize: 12 }}>none</Text>}
          </span>
        </div>
      )}
      {watch.length > 0 && (
        <div aria-label="Squeeze watch" style={{ fontSize: 12, marginBottom: 8, padding: '6px 8px', border: '1px solid #fa8c1666', borderRadius: 6, background: '#fa8c160d' }}>
          {watch.map((w) => {
            const meta = STRATEGY_BY_ID[w.id]
            return (
              <div key={`${w.id}${w.side}`}>
                <Tag color="orange" style={{ margin: '0 6px 0 0', fontSize: 11 }}>WATCH</Tag>
                <b style={{ color: w.side === 'LONG' ? UP_COLOR : DOWN_COLOR }}>#{meta?.no} {meta?.short} {w.side}</b>
                <Text style={{ fontSize: 12 }}> - the OI shows it: {w.evidence.join(' · ')}</Text>
                <div style={{ marginLeft: 8 }}><Text type="secondary" style={{ fontSize: 12 }}>Not called yet - waiting for: </Text>{w.missing.join(' · ')}</div>
              </div>
            )
          })}
        </div>
      )}
      {estimated && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Estimated day: no tape, book or heatmap - tape checks use each minute's estimated buy/sell split and the DOM / Heatmap confirmation is waived. Results are marked est." />}
      <Row gutter={[16, 12]}>
        <Col xs={24} xl={10}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {/* The picks scroll sideways inside the card on a phone rather than widening the page. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Text style={{ fontSize: 12 }}>Alert on</Text>
              <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
                <Segmented size="small" value={settings.pick} onChange={(v) => setSettings((s) => ({ ...s, pick: v }))}
                  options={[
                    { value: 'top15', label: `Top 15${top.measured ? ' (measured)' : ''}${top.trial.length ? ` + ${top.trial.length} on trial` : ''}` },
                    { value: 'oi5', label: 'Top 5 OI + flow' },
                    { value: 'profile5', label: 'Top 5 profile' },
                    { value: 'range', label: `Range-bound (${RANGE_IDS.length})` },
                    { value: 'all', label: `All ${ACTIVE_STRATEGIES.length}` },
                    { value: 'custom', label: 'My choice' },
                  ]} />
              </div>
            </div>
            <Space wrap size={8} aria-label="Exits">
              <Space size={4}><Switch size="small" checked={settings.trail?.on !== false} onChange={(v) => setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, on: v } }))} /><Text style={{ fontSize: 12 }}>Trailing SL</Text></Space>
              {settings.trail?.on !== false && (
                <>
                  <Tooltip title="pts = futures (index) points, set per underlying; R = multiples of the trade's own risk (entry to stop). Applies to new signals.">
                    <Segmented size="small" value={trailUnit(settings)} aria-label="Trailing SL unit"
                      onChange={(v) => setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, unit: v === 'R' ? 'R' : 'pts' } }))}
                      options={[{ value: 'pts', label: 'pts' }, { value: 'R', label: 'R' }]} />
                  </Tooltip>
                  <Text style={{ fontSize: 12 }}>after +</Text>
                  {trailUnit(settings) === 'pts'
                    ? (
                      <InputNumber size="small" min={1} max={5000} step={5} style={{ width: 76 }} value={trailPtsFor(settings, underlying).start} aria-label="Trail starts after points"
                        onChange={(v) => v != null && setTrailPts({ start: v })} />
                    )
                    : (
                      <InputNumber size="small" min={0.25} max={20} step={0.25} style={{ width: 70 }} value={settings.trail?.startR ?? DEFAULT_TRAIL.startR} aria-label="Trail starts at R"
                        onChange={(v) => v != null && setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, startR: v } }))} />
                    )}
                  <Text style={{ fontSize: 12 }}>{trailUnit(settings) === 'pts' ? 'pts, follow' : 'R, follow'}</Text>
                  {trailUnit(settings) === 'pts'
                    ? (
                      <InputNumber size="small" min={1} max={5000} step={5} style={{ width: 76 }} value={trailPtsFor(settings, underlying).gap} aria-label="Trail distance in points"
                        onChange={(v) => v != null && setTrailPts({ gap: v })} />
                    )
                    : (
                      <InputNumber size="small" min={0.25} max={20} step={0.25} style={{ width: 70 }} value={settings.trail?.gapR ?? DEFAULT_TRAIL.gapR} aria-label="Trail distance in R"
                        onChange={(v) => v != null && setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, gapR: v } }))} />
                    )}
                  <Text style={{ fontSize: 12 }}>{trailUnit(settings) === 'pts' ? `pts behind (${underlying} futures)` : 'R behind'}</Text>
                  <Tooltip title="Off (default): a trade ends at its target, its stop / trailing stop, its time stop or 15:10 - the rules the stats were measured with. On: no fixed target and no time stop - the trailing stop follows the move and only it (or 15:10) ends the trade, so a trend can pay several R. Applies to new alerts. For the paper / live OPTION trades set Target 0 too, or their own premium target still closes them.">
                    <Space size={4}><Switch size="small" checked={!!settings.trail?.runner} onChange={(v) => setSettings((s) => ({ ...s, trail: { ...DEFAULT_TRAIL, ...s.trail, runner: v } }))} aria-label="Let winners run" /><Text style={{ fontSize: 12 }}>Let winners run</Text></Space>
                  </Tooltip>
                </>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>Entries 09:30-{fmtHm(LAST_ENTRY)} · every trade closed by <b>{fmtHm(SQUARE_OFF)}</b></Text>
            </Space>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
              {ACTIVE_STRATEGIES.map((s) => (
                <Checkbox key={s.id} checked={alertIds.includes(s.id)} disabled={settings.pick !== 'custom'} onChange={(e) => toggleCustom(s.id, e.target.checked)} style={{ fontSize: 12 }}>
                  {s.no}. {s.short}
                </Checkbox>
              ))}
            </div>
            <Space wrap size={8}>
              <Tooltip title={isReplay ? `Runs all ${ACTIVE_STRATEGIES.length} strategies over the whole loaded day and scores every setup - adds the day to the stats` : `Runs all ${ACTIVE_STRATEGIES.length} strategies over today so far, minute by minute - the setups join today's list (not alerted) and are followed live from here`}>
                <Button type="primary" size="small" onClick={scanDay} disabled={!oi || (isReplay && !replayDay) || (scan && scan.progress < 100 && !scan.error)}>{isReplay ? 'Scan day' : 'Scan today so far'}</Button>
              </Tooltip>
              {scan && !scan.error && scan.progress < 100 && <Progress percent={scan.progress} size="small" style={{ width: 140, margin: 0 }} />}
              {scan?.done != null && <Text type="secondary" style={{ fontSize: 12 }}>{scan.until ? `${scan.done} setup(s) found today up to ${IST_HHMM.format(new Date(scan.until))} - in the list below` : `${scan.done} setup(s) scored for ${date}`}</Text>}
              {scan?.error && <Text type="danger" style={{ fontSize: 12 }}>{scan.error}</Text>}
              <Popconfirm title="Clear every saved strategy result?" onConfirm={() => { setHistory({}); writeJson(HISTORY_KEY, {}) }}>
                <Button size="small" danger>Reset stats</Button>
              </Popconfirm>
            </Space>
            {cooling.length > 0 && (
              <div aria-label="Waiting for cool-off" style={{ marginBottom: 4 }}>
                {cooling.map((s) => {
                  const meta = STRATEGY_BY_ID[s.id]
                  return (
                    <Tooltip key={`${s.id}-${s.t}`} title={setupTip(s)}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, padding: '2px 0' }}>
                        <Tag color="gold" style={{ margin: 0, fontSize: 11 }}>WAIT</Tag>
                        <span>#{meta.no} {meta.short} {s.side} <Text type="secondary" style={{ fontSize: 11 }}>since {IST_HHMM.format(new Date(s.t))} @ {s.entry.toFixed(1)} - ran {s.coolOff.run.toFixed(1)} pts in 3 min; enters on a pullback or a pause · <b>SL {s.stop.toFixed(1)}</b> · <b>T {s.target.toFixed(1)}</b></Text></span>
                      </div>
                    </Tooltip>
                  )
                })}
              </div>
            )}
            {(dayResults.length > 0 || regimeNow) && (
              <div aria-label="Today adaptive" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', fontSize: 12 }}>
                {regimeNow && (
                  <Tooltip title={`${regimeNow.reasons}. The day type is read from three votes - price, OI (options + futures) and CVD - and adaptive takes only the trades that suit it: trend days with the trend, range / two-sided days fades. Tracking only: every signal still fires and alerts.`}>
                    <Text style={{ fontSize: 12 }} aria-label="Day type now">Day type now: <b>{regimeNow.label}</b>
                      {regimeNow.votes && regimeNow.priceType !== 'early' && (
                        <Text type="secondary" style={{ fontSize: 11 }}>{' '}· price {regimeNow.votes.price.replace('-', ' ')} · OI {regimeNow.votes.oi} · CVD {regimeNow.votes.cvd}</Text>
                      )}
                    </Text>
                  </Tooltip>
                )}
                {dayResults.length > 0 && <Segmented size="small" value={adaptiveView ? 'adaptive' : 'all'} onChange={(v) => setSettings((x) => ({ ...x, signalView: v }))}
                  options={[{ value: 'all', label: `All signals (${dayResults.length})` }, { value: 'adaptive', label: `Adaptive would take (${dayTaken})` }]} />}
                {dayResults.length > 0 && <Tooltip title="Closed trades only; the adaptive call is the day type known at each signal. Tracking only - every signal still fires and alerts.">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Today: all {dayAdaptive.all.trades ? `${dayAdaptive.all.trades} closed ${fmtR(dayAdaptive.all.totalR)}` : 'none closed'}
                    {' '}→ adaptive {dayAdaptive.take.trades ? `${dayAdaptive.take.trades} closed ${fmtR(dayAdaptive.take.totalR)}` : 'none closed'}
                    {dayAdaptive.skip.trades ? <> (skipped {dayAdaptive.skip.trades}: {fmtR(dayAdaptive.skip.totalR)})</> : null}
                    {dayTagged < dayResults.length ? ` · ${dayResults.length - dayTagged} without a day type` : ''}
                  </Text>
                </Tooltip>}
              </div>
            )}
            <div style={{ maxHeight: 260, overflowY: 'auto' }} aria-label="Strategy setups">
              {dayResults.length === 0
                ? <Text type="secondary" style={{ fontSize: 12 }}>{oi ? 'No setup yet today.' : oiError ? 'Waiting for OI…' : 'Loading OI…'}</Text>
                : shownResults.length === 0
                  ? <Text type="secondary" style={{ fontSize: 12 }}>Adaptive would have skipped every signal so far today.</Text>
                  : [...shownResults].reverse().map((s) => {
                  const meta = STRATEGY_BY_ID[s.id]
                  const o = s.outcome
                  return (
                    <Tooltip key={`${s.id}-${s.t}`} title={setupTip(s, o)}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, padding: '3px 0', borderBottom: '1px solid #ffffff0d' }}>
                        <Text type="secondary" style={{ fontSize: 11, minWidth: 38 }}>{IST_HHMM.format(new Date(s.t))}</Text>
                        <Tag color={s.side === 'LONG' ? 'green' : 'red'} style={{ margin: 0, fontSize: 11 }}>{s.side}</Tag>
                        <span style={{ flex: 1 }}>#{meta.no} {meta.short} <Text type="secondary" style={{ fontSize: 11 }}>@ {s.entry.toFixed(1)} · <b>SL {o.trailed ? <>{s.stop.toFixed(1)} → {o.stop.toFixed(1)}</> : s.stop.toFixed(1)}</b>{s.trail ? ' (trail)' : ''} · <b>T {s.target.toFixed(1)}</b> · {s.confidence}% {s.grade ?? gradeOf(s.confidence)}{s.signal ? ' · after cool-off' : ''}{s.estimated ? ' · est.' : ''}
                          {s.adaptive && (
                            <Tooltip title={`Day type at the signal: ${s.regime?.label ?? '-'} - adaptive would ${s.adaptive.take ? 'take' : 'skip'} it (${s.adaptive.reason}). Tracking only - it fired either way.`}>
                              {' · '}<span style={{ color: s.adaptive.take ? '#52c41a' : '#d48806', whiteSpace: 'nowrap' }}>{s.adaptive.take ? '✓' : '✗'} adaptive {s.adaptive.take ? 'take' : 'skip'} · {s.regime?.label ?? ''}</span>
                            </Tooltip>
                          )}
                          {o.status !== 'open' && o.exitPrice != null && <> · <span style={{ whiteSpace: 'nowrap' }}>out {o.exitAt != null ? IST_HHMM.format(new Date(o.exitAt)) : 'end'} @ {o.exitPrice.toFixed(1)} ({exitLabel(o)})</span></>}</Text></span>
                        {s.options && oi && (
                          <span style={{ whiteSpace: 'nowrap' }}>
                            {s.options.buy && (
                              <Tooltip title={`Paper trade: ${optionTradeText(s.options.buy)} (${optionPnlText(s.options.buy, oi, o)})`}>
                                <Button size="small" type="text" style={{ padding: '0 3px', height: 18, fontSize: 11, color: UP_COLOR }} disabled={!punchable(s, o, nowMs)} onClick={() => punchRef.current?.(s, 'buy', nowMs)} aria-label={`Paper buy ${s.options.buy.side}`}>B {s.options.buy.side}</Button>
                              </Tooltip>
                            )}
                            {s.options.sell && (
                              <Tooltip title={`Paper trade: ${optionTradeText(s.options.sell)} (${optionPnlText(s.options.sell, oi, o)})`}>
                                <Button size="small" type="text" style={{ padding: '0 3px', height: 18, fontSize: 11, color: DOWN_COLOR }} disabled={!punchable(s, o, nowMs)} onClick={() => punchRef.current?.(s, 'sell', nowMs)} aria-label={`Paper sell ${s.options.sell.side}`}>S {s.options.sell.side}</Button>
                              </Tooltip>
                            )}
                          </span>
                        )}
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
            <div aria-label="Paper option trades">
              <Space wrap size={8} style={{ marginBottom: 4 }}>
                <Text strong style={{ fontSize: 12 }}>Option trades</Text>
                {canTradeLive && (
                  <Segmented size="small" value={tradeMode} aria-label="Trade mode"
                    onChange={(v) => {
                      if (v !== 'live') { setTradeMode('paper'); setAutoLive(false); return }
                      Modal.confirm({
                        title: 'Switch to LIVE trading on Dhan?',
                        content: 'S / B on a setup or alert will place REAL super orders (with your Max SL and Target as the stop-loss and target legs). Each live trade is closed on Dhan - its own super order cancelled and only its quantity exited - when its setup ends or you press Exit.',
                        okText: 'Yes, go live', okButtonProps: { danger: true }, cancelText: 'Stay on paper',
                        onOk: () => setTradeMode('live'),
                      })
                    }}
                    options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live (Dhan)' }]} />
                )}
                <Text style={{ fontSize: 12 }}>on each alert</Text>
                <Segmented size="small" value={settings.autoPaper ?? 'sell'} onChange={(v) => setSettings((s) => ({ ...s, autoPaper: v }))}
                  options={[{ value: 'off', label: 'Off' }, { value: 'buy', label: 'Buy option' }, { value: 'sell', label: 'Sell option' }]} />
                <Tooltip title="Which strike each trade uses - paper and live: ATM, or 1-2 strikes in / out of the money for the option being traded (a call's ITM strikes are below the index, a put's above). Only the strike changes - which setups fire does not.">
                  <Select size="small" style={{ width: 84 }} value={settings.moneyness ?? 0} aria-label="Option strike"
                    onChange={(v) => setSettings((s) => ({ ...s, moneyness: v }))}
                    options={[{ value: 2, label: '2 ITM' }, { value: 1, label: '1 ITM' }, { value: 0, label: 'ATM' }, { value: -1, label: '1 OTM' }, { value: -2, label: '2 OTM' }]} />
                </Tooltip>
                <InputNumber size="small" min={1} max={100} style={{ width: 64 }} value={settings.paperLots ?? 1} aria-label="Paper lots"
                  onChange={(v) => v != null && setSettings((s) => ({ ...s, paperLots: v }))} />
                <Text style={{ fontSize: 12 }}>lot(s) × {PAPER_TRADE_LOT_SIZE[underlying] ?? 1}</Text>
                <Text style={{ fontSize: 12 }}>Max SL</Text>
                <InputNumber size="small" min={0} max={500} step={5} style={{ width: 64 }} value={settings.paperSl ?? 20} aria-label="Paper max SL points"
                  onChange={(v) => v != null && changeLimits({ paperSl: v })} />
                <Text style={{ fontSize: 12 }}>Target</Text>
                <InputNumber size="small" min={0} max={1000} step={5} style={{ width: 64 }} value={settings.paperTarget ?? 30} aria-label="Paper target points"
                  onChange={(v) => v != null && changeLimits({ paperTarget: v })} />
                <Tooltip title="Trailing stop on the option premium: once a trade is 'Trail after' points in profit, its stop follows the best premium 'Follow' points behind and only tightens (Follow 0 = off). Paper trades here; live trades: the server moves the super order's stop-loss leg on every tick. A change applies to open trades too.">
                  <Space size={4}>
                    <Text style={{ fontSize: 12 }}>Trail after</Text>
                    <InputNumber size="small" min={0} max={1000} step={5} style={{ width: 64 }} value={settings.paperTrailStart ?? 0} aria-label="Trail after points"
                      onChange={(v) => v != null && changeLimits({ paperTrailStart: v })} />
                    <Text style={{ fontSize: 12 }}>follow</Text>
                    <InputNumber size="small" min={0} max={500} step={1} style={{ width: 64 }} value={settings.paperTrailGap ?? 0} aria-label="Trail follow points"
                      onChange={(v) => v != null && changeLimits({ paperTrailGap: v })} />
                  </Space>
                </Tooltip>
                <Text type="secondary" style={{ fontSize: 11 }}>premium pts (0 = off) · lots size every paper trade of the day (live trades keep theirs); a SL / target change applies to open trades, closed ones keep theirs</Text>
                {paperRows.length > 0 && <Text strong style={{ fontSize: 12, color: paperTotal >= 0 ? UP_COLOR : DOWN_COLOR }}>P&amp;L ₹{Math.round(paperTotal).toLocaleString('en-IN')}</Text>}
                {paperRows.some((r) => !r.live) && (
                  <Popconfirm title="Clear this day's paper trades? (Live trades stay.)" onConfirm={() => setPaperBook((prev) => {
                    const day = prev[dayKey]
                    const keep = (day?.positions ?? []).filter((p) => p.live)
                    const next = { ...prev }
                    if (keep.length) next[dayKey] = { ...day, positions: keep }; else delete next[dayKey]
                    return next
                  })}>
                    <Button size="small">Clear paper</Button>
                  </Popconfirm>
                )}
              </Space>
              {canTradeLive && tradeMode === 'live' && (
                <Alert type="error" showIcon style={{ margin: '4px 0 6px', padding: '4px 10px' }} message={(
                  <Space wrap size={8} style={{ fontSize: 12 }}>
                    <b>LIVE - real orders on Dhan</b>
                    <Space size={4}>
                      <Switch size="small" checked={autoLive} aria-label="Auto-place on alert"
                        onChange={(v) => {
                          if (!v) { setAutoLive(false); return }
                          Modal.confirm({
                            title: 'Auto-place a REAL order on every alert?',
                            content: `Every alert you have selected will place a live ${settings.autoPaper === 'buy' ? 'BUY' : 'SELL'} super order on Dhan by itself, up to ${settings.maxLiveTrades ?? 5} trades today, and stops after a ₹${(settings.maxLiveLoss ?? 10000).toLocaleString('en-IN')} loss. Turns off when you leave this page.`,
                            okText: 'Turn on', okButtonProps: { danger: true }, cancelText: 'Keep off',
                            onOk: () => setAutoLive(true),
                          })
                        }} />
                      <Text style={{ fontSize: 12 }}>Auto-place on alert</Text>
                    </Space>
                    <Text style={{ fontSize: 12 }}>slippage</Text>
                    <InputNumber size="small" min={0} max={20} step={0.5} style={{ width: 60 }} value={settings.liveSlippage ?? 2} aria-label="Live slippage"
                      onChange={(v) => v != null && setSettings((s) => ({ ...s, liveSlippage: v }))} />
                    <Text style={{ fontSize: 12 }}>max trades/day</Text>
                    <InputNumber size="small" min={1} max={50} style={{ width: 56 }} value={settings.maxLiveTrades ?? 5} aria-label="Max live trades"
                      onChange={(v) => v != null && setSettings((s) => ({ ...s, maxLiveTrades: v }))} />
                    <Text style={{ fontSize: 12 }}>stop after loss ₹</Text>
                    <InputNumber size="small" min={500} max={1000000} step={500} style={{ width: 90 }} value={settings.maxLiveLoss ?? 10000} aria-label="Max live loss"
                      onChange={(v) => v != null && setSettings((s) => ({ ...s, maxLiveLoss: v }))} />
                    <Text style={{ fontSize: 12 }}>today: {liveRows.length} trade(s) · <span style={{ color: liveTotal >= 0 ? UP_COLOR : DOWN_COLOR }}>₹{Math.round(liveTotal).toLocaleString('en-IN')}</span> (est.)</Text>
                  </Space>
                )} />
              )}
              {paperRows.length === 0
                ? <div><Text type="secondary" style={{ fontSize: 11 }}>B / S on a setup (or on its alert) trades its ATM option - Buy the call (LONG) / put (SHORT), or Sell (write) the put (LONG) / call (SHORT). Each closes at its own Max SL / Target (option premium points), or when its setup ends - stop, target, trailing SL or {fmtHm(SQUARE_OFF)} - whichever comes first.</Text></div>
                : paperRows.map((r) => (
                  <div key={r.key} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, padding: '2px 0', borderBottom: '1px solid #ffffff0d' }}>
                    <Tooltip title="Entry → exit time (IST)">
                      <Text style={{ fontSize: 11, minWidth: 92, whiteSpace: 'nowrap' }}>
                        <Text type="secondary" style={{ fontSize: 10 }}>In</Text> {IST_HHMM.format(new Date(r.entryTime))}{' '}
                        <Text type="secondary" style={{ fontSize: 10 }}>Out</Text> {r.exitTime ? IST_HHMM.format(new Date(r.exitTime)) : '--:--'}
                      </Text>
                    </Tooltip>
                    {r.live && <Tag color="volcano" style={{ margin: 0, fontSize: 10 }}>LIVE</Tag>}
                    <Tag color={r.action === 'BUY' ? 'green' : 'red'} style={{ margin: 0, fontSize: 11 }}>{r.action}</Tag>
                    {r.adaptive && (
                      <Tooltip title={`${r.regime?.label ?? 'Day type'}: adaptive would ${r.adaptive.take ? 'take' : 'skip'} it (${r.adaptive.reason})`}>
                        <Tag color={r.adaptive.take ? 'green' : 'orange'} style={{ margin: 0, fontSize: 10 }}>{r.adaptive.take ? 'ADAPTIVE' : 'NOT ADAPTIVE'}</Tag>
                      </Tooltip>
                    )}
                    <span style={{ flex: 1 }}>{r.strike} {r.side} × {r.lots} <Text type="secondary" style={{ fontSize: 11 }}>@ {r.premium.toFixed(1)} → {r.current != null ? r.current.toFixed(1) : '-'} · #{STRATEGY_BY_ID[r.strategy]?.no} {STRATEGY_BY_ID[r.strategy]?.short}{levelsText(r, settings)}{r.exitReason ? ` · ${r.exitReason}` : ''}</Text>
                      {r.live && (r.exitError || r.liveNote) && (
                        <Tooltip title={r.exitError ?? r.liveNote}><Text type={r.exitError ? 'danger' : 'secondary'} style={{ fontSize: 10, marginLeft: 4 }}>{r.exitError ? 'exit failed - see Dhan' : 'Dhan ✓'}</Text></Tooltip>
                      )}
                    </span>
                    {(() => {
                      const c = costsOf(r)
                      return (
                        <Tooltip title={c ? `${r.lots} lot(s) × ${r.lotSize}: gross ${rupee(c.gross)} - STT ${rupee(c.stt)} - brokerage ${rupee(c.brokerage)} - other ${rupee(c.other)} = net ${rupee(c.net)} (1 lot: ${rupee(c.netPerLot)})${r.exitTime ? '' : ' - open: at the current premium'}` : 'No premium yet'}>
                          <Text style={{ fontSize: 12, color: (r.points ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR, minWidth: 90, textAlign: 'right' }}>
                            {r.points == null ? '-' : `${r.points >= 0 ? '+' : ''}${r.points.toFixed(1)} · ₹${Math.round(r.rupees).toLocaleString('en-IN')}`}
                          </Text>
                        </Tooltip>
                      )
                    })()}
                    {r.live
                      ? (!r.exitSent || r.exitError
                        ? (
                          <Popconfirm title="Close this LIVE trade on Dhan?" description="Cancels its super order (or its SL / target legs) and exits only this trade's quantity." okButtonProps={{ danger: true }}
                            onConfirm={() => exitLive(r, 'Exited by hand')}>
                            <Button size="small" danger style={{ height: 20, fontSize: 11 }}>Exit</Button>
                          </Popconfirm>
                        )
                        : <Tag style={{ margin: 0, fontSize: 11 }}>closed</Tag>)
                      : (r.exitTime ? <Tag style={{ margin: 0, fontSize: 11 }}>closed</Tag> : <Button size="small" onClick={() => exitPaper(r.key)} style={{ height: 20, fontSize: 11 }}>Exit</Button>)}
                  </div>
                ))}
              {!isReplay && paperRows.length > 0 && <Text type="secondary" style={{ fontSize: 10 }}>Live premiums and OI stream from the Dhan websocket. Live trades: P&amp;L here is an estimate from the premium - the Dhan panel has the real fills.</Text>}
            </div>
          </Space>
        </Col>
        <Col xs={24} xl={14}>
          <Table size="small" pagination={false} columns={statColumns} dataSource={statRows} scroll={{ x: 560 }} />
          <Text type="secondary" style={{ fontSize: 11 }} aria-label="Saved data">
            Every signal (with its day type and adaptive call) and every option trade is saved on the server, every day in one file each:
            {' '}<a href="/api/scanner-log/signals" download>signals.csv</a> · <a href="/api/scanner-log/trades" download>trades.csv</a>
            {' '}· totals per underlying: <a href="/api/scanner-log/summary/csv" download>summary.csv</a>.
          </Text>
          <div aria-label="Points captured" style={{ fontSize: 12, margin: '6px 0' }}>
            <Space wrap size={6} style={{ marginBottom: 2 }}>
              <Text strong style={{ fontSize: 12 }}>Total P&amp;L per lot, every saved day</Text>
              <Popover trigger="click" placement="bottomLeft" title="Charges taken off every trade"
                content={(
                  <Space direction="vertical" size={6} style={{ fontSize: 12 }}>
                    <span>STT <InputNumber size="small" min={0} max={5} step={0.01} style={{ width: 70 }} value={rates.sttPct} aria-label="STT percent" onChange={(v) => v != null && setRate('sttPct', v)} /> % of the SELL side's premium value</span>
                    <span>Brokerage ₹ <InputNumber size="small" min={0} max={500} step={1} style={{ width: 64 }} value={rates.brokeragePerOrder} aria-label="Brokerage per order" onChange={(v) => v != null && setRate('brokeragePerOrder', v)} /> per order (open + close)</span>
                    <span>Other ₹ <InputNumber size="small" min={0} max={500} step={1} style={{ width: 64 }} value={rates.otherPerTrade} aria-label="Other charges per trade" onChange={(v) => v != null && setRate('otherPerTrade', v)} /> per trade</span>
                    <Text type="secondary" style={{ fontSize: 11 }}>Applies to trades saved from now on; ones already saved keep the charges they were saved with.</Text>
                  </Space>
                )}>
                <Button size="small" icon={<SettingOutlined />} style={{ height: 20, fontSize: 11, padding: '0 6px' }}>Charges</Button>
              </Popover>
              <Text type="secondary" style={{ fontSize: 11 }}>after STT {rates.sttPct}% · brokerage ₹{rates.brokeragePerOrder} × 2 · other ₹{rates.otherPerTrade} per trade; per lot = each trade as if done with 1 lot, added up</Text>
            </Space>
            {!savedTotals?.length
              ? <div><Text type="secondary" style={{ fontSize: 12 }}>Nothing saved on the server yet.</Text></div>
              : savedTotals.map((t) => {
                const rows = [
                  { key: 'all', name: 'All trades', n: t.trades, pts: t.optionPoints, perLot: t.netPerLot, net: t.netRupees, strong: true },
                  { key: 'adaptive', name: 'Adaptive trades', n: t.adaptiveTrades, pts: t.adaptiveOptionPoints, perLot: t.adaptiveNetPerLot, net: t.adaptiveNetRupees },
                  { key: 'non', name: 'Non-adaptive trades', n: t.nonAdaptiveTrades, pts: t.nonAdaptiveOptionPoints, perLot: t.nonAdaptiveNetPerLot, net: t.nonAdaptiveNetRupees },
                ]
                const color = (v) => (v >= 0 ? UP_COLOR : DOWN_COLOR)
                return (
                  <div key={t.underlying} style={{ margin: '4px 0 8px' }}>
                    <b>{t.underlying}</b>
                    <Text type="secondary" style={{ fontSize: 12 }}> · {t.signals} signal{t.signals === 1 ? '' : 's'} ({t.closedSignals} closed{t.winPct != null ? `, ${Math.round(t.winPct)}% won` : ''}) · futures </Text>
                    <b style={{ color: color(t.futuresPoints) }}>{ptsText(t.futuresPoints)}</b><Text type="secondary" style={{ fontSize: 12 }}> ({fmtR(t.totalR)})</Text>
                    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                    <table style={{ borderCollapse: 'collapse', marginTop: 2 }}>
                      <thead>
                        <tr style={{ textAlign: 'right', fontWeight: 500 }}>
                          <th style={{ textAlign: 'left', fontWeight: 500, paddingRight: 14 }} />
                          <th style={{ fontWeight: 500, padding: '0 10px' }}>Trades</th><th style={{ fontWeight: 500, padding: '0 10px' }}>Points captured</th>
                          <th style={{ fontWeight: 500, padding: '0 10px' }}>P&amp;L per lot</th><th style={{ fontWeight: 500, padding: '0 10px' }}>P&amp;L (all lots)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.key} style={{ textAlign: 'right' }}>
                            <td style={{ textAlign: 'left', paddingRight: 14, whiteSpace: 'nowrap' }}>{r.strong ? <b>{r.name}</b> : r.name}</td>
                            <td style={{ padding: '0 10px' }}>{r.n}</td>
                            <td style={{ padding: '0 10px', color: r.n ? color(r.pts) : undefined }}>{r.n ? ptsText(r.pts) : '-'}</td>
                            <td style={{ padding: '0 10px', color: r.n ? color(r.perLot) : undefined }}>{r.n ? <b>{rupee(r.perLot)}</b> : '-'}</td>
                            <td style={{ padding: '0 10px', color: r.n ? color(r.net) : undefined }}>{r.n ? rupee(r.net) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                    {(t.openTrades > 0 || t.untaggedTrades > 0) && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {t.openTrades > 0 ? `${t.openTrades} trade(s) still open, counted at their last value. ` : ''}{t.untaggedTrades > 0 ? `${t.untaggedTrades} trade(s) were saved with no adaptive call: in All only.` : ''}
                      </Text>
                    )}
                  </div>
                )
              })}
          </div>
          {filterFor && (
            <StrategyFiltersModal id={filterFor} values={settings.filters?.[filterFor]} onClose={() => setFilterFor(null)}
              onSave={(v) => { setSettings((s) => ({ ...s, filters: { ...s.filters, [filterFor]: v } })); setFilterFor(null) }} />
          )}
          <Text type="secondary" style={{ fontSize: 11 }}>
            {days.length} day(s) scored ({days.filter((d) => d.estimated).length} estimated). Ranked by average R per trade (win rate × size of the wins), shrunk for small samples;
            {' '}a strategy needs {MIN_TRADES_TO_RANK}+ trades to be ranked - until enough are, the playbook&apos;s picks fill each group's top 5 (OI + order flow, and profile) and the trapped-OI squeeze (24), then the institutional setups (17-21), fill the last five of the top 15. New strategies (27, 29, 30) are alerted on trial beside the 15 until they have {MIN_TRADES_TO_RANK} scored trades - live days are scored as each trade ends, no Scan day needed. Range-bound fades (7, 22, 23) only fire on a balanced day; pick &quot;Range-bound&quot; to alert on them alone. A strategy losing on average is never alerted. Every alert carries its stop-loss and target, a trailing-SL alert gives each new stop, and another alert follows when the stop, target or the {fmtHm(SQUARE_OFF)} cut-off ends the trade. Outcomes are the FUTURES move to
            {' '}the setup&apos;s stop (trailed as set when it fired) / target / time stop, closed by {fmtHm(SQUARE_OFF)} at the latest (stop counted first when one minute touches both), not option P&amp;L; past results do not promise future ones.
          </Text>
        </Col>
      </Row>
    </Card>
  )
}

// When a paper position's signal fired (positions saved before setupT was stored keep it in their key).
function setupTimeOf(p) {
  return p.setupT ?? Number(String(p.setupKey).split('-').at(-1))
}

// A setup can be paper-traded only while it is live at the clock: it has fired, and its stop, target,
// trailing SL or 15:10 exit has not been reached yet.
function punchable(setup, outcome, nowMs) {
  if (nowMs == null) return true
  if (setup.t > nowMs) return false
  if (!outcome || outcome.status === 'open') return true
  const exitAt = outcome.exitAt != null ? outcome.exitAt + MIN : squareOffMs(setup.t)
  return exitAt > nowMs
}

function optionPnlText(trade, oi, outcome) {
  const at = outcome && outcome.status !== 'open' && outcome.exitAt != null ? outcome.exitAt + MIN : null
  const r = at ? optionPnlPoints(trade, oi, at) : null
  return r ? `${r.points >= 0 ? '+' : ''}${r.points.toFixed(1)} pts at the setup's exit` : 'open'
}

function trimPaper(book) {
  const keys = Object.keys(book).sort((a, b) => (book[a].date < book[b].date ? 1 : -1))
  return Object.fromEntries(keys.slice(0, 20).map((k) => [k, book[k]]))
}

function trimHistory(history) {
  const keys = Object.keys(history).sort((a, b) => (history[a].date < history[b].date ? 1 : -1))
  return Object.fromEntries(keys.slice(0, MAX_DAYS_KEPT).map((k) => [k, history[k]]))
}

/** The filters of one strategy (STRATEGY_FILTERS[id]): a number box or a switch each, defaults marked;
 *  saved on OK. They apply to the setups found from then on - live, the replay clock and Scan day. */
function StrategyFiltersModal({ id, values, onClose, onSave }) {
  const meta = STRATEGY_BY_ID[id]
  const defs = STRATEGY_FILTERS[id] ?? []
  const [draft, setDraft] = useState(() => strategyFilters(id, values))
  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }))
  const defaults = strategyFilters(id, {})
  return (
    <Modal open title={`Filters · #${meta.no} ${meta.name}`} onCancel={onClose} onOk={() => onSave(strategyFilters(id, draft))} okText="Save"
      footer={(_, { OkBtn, CancelBtn }) => (
        <Space>
          <Button size="small" onClick={() => setDraft(defaults)} disabled={JSON.stringify(draft) === JSON.stringify(defaults)}>Reset to defaults</Button>
          <CancelBtn /><OkBtn />
        </Space>
      )}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {defs.map((f) => (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <Text style={{ fontSize: 12 }}>
              {f.label}
              {draft[f.key] !== f.default && <Text type="secondary" style={{ fontSize: 11 }}>{` (default ${f.type === 'switch' ? (f.default ? 'on' : 'off') : f.default})`}</Text>}
            </Text>
            {f.type === 'switch'
              ? <Switch size="small" checked={draft[f.key]} onChange={(v) => set(f.key, v)} aria-label={f.label} />
              : <InputNumber size="small" min={f.min} max={f.max} step={f.step} value={draft[f.key]} onChange={(v) => v != null && set(f.key, v)} style={{ width: 86, flex: 'none' }} aria-label={f.label} />}
          </div>
        ))}
        <Text type="secondary" style={{ fontSize: 11 }}>
          The defaults are the strategy&apos;s tested rules. Changes apply to setups found from now on - live, on the replay clock and in Scan day;
          {' '}days already scored keep the setups found with the filters they were scanned with, so re-run Scan day to measure a change.
        </Text>
      </Space>
    </Modal>
  )
}
