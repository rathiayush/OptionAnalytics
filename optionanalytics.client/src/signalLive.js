// SAVED STRATEGIES SCANNED LIVE - the pure part of the server's daily scan (scanner-runner/signal-live.mjs, started by
// SignalLiveHostedService), kept here so the tests run it as the loop does. Today is read exactly as the Signal backtest
// reads a past day - the run cut to the minutes COMPLETED at the clock (the minute still forming never counts), the same
// `prepareDay` and the same trades (`simulateDay`, the strategy's own settings) - so what the live scan says on a day is
// what a backtest of that day says later. What has happened so far is a list of EVENTS, each with its own key so it is
// sent once: a trade's ENTRY, and its EXIT once it has one (a trade the data ran out on before the session is over is
// still OPEN - no exit yet). Once the session is over the day's REPORT: the closed trades and their numbers.
import { istMinute, optionName, prepareDay, simulateDay, summarize } from './signalBacktest.js'
import { runUrl } from './signalBacktestJob.js'

const MIN_MS = 60_000
/** The session's last minute (15:29) is complete at 15:30; the report goes from a minute later. */
export const REPORT_FROM_MINUTE = 15 * 60 + 31
/** No reading is asked before the session has a few minutes. */
export const LIVE_FROM_MINUTE = 9 * 60 + 16
/** The loop stops for the day after this minute (a report not sent by then waits for the next day's - it is not sent late). */
export const LIVE_UNTIL_MINUTE = 15 * 60 + 59
/** Minutes a live day must have before it is read (a past day needs 30). */
export const LIVE_MIN_MINUTES = 5

/** Today's run as OI Replay's live mode asks it (the server's memory - its one backfill joined to the live feed). */
export const liveRunUrl = (u, date) => `${runUrl(u, date)}&forceLive=true`

const msOf = (p) => (p?.ms != null ? p.ms : Date.parse(p?.time))
/** The run with only the minutes COMPLETED at `nowMs` (a 1-minute point is stamped at its start). */
export function completedRun(run, nowMs) {
  const cut = (list) => (Array.isArray(list) ? list.filter((p) => { const t = msOf(p); return Number.isFinite(t) && t + MIN_MS <= nowMs }) : list)
  return {
    ...run,
    spotCandlesOneMinute: cut(run?.spotCandlesOneMinute), futuresBars: cut(run?.futuresBars),
    cePoints: cut(run?.cePoints), pePoints: cut(run?.pePoints), spotVwap: cut(run?.spotVwap),
  }
}

/** Today's day prepared from the completed minutes (or { ok: false, reason }). */
export function prepareLiveDay(run, { underlying, prevProfile = null, nowMs }) {
  return prepareDay(completedRun(run, nowMs), { underlying, prevProfile, minMinutes: LIVE_MIN_MINUTES })
}

/** IST date ('YYYY-MM-DD'), minute of the day and weekday (0 Sunday) of `ms`. */
export function istClock(ms) {
  const d = new Date(ms + 5.5 * 3_600_000)
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() }
}

