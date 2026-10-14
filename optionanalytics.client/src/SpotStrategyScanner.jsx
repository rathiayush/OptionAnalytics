// The SPOT + OPTIONS strategies on the OI Replay page (spotEngine.js): they read the index's own 1-minute candles
// against the option chain's OI and premiums - the data this page shows - so they live here, not on the Order Flow
// page. Judged at the start of each minute on the minutes that had FINISHED (scannerCore.spotScanTick - the same
// function the server scanner runs, and what the Strategy tuning measured), followed on the spot candles, and traded
// in OPTIONS exactly as the Order Flow page's scanner trades its alerts: a paper option trade on every alert by
// default; in Live (Dhan) mode with "Auto-place on alert" on (its own confirmed switch) a real Dhan super order with
// its SL / target legs, closed when its signal ends (index stop / target / trailing SL / time stop / 15:10) or its own
// SL / target fills - and the server watches its index stop / target on the SPOT price too, so they hold with this
// page closed. A replayed day is paper only.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Tag, Tooltip, Typography, notification } from 'antd'
import { SoundOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { liveTradingApi } from './LiveTrading.jsx'
import { chime, speak, telegram, unlockAudio } from './alerts.js'
import { notifyLiveTradeEvents, notifyTrade } from './tradeNotify.js'
import { subscribeTradeLevels, loadTradeDefaults, saveTradeDefaults } from './tradeDefaults.js'
import {
  SPOT_STRATEGIES, STRATEGY_BY_ID, DEFAULT_TRAIL, LAST_ENTRY, SQUARE_OFF, fmtHm, exitLabel, premiumAt, optionTradeText, squareOffMs,
  asReplayContext, optionTradeAt, optionPlanFor, optionExitText, capPoints, filtersForIndex, lotsFor, trailPoints,
} from './strategyEngine.js'
import { spotBarsOf, spotProfile, PROFILE_LAG, PROFILE_MIN_BARS } from './spotEngine.js'
import { SCANNER_SETTINGS_KEY, BY_INDEX_KEY, readFiltersByIndex } from './scannerSettings.js'
import {
  MIN, sameSignal, trailFor, followSetups, setupEvents, newPosition, positionRows, withCapChange, liveLegsFor, PAPER_TRADE_LOT_SIZE,
  setupExitText, paperExitResult, setupWasTraded, spotScanTick, spotScanMinutes,
} from './scannerCore.js'
import { ServerLiveSwitch, ServerLiveTrades, useServerLive } from './ServerLive.jsx'

const { Text } = Typography
const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const SETTINGS_KEY = 'optionanalytics.spotScanner.settings.v1'
const PAPER_KEY = 'optionanalytics.spotScanner.paper.v1'
// Today's fired setups, the last minute judged and the trailing-stop changes - a refresh shows them again and does not
// re-alert them.
const DAY_KEY = 'optionanalytics.spotScanner.day.v1'
const TRADE_MODE_KEY = 'optionanalytics.spotScanner.tradeMode'
const TG_SENT_KEY = 'optionanalytics.spotScanner.telegramSent.v1'
const SPOT_IDS = SPOT_STRATEGIES.filter((s) => !s.retired).map((s) => s.id)
// Live: a finished minute not in the server's candles yet is looked for again for this long.
const SPOT_WAIT_MS = 30_000
// A replay that jumped ahead (or a page opened part-way through today): setups older than this behind the clock are
// recorded and followed, not alerted or traded.
const ALERT_WINDOW_MS = 2 * MIN
const STRIKE_CHOICES = [5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5].map((v) => ({ value: v, label: v === 0 ? 'ATM' : `${Math.abs(v)} ${v > 0 ? 'ITM' : 'OTM'}` }))

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full / blocked */ }
}
const fmtR = (r) => (r == null ? '-' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`)
const trailText = (trail) => (trail
  ? `trailing SL: after +${trail.unit === 'pts' ? `${trail.startPts} pts` : `${trail.startR}R`} the stop follows ${trail.unit === 'pts' ? `${trail.gapPts} pts` : `${trail.gapR}R`} behind the best spot price${trail.runner ? ' - letting it run' : ''}`
  : 'fixed SL')
// The index's max rules for the strategies' option trades (Trade settings - Max SL / Max target, shared with the server
// scanner), its lots and live slippage. (Its SL / target / trail are a MANUAL trade's - a strategy follows its own.)
const levelsOf = (u) => {
  const d = loadTradeDefaults(u)
  return { paperMaxSl: d.maxSl, paperMaxTarget: d.maxTarget, paperLots: d.lots, liveSlippage: d.slippage }
}
const levelsText = (r) => {
  const sell = r.action === 'SELL'
  const parts = [r.slPts > 0 && `SL ${(sell ? r.premium + r.slPts : r.premium - r.slPts).toFixed(1)}`, r.targetPts > 0 && `T ${(sell ? r.premium - r.targetPts : r.premium + r.targetPts).toFixed(1)}`,
    r.trailGap > 0 && `trail ${r.trailGap} pts after +${r.trailStart ?? 0}`, r.optExit && OWN_EXIT_TEXT[r.optExit]].filter(Boolean)
  return parts.length ? ` · ${parts.join(' / ')}` : ''
}
const OWN_EXIT_TEXT = { index: 'its own exit: with the spot trade', indexSl: 'its own exit: with the spot trade, capped at its SL', first: 'its own exit: SL / target or the spot exit', option: 'its own exit: SL / target only' }
const trimBook = (book) => {
  const keys = Object.keys(book).sort((a, b) => (book[a].date < book[b].date ? 1 : -1))
  return Object.fromEntries(keys.slice(0, 20).map((k) => [k, book[k]]))
}
function setupTip(s, o = null) {
  const meta = STRATEGY_BY_ID[s.id]
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>
        #{meta?.no} {meta?.name} · {s.side} @ spot {s.entry.toFixed(1)}
        <div><b>SL {s.stop.toFixed(1)}</b>{o?.trailed ? <> → <b>{o.stop.toFixed(1)}</b> (trailed)</> : ''} · <b>Target {s.target.toFixed(1)}</b></div>
      </div>
      {Object.entries(s.checks ?? {}).map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}
    </div>
  )
}

/**
 * `bars`: the day's 1-minute spot candles as the page has them ({ t, time, open, high, low, close }, oldest first -
 * today's last one may still be running). `clockMs`: the page's clock - today live, or a replay's end of the last
 * minute shown. `oi`: the OI context (buildOiContext - live: false for a replayed day, live: true today). `expiry`:
 * the option expiry a live order is for. `onSignals`: told the day's signals (for the chart's markers).
 */
export function SpotStrategyScanner({ underlying, date, isReplay, bars, clockMs, oi, expiry, canTradeLive = false, isAdmin = false, onSignals = null, dragHandle = null }) {
  const [settings, setSettings] = useState(() => ({
    alerts: true, sound: true, voice: true, telegram: true, pick: 'applied', custom: [], autoPaper: 'strategy', moneyness: 0, maxLiveTrades: 5, maxLiveLoss: 10000,
    ...readJson(SETTINGS_KEY, {}),
  }))
  useEffect(() => writeJson(SETTINGS_KEY, settings), [settings])
  // The trailing SL, each strategy's filters and the charges: the Order Flow scanner's settings (one setting for both
  // pages and the server scanner).
  const [shared, setShared] = useState(() => readJson(SCANNER_SETTINGS_KEY, {}))
  useEffect(() => {
    const onStorage = (e) => { if (e.key === SCANNER_SETTINGS_KEY) setShared(readJson(SCANNER_SETTINGS_KEY, {})) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const [levels, setLevels] = useState(() => levelsOf(underlying))
  useEffect(() => { setLevels(levelsOf(underlying)) }, [underlying])
  const cfg = useMemo(() => ({ ...settings, ...levels, trail: { on: true, ...DEFAULT_TRAIL, ...(shared.trail ?? {}) }, filters: shared.filters ?? {} }), [settings, levels, shared])
  const cfgRef = useRef(cfg)
  useEffect(() => { cfgRef.current = cfg }, [cfg])

  // The settings fine-tuned and applied for ONE index, and each index's live list (the server's copy, each minute).
  const [filtersByIndex, setFiltersByIndex] = useState(() => readFiltersByIndex())
  const [liveList, setLiveList] = useState([])
  useEffect(() => {
    const onStorage = (e) => { if (e.key === BY_INDEX_KEY) setFiltersByIndex(readFiltersByIndex()) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  useEffect(() => {
    if (!isAdmin) return undefined
    let stopped = false
    const pull = () => fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => {
      if (stopped || !c) return
      setFiltersByIndex((cur) => (JSON.stringify(cur) === JSON.stringify(c.filtersByIndex ?? {}) ? cur : c.filtersByIndex ?? {}))
      setLiveList(c.liveList?.[underlying] ?? [])
    }).catch(() => {})
    pull()
    const timer = setInterval(pull, 60_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [isAdmin, underlying])
  const byIndexRef = useRef(filtersByIndex)
  useEffect(() => { byIndexRef.current = filtersByIndex }, [filtersByIndex])
  const filtersOf = (c) => filtersForIndex({ filters: c?.filters, filtersByIndex: byIndexRef.current }, underlying)

  // Which spot strategies alert (and trade): the ones applied on this index (a fine-tuned setting, or filters) or on its
  // live list - what the server scanner trades -, all of them, or a hand-picked list.
  const indexFilters = filtersForIndex({ filters: cfg.filters, filtersByIndex }, underlying)
  const appliedIds = SPOT_IDS.filter((id) => liveList.includes(id) || Object.keys(indexFilters[id] ?? {}).length > 0)
  const alertIds = settings.pick === 'all' ? SPOT_IDS : settings.pick === 'custom' ? (settings.custom ?? []).filter((id) => SPOT_IDS.includes(id)) : appliedIds
  const alertIdsRef = useRef(alertIds)
  useEffect(() => { alertIdsRef.current = alertIds })

  const dayKey = `${underlying}:${date}`
  const [fired, setFired] = useState([])
  const firedRef = useRef([])
  const lastMinuteRef = useRef(0)
  const restoredRef = useRef(new Set())
  const [trailLog, setTrailLog] = useState([])
  const trailLogRef = useRef(trailLog)
  trailLogRef.current = trailLog
  const [serverBars, setServerBars] = useState([])
  const [spotError, setSpotError] = useState(null)
  const clockRef = useRef(clockMs)
  useEffect(() => { clockRef.current = clockMs }, [clockMs])

  // A new day / index / mode starts afresh; today's signals so far come back after a refresh (not alerted again).
  const trailJson = JSON.stringify(trailFor(cfg, underlying))
  const lastTrailRef = useRef(trailJson)
  const trailJsonRef = useRef(trailJson)
  trailJsonRef.current = trailJson
  useEffect(() => {
    const saved = !isReplay ? readJson(DAY_KEY, {})[dayKey] : null
    firedRef.current = saved?.fired ?? []
    restoredRef.current = new Set(firedRef.current.map((f) => `${f.id}-${f.t}`))
    lastMinuteRef.current = saved?.lastMinute ?? 0
    lastTrailRef.current = trailJsonRef.current
    setFired(firedRef.current)
    setTrailLog(saved?.trailLog ?? [])
    setServerBars([])
  }, [dayKey, isReplay])
  const saveDay = () => {
    if (isReplay || !date) return
    writeJson(DAY_KEY, { [dayKey]: { fired: firedRef.current, lastMinute: lastMinuteRef.current, trailLog: trailLogRef.current } })
  }
  // The trailing SL changed (on the Order Flow scanner): the open signals follow it from this minute - nothing that
  // already happened is rewritten, and a stop never loosens (simulateOutcome).
  useEffect(() => {
    if (lastTrailRef.current === trailJson) return
    lastTrailRef.current = trailJson
    const t = Math.floor((clockRef.current ?? Date.now()) / MIN) * MIN
    setTrailLog((log) => [...log.filter((c) => c.t < t), { t, trail: JSON.parse(trailJson) }])
  }, [trailJson])
  useEffect(() => { saveDay() }, [trailLog]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Paper / live option trades (as the Order Flow page's scanner) ----------------------------------------------
  const [paperBook, setPaperBook] = useState(() => readJson(PAPER_KEY, {}))
  useEffect(() => writeJson(PAPER_KEY, trimBook(paperBook)), [paperBook])
  const paperBookRef = useRef(paperBook)
  useEffect(() => { paperBookRef.current = paperBook }, [paperBook])
  const [tradeMode, setTradeModeState] = useState(() => { try { return localStorage.getItem(TRADE_MODE_KEY) === 'live' ? 'live' : 'paper' } catch { return 'paper' } })
  const setTradeMode = (mode) => { try { localStorage.setItem(TRADE_MODE_KEY, mode) } catch { /* convenience only */ } setTradeModeState(mode) }
  const [autoLive, setAutoLive] = useState(false)
  // The server scanner Live for this index: the SERVER places each alert's order, so this page's own Auto-place stays
  // off (never two orders for one alert).
  const serverLive = useServerLive()
  const serverSt = serverLive.list?.find((x) => x.underlying === underlying) ?? null
  const serverIsLive = !!serverSt?.live
  useEffect(() => { if (serverIsLive) setAutoLive(false) }, [serverIsLive])
  useEffect(() => { if (!canTradeLive) setAutoLive(false) }, [canTradeLive])
  const liveModeRef = useRef({ mode: 'paper', auto: false })
  useEffect(() => { liveModeRef.current = { mode: canTradeLive ? tradeMode : 'paper', auto: canTradeLive && tradeMode === 'live' && autoLive && !serverIsLive } }, [canTradeLive, tradeMode, autoLive, serverIsLive])
  const liveLossRef = useRef(0)
  const placingRef = useRef(new Set())
  const placedRef = useRef(new Set())
  useEffect(() => { placedRef.current = new Set() }, [dayKey])
  const oiRef = useRef(oi)
  useEffect(() => { oiRef.current = oi }, [oi])

  // The option a setup is traded with, and how it leaves the trade: the strategy's own when it was tuned and applied (its
  // exit exactly - none of the index's points or trailing stop on top), else this card's choice and the index's levels
  // (optionPlanFor - the server scanner's rule too).
  const planOf = (setup, premium = null) => optionPlanFor(setup.id, filtersOf(cfgRef.current), cfgRef.current, premium)
  const tradeOf = (setup, which) => optionTradeAt(oiRef.current, setup, which, planOf(setup).moneyness)
  const markPosition = (key, patch) => setPaperBook((prev) => {
    const day = prev[dayKey]
    if (!day) return prev
    return { ...prev, [dayKey]: { ...day, positions: day.positions.map((p) => (p.key === key ? { ...p, ...patch } : p)) } }
  })
  const strategyText = (setup) => `#${STRATEGY_BY_ID[setup.id]?.no} ${STRATEGY_BY_ID[setup.id]?.name ?? setup.id}`

  const placeLive = async (setup, which) => {
    const trade = tradeOf(setup, which)
    const c = cfgRef.current
    const fail = (description) => notification.error({ message: 'Live order not placed', description, placement: 'topRight', duration: 10 })
    if (!trade) return fail('No option premium for this setup yet.')
    if (!expiry) return fail('The option expiry is not known yet (the listed expiries are still loading).')
    const levelsNow = planOf(setup, trade.premium)
    // Dhan's legs: its own; where its own exit has none, a safety leg at the signal's own spot distance (liveLegsFor).
    const legs = liveLegsFor(levelsNow, setup)
    if (!(legs.slPts > 0) || !(legs.targetPts > 0)) return fail('A live trade is a Dhan super order - set both Max SL and Target above 0.')
    // Its own exit 'option': only the option's own SL / target and the 15:10 square-off - not the signal's spot exits.
    const optionOnly = levelsNow.own && levelsNow.exit === 'option'
    const list = paperBookRef.current[dayKey]?.positions ?? []
    const key = `${setup.id}-${setup.t}-${which}`
    if (list.some((p) => sameSignal(p, setup, trade)) || placingRef.current.has(key) || placedRef.current.has(key)) return
    // Orders on their way, and taken orders the book does not show yet, count too.
    const liveCount = list.filter((p) => p.live).length + placingRef.current.size + [...placedRef.current].filter((k) => !list.some((p) => p.key === k)).length
    if (liveCount >= (c.maxLiveTrades ?? 5)) return fail(`The day's limit of ${c.maxLiveTrades} live trades is reached.`)
    if (liveLossRef.current <= -(c.maxLiveLoss ?? 10000)) return fail(`The day's live loss limit (₹${(c.maxLiveLoss ?? 10000).toLocaleString('en-IN')}) is reached.`)
    placingRef.current.add(key)
    const lots = lotsFor(setup.id, filtersOf(c), c.paperLots)
    const exitAtMs = optionOnly ? squareOffMs(setup.t) : Math.min(setup.timeStopMs ?? squareOffMs(setup.t), squareOffMs(setup.t))
    // The server watches the signal's index stop / target on the SPOT from now on (and exits on Dhan, with Telegram) -
    // they hold with this page closed, like the super order's own legs, trailing SL and time exit.
    const watchOnServer = (position, result) => {
      if (!result.orderIds?.length || optionOnly) return
      liveTradingApi.watchIndex({
        underlying, key: position.key, orderIds: result.orderIds, indexStop: setup.stop, indexTarget: setup.target, indexSide: setup.side, priceBasis: 'spot',
        strategy: strategyText(setup), contract: `${trade.action} ${trade.strike} ${trade.side}`, lots, lotSize: result.lotSize ?? null, entryPrice: result.prices?.limit ?? null, exitAtMs,
      }).then(() => markPosition(position.key, { indexStopSent: setup.stop, serverWatch: true }))
        .catch((err) => {
          markPosition(position.key, { serverWatch: false })
          notification.warning({ message: 'The server is NOT watching this trade\'s spot stop-loss', description: `${err.message} - its option SL / target legs on Dhan still protect it; keep this page open for the spot stop.`, placement: 'topRight', duration: 0 })
          if (c.telegram !== false) telegram(`LIVE ${trade.action} ${underlying} ${trade.strike} ${trade.side}: the server could NOT take over its spot SL (${err.message}) - keep the OI Replay page open`)
        })
    }
    const record = (result, note) => {
      placedRef.current.add(key)
      const position = {
        ...newPosition({ setup, trade, which, lots, lotSize: result.lotSize ?? PAPER_TRADE_LOT_SIZE[underlying] ?? 1, premium: result.prices?.limit ?? trade.premium, cfg: { ...c, paperSl: levelsNow.slPts, paperTarget: levelsNow.targetPts }, at: clockRef.current ?? Date.now(), plan: levelsNow }),
        live: true, orderIds: result.orderIds ?? [], liveNote: note ?? result.message,
      }
      setPaperBook((prev) => ({ ...prev, [dayKey]: { date, positions: [...(prev[dayKey]?.positions ?? []), position] } }))
      watchOnServer(position, result)
      return position
    }
    try {
      const result = await liveTradingApi.place({
        underlying, expiry, strike: trade.strike, side: trade.side, direction: trade.action, lots,
        slippagePoints: c.liveSlippage ?? 2, stopLossPoints: legs.slPts, targetPoints: legs.targetPts,
        // A strategy's trade has no option trailing stop - it trails on the spot (its own trailing stop).
        trailStartPoints: 0, trailGapPoints: 0,
        exitAtMs, exitReason: optionOnly ? `15:10 square-off of #${STRATEGY_BY_ID[setup.id]?.no} ${STRATEGY_BY_ID[setup.id]?.short ?? setup.id} (its own option exit)` : `time stop of #${STRATEGY_BY_ID[setup.id]?.no} ${STRATEGY_BY_ID[setup.id]?.short ?? setup.id}`,
      })
      const position = record(result)
      notifyTrade({ kind: 'entry', title: `LIVE ${trade.action} ${trade.strike} ${trade.side} x${lots} placed on Dhan`, text: result.message, sound: c.sound !== false })
      if (c.telegram !== false) telegram(`LIVE order placed: ${trade.action} ${underlying} ${trade.strike} ${trade.side} x${lots} lot(s) @ ~${position.premium.toFixed(1)} - ${strategyText(setup)} ${setup.side}, spot ${setup.entry.toFixed(1)} (SL ${setup.stop.toFixed(1)}, target ${setup.target.toFixed(1)} on the spot${optionOnly ? ' - not used: its own option exit' : ' - the server exits it there too, even with this page closed'}); ${optionExitText(levelsNow)}${levelsNow.own && !(levelsNow.slPts > 0 && levelsNow.targetPts > 0) ? ` - Dhan safety legs SL ${legs.slPts.toFixed(1)} / target ${legs.targetPts.toFixed(1)} pts` : ''}`)
    } catch (err) {
      if (err.result?.orderIds?.length) {
        record(err.result, `PARTLY placed - ${err.message}`)
        notification.warning({ message: `LIVE order only partly placed: ${trade.action} ${trade.strike} ${trade.side}`, description: `${err.message} - the placed part is tracked and exits with its setup; check the Dhan panel.`, placement: 'topRight', duration: 0 })
        if (c.telegram !== false) telegram(`LIVE order PARTLY placed: ${trade.action} ${underlying} ${trade.strike} ${trade.side} - ${err.message}`)
      } else fail(err.message)
    } finally {
      placingRef.current.delete(key)
    }
  }

  const punchRef = useRef(null)
  punchRef.current = (setup, which, atMs, opts = {}) => {
    if (liveModeRef.current.mode === 'live') {
      if (opts.auto) { placeLive(setup, which); return }
      const trade = tradeOf(setup, which)
      const lv = trade ? planOf(setup, trade.premium) : null
      const legs = lv ? liveLegsFor(lv, setup) : null
      Modal.confirm({
        title: 'Place a REAL order on Dhan?',
        content: trade ? `${trade.action} ${underlying} ${trade.strike} ${trade.side} x${lotsFor(setup.id, filtersOf(cfgRef.current), cfgRef.current.paperLots)} lot(s) - a super order with SL ${legs.slPts?.toFixed(1) ?? '-'} / target ${legs.targetPts?.toFixed(1) ?? '-'} premium points (${optionExitText(lv)})${lv.own && lv.exit === 'option' ? '.' : '; the server also exits it at the signal\'s spot SL / target.'}` : 'No option for this setup.',
        okText: 'Place order', okButtonProps: { danger: true }, cancelText: 'Cancel',
        onOk: () => placeLive(setup, which),
      })
      return
    }
    const trade = tradeOf(setup, which)
    const ctx = oiRef.current
    if (!trade || !ctx) return
    const at = atMs ?? setup.t
    const premium = premiumAt(ctx, trade.side, trade.strike, at) ?? trade.premium
    const lots = lotsFor(setup.id, filtersOf(cfgRef.current), cfgRef.current.paperLots)
    const already = (paperBookRef.current[dayKey]?.positions ?? []).some((p) => sameSignal(p, setup, trade))
    const lv = planOf(setup, premium)
    if (!already && !opts.quiet) {
      notifyTrade({ kind: 'entry', key: `spot-paper-${setup.id}-${setup.t}-${which}`, sound: false,
        title: `Paper ${trade.action} ${trade.strike} ${trade.side} x${lots} @ ${premium.toFixed(1)}`,
        text: `${strategyText(setup)} ${setup.side} · ${optionExitText(lv)}` })
      if (!isReplay && cfgRef.current.telegram !== false) {
        telegram(`Paper ${trade.action} ${underlying} ${trade.strike} ${trade.side} x${lots} lot(s) @ ${premium.toFixed(1)} - ${strategyText(setup)} ${setup.side}, spot ${setup.entry.toFixed(1)} (SL ${setup.stop.toFixed(1)}, target ${setup.target.toFixed(1)}); ${optionExitText(lv)}`)
      }
    }
    setPaperBook((prev) => {
      const list = prev[dayKey]?.positions ?? []
      if (list.some((p) => sameSignal(p, setup, trade))) return prev // one paper trade per signal
      const position = newPosition({ setup, trade, which, lots, lotSize: PAPER_TRADE_LOT_SIZE[underlying] ?? 1, premium, cfg: { ...cfgRef.current, paperSl: lv.slPts, paperTarget: lv.targetPts }, at, plan: lv })
      return { ...prev, [dayKey]: { date, positions: [...list, position] } }
    })
  }

  // A live trade's exit goes to Dhan once (its own super order cancelled / its legs, only its quantity closed).
  const exitingRef = useRef(new Set())
  const exitLive = (row, reason) => {
    if (exitingRef.current.has(row.key)) return
    exitingRef.current.add(row.key)
    const atMs = row.exitTime ?? clockRef.current ?? Date.now()
    const premium = row.exitTime ? row.current : premiumAt(oiRef.current, row.side, row.strike, atMs) ?? row.current
    markPosition(row.key, { exitSent: true, exitError: null, exitTime: atMs, exitPremium: premium, exitReason: reason })
    if (cfgRef.current.telegram !== false) telegram(`LIVE exit: ${row.action === 'SELL' ? 'buy back' : 'sell'} ${underlying} ${row.strike} ${row.side} x${row.lots} - ${reason}${premium != null ? ` (~${Number(premium).toFixed(1)})` : ''}`)
    liveTradingApi.exitTrade(row.orderIds ?? [], cfgRef.current.liveSlippage ?? 2)
      .then((result) => markPosition(row.key, { liveNote: result.message }))
      .catch((err) => {
        exitingRef.current.delete(row.key)
        markPosition(row.key, { exitError: err.message })
        notification.error({ message: `Live exit failed: ${row.strike} ${row.side}`, description: `${err.message} - check the Dhan panel and press Exit again.`, placement: 'topRight', duration: 0 })
      })
  }
  const exitPaper = (key) => setPaperBook((prev) => {
    const list = prev[dayKey]?.positions ?? []
    const nowMs = clockRef.current
    return {
      ...prev,
      [dayKey]: {
        date,
        positions: list.map((p) => {
          if (p.key !== key || p.exitTime) return p
          const now = premiumAt(oiRef.current, p.side, p.strike, nowMs)
          return now == null ? p : { ...p, exitTime: nowMs, exitPremium: now, exitReason: 'Exited by hand' }
        }),
      },
    }
  })

  // ---- The scan: each whole minute, on the minutes finished by then ----------------------------------------------
  // An alert: the option traded at once (paper; live with Auto-place on), a chime, the name spoken, a notification.
  const alertSetup = (s) => {
    const c = cfgRef.current
    if (!c.alerts || !alertIdsRef.current.includes(s.id)) return
    const meta = STRATEGY_BY_ID[s.id]
    const live = liveModeRef.current
    const side = optionPlanFor(s.id, filtersOf(c), c).leg
    const autoTrade = side && (live.mode !== 'live' || live.auto) ? tradeOf(s, side) : null
    if (autoTrade) punchRef.current?.(s, side, s.t, { auto: true })
    if (c.sound) chime(s.side === 'LONG')
    if (c.voice) speak(`${meta.short}. ${s.side === 'LONG' ? 'Long' : 'Short'}.${autoTrade ? ` ${autoTrade.action === 'SELL' ? 'Sold' : 'Bought'} ${autoTrade.strike} ${autoTrade.side === 'CE' ? 'call' : 'put'}.` : ''}`)
    notification.open({
      key: `${s.id}-${s.t}`, placement: 'topRight', duration: 12,
      message: <span style={{ color: s.side === 'LONG' ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>#{meta.no} {meta.name} · {s.side}</span>,
      description: (
        <div style={{ fontSize: 12 }}>
          <div style={{ fontSize: 13 }}>{IST_HHMM.format(new Date(s.t))} · spot {s.entry.toFixed(1)} · <b>SL {s.stop.toFixed(1)}</b> · <b>Target {s.target.toFixed(1)}</b></div>
          <div>{trailText(s.trail)}{s.trail ? ` (from ${(s.entry + (s.side === 'LONG' ? 1 : -1) * trailPoints(s.trail, Math.abs(s.entry - s.stop)).start).toFixed(1)})` : ''} · closed by {fmtHm(SQUARE_OFF)} at the latest</div>
          {s.options && (
            <div style={{ margin: '4px 0' }}>
              <b>Option:</b> {[optionTradeText(tradeOf(s, 'buy')), optionTradeText(tradeOf(s, 'sell'))].filter(Boolean).join(' · or ')}
              {autoTrade && <Text strong style={{ fontSize: 11, color: autoTrade.action === 'SELL' ? DOWN_COLOR : UP_COLOR }}> · {live.mode === 'live' ? 'LIVE order sent:' : 'paper'} {autoTrade.action === 'SELL' ? 'SOLD' : 'BOUGHT'} {autoTrade.strike} {autoTrade.side}</Text>}
            </div>
          )}
          {Object.entries(s.checks ?? {}).map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}
        </div>
      ),
    })
  }
  // A replay that moved over a signal (a jump, a fast replay): it is still paper-traded - quietly, at its own minute and
  // premium (nothing after it is read) - so a replayed day trades every signal of the strategies picked, as the server
  // scanner would have. Never a live order: a replay is always on paper.
  const paperTradeQuietly = (s) => {
    const c = cfgRef.current
    if (!isReplay || liveModeRef.current.mode === 'live' || !c.alerts || !alertIdsRef.current.includes(s.id)) return
    const side = optionPlanFor(s.id, filtersOf(c), c).leg
    if (side && tradeOf(s, side)) punchRef.current?.(s, side, s.t, { auto: true, quiet: true })
  }
  // Today's finished spot minutes by `minute`: the server's own candles (every tick - what the server scanner judges),
  // over this page's; a failed read keeps this page's.
  const finishedBars = async (minute) => {
    const own = (bars ?? []).filter((b) => b.t + MIN <= minute)
    if (isReplay) return own
    const from = Date.parse(`${date}T09:15:00+05:30`)
    try {
      const res = await fetch(`/api/spot/${underlying}/candles?${new URLSearchParams({ from: new Date(from).toISOString() })}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const byMinute = new Map(own.map((b) => [b.t, b]))
      for (const b of spotBarsOf(await res.json())) if (b.t >= from && b.t + MIN <= minute) byMinute.set(b.t, b)
      const merged = [...byMinute.values()].sort((a, b) => a.t - b.t)
      setServerBars(merged)
      setSpotError(null)
      return merged
    } catch (err) {
      setSpotError(err.message)
      return own
    }
  }
  const scanningRef = useRef(false)
  const clockMinute = clockMs ? Math.floor(clockMs / MIN) * MIN : 0
  const look = isReplay ? clockMinute : Math.floor((clockMs ?? 0) / 5_000)
  useEffect(() => {
    if (!oi || !clockMinute || !bars?.length || scanningRef.current) return
    // The replay clock went back: setups after it are forgotten, so they can fire again.
    if (isReplay && lastMinuteRef.current > clockMinute) {
      firedRef.current = firedRef.current.filter((f) => f.t <= clockMinute)
      lastMinuteRef.current = clockMinute
      setFired(firedRef.current)
      return
    }
    if (clockMinute <= lastMinuteRef.current) return
    scanningRef.current = true
    ;(async () => {
      try {
        const dayBars = await finishedBars(clockMinute)
        const nowMs = clockRef.current ?? clockMinute
        // Live: the minute that just ended must be in - its close is the entry. Looked for again on the next look.
        const caughtUp = dayBars.at(-1)?.t === clockMinute - MIN
        if (!isReplay && !caughtUp && nowMs - clockMinute < SPOT_WAIT_MS) return
        const c = cfgRef.current
        const filters = filtersOf(c)
        const trail = trailFor(c, underlying)
        const from = lastMinuteRef.current || (dayBars[0]?.t ?? clockMinute)
        let memory = { fired: firedRef.current }
        const found = []
        if (isReplay) {
          const r = spotScanMinutes({ from, to: clockMinute, bars: dayBars, oi, filters, trail }, memory)
          memory = { fired: r.fired }
          found.push(...r.fresh)
        } else {
          // Minutes this page has not judged (opened part-way through the day): read the way a replay is - each minute once
          // it is over -, recorded, not alerted. Then this minute, on the live OI.
          if (from < clockMinute - MIN) {
            const r = spotScanMinutes({ from, to: clockMinute - MIN, bars: dayBars, oi: asReplayContext(oi), filters, trail }, memory)
            memory = { fired: r.fired }
            found.push(...r.fresh)
          }
          const tick = caughtUp ? spotScanTick({ minute: clockMinute, bars: dayBars, oi, filters, trail }, memory) : null
          if (tick) { memory = { fired: tick.fired }; found.push(...tick.fresh) }
        }
        lastMinuteRef.current = clockMinute
        if (found.length) {
          firedRef.current = memory.fired
          setFired(firedRef.current)
          // Alerted (and traded) while it is news: today, this minute's; a replay, the last minutes it moved over - the
          // older ones a replay moved over are still paper-traded, quietly (paperTradeQuietly).
          const alertFrom = isReplay ? clockMinute - ALERT_WINDOW_MS + MIN : clockMinute
          for (const s of found) {
            if (s.t < alertFrom) { restoredRef.current.add(`${s.id}-${s.t}`); paperTradeQuietly(s) }
            else alertSetup(s)
          }
        }
        saveDay()
      } finally {
        scanningRef.current = false
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oi, look, bars?.length, isReplay, dayKey])

  // Outcomes on the spot candles up to the clock (never past it): the server's finished ones, then this page's.
  const outcomeBars = useMemo(() => {
    if (!serverBars.length) return bars ?? []
    const last = serverBars.at(-1).t
    return [...serverBars, ...(bars ?? []).filter((b) => b.t > last)]
  }, [bars, serverBars])
  const withOutcome = useMemo(() => followSetups(fired, trailLog, outcomeBars, clockMs ?? 0), [fired, trailLog, outcomeBars, clockMs])
  // The day's own spot profile #111 - #113 read now (spotProfile: time at price over the minutes finished 15+ minutes ago).
  const profile = useMemo(() => spotProfile(outcomeBars.filter((b) => b.t + MIN <= clockMinute), oi?.step), [outcomeBars, clockMinute, oi?.step])
  const signalsSig = withOutcome.map((s) => `${s.id}${s.t}${s.outcome.status}`).join()
  useEffect(() => { onSignals?.(withOutcome) }, [signalsSig]) // eslint-disable-line react-hooks/exhaustive-deps

  // Each alerted signal followed to its end - a trailing-stop move by half a risk unit or more, and its exit - alerted.
  const closedRef = useRef(new Set())
  const trailAlertRef = useRef(new Map())
  const primedRef = useRef(new Set())
  useEffect(() => { closedRef.current = new Set(); trailAlertRef.current = new Map(); primedRef.current = new Set() }, [dayKey, isReplay])
  useEffect(() => {
    const c = cfgRef.current
    const memory = { closed: closedRef.current, trail: trailAlertRef.current, primed: primedRef.current, restored: restoredRef.current }
    for (const event of setupEvents(withOutcome, memory, outcomeBars.length > 0)) {
      const { s, key } = event
      if (!c.alerts || !alertIdsRef.current.includes(s.id)) continue
      const meta = STRATEGY_BY_ID[s.id]
      if (event.type === 'trail') {
        if (c.sound) chime(true)
        if (c.voice) speak(`Trail stop. ${meta.short}.`)
        notification.open({ key: `${key}-trail`, placement: 'topRight', duration: 12,
          message: <span style={{ fontWeight: 700 }}>Move SL to {s.outcome.stop.toFixed(1)} · #{meta.no} {meta.name} · {s.side}</span>,
          description: <div style={{ fontSize: 12 }}>spot entry {s.entry.toFixed(1)} · new stop <b>{s.outcome.stop.toFixed(1)}</b> (was {event.last.toFixed(1)}) · locks {fmtR(event.locked)} · target {s.target.toFixed(1)}</div> })
        continue
      }
      const hit = exitLabel(s.outcome)
      const good = s.outcome.r > 0
      if (!isReplay && c.telegram !== false && !setupWasTraded(paperBookRef.current[dayKey]?.positions, s)) telegram(`${setupExitText(s)} (spot)`)
      if (c.sound) chime(good)
      if (c.voice) speak(`${hit}. ${meta.short}. ${good ? 'Plus' : 'Minus'} ${Math.abs(s.outcome.r).toFixed(1)} R.`)
      notification.open({ key: `${key}-exit`, placement: 'topRight', duration: 15,
        message: <span style={{ color: good ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>{hit} · #{meta.no} {meta.name} · {s.side}</span>,
        description: <div style={{ fontSize: 12 }}>spot entry {s.entry.toFixed(1)} at {IST_HHMM.format(new Date(s.t))} · {s.outcome.exitAt ? `exit ${IST_HHMM.format(new Date(s.outcome.exitAt))} · ` : ''}stop {s.outcome.stop.toFixed(1)} · target {s.target.toFixed(1)} · <b>{fmtR(s.outcome.r)}</b></div> })
    }
  }, [withOutcome, outcomeBars.length, dayKey, isReplay])

  // The day's option trades: each closed by its own SL / target / trail, or by its signal's exit (or by hand).
  const paperRows = useMemo(
    () => positionRows({ positions: paperBook[dayKey]?.positions, dayResults: withOutcome, withOutcome, oi, nowMs: clockMs, settings: { ...cfg, filters: indexFilters } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paperBook, dayKey, withOutcome, oi, clockMs, cfg, filtersByIndex],
  )
  const paperRowsRef = useRef(paperRows)
  useEffect(() => { paperRowsRef.current = paperRows }, [paperRows])
  const paperTotal = paperRows.reduce((sum, r) => sum + (r.rupees ?? 0), 0)
  const liveRows = paperRows.filter((r) => r.live)
  const liveTotal = liveRows.reduce((sum, r) => sum + (r.rupees ?? 0), 0)
  useEffect(() => { liveLossRef.current = liveTotal }, [liveTotal])
  // A live trade reaching its exit is closed on Dhan once (only while this page is open - the super order's legs and the
  // server's spot SL / target / time exit hold either way).
  useEffect(() => {
    if (isReplay) return
    for (const r of paperRows) if (r.live && r.exitTime && !r.exitSent) exitLive(r, r.exitReason ?? 'Exit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperRows, isReplay])
  // Its signal's trailing stop moved its spot stop tighter: the server is told (its own check follows the trail).
  const stopSendingRef = useRef(new Set())
  useEffect(() => {
    if (isReplay) return
    for (const r of paperRows) {
      if (!r.live || r.exitTime || r.exitSent || !r.serverWatch || r.optExit === 'option' || stopSendingRef.current.has(r.key)) continue
      const sig = withOutcome.find((x) => `${x.id}-${x.t}` === r.setupKey)
      const stop = sig?.outcome?.stop
      if (!Number.isFinite(stop) || sig.outcome.status !== 'open') continue
      const dir = r.setupSide === 'LONG' ? 1 : -1
      if (r.indexStopSent != null && !(dir * (stop - r.indexStopSent) > 0)) continue
      stopSendingRef.current.add(r.key)
      liveTradingApi.moveIndexStop(underlying, r.key, stop)
        .then(() => markPosition(r.key, { indexStopSent: stop }))
        .catch(() => { /* sent again on the next change */ })
        .finally(() => stopSendingRef.current.delete(r.key))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperRows, withOutcome, isReplay])
  // A paper trade closing is announced once (Telegram today; kept per day so a refresh does not repeat it).
  const tgPrimedRef = useRef(null)
  const exitNotifiedRef = useRef({ day: null, keys: new Set() })
  useEffect(() => {
    if (!(oi && outcomeBars.length) && tgPrimedRef.current !== dayKey) return
    if (exitNotifiedRef.current.day !== dayKey) {
      const stored = isReplay ? [] : readJson(TG_SENT_KEY, {})[dayKey] ?? []
      exitNotifiedRef.current = { day: dayKey, keys: new Set(stored) }
    }
    const sent = exitNotifiedRef.current.keys
    const opening = tgPrimedRef.current !== dayKey
    if (opening) tgPrimedRef.current = dayKey
    const c = cfgRef.current
    let changed = false
    for (const r of paperRows) {
      if (r.live || !r.exitTime || !r.exitReason || sent.has(r.key)) continue
      sent.add(r.key)
      changed = true
      if (opening) continue
      const meta = STRATEGY_BY_ID[r.strategy]
      const reason = String(r.exitReason)
      const result = paperExitResult(r, underlying)
      notifyTrade({ kind: /target/i.test(reason) ? 'target' : /\bSL\b|stop/i.test(reason) ? 'stopLoss' : 'exit', good: (r.points ?? 0) >= 0, key: `spot-paper-exit-${r.key}`, sound: c.sound !== false,
        title: `Paper exit - ${reason}`, text: `${result} (#${meta?.no} ${meta?.name})`,
        telegramText: !isReplay && c.telegram !== false ? `Paper exit - ${reason}: ${result} (#${meta?.no} ${meta?.name})` : null })
    }
    if (changed && !isReplay) writeJson(TG_SENT_KEY, { [dayKey]: [...sent] })
  }, [paperRows, isReplay, dayKey, underlying, oi, outcomeBars.length])
  // A live trade closed OUTSIDE this card (this page's live panel, the Dhan app, or its own SL / target filling): once its
  // super order was seen pending and is then gone on two checks in a row, the row is closed here too (nothing sent).
  const dhanSeenRef = useRef(new Map())
  useEffect(() => {
    if (isReplay || !canTradeLive) return undefined
    const check = async () => {
      const open = paperRowsRef.current.filter((r) => r.live && !r.exitSent && r.orderIds?.length)
      if (!open.length) return
      const snap = await liveTradingApi.positions().catch(() => null)
      if (!snap?.dhanLoggedIn) return
      notifyLiveTradeEvents(snap.events, { sound: cfgRef.current.sound !== false })
      const pending = new Set((snap.pendingOrders ?? []).map((o) => String(o.orderId)))
      for (const r of open) {
        const st = dhanSeenRef.current.get(r.key) ?? { seen: false, missing: 0 }
        if (r.orderIds.some((id) => pending.has(String(id)))) { st.seen = true; st.missing = 0 } else if (st.seen) st.missing += 1
        dhanSeenRef.current.set(r.key, st)
        if (st.seen && st.missing >= 2) {
          const atMs = clockRef.current ?? Date.now()
          markPosition(r.key, { exitSent: true, exitError: null, exitTime: atMs, exitPremium: premiumAt(oiRef.current, r.side, r.strike, atMs) ?? r.current, exitReason: 'Closed on Dhan (its SL / target or by hand)', liveNote: 'Its super order is no longer pending on Dhan.' })
        }
      }
    }
    const id = setInterval(check, 10_000)
    check()
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReplay, canTradeLive, dayKey])

  // New max rules (the index's - Trade settings: Max SL / Max target) apply to the strategy trades still OPEN, from this
  // minute - each one's own SL / target held to the new max (withCapChange); open LIVE trades get their Dhan legs moved too.
  const levelsTimerRef = useRef(null)
  const changeLimitsRef = useRef(null)
  const changeLimits = (patch, { save = true } = {}) => {
    const cur = cfgRef.current
    const caps = { maxSl: patch.paperMaxSl ?? cur.paperMaxSl ?? 0, maxTarget: patch.paperMaxTarget ?? cur.paperMaxTarget ?? 0 }
    setLevels((l) => ({ ...l, ...patch }))
    if (save) saveTradeDefaults(underlying, caps)
    const openRows = paperRowsRef.current.filter((r) => !r.exitTime && r.optExit)
    const open = new Set(openRows.map((r) => r.key))
    if (!open.size) return
    const changeAt = Math.floor((clockRef.current ?? Date.now()) / MIN) * MIN
    const liveOpen = openRows.filter((r) => r.live && r.orderIds?.length)
    if (liveOpen.length) {
      clearTimeout(levelsTimerRef.current)
      levelsTimerRef.current = setTimeout(() => {
        for (const r of liveOpen) {
          // Its own SL / target held to the new max; a leg with none stays where it is on Dhan (0 = not moved).
          const sl = capPoints(r.ownSlPts, caps.maxSl) ?? 0
          const target = capPoints(r.ownTargetPts, caps.maxTarget) ?? 0
          if (!(sl > 0) && !(target > 0)) continue
          liveTradingApi.tradeLevels(r.orderIds, sl, target, { start: 0, gap: 0 })
            .then((result) => markPosition(r.key, { liveNote: result.message }))
            .catch((err) => notification.error({ message: `Could not move the SL / target on Dhan: ${r.strike} ${r.side}`, description: err.message, placement: 'topRight', duration: 10 }))
        }
      }, 900)
    }
    setPaperBook((prev) => {
      const day = prev[dayKey]
      return day ? { ...prev, [dayKey]: { ...day, positions: withCapChange(day.positions, open, caps, changeAt) } } : prev
    })
  }
  changeLimitsRef.current = changeLimits
  useEffect(() => subscribeTradeLevels(() => {
    const next = levelsOf(underlying)
    const cur = cfgRef.current
    if (cur.paperLots !== next.paperLots || cur.liveSlippage !== next.liveSlippage) setLevels((l) => ({ ...l, paperLots: next.paperLots, liveSlippage: next.liveSlippage }))
    // The max rules changed elsewhere (Trade settings, another tab): taken here too - not saved again.
    if (cur.paperMaxSl === next.paperMaxSl && cur.paperMaxTarget === next.paperMaxTarget) return
    changeLimitsRef.current?.({ paperMaxSl: next.paperMaxSl, paperMaxTarget: next.paperMaxTarget }, { save: false })
  }), [underlying])

  const toggleCustom = (id, on) => setSettings((x) => ({ ...x, custom: on ? [...new Set([...(x.custom ?? []), id])] : (x.custom ?? []).filter((y) => y !== id) }))
  const closed = withOutcome.filter((s) => s.outcome.status !== 'open')
  const totalR = closed.reduce((a, s) => a + s.outcome.r, 0)
  const punchable = (s, o) => clockMs == null || (s.t <= clockMs && (o.status === 'open' || (o.exitAt != null ? o.exitAt + MIN : squareOffMs(s.t)) > clockMs))

  return (
    <Card
      size="small" title={<Space size={4}>{dragHandle}{`Spot + options strategies (${SPOT_IDS.length}) · signals on the spot candles, traded in options`}</Space>}
      extra={(
        <Space size={10} wrap>
          <Space size={4}><Switch size="small" checked={settings.alerts} onChange={(v) => { unlockAudio(); setSettings((x) => ({ ...x, alerts: v })) }} aria-label="Spot alerts" /><Text style={{ fontSize: 12 }}>Alerts</Text></Space>
          <Space size={4}><Switch size="small" checked={settings.sound} onChange={(v) => { unlockAudio(); setSettings((x) => ({ ...x, sound: v })) }} /><Text style={{ fontSize: 12 }}>Sound</Text></Space>
          <Space size={4}><Switch size="small" checked={settings.voice} onChange={(v) => setSettings((x) => ({ ...x, voice: v }))} /><Text style={{ fontSize: 12 }}>Speak name</Text></Space>
          <Tooltip title="Each trade punched (paper) or placed (live) today - and its exit - also goes to the server's Telegram chat. Not for replays.">
            <Space size={4}><Switch size="small" checked={settings.telegram !== false} onChange={(v) => setSettings((x) => ({ ...x, telegram: v }))} aria-label="Spot Telegram" /><Text style={{ fontSize: 12 }}>Telegram</Text></Space>
          </Tooltip>
          <Button size="small" icon={<SoundOutlined />} onClick={() => { unlockAudio(); chime(true); speak('Alerts are on') }}>Test</Button>
        </Space>
      )}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 12 }}>Alert and trade</Text>
          <Segmented size="small" value={settings.pick} onChange={(v) => setSettings((x) => ({ ...x, pick: v }))} aria-label="Spot strategies alerted"
            options={[
              { value: 'applied', label: <Tooltip title={`The spot strategies applied on ${underlying} (a fine-tuned setting from the Trades / Strategy tuning page) or on its live list - what the server scanner trades.`}>Applied on {underlying} ({appliedIds.length})</Tooltip> },
              { value: 'all', label: `All ${SPOT_IDS.length}` },
              { value: 'custom', label: 'My choice' },
            ]} />
          <Text type="secondary" style={{ fontSize: 12 }}>Every signal is listed below; only these alert and trade.{isReplay ? ` Replay: every signal of these is paper-traded as the replay runs - also the ones a jump moves over.${alertIds.length === 0 ? ' None picked - pick All to trade them all.' : ''}` : ''}</Text>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
          {SPOT_STRATEGIES.filter((s) => !s.retired).map((s) => (
            <Checkbox key={s.id} checked={alertIds.includes(s.id)} disabled={settings.pick !== 'custom'} onChange={(e) => toggleCustom(s.id, e.target.checked)} style={{ fontSize: 12 }}>
              {s.no}. {s.short}{appliedIds.includes(s.id) ? <Tag color="gold" style={{ marginLeft: 4, fontSize: 10 }}>applied</Tag> : null}
            </Checkbox>
          ))}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Judged as each minute closes on the spot candles and the OI known then - the same as the server scanner and the Strategy tuning. Entries 09:30-{fmtHm(LAST_ENTRY)}, every trade closed by <b>{fmtHm(SQUARE_OFF)}</b>; stop / target in spot points; {trailText(trailFor(cfg, underlying))} (set on the Order Flow page&apos;s scanner).
          {spotError && !isReplay ? <Text type="warning" style={{ fontSize: 12 }}> The server&apos;s spot candles could not be read ({spotError}) - this page&apos;s candles are used.</Text> : null}
        </Text>

        <div aria-label="Spot strategy signals" style={{ maxHeight: 240, overflowY: 'auto' }}>
          {withOutcome.length === 0
            ? <Text type="secondary" style={{ fontSize: 12 }}>{oi ? `No spot signal ${isReplay ? 'up to the replay time' : 'yet today'}.` : 'Loading OI…'}</Text>
            : [...withOutcome].reverse().map((s) => {
              const meta = STRATEGY_BY_ID[s.id]
              const o = s.outcome
              const on = alertIds.includes(s.id)
              return (
                <Tooltip key={`${s.id}-${s.t}`} title={setupTip(s, o)}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, padding: '3px 0', borderBottom: '1px solid #ffffff0d', opacity: on ? 1 : 0.6 }}>
                    <Text type="secondary" style={{ fontSize: 11, minWidth: 38 }}>{IST_HHMM.format(new Date(s.t))}</Text>
                    <Tag color={s.side === 'LONG' ? 'green' : 'red'} style={{ margin: 0, fontSize: 11 }}>{s.side}</Tag>
                    <span style={{ flex: 1 }}>#{meta.no} {meta.short} <Text type="secondary" style={{ fontSize: 11 }}>@ {s.entry.toFixed(1)} · <b>SL {o.trailed ? <>{s.stop.toFixed(1)} → {o.stop.toFixed(1)}</> : s.stop.toFixed(1)}</b>{s.trail ? ' (trail)' : ''} · <b>T {s.target.toFixed(1)}</b>
                      {o.status !== 'open' && o.exitPrice != null && <> · out {o.exitAt != null ? IST_HHMM.format(new Date(o.exitAt)) : 'end'} @ {o.exitPrice.toFixed(1)} ({exitLabel(o)})</>}{on ? '' : ' · not alerted'}</Text></span>
                    {s.options && oi && (
                      <span style={{ whiteSpace: 'nowrap' }}>
                        {s.options.buy && <Button size="small" type="text" style={{ padding: '0 3px', height: 18, fontSize: 11, color: UP_COLOR }} disabled={!punchable(s, o)} onClick={() => punchRef.current?.(s, 'buy', clockMs)} aria-label={`Spot buy ${s.options.buy.side}`}>B {s.options.buy.side}</Button>}
                        {s.options.sell && <Button size="small" type="text" style={{ padding: '0 3px', height: 18, fontSize: 11, color: DOWN_COLOR }} disabled={!punchable(s, o)} onClick={() => punchRef.current?.(s, 'sell', clockMs)} aria-label={`Spot sell ${s.options.sell.side}`}>S {s.options.sell.side}</Button>}
                      </span>
                    )}
                    <Tag color={o.status === 'win' ? 'success' : o.status === 'loss' ? 'error' : o.status === 'flat' ? 'default' : 'processing'} style={{ margin: 0, fontSize: 11 }}>
                      {o.status === 'open' ? `open ${fmtR(o.r)}` : `${o.status} ${fmtR(o.r)}`}
                    </Tag>
                  </div>
                </Tooltip>
              )
            })}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }} aria-label="Own spot profile">
          <Tooltip title={`Built by the strategies themselves from today's spot candles (no server or futures profile): spot has no volume, so each minute counts once over its high - low (time at price). The minutes that finished ${PROFILE_LAG}+ minutes ago are in it; #111 - #113 trade its thin areas (LVNs between two nodes) and its POC.`}>
            <b>Own spot profile</b>
          </Tooltip>{' '}
          {profile
            ? <>(to {IST_HHMM.format(new Date(profile.upTo))}, {profile.minutes} min): POC <b>{profile.poc}</b> · nodes {profile.nodes.join(' / ')} · LVN {profile.lvns.length ? profile.lvns.map((z) => `${z.low}-${z.high}`).join(', ') : 'none yet'}</>
            : `not yet - it needs ${PROFILE_LAG + PROFILE_MIN_BARS} finished minutes`}
        </Text>
        {withOutcome.length > 0 && <Text type="secondary" style={{ fontSize: 12 }}>{withOutcome.length} signal(s){closed.length ? ` · ${closed.length} closed ${fmtR(totalR)} on the spot` : ''}</Text>}

        <div aria-label="Spot option trades">
          {serverSt && !isReplay && (
            <div style={{ marginBottom: 4 }}>
              <Space wrap size={8} align="center">
                <Tooltip title={`What the SERVER scanner does on every ${underlying} alert of a strategy on its live list - spot + options ones too - with no page open. Live today: it places the Dhan super order itself, so this card's Auto-place stays off.`}>
                  <Text strong style={{ fontSize: 12 }}>Server trading ({underlying})</Text>
                </Tooltip>
                <ServerLiveSwitch underlying={underlying} st={serverSt} isAdmin={isAdmin} set={serverLive.set} compact />
              </Space>
              <ServerLiveTrades st={serverSt} />
            </div>
          )}
          <Space wrap size={8} style={{ marginBottom: 4 }}>
            <Text strong style={{ fontSize: 12 }}>Option trades</Text>
            {canTradeLive && (
              <Segmented size="small" value={tradeMode} aria-label="Spot trade mode"
                onChange={(v) => {
                  if (v !== 'live') { setTradeMode('paper'); setAutoLive(false); return }
                  Modal.confirm({
                    title: 'Switch the spot strategies to LIVE trading on Dhan?',
                    content: 'B / S on a signal will place REAL super orders (with the option SL and target as its stop-loss and target legs). Each live trade is closed on Dhan when its signal ends or you press Exit, and the server exits it at the signal\'s spot SL / target too.',
                    okText: 'Yes, go live', okButtonProps: { danger: true }, cancelText: 'Stay on paper',
                    onOk: () => setTradeMode('live'),
                  })
                }}
                options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live (Dhan)' }]} />
            )}
            <Text style={{ fontSize: 12 }}>on each alert</Text>
            <Segmented size="small" value={settings.autoPaper ?? 'strategy'} onChange={(v) => setSettings((x) => ({ ...x, autoPaper: v }))} aria-label="Spot auto trade"
              options={[{ value: 'off', label: 'Off' }, { value: 'buy', label: 'Buy option' }, { value: 'sell', label: 'Sell option' },
                { value: 'strategy', label: <Tooltip title="Each strategy buys or sells what its own applied fine-tuned setting says - its strike and option SL / target too; sells ATM where it has none.">Per strategy</Tooltip> }]} />
            <Tooltip title="Which strike (when the strategy has no tuned strike of its own): ATM, or up to 5 strikes in / out of the money.">
              <Select size="small" style={{ width: 84 }} value={settings.moneyness ?? 0} onChange={(v) => setSettings((x) => ({ ...x, moneyness: v }))} options={STRIKE_CHOICES} aria-label="Spot option strike" />
            </Tooltip>
            <InputNumber size="small" min={1} max={100} style={{ width: 64 }} value={cfg.paperLots ?? 1} aria-label="Spot lots"
              onChange={(v) => { if (v != null) { setLevels((l) => ({ ...l, paperLots: v })); saveTradeDefaults(underlying, { lots: v }) } }} />
            <Text style={{ fontSize: 12 }}>lot(s) × {PAPER_TRADE_LOT_SIZE[underlying] ?? 1}</Text>
            <Tooltip title="Each strategy's option trade follows its OWN exit - its spot stop / target / trailing stop, and its own option SL / target where it was tuned with one. These are the max rules it is held to: never a wider option SL than Max SL, never a farther target than Max target (premium points; 0 = no max).">
              <Space size={4}>
                <Text style={{ fontSize: 12 }}>Max SL</Text>
                <InputNumber size="small" min={0} max={5000} step={5} style={{ width: 64 }} value={cfg.paperMaxSl ?? 0} aria-label="Spot max SL" onChange={(v) => v != null && changeLimits({ paperMaxSl: v })} />
                <Text style={{ fontSize: 12 }}>Max target</Text>
                <InputNumber size="small" min={0} max={5000} step={5} style={{ width: 64 }} value={cfg.paperMaxTarget ?? 0} aria-label="Spot max target" onChange={(v) => v != null && changeLimits({ paperMaxTarget: v })} />
              </Space>
            </Tooltip>
            <Text type="secondary" style={{ fontSize: 11 }}>premium pts (0 = no max) - {underlying}&apos;s max rules (Trade settings, shared with the server scanner); a strategy&apos;s own SL / target is used within them; a change applies to open trades from now</Text>
            {paperRows.length > 0 && <Text strong style={{ fontSize: 12, color: paperTotal >= 0 ? UP_COLOR : DOWN_COLOR }}>P&amp;L ₹{Math.round(paperTotal).toLocaleString('en-IN')}</Text>}
            {paperRows.some((r) => !r.live) && (
              <Popconfirm title="Clear this day's spot paper trades? (Live trades stay.)" onConfirm={() => setPaperBook((prev) => {
                const keep = (prev[dayKey]?.positions ?? []).filter((p) => p.live)
                const next = { ...prev }
                if (keep.length) next[dayKey] = { ...prev[dayKey], positions: keep }; else delete next[dayKey]
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
                  <Switch size="small" checked={autoLive && !serverIsLive} disabled={serverIsLive} aria-label="Spot auto-place on alert"
                    onChange={(v) => {
                      if (!v) { setAutoLive(false); return }
                      Modal.confirm({
                        title: 'Auto-place a REAL order on every spot alert?',
                        content: `Every alert of the spot strategies selected (${alertIds.length}) will place a live super order on Dhan by itself - ${settings.autoPaper === 'buy' ? 'BUY' : settings.autoPaper === 'sell' ? 'SELL' : 'buy or sell as each strategy was tuned (sell where it was not)'} - up to ${settings.maxLiveTrades ?? 5} trades today, and stops after a ₹${(settings.maxLiveLoss ?? 10000).toLocaleString('en-IN')} loss. Turns off when you leave this page.`,
                        okText: 'Turn on', okButtonProps: { danger: true }, cancelText: 'Keep off',
                        onOk: () => setAutoLive(true),
                      })
                    }} />
                  <Text style={{ fontSize: 12 }}>Auto-place on alert{serverIsLive ? ' (off - the server places them)' : ''}</Text>
                </Space>
                <Text style={{ fontSize: 12 }}>slippage</Text>
                <InputNumber size="small" min={0} max={20} step={0.5} style={{ width: 60 }} value={cfg.liveSlippage ?? 2} aria-label="Spot live slippage"
                  onChange={(v) => { if (v != null) { setLevels((l) => ({ ...l, liveSlippage: v })); saveTradeDefaults(underlying, { slippage: v }) } }} />
                <Text style={{ fontSize: 12 }}>max trades/day</Text>
                <InputNumber size="small" min={1} max={50} style={{ width: 56 }} value={settings.maxLiveTrades ?? 5} aria-label="Spot max live trades" onChange={(v) => v != null && setSettings((x) => ({ ...x, maxLiveTrades: v }))} />
                <Text style={{ fontSize: 12 }}>stop after loss ₹</Text>
                <InputNumber size="small" min={500} max={1000000} step={500} style={{ width: 90 }} value={settings.maxLiveLoss ?? 10000} aria-label="Spot max live loss" onChange={(v) => v != null && setSettings((x) => ({ ...x, maxLiveLoss: v }))} />
                <Text style={{ fontSize: 12 }}>today: {liveRows.length} trade(s) · <span style={{ color: liveTotal >= 0 ? UP_COLOR : DOWN_COLOR }}>₹{Math.round(liveTotal).toLocaleString('en-IN')}</span> (est.)</Text>
              </Space>
            )} />
          )}
          {paperRows.length === 0
            ? <Text type="secondary" style={{ fontSize: 11 }}>On each alert the option is traded at once (paper by default). It closes at its own Max SL / Target (premium points) or when its signal ends - the spot stop, target, trailing SL or {fmtHm(SQUARE_OFF)} - whichever comes first.</Text>
            : paperRows.map((r) => (
              <div key={r.key} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, padding: '2px 0', borderBottom: '1px solid #ffffff0d' }}>
                <Text style={{ fontSize: 11, minWidth: 92, whiteSpace: 'nowrap' }}>
                  <Text type="secondary" style={{ fontSize: 10 }}>In</Text> {IST_HHMM.format(new Date(r.entryTime))}{' '}
                  <Text type="secondary" style={{ fontSize: 10 }}>Out</Text> {r.exitTime ? IST_HHMM.format(new Date(r.exitTime)) : '--:--'}
                </Text>
                {r.live && <Tag color="volcano" style={{ margin: 0, fontSize: 10 }}>LIVE</Tag>}
                <Tag color={r.action === 'BUY' ? 'green' : 'red'} style={{ margin: 0, fontSize: 11 }}>{r.action}</Tag>
                <span style={{ flex: 1 }}>{r.strike} {r.side} × {r.lots} <Text type="secondary" style={{ fontSize: 11 }}>@ {r.premium.toFixed(1)} → {r.current != null ? r.current.toFixed(1) : '-'} · #{STRATEGY_BY_ID[r.strategy]?.no} {STRATEGY_BY_ID[r.strategy]?.short}{levelsText(r)}{r.exitReason ? ` · ${r.exitReason}` : ''}</Text>
                  {r.live && (r.exitError || r.liveNote) && <Tooltip title={r.exitError ?? r.liveNote}><Text type={r.exitError ? 'danger' : 'secondary'} style={{ fontSize: 10, marginLeft: 4 }}>{r.exitError ? 'exit failed - see Dhan' : 'Dhan ✓'}</Text></Tooltip>}
                  {r.live && r.serverWatch === false && <Text type="warning" style={{ fontSize: 10, marginLeft: 4 }}>server not watching its spot SL</Text>}
                </span>
                <Text style={{ fontSize: 12, color: (r.points ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR, minWidth: 90, textAlign: 'right' }}>
                  {r.points == null ? '-' : `${r.points >= 0 ? '+' : ''}${r.points.toFixed(1)} · ₹${Math.round(r.rupees).toLocaleString('en-IN')}`}
                </Text>
                {r.live
                  ? (!r.exitSent || r.exitError
                    ? (
                      <Popconfirm title="Close this LIVE trade on Dhan?" description="Cancels its super order (or its SL / target legs) and exits only this trade's quantity." okButtonProps={{ danger: true }} onConfirm={() => exitLive(r, 'Exited by hand')}>
                        <Button size="small" danger style={{ height: 20, fontSize: 11 }}>Exit</Button>
                      </Popconfirm>
                    )
                    : <Tag style={{ margin: 0, fontSize: 11 }}>closed</Tag>)
                  : (r.exitTime ? <Tag style={{ margin: 0, fontSize: 11 }}>closed</Tag> : <Button size="small" onClick={() => exitPaper(r.key)} style={{ height: 20, fontSize: 11 }}>Exit</Button>)}
              </div>
            ))}
        </div>
      </Space>
    </Card>
  )
}
