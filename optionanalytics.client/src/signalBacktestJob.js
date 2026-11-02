// A Signal backtest RUN - shared by the page (SignalBacktestPage.jsx) and the server's BACKGROUND job
// (scanner-runner/signal-backtest.mjs, started by the server's SignalBacktestJobService): the same day loader, the same
// settings (held to the page's ranges) and the same report, so a run in the background reports exactly what the page
// would (tests/signal-backtest-job.test.mjs).
//
// A run = its days' OUTCOMES put together: each day is replayed through the rule on its own (simulateDay - the days are
// independent, as simulateRun has them), so the background job keeps a day's trades and drops the day itself.
import {
  BACKTEST_DEFAULTS, EXPIRY_DAY_CHOICES, LEVEL_UNITS, RULE_ACTIONS, RULE_CONDITIONS, TIMEFRAMES, mirrorIsSame, mirrorLines, normalizeRule, prepareDay, ruleText,
  simulateDay, summarize,
} from './signalBacktest.js'
import { PAPER_TRADE_LOT_SIZE } from './scannerCore.js'

export const BACKTEST_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
export const SIDE_NAMES = { rule: 'Rule', mirror: 'Mirror', all: 'Both' }
const ACTION_OF = Object.fromEntries(RULE_ACTIONS.map((a) => [a.value, a]))
const GROUP_OF = Object.fromEntries(RULE_CONDITIONS.map((c) => [c.id, c.group]))

// The day as OI Replay loads it (1-minute, the index's own series - BANKNIFTY's monthly) and the previous trading day's
// volume profile (spot's POC / VAH / VAL / HVN / LVN - OI Replay's entry chart lines).
export const runUrl = (u, date) => `/api/oi-replay/${u}/run?date=${date}&timeframeMinutes=1&expiryFlag=${u === 'BANKNIFTY' ? 'MONTH' : 'WEEK'}`
export const prevProfileUrl = (u, date) => `/api/oi-replay/${u}/previous-day-volume-profile?date=${date}`

/**
 * One day loaded and prepared (`prepareDay`), or { ok: false, date, reason } - with `final` when the day's own data cannot
 * be read (it will not change: keep it), `retry` when it failed on the way (a timeout, the network, a server error: worth
 * one more try). A day without the previous day's profile still runs (its previous-day lines never hold). Throws only
 * when `signal` stops it.
 */
