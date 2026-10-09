// One index (NIFTY, BANKNIFTY or SENSEX) of the server-side strategy scanner: the same data the Order Flow
// page builds (order flow snapshot + pushes, tape, OI context, previous session profile), the same
// evaluation (scannerCore.scanTick every 10 s of market time or on new data), the same paper trades, exits
// and record - with no browser. PAPER ONLY: it never calls the live-trading endpoints.
//
// Everything outside (HTTP, Telegram, the state file, the clock) comes in through `io`, so the tests can
// drive a whole day through it.

import { buildOiContext, optionTradeAt, premiumAt, strategyStats, topFifteen, STRATEGY_BY_ID, DEFAULT_TRAIL } from '../src/strategyEngine.js'
import { liquiditySignals, pullStackSignals, autoBigLots } from '../src/orderFlowMath.js'
import {
  MIN, msOf, scanTick, trailFor, alertIdsFor, followSetups, setupEvents, newSetupEventMemory, newPosition, positionRows, sameSignal,
  withLevelChange, setupWasTraded, paperEntryText, setupExitText, paperExitText, scannerLogBody, scannerLogSig, scannerProfileOf, PAPER_TRADE_LOT_SIZE,
} from '../src/scannerCore.js'
import { orderFlowFromSnapshot, applyOrderFlowPush, mergePrints, applyOiTicks, applyFuturesTicks, applySpotUpdate, expiryFlagOf, TAPE_PRINTS } from '../src/liveFeeds.js'
import { defaultTradeLevels } from '../src/tradeDefaults.js'
import { newProfileWatch, profileAlertText, profileLevels, spotLevelsOf, spotProfileLevels, watchProfiles } from '../src/profileAlerts.js'
import { tpoRowFor } from '../src/profiles.js'

// The page's own defaults (StrategyScanner / OrderFlowPage) for anything the config does not say.
export const DEFAULT_SETTINGS = { alerts: true, telegram: true, pick: 'top15', custom: [], filters: {}, trail: { on: true, ...DEFAULT_TRAIL }, autoPaper: 'sell', paperLots: 1, moneyness: 0 }
export const DEFAULT_ROW_SIZES = { NIFTY: 1, BANKNIFTY: 5, SENSEX: 5 }
const RETRY_MS = 30_000
const LOG_EVERY_MS = 3_000
export const TAG = '[Server]'

const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
export const istDate = (ms) => IST_DATE.format(new Date(ms))

export class IndexScanner {
  constructor(underlying, io) {
    this.underlying = underlying
    this.io = io
    this.config = {}
    this.date = null
    this.data = null // { view, prints, oi, profile }
    this.error = null
    this.loading = null
    this.nextLoadAt = 0
    this.lastLook = null
    this.lastLogAt = 0
    this.lastLogSig = ''
    this.reset(null)
  }

  reset(date) {
    this.date = date
    this.data = null
    this.memory = { fired: [] }
    this.events = newSetupEventMemory()
    this.positions = []
    this.trailLog = []
    this.notified = new Set()
    this.primedExits = false
    this.watching = []
    this.profileWatch = newProfileWatch()
    this.profileLevelsOf = { futures: [], spotOwn: [] }
    this.appliedLevels = null
    this.appliedTrail = null
    this.dirty = false
    this.lastLogSig = ''
  }

  // ---- Configuration -------------------------------------------------------------------------------

  get enabled() { return this.config.enabled?.[this.underlying] !== false }

  // The scanner settings as the page would have them for this index: its saved settings, this index's SL /
  // target / trail levels.
  settings() {
    const s = { ...DEFAULT_SETTINGS, ...(this.config.settings ?? {}) }
    const levels = { ...defaultTradeLevels(this.underlying), trailStart: 0, trailGap: 0, ...(this.config.levels?.[this.underlying] ?? {}) }
    // The index's own trade settings (trade-settings.csv): its lots and what an alert trades.
    const trade = this.config.trade?.[this.underlying] ?? {}
    return {
      ...s, paperSl: levels.sl, paperTarget: levels.target, paperTrailStart: levels.trailStart ?? 0, paperTrailGap: levels.trailGap ?? 0,
      ...(trade.lots > 0 ? { paperLots: trade.lots } : {}), ...(trade.autoTrade ? { autoPaper: trade.autoTrade } : {}),
    }
  }

  rowSize() { return this.config.settings?.orderFlow?.rowSizes?.[this.underlying] ?? DEFAULT_ROW_SIZES[this.underlying] ?? 1 }
  bigMode() { return this.config.settings?.orderFlow?.bigMode ?? 'auto' }
  largeLotsSetting() { return this.config.settings?.orderFlow?.largeLots ?? 10 }

