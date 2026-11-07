// A Signal backtest RUN - shared by the page (SignalBacktestPage.jsx) and the server's BACKGROUND job
// (scanner-runner/signal-backtest.mjs, started by the server's SignalBacktestJobService): the same day loader, the same
// settings (held to the page's ranges) and the same report, so a run in the background reports exactly what the page
// would (tests/signal-backtest-job.test.mjs).
//
// A run = its days' OUTCOMES put together: each day is replayed through the rule on its own (simulateDay - the days are
// independent, as simulateRun has them), so the background job keeps a day's trades and drops the day itself.
import {
  BACKTEST_DEFAULTS, COST_SL_CHOICES, EXPIRY_DAY_CHOICES, LEVEL_UNITS, RULE_ACTIONS, RULE_CONDITIONS, TIMEFRAMES, mirrorIsSame, mirrorLines, normalizeRule, prepareDay, ruleText,
  simulateDay, summarize,
} from './signalBacktest.js'
import { PAPER_TRADE_LOT_SIZE } from './scannerCore.js'
import { summedExpiries } from './expirySum.js'

export const BACKTEST_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
export const SIDE_NAMES = { rule: 'Rule', mirror: 'Mirror', all: 'Both' }
const ACTION_OF = Object.fromEntries(RULE_ACTIONS.map((a) => [a.value, a]))
const GROUP_OF = Object.fromEntries(RULE_CONDITIONS.map((c) => [c.id, c.group]))

// The day as OI Replay loads it (1-minute, the index's own series - BANKNIFTY's monthly) and the previous trading day's
// volume profile (spot's POC / VAH / VAL / HVN / LVN - OI Replay's entry chart lines).
export const seriesFlag = (u) => (u === 'BANKNIFTY' ? 'MONTH' : 'WEEK')
export const runUrl = (u, date) => `/api/oi-replay/${u}/run?date=${date}&timeframeMinutes=1&expiryFlag=${seriesFlag(u)}`
export const prevProfileUrl = (u, date) => `/api/oi-replay/${u}/previous-day-volume-profile?date=${date}`
// "Σ 3 expiries" (OI Replay's): the day's current / next / monthly expiry, and the band of each one added to the current.
export const summedExpiriesUrl = (u, date) => `/api/oi-replay/${u}/summed-expiries?date=${date}&expiryFlag=${seriesFlag(u)}`
export const expiryBandUrl = (u, date, band, live = false) =>
  `/api/oi-replay/${u}/expiry-band?date=${date}&expiryFlag=${band.expiryFlag}&expiryCode=${band.expiryCode}${live ? '&forceLive=true' : ''}`

/**
 * The day's OTHER EXPIRIES for the "Σ 3 expiries" option - the next expiry and the monthly (the monthly only when it is not
 * the current or the next: an expiry is never counted twice - `summedExpiries`), as `prepareDay`'s `expiryChains`. `getJson(url)`
 * -> { ok, status, body }; `live` - today's, from the server's memory (`forceLive`). { ok: true, chains, expiries (the dates
 * summed, the current first) } or { ok: false, reason, retry (a server error / rate limit - worth one more try) }.
 */
export async function loadExpiryChains(getJson, u, date, { live = false } = {}) {
  const dates = await getJson(summedExpiriesUrl(u, date))
  if (!dates.ok || !dates.body?.current) {
    return { ok: false, reason: `the day's expiries: ${dates.body?.error ?? (dates.ok ? 'could not be worked out' : `HTTP ${dates.status}`)}`, retry: !dates.ok ? dates.status >= 500 || dates.status === 429 : true }
  }
  const { current, next, monthly } = dates.body
  const spec = summedExpiries([current, next].filter(Boolean), monthly, seriesFlag(u))
  const chains = []
  for (const band of spec) {
    const r = await getJson(expiryBandUrl(u, date, band, live))
    if (!r.ok || !r.body?.success) {
      return { ok: false, reason: `the ${band.name} expiry (${band.expiry}): ${r.body?.error ?? `HTTP ${r.status}`}`, retry: !r.ok && (r.status >= 500 || r.status === 429) }
    }
    chains.push({ cePoints: r.body.cePoints ?? [], pePoints: r.body.pePoints ?? [], expiry: band.expiry ?? r.body.optionExpiry ?? null, name: band.name })
  }
  return { ok: true, chains, expiries: [current, ...spec.map((b) => b.expiry)] }
}