export async function loadBacktestDay(underlying, date, { signal, timeoutMs = 240_000, fetch: fetchImpl } = {}) {
  const get = fetchImpl ?? globalThis.fetch
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort('timeout'), timeoutMs)
  const abort = () => timeout.abort('stopped')
  signal?.addEventListener('abort', abort)
  if (signal?.aborted) abort()
  try {
    const prevPromise = get(prevProfileUrl(underlying, date), { signal: timeout.signal }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    const r = await get(runUrl(underlying, date), { signal: timeout.signal })
    const body = await r.json().catch(() => null)
    if (!r.ok || !body?.success) return { ok: false, date, reason: body?.error ?? `HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429 }
    // Let a page draw its progress before the day's minutes are worked through.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const day = prepareDay(body, { underlying, prevProfile: await prevPromise })
    return day.ok ? day : { ok: false, date, reason: day.reason, final: true }
  } catch (err) {
    if (signal?.aborted) throw err
    return { ok: false, date, reason: timeout.signal.aborted ? 'took too long to load' : String(err?.message ?? err), retry: true }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
const held = (v, min, max, fallback) => {
  const n = Number(v)
  return v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/**
 * A run's settings made whole and held to the page's ranges - what the page sends to the background and what the job
 * reads: { underlying, from, to, rule: { tree, action, mirror }, moneyness, slPct, targetPct, levelUnit, trailGap,
 * trailStart, timeStopMin, maxTradesPerDay, cooldownMin, lots, charges, sttPct, brokeragePerOrder, otherPerTrade, maxDayLoss,
 * maxDayProfit, timeframe, expiryDay }. The rule goes through its tree, as
 * the page always has it (a rule saved before the builder opens as its groups).
 */
export function cleanBacktestSettings(s = {}) {
  const d = BACKTEST_DEFAULTS
  const levelUnit = LEVEL_UNITS.includes(s?.levelUnit) ? s.levelUnit : d.levelUnit
  const max = levelUnit === 'pts' ? 5000 : 1000
  const saved = normalizeRule(s?.rule)
  return {
    underlying: BACKTEST_UNDERLYINGS.includes(s?.underlying) ? s.underlying : 'NIFTY',
    from: isDate(s?.from) ? s.from : null,
    to: isDate(s?.to) ? s.to : null,
    rule: { tree: saved.tree, action: saved.action, mirror: saved.mirror },
    moneyness: Math.round(held(s?.moneyness, -1, 1, d.moneyness)),
    slPct: held(s?.slPct, 0, max, d.slPct),
    targetPct: held(s?.targetPct, 0, max, d.targetPct),
    levelUnit,
    trailGap: held(s?.trailGap, 0, max, d.trailGap),
    trailStart: held(s?.trailStart, 0, max, d.trailStart),
    timeStopMin: held(s?.timeStopMin, 0, 360, d.timeStopMin),
    maxTradesPerDay: Math.round(held(s?.maxTradesPerDay, 1, 20, d.maxTradesPerDay)),
    cooldownMin: held(s?.cooldownMin, 0, 120, d.cooldownMin),
    lots: Math.round(held(s?.lots, 1, 100, d.lots)),
    charges: typeof s?.charges === 'boolean' ? s.charges : d.charges,
    sttPct: held(s?.sttPct, 0, 1, d.sttPct),
    brokeragePerOrder: held(s?.brokeragePerOrder, 0, 500, d.brokeragePerOrder),
    otherPerTrade: held(s?.otherPerTrade, 0, 500, d.otherPerTrade),
    maxDayLoss: held(s?.maxDayLoss, 0, 10_000_000, d.maxDayLoss),
    maxDayProfit: held(s?.maxDayProfit, 0, 10_000_000, d.maxDayProfit),
    timeframe: TIMEFRAMES.includes(Number(s?.timeframe)) ? Number(s.timeframe) : d.timeframe,
    expiryDay: EXPIRY_DAY_CHOICES.some((c) => c.value === s?.expiryDay) ? s.expiryDay : d.expiryDay,
  }
}

/** What the engine reads (simulateDay): the settings with the rule made whole and the index's lot size. */
export function engineSettings(s) {
  const { underlying, from: _from, to: _to, rule, ...rest } = s
  return { ...rest, rule: normalizeRule(rule), lotSize: PAPER_TRADE_LOT_SIZE[underlying] ?? 1 }
}

/** A day's part of a run: its trades and how many signals each side gave - or why it did not run. `engine` =
 *  engineSettings(...). Only the outcome is kept, not the day. */
export function dayOutcome(date, day, engine) {
  if (!day?.ok) return { date, ok: false, reason: day?.reason ?? 'not loaded', trades: [], signals: { rule: 0, mirror: 0 } }
  const { trades, signals, dayLimit } = simulateDay(day, engine)
  return {
    date, ok: true, prev: Boolean(day.prevVp), expiry: Boolean(day.isExpiry), limit: dayLimit ?? null, trades,
    signals: { rule: signals.filter((x) => x.strategy === 'rule').length, mirror: signals.filter((x) => x.strategy === 'mirror').length },
  }
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
const netOf = (trades) => trades.reduce((a, t) => a + t.net, 0)

/**
 * The report of a run from its days' outcomes: the rule, its mirror and both (`summarize`), day by day, the running net
 * at each day's end (`lines` - { id, name, points: [{ time, value }] }), every trade, the days that did not run
 * (`failed`) and - when the rule reads the previous day's volume profile - the days run without one (`noPrev`).
 */
export function backtestReport(outcomes, settings) {
  const rule = normalizeRule(settings.rule)
  const mirrorOn = rule.mirror && !(rule.lines.length > 0 && mirrorIsSame(rule.lines))
  const days = [...(outcomes ?? [])].sort(byDate)
  const okDays = days.filter((o) => o.ok)
  const trades = okDays.flatMap((o) => o.trades)
  const count = (id) => okDays.reduce((a, o) => a + (o.signals?.[id] ?? 0), 0)
  const sides = mirrorOn ? ['rule', 'mirror'] : ['rule']
  const rows = sides.map((id) => ({
    key: id, id, name: SIDE_NAMES[id],
    what: ruleText(id === 'mirror' ? mirrorLines(rule.lines) : rule.lines, id === 'mirror' ? ACTION_OF[rule.action]?.opposite : rule.action, rule.logic),
    signals: count(id), ...summarize(trades.filter((t) => t.strategy === id)),
  }))
  const all = { key: 'all', id: 'all', name: SIDE_NAMES.all, what: 'the rule and its mirror together', signals: count('rule') + count('mirror'), ...summarize(trades) }
  const dayRows = days.map((o) => {
    const row = { key: o.date, date: o.date, ok: o.ok, reason: o.ok ? null : o.reason, expiry: Boolean(o.expiry), limit: o.limit ?? null, trades: o.trades.length, net: netOf(o.trades) }
    for (const id of sides) row[id] = netOf(o.trades.filter((t) => t.strategy === id))
    return row
  })
  const lineOf = (id, pick) => {
    let total = 0
    return { id, name: SIDE_NAMES[id], points: okDays.map((o) => { total += pick(o.trades); return { time: o.date, value: Math.round(total) } }) }
  }
  const lines = [
    ...(mirrorOn ? sides.map((id) => lineOf(id, (ts) => netOf(ts.filter((t) => t.strategy === id)))) : []),
    lineOf('all', netOf),
  ]
  const readsPrev = rule.lines.some((l) => GROUP_OF[l.id] === 'PrevProfile')
  return {
    trades, rows, all, dayRows, lines, okDays: okDays.length, sides,
    failed: days.filter((o) => !o.ok).map((o) => ({ date: o.date, reason: o.reason })),
    noPrev: readsPrev ? okDays.filter((o) => !o.prev).map((o) => o.date) : [],
  }
}

/** The report's heading: the index, the days run, the timeframe and the stop / target / trail. */
export function reportHead(s, okDays) {
  if (!okDays) return ''
  const unit = s.levelUnit === 'pts' ? ' pts' : '%'
  const level = (v) => (v > 0 ? `${v}${unit}` : 'none')
  const trail = s.trailGap > 0 ? ` · trail ${s.trailGap}${unit}${s.trailStart > 0 ? ` after +${s.trailStart}${unit}` : ''}` : ''
  const expiry = s.expiryDay === 'buy' || s.expiryDay === 'sell' ? ` · expiry day: ${s.expiryDay}` : ''
  const rupee = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`
  const limits = [s.maxDayLoss > 0 ? `day max loss ${rupee(s.maxDayLoss)}` : null, s.maxDayProfit > 0 ? `day max profit ${rupee(s.maxDayProfit)}` : null].filter(Boolean)
  return `${s.underlying} · ${okDays} day${okDays === 1 ? '' : 's'} · ${s.timeframe}m candles · SL ${level(s.slPct)} · target ${level(s.targetPct)}${trail}${expiry}${limits.length ? ` · ${limits.join(' · ')}` : ''} · ${chargesText(s)}`
}

/** The charges a run takes off its P&L, in words. */
export function chargesText(s) {
  if (s.charges === false) return 'no charges'
  const other = s.otherPerTrade > 0 ? ` + ₹${s.otherPerTrade} a trade` : ''
  return `net of STT ${s.sttPct}% + ₹${s.brokeragePerOrder} an order${other}`
}

/** A run's name when none is given: the index, the days and the trade. */
export function defaultRunName(s) {
  const day = (v) => (v ? new Date(`${v}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '?')
  return `${s.underlying} ${day(s.from)} – ${day(s.to)} · ${ACTION_OF[s.rule?.action]?.label ?? ''}${s.rule?.mirror ? ' + mirror' : ''}`
}

// A report as JSON and back: a profit factor with no losing trade is Infinity, which JSON has no word for.
export const reportReplacer = (_k, v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v)
export const reportReviver = (_k, v) => (v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v)
