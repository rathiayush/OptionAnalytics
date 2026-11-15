// One index (NIFTY, BANKNIFTY or SENSEX) of the server's ALERT RUNNER: with no browser open it keeps the same data the
// pages build (the order flow snapshot + pushes, the tape, the day's OI, the previous session's profiles) and raises the
// app's two server-side alerts from it - price reaching a PROFILE LEVEL (profileAlerts.js) and the OI totals' S/R BREAKS
// and high-probability signals (oiLevelBreaks.js). (It was the server-side STRATEGY SCANNER - the strategies, their paper
// trades, exits and log were removed with the scanner, on request; these alerts ran beside them and stay.) It places
// nothing: its role cannot reach the live-trading API.
//
// Everything outside (HTTP, Telegram, the clock) comes in through `io`, so the tests can drive a day through it.

import { buildOiContext } from '../src/oiContext.js'
import { orderFlowFromSnapshot, applyOrderFlowPush, orderFlowPushGap, mergePrints, applyOiTicks, applyFuturesTicks, applySpotUpdate, expiryFlagOf, TAPE_PRINTS } from '../src/liveFeeds.js'
import { newProfileWatch, profileAlertText, profileLevels, sendsProfileTelegram, sessionProfileOf, spotLevelsOf, spotProfileLevels, watchProfiles } from '../src/profileAlerts.js'
import { tpoRowFor } from '../src/profiles.js'
import {
  IST_OFFSET_SECONDS, OI_BREAK_ALERT_DEFAULTS, breakAlertKey, breakMeaning, breakText, chartTimeHHmm, fmtOiLakh, highProbabilityAlertKey, highProbabilityText,
  changesFromLevels, newOiBreakAlertState, perStrikeLevels, stepOiBreakAlerts,
} from '../src/oiLevelBreaks.js'