const pad = (v) => String(v).padStart(2, '0')
const clock = (ms) => { const m = istMinute(ms); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }
const rupees = (v) => `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`
const signed = (v, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`
const tradeName = (t) => `${t.action} ${optionName(t)}`
const tags = (t) => [t.strategy === 'mirror' ? 'mirror' : null, t.overridden ? 'expiry day' : null].filter(Boolean)

/** A trade's entry, as Telegram shows it. */
export function entryText(name, underlying, t, { late = false } = {}) {
  const extra = [...tags(t), late ? 'seen late' : null].filter(Boolean)
  return `🟢 ${name} · ${underlying}: ${tradeName(t)} @ ${t.entry.toFixed(2)} (${clock(t.entryTime)})${extra.length ? ` · ${extra.join(' · ')}` : ''}\n${t.why}`
}
/** A trade's exit, as Telegram shows it. */
export function exitText(name, underlying, t) {
  const net = t.charges > 0 ? `net ${rupees(t.net)} after ${rupees(t.charges)} charges` : rupees(t.net)
  return `${t.net >= 0 ? '✅' : '❌'} ${name} · ${underlying}: out of ${tradeName(t)} @ ${t.exit.toFixed(2)} (${clock(t.exitTime)}, ${t.exitReason}) · ${signed(t.points)} pts · ${net}`
}

/**
 * What a strategy's day has come to so far: `trades` (the backtest's - `simulateDay`), `events` - each trade's ENTRY and,
 * once it has one, its EXIT, keyed `date|rule-or-mirror|entry time|entry-or-exit` so each is sent once - the trades
 * `closed` and still `open`, and the closed ones' `summary`. `complete`: the session is over - a trade the data ran out on
 * exits there. `nowMs`: an entry first seen more than 3 minutes after it is marked "seen late" (after a restart).
 */
export function liveDayEvents(day, engine, { name = 'Strategy', complete = false, nowMs = null, tradeDay = null } = {}) {
  const { trades, signals, dayLimit, expirySkipped } = simulateDay(day, engine, { tradeDay })
  const isOpen = (t) => !complete && t.exitReason === 'Day end'
  const events = []
  for (const t of trades) {
    const key = `${day.date}|${t.strategy}|${t.entryTime}`
    const late = nowMs != null && nowMs - (t.entryTime + MIN_MS) > 3 * MIN_MS
    events.push({ key: `${key}|entry`, kind: 'entry', at: t.entryTime, text: entryText(name, day.underlying, t, { late }) })
    if (!isOpen(t)) events.push({ key: `${key}|exit`, kind: 'exit', at: t.exitTime, text: exitText(name, day.underlying, t) })
  }
  events.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'entry' ? -1 : 1))
  const closed = trades.filter((t) => !isOpen(t))
  return {
    trades, closed, open: trades.filter(isOpen), events, signals: signals.length, dayLimit: dayLimit ?? null, expirySkipped: Boolean(expirySkipped),
    tradeIn: engine.tradeIn || '',
    summary: summarize(closed),
  }
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
/** The day as the history keeps it (one row) and its closed trades (a row each - the backtest CSV's columns). */
export function dayRecord(day, result) {
  const s = result.summary
  return {
    day: {
      date: day.date, underlying: day.underlying, trades: s.trades, wins: s.wins, losses: s.losses, winRate: r2(s.winRate),
      net: r2(s.net), gross: r2(s.gross), charges: r2(s.charges), points: r2(s.points), signals: result.signals,
      limit: result.dayLimit ?? '',
    },
    trades: result.closed.map((t) => ({
      date: t.date, side: t.strategy, signal: t.dir > 0 ? 'bullish' : 'bearish', action: t.action, option: optionName(t),
      entryTime: clock(t.entryTime), entry: r2(t.entry), exitTime: clock(t.exitTime), exit: r2(t.exit), exitReason: t.exitReason,
      points: r2(t.points), gross: r2(t.gross), charges: r2(t.charges), net: r2(t.net), expiryDay: t.expiryDay ? (t.overridden ? 'yes - overridden' : 'yes') : '', why: t.why,
    })),
  }
}

/** The day's report, as Telegram shows it. */
export function dayReportText(name, day, result) {
  const s = result.summary
  const date = new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const lines = [`📊 ${name} · ${day.underlying}${result.tradeIn ? ` → traded in ${result.tradeIn}` : ''} · ${date}`]
  if (result.expirySkipped) lines.push(`Expiry day - not traded (the strategy's Expiry day setting)${result.signals ? `; ${result.signals} signal${result.signals === 1 ? '' : 's'} not taken` : ''}.`)
  else if (!s.trades) lines.push('No trades today.')
  else {
    lines.push(`Net ${rupees(s.net)} after ${rupees(s.charges)} charges (gross ${rupees(s.gross)}) · ${s.trades} trade${s.trades === 1 ? '' : 's'} · ${Math.round(s.winRate ?? 0)}% win`)
    result.closed.forEach((t, k) => lines.push(`${k + 1}. ${clock(t.entryTime)} - ${clock(t.exitTime)} ${tradeName(t)} ${t.entry.toFixed(2)} → ${t.exit.toFixed(2)} ${t.exitReason} ${rupees(t.net)}${tags(t).length ? ` (${tags(t).join(', ')})` : ''}`))
  }
  if (result.dayLimit) lines.push(`The day's max ${result.dayLimit} was reached - no more trades after it.`)
  const skipped = result.signals - result.trades.length
  if (skipped > 0 && !result.expirySkipped) lines.push(`${skipped} more signal${skipped === 1 ? '' : 's'} not taken (a trade open, the day's limits, the cooldown or outside 09:30 - 14:45).`)
  return lines.join('\n')
}