  // The strategies alerted: the page's own list when it sent one, else the Top 15 from the scanner log.
  alertIds() {
    if (Array.isArray(this.config.alertIds)) return this.config.alertIds
    return alertIdsFor(this.settings(), this.config.top ?? topFifteen(strategyStats([])))
  }

  setConfig(config) {
    const wasRow = this.rowSize()
    this.config = config ?? {}
    // A new row size changes every footprint row - load the day again.
    if (this.data && wasRow !== this.rowSize()) this.invalidate()
    this.applySettingChanges()
  }

  // A new SL / target / trail applies to the open paper trades from this minute; a new trailing-stop
  // setting to the open signals - exactly as changing it on the page does.
  applySettingChanges() {
    const cfg = this.settings()
    const levels = JSON.stringify([cfg.paperSl, cfg.paperTarget, cfg.paperTrailStart, cfg.paperTrailGap])
    const trail = JSON.stringify(trailFor(cfg, this.underlying))
    const nowMs = this.clock() ?? this.io.now()
    if (this.appliedLevels != null && this.appliedLevels !== levels && this.data?.oi) {
      const [paperSl, paperTarget, paperTrailStart, paperTrailGap] = JSON.parse(levels)
      const before = JSON.parse(this.appliedLevels)
      const cur = { paperSl: before[0], paperTarget: before[1], paperTrailStart: before[2], paperTrailGap: before[3] }
      const open = new Set(this.rows(nowMs).filter((r) => !r.exitTime).map((r) => r.key))
      if (open.size) {
        this.positions = withLevelChange(this.positions, open, { paperSl, paperTarget, paperTrailStart, paperTrailGap }, Math.floor(nowMs / MIN) * MIN, cur)
        this.dirty = true
      }
    }
    if (this.appliedTrail != null && this.appliedTrail !== trail) {
      const t = Math.floor(nowMs / MIN) * MIN
      this.trailLog = [...this.trailLog.filter((c) => c.t < t), { t, trail: JSON.parse(trail) }]
      this.dirty = true
    }
    this.appliedLevels = levels
    this.appliedTrail = trail
  }

  groups() {
    return [`of:${this.underlying}`, `u:${this.underlying}`, `c:${this.underlying}:${expiryFlagOf(this.underlying)}`]
  }

  // ---- Data ----------------------------------------------------------------------------------------

  // Today's data, loaded once per day (again after a failure, a reconnect or a new row size).
  async ensureDay(today) {
    if (this.date !== today) {
      this.reset(today)
      const saved = await this.io.loadState(this.underlying, today)
      if (saved) this.restore(saved)
    }
    if (this.data || this.loading || this.io.now() < this.nextLoadAt) return
    this.loading = this.load(today).finally(() => { this.loading = null })
    await this.loading
  }

  async load(today) {
    const u = this.underlying
    const rowSize = this.rowSize()
    const fetchLots = this.bigMode() === 'auto' ? 5 : this.largeLotsSetting()
    try {
      const flag = expiryFlagOf(u)
      const [snapshot, tape, run, expiries, prev, spotVp] = await Promise.all([
        this.io.api(`/api/order-flow/${u}?rowSize=${rowSize}&minTradeLots=${fetchLots}&heatmapColumns=900`),
        this.io.api(`/api/order-flow/${u}/tape?count=${TAPE_PRINTS}`),
        this.io.api(`/api/oi-replay/${u}/run?${new URLSearchParams({ date: today, timeframeMinutes: '1', expiryFlag: flag, forceLive: 'true' })}`),
        this.io.api(`/api/oi-replay/${u}/expiries`).catch(() => null),
        this.io.previousSession(u, today, rowSize).catch(() => null),
        // The previous day's spot volume profile - the lines on the OI Replay charts (profile alerts on spot).
        this.io.api(`/api/oi-replay/${u}/previous-day-volume-profile?date=${today}`).catch(() => null),
      ])
      if (!run?.success || !(run.spotCandlesOneMinute ?? run.spotCandles ?? []).length) throw new Error(run?.success ? 'no index data yet (before the open?)' : run?.error ?? 'OI data unavailable')
      const expiryDate = u === 'BANKNIFTY' ? expiries?.month ?? null : expiries?.week ?? null
      this.setData({
        view: orderFlowFromSnapshot(snapshot),
        prints: tape?.prints ?? [],
        oi: buildOiContext(run, expiryDate, { live: true }),
        profile: scannerProfileOf(prev?.bars, u, rowSize),
        spotVp: spotVp?.success ? spotVp : null,
      })
      this.error = null
      this.io.log(`${u}: day ${today} loaded (${snapshot.bars?.length ?? 0} bars, ${tape?.prints?.length ?? 0} prints)`)
    } catch (err) {
      this.error = err.message
      this.nextLoadAt = this.io.now() + RETRY_MS
    }
  }