const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
// Telegram is on unless the saved settings say otherwise (config.settings.telegram === false).
export const DEFAULT_SETTINGS = { telegram: true }
export const DEFAULT_ROW_SIZES = { NIFTY: 1, BANKNIFTY: 5, SENSEX: 5 }
const RETRY_MS = 30_000
// OI break alerts: looked at when a bucket completes, or at most this often while OI ticks arrive.
const OI_BREAK_EVERY_MS = 5_000
const OI_BREAK_RECENT = 30
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
    this.reset(null)
  }

  reset(date) {
    this.date = date
    this.data = null
    this.profileWatch = newProfileWatch()
    this.profileLevelsOf = { futures: [], spotOwn: [] }
    this.oiBreaks = { state: newOiBreakAlertState(), settingsSig: null, boundary: null, at: 0, sent: [] }
  }

  // ---- Configuration -------------------------------------------------------------------------------

  get enabled() { return this.config.enabled?.[this.underlying] !== false }

  settings() { return { ...DEFAULT_SETTINGS, ...(this.config.settings ?? {}) } }

  rowSize() { return this.config.settings?.orderFlow?.rowSizes?.[this.underlying] ?? DEFAULT_ROW_SIZES[this.underlying] ?? 1 }
  bigMode() { return this.config.settings?.orderFlow?.bigMode ?? 'auto' }
  largeLotsSetting() { return this.config.settings?.orderFlow?.largeLots ?? 10 }

  setConfig(config) {
    const wasRow = this.rowSize()
    this.config = config ?? {}
    // A new row size changes every footprint row - load the day again.
    if (this.data && wasRow !== this.rowSize()) this.invalidate()
  }

  groups() {
    return [`of:${this.underlying}`, `u:${this.underlying}`, `c:${this.underlying}:${expiryFlagOf(this.underlying)}`]
  }

  // ---- Data ----------------------------------------------------------------------------------------

  // Today's data, loaded once per day (again after a failure, a reconnect or a new row size).
  async ensureDay(today) {
    if (this.date !== today) this.reset(today)
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
        profile: sessionProfileOf(prev?.bars, u, rowSize),
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
  }

  // Missed pushes (a reconnect): reload the day so far.
  invalidate() { this.data = null; this.nextLoadAt = 0 }

  onOrderFlowLive(payload) {
    const d = this.data
    if (!d?.view || payload?.meta?.securityId !== d.view.meta?.securityId) return
    // The engine rolled into a new trading day (or another contract): start from its snapshot.
    if (payload.meta?.day && d.view.meta?.day && payload.meta.day !== d.view.meta.day) { this.invalidate(); return }
    // A minute missed between the day held and this push (pushes skipped): load the day so far again.
    if (orderFlowPushGap(d.view, payload)) { this.invalidate(); return }
    d.view = applyOrderFlowPush(d.view, payload, this.rowSize())
    if (payload.trades?.length) d.prints = mergePrints(d.prints, payload.trades)
  }

  onOiTicks(ticks) { if (applyOiTicks(this.data?.oi, ticks, this.underlying, expiryFlagOf(this.underlying))) this.oiVersion++ }
  onFuturesTicks(ticks) { if (applyFuturesTicks(this.data?.oi, ticks, this.underlying)) this.oiVersion++ }
  onSpotUpdate(snapshot) { if (applySpotUpdate(this.data?.oi, snapshot, this.underlying)) this.oiVersion++ }

  // ---- The alerts ----------------------------------------------------------------------------------

  // The market clock: the last heatmap column the server pushed (the page's own "now").
  clock() {
    const v = this.data?.view
    if (!v) return null
    return v.heatmap?.at(-1)?.t ?? (v.meta?.lastTradeAt ? msOf(v.meta.lastTradeAt) : null)
  }

  // Which indices' profile alerts the server sends: the page's switches (config.profileAlerts), on by default.
  profileAlertsOn() { return { futures: true, spot: true, ...(this.config.profileAlerts ?? {}) } }

  // Price reaching a profile level - futures: the previous session's volume / market profile; spot: those less
  // the futures premium, and the previous day's spot volume profile. Telegram, tagged [Server] - with no page open -
  // for a POC or an LVN only (sendsProfileTelegram); an HVN / single prints are logged, not sent.
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
      if (cfg.telegram !== false && sendsProfileTelegram(level)) await this.io.telegram(`${TAG} 📊 ${text}`)
    }
  }

  // The OI Replay page's S/R break and high-probability alerts (oiLevelBreaks.js), on the server: the page's settings
  // (config.oiBreakAlerts), on by default - but to Telegram only when its Telegram switch is on (off by default: they
  // are the app's alerts); either way what was raised is listed for the page.
  oiBreakSettings() {
    const c = { ...OI_BREAK_ALERT_DEFAULTS, ...(this.config.oiBreakAlerts ?? {}) }
    const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt)
    return {
      on: c.on !== false,
      telegram: c.telegram === true,
      bucketMinutes: clamp(c.bucketMinutes, 1, 15, 1),
      windowMinutes: clamp(c.windowMinutes, 1, 15, OI_BREAK_ALERT_DEFAULTS.windowMinutes),
      atmShiftPct: clamp(c.atmShiftPct, 1, 500, OI_BREAK_ALERT_DEFAULTS.atmShiftPct),
    }
  }

  // A CE / PE / Net cumulative line breaking its support / resistance, and a break with the ATM +-1 CE or PE OI shifting
  // the set % the same way within the window - Telegram (when its switch is on), tagged [Server], with no page open. Keyed
  // like the page's, so the two never send the same message twice. Completed buckets only; what was already broken when the day loaded is not sent.
  async checkOiBreaks(d, nowMs) {
    const set = this.oiBreakSettings()
    const ob = this.oiBreaks
    // The watch starts again when what is watched changes - not for the Telegram switch, which only says where they go.
    const sig = JSON.stringify({ ...set, telegram: undefined })
    if (ob.settingsSig !== sig) { ob.state = newOiBreakAlertState(); ob.settingsSig = sig; ob.boundary = null }
    if (!set.on || !d.oi?.ce || !d.oi?.pe) return
    const bucketSeconds = set.bucketMinutes * 60
    const nowSec = Math.floor(nowMs / 1000) + IST_OFFSET_SECONDS
    const boundary = Math.floor(nowSec / bucketSeconds) * bucketSeconds
    if (boundary === ob.boundary && this.io.now() - ob.at < OI_BREAK_EVERY_MS) return
    ob.boundary = boundary
    ob.at = this.io.now()
    const spot = d.oi.spot?.at(-1)?.close
    const step = d.oi.step || 50
    const ceLevels = perStrikeLevels(d.oi.ce, bucketSeconds)
    const peLevels = perStrikeLevels(d.oi.pe, bucketSeconds)
    const { breaks, signals } = stepOiBreakAlerts(ob.state, {
      ce: changesFromLevels(ceLevels), pe: changesFromLevels(peLevels), ceLevels, peLevels,
      bucketSeconds, nowSec: boundary, atmStrike: spot > 0 ? Math.round(spot / step) * step : null,
    }, { windowMinutes: set.windowMinutes, atmShiftPct: set.atmShiftPct })
    if (!breaks.length && !signals.length) return
    const cfg = this.settings()
    const dayKey = `${this.underlying}-${this.date}`
    const send = async (text, key) => {
      this.io.log(`${this.underlying}: ${text.replace(/\n/g, ' ')}`)
      ob.sent = [...ob.sent, { t: nowMs, text }].slice(-OI_BREAK_RECENT)
      if (cfg.telegram !== false && set.telegram) await this.io.telegram(`${TAG} ${text}`, key)
    }
    for (const b of breaks) {
      await send(`🧱 ${breakText(this.underlying, b, fmtOiLakh, chartTimeHHmm, set.bucketMinutes)} ${breakMeaning(b.side.key, b.up) > 0 ? '🟢' : '🔴'}`,
        breakAlertKey(this.underlying, dayKey, set.bucketMinutes, b))
    }
    for (const { b, hp, key } of signals) {
      await send(`🎯 ${highProbabilityText(this.underlying, b, hp, fmtOiLakh, chartTimeHHmm, set.bucketMinutes)}`,
        highProbabilityAlertKey(this.underlying, dayKey, set.bucketMinutes, key))
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
    await this.checkOiBreaks(d, nowMs)
  }

  status() {
    const nowMs = this.clock()
    return {
      underlying: this.underlying, enabled: this.enabled, date: this.date, ready: !!this.data, error: this.error,
      clockUtc: nowMs ? new Date(nowMs).toISOString() : null, contract: this.data?.view?.meta?.contractSymbol ?? null,
      profileAlerts: {
        futures: this.profileAlertsOn().futures && this.profileLevelsOf.futures.length > 0,
        spot: this.profileAlertsOn().spot && (this.profileLevelsOf.futures.length > 0 || this.profileLevelsOf.spotOwn.length > 0),
        levels: this.profileLevelsOf.futures.length + this.profileLevelsOf.spotOwn.length,
      },
      oiBreakAlerts: { ...this.oiBreakSettings(), ready: !!this.data?.oi, sent: this.oiBreaks.sent },
    }
  }
}