/**
 * One day loaded and prepared (`prepareDay`), or { ok: false, date, reason } - with `final` when the day's own data cannot
 * be read (it will not change: keep it), `retry` when it failed on the way (a timeout, the network, a server error: worth
 * one more try). A day without the previous day's profile still runs (its previous-day lines never hold). Throws only
 * when `signal` stops it. `sumExpiries` - the "Σ 3 expiries" option: the day's next and monthly expiries loaded too
 * (`loadExpiryChains`) and summed into its OI reads, each one's own GEX added (`prepareDay`'s `expiryChains`); the day then
 * says which (`sumExpiries` - the dates). A day whose other expiries cannot be loaded does not run (it would be another
 * strategy's numbers).
 */
export async function loadBacktestDay(underlying, date, { signal, timeoutMs = 240_000, fetch: fetchImpl, sumExpiries = false } = {}) {
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
    let summed = null
    if (sumExpiries) {
      const getJson = async (url) => {
        const res = await get(url, { signal: timeout.signal })
        return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) }
      }
      summed = await loadExpiryChains(getJson, underlying, date)
      if (!summed.ok) return { ok: false, date, reason: `Σ 3 expiries - ${summed.reason}`, ...(summed.retry ? { retry: true } : { final: true }) }
    }
    // Let a page draw its progress before the day's minutes are worked through.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const day = prepareDay(body, { underlying, prevProfile: await prevPromise, expiryChains: summed?.chains ?? null })
    if (day.ok && summed) day.sumExpiries = summed.expiries
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
 * reads: { underlying, tradeIn (another index the trades are taken in - '' = the same), from, to, rule: { tree, action, mirror }, moneyness, slPct, targetPct, levelUnit, trailGap,
 * trailStart, timeStopMin, maxTradesPerDay, cooldownMin, lots, charges, sttPct, brokeragePerOrder, otherPerTrade, maxDayLoss,
 * maxDayProfit, timeframe, expiryDay, costSl, costAfter, strategyName }. The rule goes through its tree, as
 * the page always has it (a rule saved before the builder opens as its groups).
 */
export function cleanBacktestSettings(s = {}) {
  const d = BACKTEST_DEFAULTS
  const levelUnit = LEVEL_UNITS.includes(s?.levelUnit) ? s.levelUnit : d.levelUnit
  const max = levelUnit === 'pts' ? 5000 : 1000
  const saved = normalizeRule(s?.rule)
  const underlying = BACKTEST_UNDERLYINGS.includes(s?.underlying) ? s.underlying : 'NIFTY'
  return {
    underlying,
    tradeIn: BACKTEST_UNDERLYINGS.includes(s?.tradeIn) && s.tradeIn !== underlying ? s.tradeIn : '',
    from: isDate(s?.from) ? s.from : null,
    to: isDate(s?.to) ? s.to : null,
    rule: { tree: saved.tree, action: saved.action, mirror: saved.mirror },
    moneyness: Math.round(held(s?.moneyness, -4, 4, d.moneyness)),   // ATM, 1 - 4 in (+) / out of (-) the money
    costSl: COST_SL_CHOICES.includes(s?.costSl) ? s.costSl : d.costSl,
    costAfter: held(s?.costAfter, 0, 5000, d.costAfter),
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
    strategyName: strategyName(s?.strategyName),
    // "Σ 3 expiries": the OI reads on the current + next + monthly expiry's OI, GEX on each one's own (loadBacktestDay).
    sumExpiries: s?.sumExpiries === true,
  }
}

