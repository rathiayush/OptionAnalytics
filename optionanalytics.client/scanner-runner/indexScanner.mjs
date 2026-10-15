// One index (NIFTY, BANKNIFTY or SENSEX) of the server-side strategy scanner: the same data the Order Flow
// page builds (order flow snapshot + pushes, tape, OI context, previous session profile), the same
// evaluation (scannerCore.scanTick every 10 s of market time or on new data), the same paper trades, exits
// and record - with no browser. Paper, unless an admin switched the index to Live for today (Trade settings or the
// Order Flow page): then each alert ALSO asks the server for a real order (/api/scanner-runner/live/{index}/order -
// ServerLiveService checks every limit and places it; the scanner never reaches the manual live-trading API), and
// its exit closes it there. The paper trade beside it keeps the record either way.
//
// The SPOT + OPTIONS strategies (spotEngine.js) run here too, once each finished minute, on today's 1-minute spot
// candles (the server's own, /api/spot/{index}/candles) against the same OI context - exactly as the Strategy tuning
// measures them. Their stop / target / trail are in SPOT points, so their outcomes follow the spot candles and a live
// order tells the server to watch its index stop on the spot price. Every spot signal is recorded; a spot strategy
// is paper-traded (and, live today, ordered) where it was applied (a setting applied for this index or for all) or put
// on this index's live list - or picked in the page's alert list.
//
// Everything outside (HTTP, Telegram, the state file, the clock) comes in through `io`, so the tests can
// drive a whole day through it.

import { buildOiContext, optionTradeAt, premiumAt, strategyStats, topFifteen, STRATEGY_BY_ID, optionPlanFor, optionExitText, squareOffMs, lotsFor } from '../src/strategyEngine.js'
import { spotBarsOf } from '../src/spotEngine.js'
import { liquiditySignals, pullStackSignals, autoBigLots } from '../src/orderFlowMath.js'
import {
  MIN, msOf, scanTick, spotScanTick, followAllSetups, trailFor, alertIdsFor, setupEvents, newSetupEventMemory, newPosition, positionRows, sameSignal,
  withLevelChange, withCapChange, setupWasTraded, paperEntryText, signalLegs, liveLegsFor, liveLegsNow, sameLegs, setupExitText, paperExitText, scannerLogBody, scannerLogSig, scannerProfileOf, PAPER_TRADE_LOT_SIZE,
  RUNNER_DEFAULT_SETTINGS, runnerSettingsOf,
} from '../src/scannerCore.js'
import { orderFlowFromSnapshot, applyOrderFlowPush, mergePrints, applyOiTicks, applyFuturesTicks, applySpotUpdate, expiryFlagOf, TAPE_PRINTS } from '../src/liveFeeds.js'
import { newProfileWatch, profileAlertText, profileLevels, spotLevelsOf, spotProfileLevels, watchProfiles } from '../src/profileAlerts.js'
import { tpoRowFor } from '../src/profiles.js'

// The page's own defaults (StrategyScanner / OrderFlowPage) for anything the config does not say (scannerCore).
export const DEFAULT_SETTINGS = RUNNER_DEFAULT_SETTINGS
export const DEFAULT_ROW_SIZES = { NIFTY: 1, BANKNIFTY: 5, SENSEX: 5 }
const RETRY_MS = 30_000
// A failed load waits longer each time (30 s, 1 min, 2 min, then every 5 min): each try costs Dhan calls, and a
// failure that repeats (a holiday, a long outage) must not keep paying for them every 30 s all day.
const MAX_RETRY_MS = 5 * 60_000
// Before the open and at weekends there is no day to load yet: not even tried. 09:14 IST so the seed is ready as the
// first minute closes.
const LOAD_FROM_MINUTE = 9 * 60 + 14
// The session is over (15:30) and the last minute's candles have landed: from this IST minute the day is FINISHED -
// every signal gets its outcome and every paper trade its exit on the day's complete minutes, and the final record
// goes out. Nothing of a day that has closed is ever left "open".
const SESSION_OVER_MINUTE = 15 * 60 + 40
// How many past days a restart looks back over for a day it never finished (an overnight restart, the server down at
// the close). Each one costs a day of order flow and OI to read back.
export const FINISH_BACK_DAYS = 7
// How many times a day whose minutes came back incomplete is tried again before it is let go.
const FINISH_TRIES = 3
const istClock = (ms) => {
  const d = new Date(ms + 330 * 60_000)
  return { minute: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() }
}
const LOG_EVERY_MS = 3_000
// A finished spot minute not in the server's candles yet: looked for again on the next look, for up to this long.
const SPOT_WAIT_MS = 30_000
export const TAG = '[Server]'

/** The futures' own 1-minute bars from an OI-replay run (run.futuresBars: the contract's real open / high / low /
 *  close from Dhan), in the shape simulateOutcome reads. The fallback for a day whose order flow could not be rebuilt:
 *  a signal's outcome needs each minute's range, and these carry it. Empty when the run has no futures. */