  setData(data) {
    this.data = data
    this.oiVersion = 0
    // Profile-level alerts: the previous session's futures volume / market profile levels, and the previous
    // day's spot volume profile; nothing is armed until price is away from a level.
    const tpoRow = tpoRowFor(this.underlying, this.rowSize())
    this.profileLevelsOf = { futures: profileLevels(data.profile?.vp, data.profile?.tpoPrev, tpoRow), spotOwn: spotProfileLevels(data.spotVp, tpoRow) }
    this.profileWatch = newProfileWatch()
    this.applySettingChanges()
  }

  // Missed pushes (a reconnect): reload the day so far.
  invalidate() { this.data = null; this.nextLoadAt = 0 }

  onOrderFlowLive(payload) {
    const d = this.data
    if (!d?.view || payload?.meta?.securityId !== d.view.meta?.securityId) return
    // The engine rolled into a new trading day (or another contract): start from its snapshot.
    if (payload.meta?.day && d.view.meta?.day && payload.meta.day !== d.view.meta.day) { this.invalidate(); return }
    d.view = applyOrderFlowPush(d.view, payload, this.rowSize())
    if (payload.trades?.length) d.prints = mergePrints(d.prints, payload.trades)
  }

  onOiTicks(ticks) { if (applyOiTicks(this.data?.oi, ticks, this.underlying, expiryFlagOf(this.underlying))) this.oiVersion++ }
  onFuturesTicks(ticks) { if (applyFuturesTicks(this.data?.oi, ticks, this.underlying)) this.oiVersion++ }
  onSpotUpdate(snapshot) { if (applySpotUpdate(this.data?.oi, snapshot, this.underlying)) this.oiVersion++ }

  // ---- The scan ------------------------------------------------------------------------------------

  // The market clock: the last heatmap column the server pushed (the page's own "now").
  clock() {
    const v = this.data?.view
    if (!v) return null
    return v.heatmap?.at(-1)?.t ?? (v.meta?.lastTradeAt ? msOf(v.meta.lastTradeAt) : null)
  }

  rows(nowMs) {
    const withOutcome = followSetups(this.memory.fired, this.trailLog, this.data?.view?.minuteBars, nowMs)
    return positionRows({ positions: this.positions, dayResults: withOutcome, withOutcome, oi: this.data?.oi, nowMs, settings: this.settings() })
  }

  // Which indices' profile alerts the server sends: the page's switches (config.profileAlerts), on by default.
  profileAlertsOn() { return { futures: true, spot: true, ...(this.config.profileAlerts ?? {}) } }

  // Price reaching a profile level - futures: the previous session's volume / market profile; spot: those less
  // the futures premium, and the previous day's spot volume profile. Telegram, tagged [Server] - with no page open.
  async checkProfileLevels(d) {
    const futures = d.prints.at(-1)?.price ?? d.view.meta?.lastPrice ?? null
    const spot = d.oi?.spot?.at(-1)?.close ?? null
    const basis = futures > 0 && spot > 0 ? Math.round(futures - spot) : null
    const levels = { futures: this.profileLevelsOf.futures, spot: spotLevelsOf(this.profileLevelsOf.futures, basis, this.profileLevelsOf.spotOwn) }
    const hits = watchProfiles(this.profileWatch, { levels, prices: { futures, spot }, enabled: this.profileAlertsOn(), tpoRow: tpoRowFor(this.underlying, this.rowSize()) })
    if (!hits.length) return
    const cfg = this.settings()
    for (const { market, level, price } of hits) {
      const text = profileAlertText(level, price, `${this.underlying} ${market}`)
      this.io.log(`${this.underlying}: ${text}`)
      if (cfg.telegram !== false) await this.io.telegram(`${TAG} 📊 ${text}`)
    }
  }

