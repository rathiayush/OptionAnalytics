// AI analysis of a run's report (asked for - "integrate everything into our system, we should be able to analyse every run"):
// the page turns a report into compact TEXT (everything below is pure - `tests/llm-analysis.test.mjs`) and the server
// (LlmAnalysisService, `/api/llm`) hands it to a LOCAL model (Ollama - nothing leaves the machine). The model only
// interprets the numbers in the text; it never works them out, and what it says is a lead to backtest, not a signal.
// It feeds no strategy, alert or order.
import { HOLD_IC, LABELS } from './featureFinder.js'
import { cleanBacktestSettings, reportHead } from './signalBacktestJob.js'

const API = '/api/llm'

async function api(path, options) {
  const r = await fetch(path, options)
  const text = await r.text()
  if (!r.ok) {
    let reason = text.slice(0, 300)
    try { reason = JSON.parse(text)?.error ?? reason } catch { /* not JSON */ }
    throw new Error(reason || `HTTP ${r.status}`)
  }
  return text ? JSON.parse(text) : null
}

/** { enabled, available, defaultModel, models, reason } - asked once by the page (a click or opening the card), never polled. */
export const llmStatus = () => api(`${API}/status`)

/** The analysis of a report text: { text, model, seconds }. `ask` - an optional question; `model` - one of the installed. */
export const llmAnalyse = (text, { ask = '', model = '', signal } = {}) =>
  api(`${API}/analyse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ask, model }), signal })

// ---- the texts -------------------------------------------------------------------------------------------------------

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const n = (v, d = 2) => (fin(v) ? String(Math.round(v * 10 ** d) / 10 ** d) : v === Infinity ? 'inf' : 'n/a')
const rs = (v) => (fin(v) ? `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}` : 'n/a')
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
const pct = (v, d = 0) => (fin(v) ? `${n(v, d)}%` : 'n/a')
/** Most characters of a report text - the server cuts at its own limit, this keeps a 1 500-day run's text to what it reads. */
export const MAX_TEXT_CHARS = 40000
const istHour = (ms) => new Date(ms + 5.5 * 3600e3).getUTCHours()

/** A Signal backtest report ({ rows, all, dayRows, trades, failed, ... } from `backtestReport`) as text. */
export function backtestReportText(report, settings = {}) {
  if (!report?.okDays) return ''
  const first = report.dayRows?.[0]?.date, last = report.dayRows?.at(-1)?.date
  const lines = []
  lines.push('SIGNAL BACKTEST REPORT')
  lines.push(reportHead({ ...settings, from: first, to: last }, report.okDays))
  lines.push('')
  lines.push('Rules tested:')
  for (const r of report.rows ?? []) lines.push(`- ${r.name}: ${r.what}`)
  lines.push('')
  lines.push('Results (net of charges unless the heading says otherwise; money in rupees):')
  const side = (r) => `${r.name}: ${r.signals ?? 0} signals, ${r.trades} trades, win ${pct(r.winRate)}, net ${rs(r.net)}, gross ${rs(r.gross)}, charges ${rs(r.charges)}, ` +
    `profit factor ${n(r.profitFactor)}, expectancy ${rs(r.expectancy)} a trade, avg win ${rs(r.avgWin)}, avg loss ${rs(r.avgLoss)}, max drawdown ${rs(r.maxDrawdown)}, ` +
    `best trade ${rs(r.best)}, worst ${rs(r.worst)}, green days ${r.winningDays ?? 0} of ${r.days ?? 0} traded, avg hold ${n(r.avgHoldMin, 0)} min`
  for (const r of [report.all, ...(report.rows ?? []).filter(() => (report.sides?.length ?? 1) > 1)]) if (r) lines.push(`- ${side(r)}`)

  const trades = report.trades ?? []
  if (trades.length) {
    const group = (key) => {
      const m = new Map()
      for (const t of trades) {
        const k = key(t)
        const g = m.get(k) ?? { trades: 0, wins: 0, net: 0 }
        g.trades++
        if (t.net > 0) g.wins++
        g.net += t.net
        m.set(k, g)
      }
      return m
    }
    const show = (m, label, sort = (a, b) => b[1].net - a[1].net) =>
      [...m.entries()].sort(sort).map(([k, g]) => `${label(k)}: ${plural(g.trades, 'trade')}, win ${pct((g.wins / g.trades) * 100)}, net ${rs(g.net)}`)
    lines.push('', 'By exit reason:')
    for (const l of show(group((t) => t.exitReason || 'unknown'), (k) => `- ${k}`)) lines.push(l)
    lines.push('', 'By entry hour (IST):')
    for (const l of show(group((t) => istHour(t.entryTime)), (k) => `- ${String(k).padStart(2, '0')}h`, (a, b) => a[0] - b[0])) lines.push(l)
    lines.push('', 'By option side:')
    for (const l of show(group((t) => t.side ?? '?'), (k) => `- ${k}`)) lines.push(l)
  }

  const months = monthsOf(report)
  if (months.length) {
    lines.push('', 'Month by month (month: days run, trades, win %, net, green days of days traded):')
    for (const m of months) lines.push(`- ${m.month}: ${plural(m.days, 'day')}, ${plural(m.trades, 'trade')}, win ${pct(m.winRate)}, net ${rs(m.net)}, green ${m.greenDays} of ${m.daysTraded}`)
    lines.push(`${months.filter((m) => m.net > 0).length} of ${months.length} months were green.`)
  }

  const traded = (report.dayRows ?? []).filter((d) => d.ok && d.trades > 0)
  if (traded.length) {
    const byNet = [...traded].sort((a, b) => b.net - a.net)
    lines.push('', `Best days: ${byNet.slice(0, 5).map((d) => `${d.date} ${rs(d.net)}`).join(', ')}`)
    lines.push(`Worst days: ${byNet.slice(-5).reverse().map((d) => `${d.date} ${rs(d.net)}`).join(', ')}`)
    const top = byNet.slice(0, Math.max(1, Math.ceil(traded.length * 0.1)))
    const total = traded.reduce((a, d) => a + d.net, 0)
    lines.push(`The best ${top.length === 1 ? 'day' : `${top.length} days`} (10% of the traded days) made ${rs(top.reduce((a, d) => a + d.net, 0))}; all ${traded.length} traded days made ${rs(total)}.`)
  }
  if (report.failed?.length) lines.push('', `Days not run: ${report.failed.length} (${[...new Set(report.failed.map((f) => f.reason))].slice(0, 3).join('; ')})`)
  for (const [list, what] of [[report.noPrev, 'no previous session profile'], [report.noPivots, 'no pivots'], [report.noDeltaPast, 'fewer sessions before than the rule reads']]) {
    if (list?.length) lines.push(`${list.length} day(s) with ${what}.`)
  }
  return clip(lines.join('\n'))
}

function monthsOf(report) {
  const m = new Map()
  const at = (date) => {
    const key = String(date).slice(0, 7)
    if (!m.has(key)) m.set(key, { month: key, days: 0, daysTraded: 0, greenDays: 0, trades: 0, wins: 0, net: 0 })
    return m.get(key)
  }
  for (const d of report.dayRows ?? []) {
    if (!d.ok) continue
    const r = at(d.date)
    r.days++
    if (d.trades > 0) { r.daysTraded++; if (d.net > 0) r.greenDays++ }
  }
  for (const t of report.trades ?? []) { const r = at(t.date); r.trades++; if (t.net > 0) r.wins++; r.net += t.net }
  return [...m.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((r) => ({ ...r, winRate: r.trades ? (r.wins / r.trades) * 100 : null }))
}

/** A Feature finder report (`featureReport` for one label) as text: the readings that hold first. */
export function featureReportText(report, target, info = {}) {
  if (!report?.features?.length) return ''
  const label = LABELS.find((l) => l.key === target)?.name ?? target
  const lines = []
  lines.push('FEATURE FINDER REPORT')
  lines.push(`${info.underlying ? `${info.underlying} · ` : ''}${report.days} days (${report.rows} candle rows${info.timeframe ? `, ${info.timeframe}-minute candles` : ''}). Label: ${label}.`)
  if (report.split) {
    lines.push(`Split by date: ${report.earlyDays} earlier days (${report.earlyRows} rows) and ${report.laterDays} later days (${report.laterRows} rows, from ${report.firstLater}).`)
    lines.push(`A reading HOLDS when its rank correlation with the label has the same sign on the earlier and the later days and |later| >= ${HOLD_IC}.`)
    if (report.laterDays < 10) lines.push(`Only ${report.laterDays} later days: a hint, not proof.`)
  } else {
    lines.push('Fewer than 6 days: no earlier / later split, so nothing can be said to hold.')
  }
  const held = report.features.filter((f) => f.holds)
  lines.push(`${held.length} of ${report.features.length} readings hold.`, '')
  const row = (f) => {
    const fi = f.fifths
    const tail = fi ? ` | later days, top fifth of the reading: win ${pct(fi.high.win)} avg ${n(fi.high.avg, 3)}; bottom fifth: win ${pct(fi.low.win)} avg ${n(fi.low.avg, 3)}; all: win ${pct(fi.all.win)} avg ${n(fi.all.avg, 3)}` : ''
    return `- ${f.name} [${f.group}]: earlier ${n(f.icEarly, 3)}, later ${n(f.icLater, 3)}, later days agreeing ${pct(f.dayAgree)} of ${f.days}, coverage ${pct(f.coverage)}${tail}`
  }
  lines.push('Readings that hold (strongest later correlation first):')
  for (const f of held.slice(0, 20)) lines.push(row(f))
  const rest = report.features.filter((f) => !f.holds && fin(f.icLater)).sort((a, b) => Math.abs(b.icLater) - Math.abs(a.icLater)).slice(0, 8)
  if (rest.length) {
    lines.push('', 'Strongest readings that do NOT hold (they flipped sign or are too weak later):')
    for (const f of rest) lines.push(row(f))
  }
  return clip(lines.join('\n'))
}

/** Compare all (`compareTemplates` rows) as text: every template over the same days, best net first. */
export function compareText(rows, info = {}) {
  if (!rows?.length) return ''
  const lines = ['COMPARE ALL - every built-in rule template over the same days, best net first',
    `${info.underlying ?? ''} · ${rows[0].days} days. They are starting points, not measured edges; the ranking is in-sample.`, '']
  for (const r of rows) {
    lines.push(`- ${r.name} (${r.family}, ${r.timeframe}m): ${r.trades} trades, win ${pct(r.winRate)}, net ${rs(r.net)}, profit factor ${n(r.profitFactor)}, ` +
      `expectancy ${rs(r.expectancy)}, max drawdown ${rs(r.maxDrawdown)}, rule ${rs(r.ruleNet)}${r.mirrorNet == null ? '' : `, mirror ${rs(r.mirrorNet)}`}. Idea: ${r.idea}`)
  }
  const made = rows.filter((r) => r.net > 0).length
  lines.push('', `${made} of ${rows.length} templates ended in profit.`)
  return clip(lines.join('\n'))
}

/** The text of a finished BACKGROUND run's result (`GET /api/signal-backtest/jobs/{id}/result`): a backtest's report, or a
 *  Feature finder's reports for the labels people read first (CE buy, PE buy, spot 30 min). '' when it kept no report. */
export function storedRunText(result) {
  if (!result) return ''
  const settings = cleanBacktestSettings(result.settings)
  if (result.kind === 'features') {
    const f = result.features ?? {}
    return ['ceBuy', 'peBuy', 'fwd30']
      .map((label) => featureReportText(f.reports?.[label], label, { underlying: settings.underlying, timeframe: f.timeframe ?? settings.timeframe }))
      .filter(Boolean)
      .join('\n\n')
  }
  return backtestReportText(result.report, settings)
}

function clip(text) {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[cut]` : text
}