export function futuresMinuteBars(run) {
  return (run?.futuresBars ?? [])
    .filter((b) => b?.time && b.close > 0 && b.high >= b.low)
    .map((b) => ({ time: b.time, open: b.open ?? b.close, high: b.high, low: b.low, close: b.close }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}

/** Signals in the order to take them: the ones on the live list first, best first (the list's order); the rest after,
 *  as they came. No list (paper): unchanged. */
export function byLiveList(fresh, list) {
  if (!Array.isArray(list) || !list.length) return fresh
  const rank = (s) => { const i = list.indexOf(s.id); return i < 0 ? Infinity : i }
  return [...fresh].map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s)
}

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
    this.spotBars = [] // today's FINISHED 1-minute spot candles (spotBarsOf), up to the last spot look
    this.spotMinute = 0 // the last minute the spot strategies were judged at
    this.spotError = null
    this.notified = new Set()
    this.primedExits = false
    this.finished = null // the date whose record is final - that day is never scanned or posted again
    this.watching = []
    this.profileWatch = newProfileWatch()
    this.profileLevelsOf = { futures: [], spotOwn: [] }
    this.appliedLevels = null
    this.appliedTrail = null
    this.appliedCaps = null
    this.dirty = false
    this.lastLogSig = ''
  }

  // ---- Configuration -------------------------------------------------------------------------------

  get enabled() { return this.config.enabled?.[this.underlying] !== false }
  // Switched to Live for today (the server says so in the config; it is only ever true for today).
  get live() { return this.config.live?.[this.underlying] === true }

  // The scanner settings as the page would have them for this index: its saved settings, this index's SL /
  // target / trail levels and max rules, its lots and what an alert trades (scannerCore.runnerSettingsOf).
  settings() {
    return runnerSettingsOf(this.config, this.underlying)
  }

  rowSize() { return this.config.settings?.orderFlow?.rowSizes?.[this.underlying] ?? DEFAULT_ROW_SIZES[this.underlying] ?? 1 }
  bigMode() { return this.config.settings?.orderFlow?.bigMode ?? 'auto' }
  largeLotsSetting() { return this.config.settings?.orderFlow?.largeLots ?? 10 }

  // The strategies alerted: the page's own list when it sent one, else the Top 15 from the scanner log.
  alertIds() {
    if (Array.isArray(this.config.alertIds)) return this.config.alertIds
    return alertIdsFor(this.settings(), this.config.top ?? topFifteen(strategyStats([])))
  }

  // Whether a strategy is alerted (paper-traded, and ordered when live today): the alert list (the Top 15 by default) -
  // and, whatever that list says, a strategy on this index's live list or with a fine-tuned setting applied on this index
  // (applying / listing it is the choice to trade it). A spot one also where its all-index filters were set (the Top 15
  // is the futures strategies' and knows nothing of them).
  isAlerted(id, cfg = this.settings()) {
    if (this.alertIds().includes(id)) return true
    if ((this.config.liveList?.[this.underlying] ?? []).includes(id) || this.config.filtersByIndex?.[this.underlying]?.[id]) return true
    return !!STRATEGY_BY_ID[id]?.spot && Object.keys(cfg.filters?.[id] ?? {}).length > 0
  }

  setConfig(config) {
    const wasRow = this.rowSize()
    this.config = config ?? {}
    // A new row size changes every footprint row - load the day again.
    if (this.data && wasRow !== this.rowSize()) this.invalidate()
    this.applySettingChanges()
  }

  // New max rules apply to the open strategy trades from this minute (withCapChange); a new trailing-stop setting to the
  // open signals that trail the scanner's - exactly as changing it on the page does. (A new SL / target / trail - a
  // manual trade's - only reaches trades opened before the max rules existed.)
  applySettingChanges() {
    const cfg = this.settings()
    const caps = JSON.stringify([cfg.paperMaxSl, cfg.paperMaxTarget])
    if (this.appliedCaps != null && this.appliedCaps !== caps && this.data?.oi) {
      const [maxSl, maxTarget] = JSON.parse(caps)
      const nowMs = this.clock() ?? this.io.now()
      const open = new Set(this.rows(nowMs).filter((r) => !r.exitTime).map((r) => r.key))
      if (open.size) {
        this.positions = withCapChange(this.positions, open, { maxSl, maxTarget }, Math.floor(nowMs / MIN) * MIN)
        this.dirty = true
      }
    }
    this.appliedCaps = caps
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
      // The day that just ended is finished before it is let go: its outcomes and exits on its complete minutes, and
      // its final record. (A day the runner was not up for at the close is finished at the next start - finishPastDays.)
      const was = this.date
      if (was && was < today) await this.finishDay(was).catch((err) => this.io.log(`${this.underlying}: ${was} not finished - ${err.message}`))
      this.reset(today)
      const saved = await this.io.loadState(this.underlying, today)
      if (saved) this.restore(saved)
    }
    if (this.data || this.loading || this.io.now() < this.nextLoadAt) return
    const clock = istClock(this.io.now())
    if (clock.weekday === 0 || clock.weekday === 6 || clock.minute < LOAD_FROM_MINUTE) return
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
        // Today's spot minutes so far (the spot strategies' bars until the first spot look brings the server's own).
        spotBars: spotBarsOf(run.spotCandlesOneMinute ?? run.spotCandles),
      })
      this.error = null
      this.failedLoads = 0
      this.io.log(`${u}: day ${today} loaded (${snapshot.bars?.length ?? 0} bars, ${tape?.prints?.length ?? 0} prints)`)
    } catch (err) {
      this.error = err.message
      this.failedLoads = (this.failedLoads ?? 0) + 1
      this.nextLoadAt = this.io.now() + Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (this.failedLoads - 1))
    }
  }

  setData(data) {
    this.data = data
    this.oiVersion = 0
    // The seed's last candle can be the minute still running when it was read - only finished ones are kept.
    const clock = this.clock() ?? this.io.now()
    if (data.spotBars?.length) this.spotBars = data.spotBars.filter((b) => b.t + MIN <= clock)
    // Profile-level alerts: the previous session's futures volume / market profile levels, and the previous
    // day's spot volume profile; nothing is armed until price is away from a level.
    const tpoRow = tpoRowFor(this.underlying, this.rowSize())
    this.profileLevelsOf = { futures: profileLevels(data.profile?.vp, data.profile?.tpoPrev, tpoRow), spotOwn: spotProfileLevels(data.spotVp, tpoRow) }
    this.profileWatch = newProfileWatch()
    this.applySettingChanges()
  }

  // Missed pushes (a reconnect): reload the day so far.
  invalidate() { this.data = null; this.nextLoadAt = 0 }

  // ---- Finishing a day -----------------------------------------------------------------------------

  /** Once the session is over, today is finished - once. Called every loop; does nothing until then. `force` (a
   *  reconcile): today is judged again even if it was finished already - but still only once its session is over, since
   *  a signal still running during the day is open for a good reason. */
  async finishIfDue({ force = false } = {}) {
    if (!this.date || (this.finished === this.date && !force)) return false
    if (istClock(this.io.now()).minute < SESSION_OVER_MINUTE || istDate(this.io.now()) !== this.date) return false
    return this.finishDay(this.date, { force })
  }

  /** The day's minutes read back whole, for a date whose session is over: the futures 1-minute bars (the day the
   *  server recorded, else estimated from Dhan's 1-minute candles) and that date's OI and spot - read as a replay
   *  reads them (each point at its minute's END, so nothing is seen before it was known). */
  async pastDay(date) {
    const u = this.underlying
    const flag = expiryFlagOf(u)
    const [snapshot, run, expiries] = await Promise.all([
      this.io.api(`/api/order-flow/${u}/day/${date}?rowSize=${this.rowSize()}&minTradeLots=5&heatmapColumns=900`).catch(() => null),
      this.io.api(`/api/oi-replay/${u}/run?${new URLSearchParams({ date, timeframeMinutes: '1', expiryFlag: flag })}`).catch(() => null),
      this.io.api(`/api/oi-replay/${u}/expiries`).catch(() => null),
    ])
    const expiryDate = u === 'BANKNIFTY' ? expiries?.month ?? null : expiries?.week ?? null
    const view = snapshot ? orderFlowFromSnapshot(snapshot) : null
    return {
      // The recorded (or estimated) order flow, else the futures' OWN 1-minute candles from the OI run - Dhan's real
      // high / low / close for that contract, which is all a signal's outcome needs. Without this a day whose order
      // flow could not be rebuilt had no minutes at all, and its futures signals stayed "open" for ever.
      view: view?.minuteBars?.length ? view : { minuteBars: futuresMinuteBars(run) },
      oi: run?.success ? buildOiContext(run, expiryDate, { live: false }) : null,
      spotBars: spotBarsOf(run?.spotCandlesOneMinute ?? run?.spotCandles ?? []),
    }
  }

  /**
   * THE DAY IS OVER: every signal of `date` gets its outcome and every paper trade its exit, on that day's COMPLETE
   * minutes (a setup that never reached its stop or target is closed at the last price, not left "open"), each closed
   * signal gets what its bought and its sold option would have made (signalLegs), and the final record is posted.
   * Then the day is marked finished and never scanned, re-priced or posted again.
   * Today: on the minutes in memory. A past day (one a restart left open): on its minutes read back (pastDay) - so a
   * day the runner was down for at the close is still finished, on the backend, with no page open.
   * Returns true when a record was posted.
   */
  async finishDay(date, { force = false } = {}) {
    if (!date || (this.finished === date && !force)) return false
    const today = date === this.date
    const state = today
      ? { date, fired: this.memory.fired, positions: this.positions, trailLog: this.trailLog, notified: [...this.notified] }
      : await this.io.loadState(this.underlying, date)
    // `force` (the trader pressed Reconcile): a day already marked finished is judged again, so a day whose minutes were
    // missing the first time - and whose signals are still showing "open" - gets another go.
    if (!state || (state.finished && !force)) { if (today && state?.finished) this.finished = date; return false }
    const fired = state.fired ?? []
    const positions = state.positions ?? []
    const tries = force ? 1 : (state.finishTries ?? 0) + 1
    const done = async (finished = true) => {
      await this.io.saveState(this.underlying, date, { ...state, date, positions, finishTries: tries, finished })
      if (today && finished) this.finished = date
    }
    if (!fired.length && !positions.length) { await done(); return false }
    // Forced: the exits already frozen onto the trades are kept (the record is what Telegram said), but a day left
    // half-judged is read again from scratch.
    if (force) this.io.log(`${this.underlying}: ${date} reconciling - judging it again on its own minutes`)

    const cfg = this.settings()
    let data = today && this.data?.oi ? { view: this.data.view, oi: this.data.oi, spotBars: this.spotBars } : await this.pastDay(date)
    // A side with no minutes cannot be judged at all, and its signals would be left "open" for ever (the day is closed
    // at the last price, and with no bars there is no last price). So where this day HAS setups on a side whose minutes
    // are missing, they are read back before giving up - the futures ones from the day's order flow or the futures'
    // own candles, the spot ones from the day's spot candles.
    const needs = (spot) => fired.some((x) => !!x.spot === spot)
    // The option chain counts as missing too: without it a signal closes but says nothing about what its option bought
    // or sold would have made (signalLegs needs the chain), and the row keeps empty If bought / If sold for ever.
    const missing = (d) => (needs(false) && !d.view?.minuteBars?.length) || (needs(true) && !d.spotBars?.length) || (fired.length > 0 && !d.oi)
    if (missing(data)) {
      const back = await this.pastDay(date)
      data = {
        oi: data.oi ?? back.oi,
        // (a side read back keeps whatever was already there - only what is missing is replaced)
        view: data.view?.minuteBars?.length ? data.view : back.view,
        spotBars: data.spotBars?.length ? data.spotBars : back.spotBars,
      }
    }
    // Nothing came back at all: left unfinished rather than closed on no data - the next start tries again.
    if (!data.oi && !data.view?.minuteBars?.length) { this.io.log(`${this.underlying}: ${date} not finished yet - its minutes did not come back`); return false }

    // Past the last minute of the day, so every bar counts and the 15:10 square-off always lands.
    const endMs = Date.parse(`${date}T23:59:00+05:30`)
    const withOutcome = followAllSetups(fired, state.trailLog ?? [], data.view?.minuteBars, data.spotBars, endMs, true)
    const rowsNow = () => positionRows({ positions, dayResults: withOutcome, withOutcome, oi: data.oi, nowMs: endMs, settings: cfg, dayOver: true })
    let rows = rowsNow()
    // The exit each trade ends with is kept on it, as during the day (exitFinal) - the record never re-prices it later.
    for (const r of rows) {
      const p = positions.find((x) => x.key === r.key)
      if (!p || p.exitFinal || !r.exitTime || r.current == null) continue
      Object.assign(p, { exitTime: r.exitTime, exitPremium: r.current, exitReason: r.exitReason ?? null, exitFinal: true })
    }
    rows = rowsNow()
    const body = scannerLogBody({ underlying: this.underlying, date, source: 'server', dayResults: withOutcome, rows, charges: cfg.charges, oi: data.oi, cfg })
    await this.io.api('/api/scanner-log/day', { method: 'POST', body })
    const open = withOutcome.filter((x) => (x.outcome?.status ?? 'open') === 'open')
    const stillOpen = open.length
    const openRows = rows.filter((r) => !r.exitTime).length
    // Why, so a row still showing "open" is never a mystery: with no minutes on its side there is nothing to judge it on.
    const why = stillOpen
      ? ` - ${[open.some((x) => x.spot) && !data.spotBars?.length ? 'no spot minutes' : null,
        open.some((x) => !x.spot) && !data.view?.minuteBars?.length ? 'no futures minutes' : null].filter(Boolean).join(', ') || 'their minutes do not reach them'}`
      : ''
    // Something was still open: part of the day's minutes did not come back. What was judged is posted anyway, and the
    // day is tried again at the next start - but only so many times, so a day whose data is simply gone is let go
    // rather than re-read for ever.
    await done(!(stillOpen || openRows) || tries >= FINISH_TRIES)
    if (today) { this.lastOutcomes = withOutcome; this.lastRows = rows; this.lastLogSig = scannerLogSig(`${this.underlying}:${date}`, body) }
    this.io.log(`${this.underlying}: ${date} finished - ${withOutcome.length} signal(s)${stillOpen ? `, ${stillOpen} still open${why} (try ${tries})` : ''}, ${rows.length - openRows}/${rows.length} trade(s) closed`)
    return true
  }

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

  // Every fired setup with its outcome so far: the futures ones on the futures minutes, the spot ones on the spot
  // minutes (their stop / target are spot prices).
  followAll(nowMs) {
    return followAllSetups(this.memory.fired, this.trailLog, this.data?.view?.minuteBars, this.spotBars, nowMs)
  }

  rows(nowMs) {
    const withOutcome = this.followAll(nowMs)
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
    // The day's record is final (finishDay): never scanned, re-priced or posted again.
    if (this.finished === this.date) return
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
    const fresh = []
    if (tick) {
      this.watching = tick.watching
      if (tick.fresh.length) {
        this.memory.fired = tick.fired
        fresh.push(...tick.fresh)
      }
    }
    // The spot + options strategies, once each finished minute.
    const spotFresh = await this.scanSpot(nowMs, cfg)
    if (spotFresh.length) {
      this.memory.fired = [...this.memory.fired, ...spotFresh]
      fresh.push(...spotFresh)
    }
    if (fresh.length) {
      this.dirty = true
      // Live: two signals in the same moment - the better-proven one (higher on the index's live list) goes first,
      // so it gets the one open live slot.
      for (const s of byLiveList(fresh, this.live ? this.config.liveList?.[this.underlying] : null)) await this.onFired(s, cfg)
    }
    await this.follow(nowMs, cfg)
    if (this.dirty) { await this.io.saveState(this.underlying, this.date, this.snapshotState()); this.dirty = false }
    await this.postLog(nowMs, cfg)
  }

  // The spot strategies at the minute the clock is in: judged once per minute, at its start, on the spot minutes that had
  // FINISHED by then and the OI known then (no look-ahead) - the setups evaluateSpotStrategies gives the Strategy
  // tuning for the same minute. Each strategy and side at most once per COOLDOWN_MS, as the futures ones (and as the
  // tuning's firstPerCooldown). Returns the fresh setups.
  async scanSpot(nowMs, cfg) {
    const minute = Math.floor(nowMs / MIN) * MIN
    if (minute <= this.spotMinute) return []
    const bars = await this.spotBarsUpTo(minute)
    // The minute that just ended must be in - its close is the entry. Not yet: looked for again on the next look.
    if (bars.at(-1)?.t !== minute - MIN) {
      if (nowMs - minute >= SPOT_WAIT_MS) this.spotMinute = minute
      return []
    }
    this.spotMinute = minute
    return spotScanTick({ minute, bars, oi: this.data.oi, filters: cfg.filters, trail: trailFor(cfg, this.underlying) }, this.memory)?.fresh ?? []
  }

  // Today's finished spot minutes by `minute`: the server's own 1-minute spot candles (its live feed, every tick), over
  // the day's seed from the OI replay; a failed read keeps what is already known.
  async spotBarsUpTo(minute) {
    const from = Date.parse(`${this.date}T09:15:00+05:30`)
    try {
      const candles = await this.io.api(`/api/spot/${this.underlying}/candles?${new URLSearchParams({ from: new Date(from).toISOString() })}`)
      const byMinute = new Map(this.spotBars.map((b) => [b.t, b]))
      // Only finished minutes are kept: a running one read now would later pass for the whole minute.
      for (const b of spotBarsOf(Array.isArray(candles) ? candles : [])) if (b.t >= from && b.t + MIN <= minute) byMinute.set(b.t, b)
      this.spotBars = [...byMinute.values()].sort((a, b) => a.t - b.t)
      this.spotError = null
    } catch (err) {
      if (this.spotError == null) this.io.log(`${this.underlying}: spot candles not read - ${err.message}`)
      this.spotError = err.message
    }
    return this.spotBars.filter((b) => b.t + MIN <= minute)
  }

  async onFired(s, cfg) {
    const meta = STRATEGY_BY_ID[s.id]
    this.io.log(`${this.underlying}: #${meta?.no} ${meta?.name} ${s.side} @ ${s.entry.toFixed(1)} (SL ${s.stop.toFixed(1)}, target ${s.target.toFixed(1)})`)
    if (!cfg.alerts || !this.isAlerted(s.id, cfg)) return
    // The moment it alerts, the option is paper-traded (the sell side by default) - as on the page.
    // Buy or sell, which strike (this strategy's own if it was tuned and applied, else the scanner's), and how the option
    // leaves the trade - always the strategy's own exit, held to the index's Max SL / Max target (optionPlanFor).
    const plan = optionPlanFor(s.id, cfg.filters, cfg)
    const side = plan.leg
    const trade = side ? optionTradeAt(this.data.oi, s, side, plan.moneyness) : null
    if (trade) {
      const premium = premiumAt(this.data.oi, trade.side, trade.strike, s.t) ?? trade.premium
      const levels = optionPlanFor(s.id, cfg.filters, cfg, premium) // a % SL / target needs the premium
      // This strategy's own lot size on this index when one was applied with it, else the index's lots (Trade settings).
      const lots = lotsFor(s.id, cfg.filters, cfg.paperLots)
      if (!this.positions.some((p) => sameSignal(p, s, trade))) {
        const position = newPosition({ setup: s, trade, which: side, lots, lotSize: cfg.paperLotSize ?? PAPER_TRADE_LOT_SIZE[this.underlying] ?? 1, premium, cfg: { ...cfg, paperSl: levels.slPts, paperTarget: levels.targetPts }, at: s.t, plan: levels })
        this.positions.push(position)
        this.dirty = true
        if (this.live) await this.placeLive(position, s, trade, levels, cfg)
        else if (cfg.telegram !== false) await this.io.telegram(`${TAG} ${paperEntryText({ underlying: this.underlying, trade, lots, premium, setup: s, cfg, plan: levels })}`)
      }
      return
    }
    // Not traded: the signal itself goes out.
    if (cfg.telegram !== false) {
      await this.io.telegram(`${TAG} ${this.underlying} #${meta?.no} ${meta?.name} ${s.side} - ${s.spot ? 'spot' : 'futures'} ${s.entry.toFixed(1)} (SL ${s.stop.toFixed(1)}, target ${s.target.toFixed(1)})`)
    }
  }

  // Live today: the server places the order for this alert - if every limit allows it (one open trade at a time, the
  // day's max trades / loss, 09:15 - 14:45, the account kill switch). The lots are the paper trade's (the strategy's own
  // on this index, else the index's), the slippage the index's Trade settings, the SL / target the same as the paper
  // trade's - a strategy with its own option exit: its own legs (a safety leg at the signal's own index distance where
  // its exit has none - liveLegsFor) and NO option trailing stop (the index's Trade settings trail is not its own).
  // Not placed: the paper trade stays, and says why.
  async placeLive(position, s, trade, levels, cfg) {
    const meta = STRATEGY_BY_ID[s.id]
    const expiry = this.data?.oi?.expiry
    const legs = liveLegsFor(levels, s)
    // Its own exit 'option': only the option's own SL / target (the super order's legs) and the 15:10 square-off - not
    // the signal's index stop / target / time stop (the tuning's optionOutcome).
    const optionOnly = levels.own && levels.exit === 'option'
    let res
    try {
      if (!expiry) throw new Error('the option expiry is not known yet')
      res = await this.io.api(`/api/scanner-runner/live/${this.underlying}/order`, {
        method: 'POST',
        body: {
          key: position.key, strategyId: s.id, strategy: `#${meta?.no} ${meta?.name ?? s.id}`, expiry, strike: trade.strike, side: trade.side, action: trade.action,
          stopLossPoints: legs.slPts, targetPoints: legs.targetPts, lots: position.lots,
          ...(levels.own ? { trailStartPoints: 0, trailGapPoints: 0 } : {}),
          // The signal's stop on the INDEX: the server exits the trade itself when the futures go through it - so the
          // index stop holds even if this scanner stops (the option's own SL / target legs are on Dhan already). A spot
          // strategy's levels are SPOT prices: the server watches those on the spot.
          ...(optionOnly ? {} : { indexStop: s.stop, indexSide: s.side, indexTarget: s.target }), priceBasis: s.spot ? 'spot' : 'futures',
          // The server closes it itself at the setup's time stop (15:10 at the latest) - even if this scanner stops.
          exitAtMs: optionOnly ? squareOffMs(s.t) : Math.min(s.timeStopMs ?? squareOffMs(s.t), squareOffMs(s.t)),
          exitReason: optionOnly ? `15:10 square-off of #${meta?.no} ${meta?.short ?? s.id} (its own option exit)` : `time stop of #${meta?.no} ${meta?.short ?? s.id}`,
        },
      })
    } catch (err) {
      res = { placed: false, message: err.message }
    }
    if (res?.placed) {
      const o = res.order ?? {}
      Object.assign(position, {
        live: true, orderIds: o.orderIds ?? [], indexStopSent: optionOnly ? null : s.stop, liveNote: o.success === false ? `PARTLY placed - ${res.message}` : res.message,
        // The legs Dhan got with the entry, and the safety legs (the signal's own index distance) a leg with none falls
        // back to - so a later change of its SL / target moves them (follow).
        liveLegs: { slPts: legs.slPts ?? null, targetPts: legs.targetPts ?? null },
        liveSafety: { slPts: Math.abs(s.entry - s.stop), targetPts: Math.abs(s.target - s.entry) },
        lotSize: o.lotSize ?? position.lotSize, premium: o.prices?.limit ?? position.premium,
      })
      this.dirty = true
      this.io.log(`${this.underlying}: LIVE ${trade.action} ${trade.strike} ${trade.side} placed - ${res.message}`)
      if (cfg.telegram !== false) await this.io.telegram(`${TAG} LIVE order placed: ${trade.action} ${this.underlying} ${trade.strike} ${trade.side} x${position.lots} lot(s) @ ~${position.premium.toFixed(1)} - #${meta?.no} ${meta?.name} ${s.side}, ${s.spot ? 'spot' : 'futures'} ${s.entry.toFixed(1)}; ${optionExitText(levels)}${levels.own && !(levels.slPts > 0 && levels.targetPts > 0) ? ` - Dhan safety legs SL ${legs.slPts.toFixed(1)} / target ${legs.targetPts.toFixed(1)} pts` : ''}${o.success === false ? ` - PARTLY placed: ${res.message}` : ''}`)
      return
    }
    position.liveNote = `not placed - ${res?.message ?? 'no answer'}`
    this.io.log(`${this.underlying}: LIVE order not placed - ${res?.message}`)
    if (cfg.telegram !== false) await this.io.telegram(`${TAG} LIVE order NOT placed for #${meta?.no} ${meta?.name} ${s.side} (${trade.action} ${trade.strike} ${trade.side}): ${res?.message ?? 'no answer'} - paper trade only`)
  }

  // Signals' exits and the paper trades' exits, each announced once.
  async follow(nowMs, cfg) {
    const d = this.data
    const withOutcome = this.followAll(nowMs)
    // Restored setups are judged once their bars are in - the spot ones' too.
    const barsReady = !!d.view.minuteBars?.length && (this.spotBars.length > 0 || !this.memory.fired.some((s) => s.spot))
    for (const event of setupEvents(withOutcome, this.events, barsReady)) {
      if (event.type !== 'exit') continue
      if (!cfg.alerts || !this.isAlerted(event.s.id, cfg)) continue
      if (cfg.telegram !== false && !setupWasTraded(this.positions, event.s)) await this.io.telegram(`${TAG} ${this.underlying} ${setupExitText(event.s)}`)
    }
    let rows = positionRows({ positions: this.positions, dayResults: withOutcome, withOutcome, oi: d.oi, nowMs, settings: cfg })
    // A trade's exit is kept on it the moment it is first seen (exitFinal) - what Telegram says is what the record keeps,
    // never re-priced by a later read of the same minutes (a reload of the day, a late tick).
    let froze = false
    for (const r of rows) {
      const p = this.positions.find((x) => x.key === r.key)
      if (!p || p.exitFinal || !r.exitTime || r.current == null) continue
      Object.assign(p, { exitTime: r.exitTime, exitPremium: r.current, exitReason: r.exitReason ?? null, exitFinal: true })
      froze = true
    }
    if (froze) {
      this.dirty = true
      rows = positionRows({ positions: this.positions, dayResults: withOutcome, withOutcome, oi: d.oi, nowMs, settings: cfg })
    }
    // The first look after a restart: trades already closed by then are not news.
    const opening = !this.primedExits
    this.primedExits = true
    // A live trade whose trailing stop moved its index stop tighter: the server is told, so its own index stop check
    // (which holds even when this scanner is down) follows the trail.
    for (const p of this.positions) {
      // Its own exit 'option' does not follow the signal's index stop at all.
      if (!p.live || p.liveExitSent || p.optExit === 'option') continue
      const sig = withOutcome.find((x) => `${x.id}-${x.t}` === p.setupKey)
      const stop = sig?.outcome?.stop
      if (!Number.isFinite(stop) || sig.outcome.status !== 'open') continue
      const dir = p.setupSide === 'LONG' ? 1 : -1
      if (p.indexStopSent != null && !(dir * (stop - p.indexStopSent) > 0)) continue
      try {
        await this.io.api(`/api/scanner-runner/live/${this.underlying}/index-stop`, { method: 'POST', body: { key: p.key, stop } })
        p.indexStopSent = stop
        this.dirty = true
      } catch (err) {
        this.io.log(`${this.underlying}: the trailed index stop of ${p.key} was not sent - ${err.message}`)
      }
    }
    // A live trade's option SL / target moved by the strategy (a new Max SL / Max target reaching its open trades from
    // that minute - withCapChange): its Dhan legs are moved to the same points at once, so the real order leaves where
    // the paper trade does. A failure is tried again a minute later (and said once on Telegram).
    for (const p of this.positions) {
      if (!p.live || p.liveExitSent || !p.orderIds?.length) continue
      const row = rows.find((r) => r.key === p.key)
      if (!row || row.exitTime) continue
      const want = liveLegsNow(p)
      if (!(want.slPts > 0) && !(want.targetPts > 0)) continue
      // Placed before its legs were kept: what it has now is what it was placed with.
      if (!p.liveLegs) { p.liveLegs = want; this.dirty = true; continue }
      if (sameLegs(want, p.liveLegs) || (p.liveLegsRetryAt ?? 0) > nowMs) continue
      const was = p.liveLegs
      const pts = (x) => (x > 0 ? x.toFixed(1) : '-')
      try {
        const res = await this.io.api(`/api/scanner-runner/live/${this.underlying}/levels`, { method: 'POST', body: { key: p.key, stopLossPoints: want.slPts ?? 0, targetPoints: want.targetPts ?? 0 } })
        Object.assign(p, { liveLegs: want, liveLegsRetryAt: null, liveNote: res?.message ?? p.liveNote })
        this.dirty = true
        this.io.log(`${this.underlying}: LIVE ${p.key} legs moved on Dhan - SL ${pts(want.slPts)} / target ${pts(want.targetPts)} pts`)
        if (cfg.telegram !== false) await this.io.telegram(`${TAG} LIVE SL / target moved on Dhan: ${p.action} ${this.underlying} ${p.strike} ${p.side} - SL ${pts(was.slPts)} -> ${pts(want.slPts)}, target ${pts(was.targetPts)} -> ${pts(want.targetPts)} pts`)
      } catch (err) {
        const first = !p.liveLegsRetryAt
        Object.assign(p, { liveLegsRetryAt: nowMs + MIN, liveNote: `SL / target not moved on Dhan - ${err.message}` })
        this.dirty = true
        this.io.log(`${this.underlying}: LIVE ${p.key} legs NOT moved - ${err.message}`)
        if (first && cfg.telegram !== false) await this.io.telegram(`${TAG} LIVE SL / target NOT moved on Dhan for ${this.underlying} ${p.action} ${p.strike} ${p.side} (SL ${pts(want.slPts)} / target ${pts(want.targetPts)} pts): ${err.message} - check the Dhan panel; trying again each minute`)
      }
    }
    // A live trade the scanner closed (its stop, target, trailing SL, time stop or the option's own levels): closed on
    // Dhan too (if its legs are still working there), once - after a restart as well - with its P&L for the day's limit.
    for (const r of rows) {
      const p = this.positions.find((x) => x.key === r.key)
      if (!p?.live || !r.exitTime || p.liveExitSent) continue
      p.liveExitSent = true
      this.dirty = true
      try {
        await this.io.api(`/api/scanner-runner/live/${this.underlying}/exit`, { method: 'POST', body: { key: p.key, reason: r.exitReason ?? 'exit', pnl: r.rupees ?? null } })
      } catch (err) {
        this.io.log(`${this.underlying}: LIVE exit of ${p.key} failed - ${err.message}`)
        if (cfg.telegram !== false) await this.io.telegram(`${TAG} LIVE exit FAILED for ${this.underlying} ${p.action} ${p.strike} ${p.side}: ${err.message} - check the Dhan panel`)
      }
    }
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
    // With the day's OI: each closed signal also says what its bought and sold option would have made (signalLegs).
    // Each leg out at the strategy's own option exit with this index's settings - as its trade is.
    const body = scannerLogBody({ underlying: this.underlying, date: this.date, source: 'server', dayResults: this.lastOutcomes ?? [], rows: this.lastRows ?? [], charges: cfg.charges, oi: this.data?.oi ?? null, cfg })
    const sig = scannerLogSig(`${this.underlying}:${this.date}`, body)
    // A trade opened or exited is saved at once (the record pages show it as it happens); anything else at most every
    // LOG_EVERY_MS.
    const tradesSig = JSON.stringify(body.trades.map((t) => [t.key, t.exitTime]))
    if (sig === this.lastLogSig || (tradesSig === this.lastLogTradesSig && this.io.now() - this.lastLogAt < LOG_EVERY_MS)) return
    this.lastLogAt = this.io.now()
    try {
      await this.io.api('/api/scanner-log/day', { method: 'POST', body })
      this.lastLogSig = sig
      this.lastLogTradesSig = tradesSig
    } catch (err) {
      this.io.log(`${this.underlying}: scanner log not saved - ${err.message}`)
    }
  }

  // ---- State across restarts -----------------------------------------------------------------------

  snapshotState() {
    return { date: this.date, fired: this.memory.fired, positions: this.positions, trailLog: this.trailLog, notified: [...this.notified], appliedLevels: this.appliedLevels, appliedTrail: this.appliedTrail, appliedCaps: this.appliedCaps, finished: this.finished === this.date }
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
    this.appliedCaps = saved.appliedCaps ?? null
    // A day already finished stays finished across a restart.
    this.finished = saved.finished ? this.date : null
  }

  /** What changes the pages' picture of this index at once: a signal fired or closed, a trade opened or exited. */
  changeSig() {
    return JSON.stringify([this.enabled, (this.lastOutcomes ?? []).map((s) => [s.id, s.t, s.outcome?.status]), (this.lastRows ?? []).map((r) => [r.key, r.exitTime ?? null, !!r.live])])
  }

  status() {
    const nowMs = this.clock()
    const rows = this.lastRows ?? []
    const outcomes = this.lastOutcomes ?? []
    const meta = (id) => STRATEGY_BY_ID[id]
    const cfg = this.settings()
    return {
      underlying: this.underlying, enabled: this.enabled, date: this.date, ready: !!this.data, error: this.error,
      clockUtc: nowMs ? new Date(nowMs).toISOString() : null, contract: this.data?.view?.meta?.contractSymbol ?? null,
      watching: this.watching.length,
      spot: { minutes: this.spotBars.length, lastMinuteUtc: this.spotBars.length ? new Date(this.spotBars.at(-1).t).toISOString() : null, error: this.spotError },
      profileAlerts: {
        futures: this.profileAlertsOn().futures && this.profileLevelsOf.futures.length > 0,
        spot: this.profileAlertsOn().spot && (this.profileLevelsOf.futures.length > 0 || this.profileLevelsOf.spotOwn.length > 0),
        levels: this.profileLevelsOf.futures.length + this.profileLevelsOf.spotOwn.length,
      },
      // Each signal with BOTH its options as they stand now: what the option bought and the option sold went in at, what
      // they are worth at this minute and the points so far (signalLegs with the clock - a closed signal's are final,
      // a running one's keep moving). So every signal, traded or not, shows its option flow live.
      signals: outcomes.map((s) => {
        const legs = this.data?.oi ? signalLegs(s, this.data.oi, { filters: cfg.filters ?? {}, cfg, nowMs }) : {}
        return {
          id: s.id, no: meta(s.id)?.no, name: meta(s.id)?.name, side: s.side, t: s.t, entry: s.entry, stop: s.stop, target: s.target,
          spot: !!s.spot, alerted: this.isAlerted(s.id, cfg), status: s.outcome?.status, r: s.outcome?.r ?? null, exitAt: s.outcome?.exitAt ?? null,
          stopNow: s.outcome?.stop ?? null, trailed: !!s.outcome?.trailed,
          points: legs.indexPoints ?? null, running: !!legs.running,
          buyOption: legs.buyOption ?? null, buyEntry: legs.buyEntry ?? null, buyNow: legs.buyExit ?? null, buyPoints: legs.buyPoints ?? null,
          buyExitReason: legs.buyExitReason ?? null,
          sellOption: legs.sellOption ?? null, sellEntry: legs.sellEntry ?? null, sellNow: legs.sellExit ?? null, sellPoints: legs.sellPoints ?? null,
          sellExitReason: legs.sellExitReason ?? null,
        }
      }),
      trades: rows.map((r) => ({
        key: r.key, strategy: r.strategy, no: meta(r.strategy)?.no, action: r.action, side: r.side, strike: r.strike, lots: r.lots, lotSize: r.lotSize,
        premium: r.premium, current: r.current, points: r.points, rupees: r.rupees, entryTime: r.entryTime, exitTime: r.exitTime, exitReason: r.exitReason,
        live: !!r.live,
      })),
      pnl: rows.reduce((sum, r) => sum + (r.rupees ?? 0), 0),
    }
  }
}

// The Top 15 from the scanner log's signals - signals.csv (the pages' record) and server-signals.csv (this scanner's own;
// the strategies run here now) - every day and device: each row's strategy and outcome, as strategyStats reads them. A
// signal both recorded (the same index, strategy and minute) counts once.
export function topFromSignalsCsv(csvs) {
  const trades = []
  const seen = new Set()
  for (const csv of Array.isArray(csvs) ? csvs : [csvs]) {
    const lines = String(csv ?? '').split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) continue
    const head = parseCsvLine(lines[0])
    const col = (name) => head.indexOf(name)
    const [idCol, statusCol, rCol, uCol, tCol] = [col('strategy_id'), col('status'), col('r'), col('underlying'), col('time_ist')]
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line)
      const status = cells[statusCol]
      const r = Number(cells[rCol])
      if (!cells[idCol] || !status || status === 'open' || !Number.isFinite(r)) continue
      const key = uCol >= 0 && tCol >= 0 ? `${cells[uCol]}|${cells[idCol]}|${String(cells[tCol]).slice(0, 16)}` : null
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      trades.push({ id: cells[idCol], outcome: { status, r } })
    }
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