  async evaluate() {
    const d = this.data
    if (!this.enabled || !d?.view || !d.oi) return
    // Before the engine has today's first tick its snapshot is yesterday's - nothing to scan.
    if (d.view.meta?.day && d.view.meta.day !== this.date) return
    const nowMs = this.clock()
    if (!nowMs || istDate(nowMs) !== this.date) return
    await this.checkProfileLevels(d)
    const look = [Math.floor(nowMs / 10_000), d.view.minuteBars?.length ?? 0, d.prints.at(-1)?.seq ?? 0, this.oiVersion, !!d.profile].join()
    if (look === this.lastLook) return
    this.lastLook = look

    const cfg = this.settings()
    const lotSize = d.view.meta?.lotSize ?? 1
    const rowSize = this.rowSize()
    const bigLots = this.bigMode() === 'auto' ? autoBigLots(d.prints, lotSize) ?? 10 : this.largeLotsSetting()
    const largeTrades = (d.view.trades ?? []).filter((t) => t.quantity >= bigLots * lotSize)
    const estimated = d.view.source === 'estimated' || d.view.source === 'truedata'
    const columns = (d.view.heatmap ?? []).slice(-1800)
    const liquidity = estimated ? [] : liquiditySignals({ columns, trades: largeTrades, minuteBars: d.view.minuteBars ?? [], rowSize, lotSize })
    const pullStack = estimated ? [] : pullStackSignals({ columns, rowSize, lotSize }).signals

    const tick = scanTick({
      nowMs, view: d.view, tapePrints: d.prints, liquidity, pullStack, oi: d.oi, estimated, lotSize, largeLots: bigLots, profile: d.profile, rowSize,
      filters: cfg.filters, trail: trailFor(cfg, this.underlying),
    }, this.memory)
    if (tick) {
      this.watching = tick.watching
      if (tick.fresh.length) {
        this.memory.fired = tick.fired
        this.dirty = true
        for (const s of tick.fresh) await this.onFired(s, cfg)
      }
    }
    await this.follow(nowMs, cfg)
    if (this.dirty) { await this.io.saveState(this.underlying, this.date, this.snapshotState()); this.dirty = false }
    await this.postLog(nowMs, cfg)
  }

  async onFired(s, cfg) {
    const meta = STRATEGY_BY_ID[s.id]
    this.io.log(`${this.underlying}: #${meta?.no} ${meta?.name} ${s.side} @ ${s.entry.toFixed(1)} (SL ${s.stop.toFixed(1)}, target ${s.target.toFixed(1)})`)
    if (!cfg.alerts || !this.alertIds().includes(s.id)) return
    // The moment it alerts, the option is paper-traded (the sell side by default) - as on the page.
    const side = cfg.autoPaper === 'buy' || cfg.autoPaper === 'sell' ? cfg.autoPaper : null
    const trade = side ? optionTradeAt(this.data.oi, s, side, cfg.moneyness ?? 0) : null
    if (trade) {
      const premium = premiumAt(this.data.oi, trade.side, trade.strike, s.t) ?? trade.premium
      const lots = Math.max(1, cfg.paperLots ?? 1)
      if (!this.positions.some((p) => sameSignal(p, s, trade))) {
        this.positions.push(newPosition({ setup: s, trade, which: side, lots, lotSize: PAPER_TRADE_LOT_SIZE[this.underlying] ?? 1, premium, cfg, at: s.t }))
        this.dirty = true
        if (cfg.telegram !== false) await this.io.telegram(`${TAG} ${paperEntryText({ underlying: this.underlying, trade, lots, premium, setup: s, cfg })}`)
      }
      return
    }
    // Not traded: the signal itself goes out.
    if (cfg.telegram !== false) {
      await this.io.telegram(`${TAG} ${this.underlying} #${meta?.no} ${meta?.name} ${s.side} - futures ${s.entry.toFixed(1)} (SL ${s.stop.toFixed(1)}, target ${s.target.toFixed(1)})`)
    }
  }

  // Signals' exits and the paper trades' exits, each announced once.
  async follow(nowMs, cfg) {
    const d = this.data
    const withOutcome = followSetups(this.memory.fired, this.trailLog, d.view.minuteBars, nowMs)
    for (const event of setupEvents(withOutcome, this.events, !!d.view.minuteBars?.length)) {
      if (event.type !== 'exit') continue
      if (!cfg.alerts || !this.alertIds().includes(event.s.id)) continue
      if (cfg.telegram !== false && !setupWasTraded(this.positions, event.s)) await this.io.telegram(`${TAG} ${this.underlying} ${setupExitText(event.s)}`)
    }
    const rows = positionRows({ positions: this.positions, dayResults: withOutcome, withOutcome, oi: d.oi, nowMs, settings: cfg })
    // The first look after a restart: trades already closed by then are not news.
    const opening = !this.primedExits
    this.primedExits = true
    for (const r of rows) {
      if (!r.exitTime || !r.exitReason || this.notified.has(r.key)) continue
      this.notified.add(r.key)
      this.dirty = true
      if (opening) continue
      if (cfg.telegram !== false) await this.io.telegram(`${TAG} ${paperExitText(r, this.underlying)}`)
    }
    this.lastRows = rows
    this.lastOutcomes = withOutcome
  }