/** The levels kept PER INDEX on the page (asked for - "different sl target for each index"): the SL, target, trail, the
 *  Cost SL's "after +" (`costAfter` - spot points differ per index too) and their unit of `index` (the traded one) - its
 *  own, else `fallback` (the page's levels from before), held to the page's ranges. */
export function indexLevels(byIndex, index, fallback = {}) {
  const d = BACKTEST_DEFAULTS
  const own = byIndex && typeof byIndex === 'object' && byIndex[index] && typeof byIndex[index] === 'object' ? byIndex[index] : {}
  const v = { ...fallback, ...own }
  const levelUnit = LEVEL_UNITS.includes(v.levelUnit) ? v.levelUnit : d.levelUnit
  const max = levelUnit === 'pts' ? 5000 : 1000
  return {
    slPct: held(v.slPct, 0, max, d.slPct), targetPct: held(v.targetPct, 0, max, d.targetPct), levelUnit,
    trailGap: held(v.trailGap, 0, max, d.trailGap), trailStart: held(v.trailStart, 0, max, d.trailStart),
    costAfter: held(v.costAfter, 0, 5000, d.costAfter),
  }
}
/** `byIndex` with `index`'s levels changed by `patch` - the index's whole set kept from then on (the others it had from
 *  `fallback` with it), every other index untouched. */
export function withIndexLevels(byIndex, index, patch, fallback = {}) {
  return { ...(byIndex && typeof byIndex === 'object' ? byIndex : {}), [index]: indexLevels({ [index]: { ...indexLevels(byIndex, index, fallback), ...patch } }, index) }
}

/** A strategy's name as the runs carry it (asked for - "add strategy name ... to runs"): one line, trimmed, at most 80
 *  characters; '' when none. */
export function strategyName(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
}

/** What the engine reads (simulateDay): the settings with the rule made whole and the TRADED index's lot size (the trade-in
 *  index's when there is one). */
export function engineSettings(s) {
  const { underlying, from: _from, to: _to, rule, strategyName: _name, sumExpiries: _sum, ...rest } = s
  return { ...rest, tradeIn: s.tradeIn || '', rule: normalizeRule(rule), lotSize: PAPER_TRADE_LOT_SIZE[s.tradeIn || underlying] ?? 1 }
}

/** A day's part of a run: its trades and how many signals each side gave - or why it did not run. `engine` =
 *  engineSettings(...); `tradeDay` - the trade-in index's day of the date (`engine.tradeIn`). Only the outcome is kept,
 *  not the day. */
