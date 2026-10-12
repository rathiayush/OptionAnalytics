import { filtersForIndex, optionPlanFor } from './strategyEngine.js'

// How a strategy applied to an index has run: its signals and option trades in the server scanner's own record
// (server-signals.csv / server-trades.csv rows, as GET /api/scanner-log/rows/{file} gives them), from when it was applied.

const istMs = (s) => (s ? Date.parse(`${String(s).replace(' ', 'T')}+05:30`) : null) // "yyyy-MM-dd HH:mm:ss" (IST) -> ms
const numOf = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null)

/** Strategy `id` on index `u` in the record `rec` ({ signals, trades }), from `sinceMs` (when its setting was applied;
 *  null = every day): its signals, option trades (live / open), wins and net rupees after charges of the closed ones. */
export function runOf(rec, u, id, sinceMs = null) {
  const mine = (r, t) => r.underlying === u && r.strategy_id === id && (!sinceMs || (istMs(t) ?? 0) >= sinceMs)
  const signals = (rec?.signals ?? []).filter((r) => mine(r, r.time_ist))
  const trades = (rec?.trades ?? []).filter((r) => mine(r, r.entry_time_ist))
  const closed = trades.filter((t) => t.exit_time_ist)
  const nets = closed.map((t) => numOf(t.net_rupees) ?? numOf(t.rupees)).filter((v) => v != null)
  const last = [...signals.map((r) => istMs(r.time_ist)), ...trades.map((r) => istMs(r.entry_time_ist))].filter(Boolean)
  return {
    signals: signals.length, trades: trades.length, live: trades.filter((t) => t.live === 'true').length, open: trades.length - closed.length,
    closed: closed.length, wins: nets.filter((v) => v > 0).length, net: nets.reduce((a, b) => a + b, 0), lastMs: last.length ? Math.max(...last) : null,
  }
}

/** Where its whole run is listed: Trades → Scanner record, filtered to it (from when it was applied). */
export const runLink = (u, id, sinceMs = null) => `/trades?${new URLSearchParams({ tab: 'record', index: u, strategy: id, kind: 'trades', ...(sinceMs ? { since: String(sinceMs) } : {}) })}`

/** What the server scanner does with strategy `id` on index `u` - the runner's own rules (indexScanner.isAlerted). */
export function strategyState({ id, spot, u, cfg, settings, alertIds }) {
  const applied = cfg?.filtersByIndex?.[u]?.[id] ?? null
  const onList = (cfg?.liveList?.[u] ?? []).includes(id)
  const indexLive = cfg?.live?.[u] === true
  const enabled = cfg?.enabled?.[u] !== false
  const filters = filtersForIndex({ filters: settings?.filters, filtersByIndex: cfg?.filtersByIndex }, u)[id]
  // The alert list - and, whatever it says, on the index's live list or applied there; a spot one also with its all-index
  // filters set (the Top 15 knows nothing of the spot strategies).
  const alerted = alertIds.includes(id) || onList || !!applied || (!!spot && Object.keys(filters ?? {}).length > 0)
  const mode = !enabled ? 'off' : alerted && onList && indexLive ? 'live' : alerted && onList ? 'list' : alerted ? 'paper' : 'signals'
  // What an alert of it trades there - the runner's own rule (indexScanner.settings + optionPlanFor): the index's "On an
  // alert" (Trade settings) Sell / Buy wins for every strategy; Per strategy hands it to the strategy's own setting on
  // this index (sell where it has none); Alert only trades nothing.
  const autoTrade = cfg?.trade?.[u]?.autoTrade ?? settings?.autoPaper ?? 'strategy'
  const plan = optionPlanFor(id, filtersForIndex({ filters: settings?.filters, filtersByIndex: cfg?.filtersByIndex }, u), { autoPaper: autoTrade, moneyness: settings?.moneyness ?? 0 })
  const option = { leg: plan.leg, autoTrade, tunedLeg: plan.tunedLeg, overrode: plan.overrode }
  return { applied, onList, indexLive, enabled, alerted, mode, option }
}