  // The day's record in the server's scanner log (server-signals.csv / server-trades.csv).
  async postLog(nowMs, cfg) {
    if (!this.lastOutcomes?.length && !this.lastRows?.length) return
    const body = scannerLogBody({ underlying: this.underlying, date: this.date, source: 'server', dayResults: this.lastOutcomes ?? [], rows: this.lastRows ?? [], charges: cfg.charges })
    const sig = scannerLogSig(`${this.underlying}:${this.date}`, body)
    if (sig === this.lastLogSig || this.io.now() - this.lastLogAt < LOG_EVERY_MS) return
    this.lastLogAt = this.io.now()
    try {
      await this.io.api('/api/scanner-log/day', { method: 'POST', body })
      this.lastLogSig = sig
    } catch (err) {
      this.io.log(`${this.underlying}: scanner log not saved - ${err.message}`)
    }
  }

  // ---- State across restarts -----------------------------------------------------------------------

  snapshotState() {
    return { date: this.date, fired: this.memory.fired, positions: this.positions, trailLog: this.trailLog, notified: [...this.notified], appliedLevels: this.appliedLevels, appliedTrail: this.appliedTrail }
  }

  restore(saved) {
    this.memory.fired = saved.fired ?? []
    // Brought back after a restart: what already happened to them was announced before.
    this.events.restored = new Set(this.memory.fired.map((f) => `${f.id}-${f.t}`))
    this.positions = saved.positions ?? []
    this.trailLog = saved.trailLog ?? []
    this.notified = new Set(saved.notified ?? [])
    this.appliedLevels = saved.appliedLevels ?? null
    this.appliedTrail = saved.appliedTrail ?? null
  }

  status() {
    const nowMs = this.clock()
    const rows = this.lastRows ?? []
    const outcomes = this.lastOutcomes ?? []
    const meta = (id) => STRATEGY_BY_ID[id]
    return {
      underlying: this.underlying, enabled: this.enabled, date: this.date, ready: !!this.data, error: this.error,
      clockUtc: nowMs ? new Date(nowMs).toISOString() : null, contract: this.data?.view?.meta?.contractSymbol ?? null,
      watching: this.watching.length,
      profileAlerts: {
        futures: this.profileAlertsOn().futures && this.profileLevelsOf.futures.length > 0,
        spot: this.profileAlertsOn().spot && (this.profileLevelsOf.futures.length > 0 || this.profileLevelsOf.spotOwn.length > 0),
        levels: this.profileLevelsOf.futures.length + this.profileLevelsOf.spotOwn.length,
      },
      signals: outcomes.map((s) => ({
        id: s.id, no: meta(s.id)?.no, name: meta(s.id)?.name, side: s.side, t: s.t, entry: s.entry, stop: s.stop, target: s.target,
        alerted: this.alertIds().includes(s.id), status: s.outcome?.status, r: s.outcome?.r ?? null, exitAt: s.outcome?.exitAt ?? null,
      })),
      trades: rows.map((r) => ({
        key: r.key, strategy: r.strategy, no: meta(r.strategy)?.no, action: r.action, side: r.side, strike: r.strike, lots: r.lots, lotSize: r.lotSize,
        premium: r.premium, current: r.current, points: r.points, rupees: r.rupees, entryTime: r.entryTime, exitTime: r.exitTime, exitReason: r.exitReason,
      })),
      pnl: rows.reduce((sum, r) => sum + (r.rupees ?? 0), 0),
    }
  }
}

// The Top 15 from the scanner log's signals (signals.csv - the pages' record, every day and device): each
// row's strategy and outcome, as strategyStats reads them.
export function topFromSignalsCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return topFifteen(strategyStats([]))
  const head = parseCsvLine(lines[0])
  const col = (name) => head.indexOf(name)
  const [idCol, statusCol, rCol] = [col('strategy_id'), col('status'), col('r')]
  const trades = []
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const status = cells[statusCol]
    const r = Number(cells[rCol])
    if (!cells[idCol] || !status || status === 'open' || !Number.isFinite(r)) continue
    trades.push({ id: cells[idCol], outcome: { status, r } })
  }
  return topFifteen(strategyStats(trades))
}

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out
}