export function dayOutcome(date, day, engine, tradeDay = null) {
  if (!day?.ok) return { date, ok: false, reason: day?.reason ?? 'not loaded', trades: [], signals: { rule: 0, mirror: 0 } }
  if (engine.tradeIn && !tradeDay?.ok) return { date, ok: false, reason: `${engine.tradeIn}: ${tradeDay?.reason ?? 'not loaded'}`, trades: [], signals: { rule: 0, mirror: 0 } }
  const { trades, signals, dayLimit, expirySkipped } = simulateDay(day, engine, { tradeDay })
  return {
    date, ok: true, prev: Boolean(day.prevVp), pivots: Boolean(day.pivots), expiry: Boolean(day.isExpiry), expirySkipped: Boolean(expirySkipped),
    limit: dayLimit ?? null, trades,
    signals: { rule: signals.filter((x) => x.strategy === 'rule').length, mirror: signals.filter((x) => x.strategy === 'mirror').length },
  }
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
const netOf = (trades) => trades.reduce((a, t) => a + t.net, 0)

/**
 * The report of a run from its days' outcomes: the rule, its mirror and both (`summarize`), day by day, the running net
 * at each day's end (`lines` - { id, name, points: [{ time, value }] }), every trade, the days that did not run
 * (`failed`) and - when the rule reads the previous day's volume profile / its pivot points - the days run without one
 * (`noPrev` / `noPivots`).
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
    const row = {
      key: o.date, date: o.date, ok: o.ok, reason: o.ok ? null : o.reason, expiry: Boolean(o.expiry), expirySkipped: Boolean(o.expirySkipped),
      limit: o.limit ?? null, trades: o.trades.length, net: netOf(o.trades),
    }
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
  const readsPivots = rule.lines.some((l) => GROUP_OF[l.id] === 'Pivots')
  return {
    trades, rows, all, dayRows, lines, okDays: okDays.length, sides,
    failed: days.filter((o) => !o.ok).map((o) => ({ date: o.date, reason: o.reason })),
    noPrev: readsPrev ? okDays.filter((o) => !o.prev).map((o) => o.date) : [],
    // A day outcome kept before the pivot points (an older background run) has no `pivots` - not listed as without them.
    noPivots: readsPivots ? okDays.filter((o) => o.pivots === false).map((o) => o.date) : [],
  }
}

/** A run's days with their years: "1 Jan 2026 – 3 Nov 2026". */
export function runRange(from, to) {
  const day = (v) => (v ? new Date(`${v}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '?')
  return `${day(from)} – ${day(to)}`
}

/**
 * MONTH BY MONTH (asked for - "add month by month pnl as well, day by day is perfectly fine"): a report's days and trades
 * put together by calendar month, oldest first - worked out from the report itself (`dayRows` and `trades`), so a
 * background run's report written before it has them too. Each row: { key, month (YYYY-MM), days (run), daysTraded,
 * greenDays (days with trades that ended up), trades, wins, winRate, gross, charges, net, rule, mirror (each side's net),
 * best / worst (the month's best / worst day's net, days with trades), total (the run's net to the month's end) }.
 */
export function monthRows(report) {
  const months = new Map()
  const at = (date) => {
    const key = String(date).slice(0, 7)
    if (!months.has(key)) {
      months.set(key, { key, month: key, days: 0, daysTraded: 0, greenDays: 0, trades: 0, wins: 0, gross: 0, charges: 0, net: 0, rule: 0, mirror: 0, best: null, worst: null })
    }
    return months.get(key)
  }
  for (const d of report?.dayRows ?? []) {
    if (!d.ok) continue
    const m = at(d.date)
    m.days++
    if (d.trades > 0) {
      m.daysTraded++
      if (d.net > 0) m.greenDays++
      m.best = m.best == null ? d.net : Math.max(m.best, d.net)
      m.worst = m.worst == null ? d.net : Math.min(m.worst, d.net)
    }
  }
  for (const t of report?.trades ?? []) {
    const m = at(t.date)
    m.trades++
    if (t.net > 0) m.wins++
    m.gross += t.gross
    m.charges += t.charges
    m.net += t.net
    if (t.strategy === 'rule' || t.strategy === 'mirror') m[t.strategy] += t.net
  }
  let total = 0
  return [...months.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((m) => {
    total += m.net
    return { ...m, winRate: m.trades ? (m.wins / m.trades) * 100 : null, total }
  })
}

/** The report's heading: the strategy's name (when it has one), the index, the days run and their range, the timeframe and
 *  the stop / target / trail. */
export function reportHead(s, okDays) {
  if (!okDays) return ''
  const unit = s.levelUnit === 'pts' ? ' pts' : '%'
  const level = (v) => (v > 0 ? `${v}${unit}` : 'none')
  const trail = trailText(s)
  const expiry = s.expiryDay === 'buy' || s.expiryDay === 'sell' ? ` · expiry day: ${s.expiryDay}` : s.expiryDay === 'skip' ? ' · expiry day: not traded' : ''
  const cost = s.costSl ? ` · cost SL (${s.costSl}${s.costAfter > 0 ? ` after +${s.costAfter}${s.costSl === 'spot' ? ' pts' : unit}` : ''})` : ''
  const strike = s.moneyness ? ` · ${Math.abs(s.moneyness)} ${s.moneyness > 0 ? 'ITM' : 'OTM'}` : ''
  const rupee = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`
  const limits = [s.maxDayLoss > 0 ? `day max loss ${rupee(s.maxDayLoss)}` : null, s.maxDayProfit > 0 ? `day max profit ${rupee(s.maxDayProfit)}` : null].filter(Boolean)
  return `${s.strategyName ? `${s.strategyName} · ` : ''}${s.underlying}${s.tradeIn ? ` signals → traded in ${s.tradeIn}` : ''} · ${okDays} day${okDays === 1 ? '' : 's'} · ${runRange(s.from, s.to)} · ${s.timeframe}m candles${s.sumExpiries ? ' · OI Σ 3 expiries' : ''}${strike} · SL ${level(s.slPct)} · target ${level(s.targetPct)}${trail}${cost}${expiry}${limits.length ? ` · ${limits.join(' · ')}` : ''} · ${chargesText(s)}`
}

// The trailing stop in words (' · trail 10% after +5%'), '' when off.
function trailText(s) {
  const unit = s.levelUnit === 'pts' ? ' pts' : '%'
  return s.trailGap > 0 ? ` · trail ${s.trailGap}${unit}${s.trailStart > 0 ? ` after +${s.trailStart}${unit}` : ''}` : ''
}

/** What a Feature finder run reads its readings against: the candles and the option its CE / PE labels buy (the strike, SL /
 *  target / trail / time stop). */
export function featureTradeText(s) {
  const unit = s.levelUnit === 'pts' ? ' pts' : '%'
  const level = (v) => (v > 0 ? `${v}${unit}` : 'none')
  const strike = s.moneyness ? `${Math.abs(s.moneyness)} ${s.moneyness > 0 ? 'ITM' : 'OTM'}` : 'ATM'
  const timeStop = s.timeStopMin > 0 ? ` · out after ${s.timeStopMin} min` : ''
  return `${s.timeframe}m candles${s.sumExpiries ? ' · OI Σ 3 expiries' : ''} · ${strike} CE / PE bought: SL ${level(s.slPct)} · target ${level(s.targetPct)}${trailText(s)}${timeStop}`
}

/** A Feature finder run's heading: the index, the days run and their range, and `featureTradeText`. */
export function featureRunHead(s, okDays) {
  return `${s.underlying} · ${okDays} day${okDays === 1 ? '' : 's'} · ${runRange(s.from, s.to)} · ${featureTradeText(s)}`
}

/** The charges a run takes off its P&L, in words. */
export function chargesText(s) {
  if (s.charges === false) return 'no charges'
  const other = s.otherPerTrade > 0 ? ` + ₹${s.otherPerTrade} a trade` : ''
  return `net of STT ${s.sttPct}% + ₹${s.brokeragePerOrder} an order${other}`
}

/** A run's name when none is given: the strategy's name (when it has one), the index and the days - else the trade; a
 *  Feature finder run (`kind` 'features') the index, the days and the candles (its tag in the list and its Telegram say
 *  what it is). */
export function defaultRunName(s, kind = 'backtest') {
  if (kind === 'features') return `${s.underlying} ${runRange(s.from, s.to)} · ${s.timeframe}m candles`
  if (s.strategyName) return `${s.strategyName} · ${s.underlying} ${runRange(s.from, s.to)}`
  return `${s.underlying} ${runRange(s.from, s.to)} · ${ACTION_OF[s.rule?.action]?.label ?? ''}${s.rule?.mirror ? ' + mirror' : ''}`
}

// A report as JSON and back: a profit factor with no losing trade is Infinity, which JSON has no word for.
export const reportReplacer = (_k, v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v)
export const reportReviver = (_k, v) => (v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v)
