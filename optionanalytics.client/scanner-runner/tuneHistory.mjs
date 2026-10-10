// The strategy tuning's HISTORY, kept as CSV files (no database) under {tuning}/history/:
//   runs.csv                     one row per finished run - when, which index, what was tuned, how many days and trades;
//   {run_id}-trades.csv          every trade of that run: each strategy as written on every day scanned, and each
//                                fine-tuned strategy's best setting - with the date and time, the levels and why it fired;
//   {run_id}-settings.csv        each strategy's tuned setting of that run: every parameter, and what it scored.
// A run is never overwritten, so a strategy can be compared across runs; the Trades page lists the runs and clubs the
// trades of the ones picked (any index) by date and time. run_id = {INDEX}-{data}-{yyyyMMdd-HHmmss} (IST).

/** A CSV field: quoted when it holds a comma, a quote or a newline; null / undefined as empty. */
export const csvField = (v) => {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** `rows` as CSV with `columns` ([{ key, value }]) - the header, then a line per row. */
export const toCsv = (columns, rows) =>
  [columns.map((c) => c.key).join(','), ...rows.map((r) => columns.map((c) => csvField(c.value(r))).join(','))].join('\n') + '\n'

const ist = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata', hour12: false }).replace(' ', ' ') : '')
const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '')
/** The strategy's own checks (why it fired) in one field: "OI: ... · Tape: ...". */
const why = (checks) => Object.entries(checks ?? {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join(' · ')

/** One run's id - unique, sortable, and readable in a file name. */
export const runIdOf = (underlying, data, finishedMs) => {
  const s = new Date(finishedMs).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata', hour12: false })
  return `${underlying}-${data}-${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11).replace(/:/g, '')}`
}
/** Only a run id this module makes - checked before a file name is built from one. */
export const isRunId = (id) => typeof id === 'string' && /^[A-Z0-9]{1,20}-(futures|spot)-\d{8}-\d{6}$/.test(id)

export const TRADE_COLUMNS = [
  { key: 'run_id', value: (t) => t.run_id },
  { key: 'date', value: (t) => t.date },
  { key: 'entry_time_ist', value: (t) => ist(t.t) },
  { key: 'exit_time_ist', value: (t) => (t.exitT ? ist(t.exitT) : '') },
  { key: 'index', value: (t) => t.index },
  { key: 'strategy_no', value: (t) => t.no },
  { key: 'strategy_id', value: (t) => t.id },
  { key: 'strategy', value: (t) => t.name },
  { key: 'setting', value: (t) => (t.setting === 'best' ? 'fine-tuned' : 'as written') },
  { key: 'setting_text', value: (t) => t.settingText ?? '' },
  { key: 'recommended', value: (t) => (t.setting === 'best' ? (t.recommend ? 'yes' : 'no') : '') },
  { key: 'side', value: (t) => t.side },
  { key: 'entry', value: (t) => n(t.entry) },
  { key: 'stop', value: (t) => n(t.stop) },
  { key: 'target', value: (t) => n(t.target) },
  { key: 'exit', value: (t) => n(t.exit) },
  { key: 'sl_points', value: (t) => n(t.slPts, 1) },
  { key: 'target_points', value: (t) => n(t.targetPts, 1) },
  { key: 'trailed_stop', value: (t) => (t.trailed ? n(t.finalStop) : '') },
  { key: 'closed_by', value: (t) => t.exitReason ?? '' },
  { key: 'points', value: (t) => n(t.points) },
  { key: 'r', value: (t) => n(t.r, 3) },
  { key: 'option_bought', value: (t) => t.buy?.label ?? '' },
  { key: 'bought_in', value: (t) => n(t.buy?.entry) },
  { key: 'bought_out', value: (t) => n(t.buy?.exit) },
  { key: 'bought_points', value: (t) => n(t.buy?.points) },
  { key: 'option_sold', value: (t) => t.sell?.label ?? '' },
  { key: 'sold_in', value: (t) => n(t.sell?.entry) },
  { key: 'sold_out', value: (t) => n(t.sell?.exit) },
  { key: 'sold_points', value: (t) => n(t.sell?.points) },
  // The option trade when the OPTION was tuned (what: option / all): its own SL / target on the premium.
  { key: 'option_traded', value: (t) => t.opt?.label ?? '' },
  { key: 'option_in', value: (t) => n(t.opt?.entry) },
  { key: 'option_out', value: (t) => n(t.opt?.exit) },
  { key: 'option_points', value: (t) => n(t.opt?.points) },
  { key: 'option_sl', value: (t) => n(t.opt?.sl) },
  { key: 'option_target', value: (t) => n(t.opt?.target) },
  { key: 'option_closed_by', value: (t) => t.opt?.reason ?? '' },
  { key: 'estimated_day', value: (t) => (t.estimated ? 'yes' : '') },
  { key: 'why', value: (t) => why(t.checks) },
]

/** The parameters a setting is made of - the trade filters and the option settings, in one column each. */
export const SETTING_KEYS = [
  'tradeSide', 'tradeFrom', 'tradeTo', 'tradeStopX', 'tradeTargetX', 'tradeTimeStop', 'tradeTrail',
  'tradeOiWindow', 'tradeFutWindow', 'tradeOiFlow', 'tradeOiCum', 'tradeWallOi', 'tradeSideOi', 'tradeSideCum',
  'tradeFutOi', 'tradeMoveSize', 'tradeDayType', 'tradeWallRoom',
  'optLeg', 'optMoneyness', 'optExit', 'optSlPct', 'optTargetPct',
]

const score = (s, key) => [
  { key: `${key}_trades`, value: (r) => r[key]?.n ?? '' },
  { key: `${key}_avg`, value: (r) => n(r[key]?.avg) },
  { key: `${key}_total`, value: (r) => n(r[key]?.total) },
  { key: `${key}_win_pct`, value: (r) => (r[key]?.winRate == null ? '' : Math.round(r[key].winRate * 100)) },
]

export const SETTING_COLUMNS = [
  { key: 'run_id', value: (r) => r.run_id },
  { key: 'finished_ist', value: (r) => r.finished_ist },
  { key: 'index', value: (r) => r.index },
  { key: 'data', value: (r) => r.data },
  { key: 'strategy_no', value: (r) => r.no },
  { key: 'strategy_id', value: (r) => r.id },
  { key: 'strategy', value: (r) => r.name },
  { key: 'which', value: (r) => r.which }, // 'as written' or 'fine-tuned'
  { key: 'recommended', value: (r) => (r.which === 'as written' ? '' : r.recommend ? 'yes' : 'no') },
  { key: 'reason', value: (r) => r.reason ?? '' },
  { key: 'setting_text', value: (r) => r.settingText ?? '' },
  { key: 'unit', value: (r) => r.unit ?? 'R' },
  ...score(null, 'train'),
  ...score(null, 'test'),
  { key: 'points_net', value: (r) => n(r.points?.total, 1) },
  { key: 'points_captured', value: (r) => n(r.points?.captured, 1) },
  { key: 'points_lost', value: (r) => n(r.points?.lost, 1) },
  { key: 'wins', value: (r) => r.points?.wins ?? '' },
  { key: 'losses', value: (r) => r.points?.losses ?? '' },
  { key: 'sl_hits', value: (r) => r.points?.slN ?? '' },
  { key: 'sl_points', value: (r) => n(r.points?.slPoints, 1) },
  ...SETTING_KEYS.map((k) => ({ key: k, value: (r) => (r.params?.[k] == null ? '' : String(r.params[k])) })),
]

export const RUN_COLUMNS = [
  { key: 'run_id', value: (r) => r.run_id },
  { key: 'finished_ist', value: (r) => r.finished_ist },
  { key: 'index', value: (r) => r.index },
  { key: 'data', value: (r) => r.data },
  { key: 'tuned', value: (r) => r.what },
  { key: 'search', value: (r) => r.search },
  { key: 'min_trades', value: (r) => r.minTrades },
  { key: 'from', value: (r) => r.from ?? '' },
  { key: 'to', value: (r) => r.to ?? '' },
  { key: 'first_day', value: (r) => r.firstDay ?? '' },
  { key: 'last_day', value: (r) => r.lastDay ?? '' },
  { key: 'days_used', value: (r) => r.daysUsed },
  { key: 'days_estimated', value: (r) => r.daysEstimated },
  { key: 'days_skipped', value: (r) => r.daysSkipped },
  { key: 'strategies_tuned', value: (r) => r.strategiesTuned },
  { key: 'trades', value: (r) => r.trades },
  { key: 'dhan_calls', value: (r) => r.dhanCalls ?? '' },
  { key: 'cache_hits', value: (r) => r.cacheHits ?? '' },
]

/** The rows a finished run adds to its history files. */
export function historyOf({ underlying, data, finishedMs, job, what, search, minTrades, from, to, days, skipped, results, ranked, trades, fetched }) {
  const run_id = runIdOf(underlying, data, finishedMs)
  const finished_ist = ist(finishedMs)
  const settings = []
  for (const res of results ?? []) {
    const common = { run_id, finished_ist, index: underlying, data, no: res.no, id: res.id, name: res.name, unit: res.unit }
    // The strategy as written, and the best setting the tuning found - so a later run can be compared with both.
    settings.push({ ...common, which: 'as written', params: res.baseline?.params, train: res.baseline?.train, test: res.baseline?.test, points: res.baseline?.points })
    if (res.best) settings.push({ ...common, which: 'fine-tuned', recommend: res.recommend, reason: res.reason, settingText: res.settingText, params: res.best.params, train: res.best.train, test: res.best.test, points: res.best.points })
  }
  const run = {
    run_id, finished_ist, index: underlying, data, what, search, minTrades, from, to,
    firstDay: days?.at(-1)?.date, lastDay: days?.[0]?.date,
    daysUsed: days?.length ?? 0, daysEstimated: (days ?? []).filter((d) => d.estimated).length, daysSkipped: skipped?.length ?? 0,
    strategiesTuned: (results ?? []).length, trades: (trades ?? []).length,
    dhanCalls: fetched?.requests, cacheHits: fetched?.cacheHits,
  }
  return { run_id, run, settings, trades: (trades ?? []).map((t) => ({ ...t, run_id })) }
}
