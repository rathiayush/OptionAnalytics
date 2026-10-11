// THE CROSS-CHECK of the strategy tuning (strategyTuning.js checkSetting). One month tuned, then another: each run
// finds its own "best" setting, judged only on its own held-back days - two settings that cannot be compared, and either
// may simply fit its own month. So every run also measures EVERY setting found so far for its index (and its own new
// ones) on the days of this run that setting was NOT chosen on, and keeps that per day in {run_id}-checks.csv. The
// Trades page (TuningPerformance.cs) adds those rows up across runs: each setting gets a record on unseen days across
// months - how it did, in how many months it won, and against the strategy as written on the same days - and the best
// is the one that keeps winning there, not the one that looked best in one run.
//
// "Not chosen on" = not one of the train days of any run that chose it (its {run}-days.csv); for a run written before
// the days list existed, none of the days between its first and last day.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asWrittenVariant, checkSetting, paramsFromSettingsRow, perDay } from '../src/strategyTuning.js'
import { SETTING_KEYS, fromCsv, isRunId } from './tuneHistory.mjs'

const read = (dir, name) => {
  const path = join(dir, name)
  return existsSync(path) ? fromCsv(readFileSync(path, 'utf8')).rows : null
}

/** A setting's identity: its non-empty parameter columns as the settings CSV writes them (TuningPerformance.SignatureOf
 *  reads the same) - two runs that chose the same setting share it, whichever columns their files had. */
export const signatureOf = (raw) => SETTING_KEYS.filter((k) => (raw[k] ?? '') !== '').map((k) => `${k}=${raw[k]}`).join('|')
/** The parameter columns of a setting, as strings - from a settings row, or from params as tuned. */
export const rawOfRow = (row) => Object.fromEntries(SETTING_KEYS.map((k) => [k, row?.[k] ?? '']))
export const rawOfParams = (params) => Object.fromEntries(SETTING_KEYS.map((k) => [k, params?.[k] == null ? '' : String(params[k])]))

/**
 * Every fine-tuned setting the history holds for one index and data mode, one per strategy and setting, with the
 * days it was chosen on: [{ id, no, name, unit, settingText, raw, params, trainDates: Set, ranges: [[from, to]], runs }].
 */
export function candidatesFrom(historyDir, { underlying, data }) {
  const out = new Map()
  if (!historyDir) return []
  for (const run of read(historyDir, 'runs.csv') ?? []) {
    if (run.index !== underlying || (run.data || 'futures') !== data || !isRunId(run.run_id)) continue
    const settings = read(historyDir, `${run.run_id}-settings.csv`)
    if (!settings) continue
    const days = read(historyDir, `${run.run_id}-days.csv`)
    const train = days ? days.filter((d) => d.status === 'used' && d.role === 'train').map((d) => d.date) : null
    for (const st of settings) {
      if (st.which !== 'fine-tuned' || !st.strategy_id) continue
      const raw = rawOfRow(st)
      const key = `${st.strategy_id}|${st.unit || 'R'}|${signatureOf(raw)}`
      let c = out.get(key)
      if (!c) out.set(key, c = { id: st.strategy_id, no: st.strategy_no, name: st.strategy, unit: st.unit || 'R', settingText: st.setting_text, raw, params: paramsFromSettingsRow(st), trainDates: new Set(), ranges: [], runs: [] })
      c.runs.push(run.run_id)
      if (train) for (const d of train) c.trainDates.add(d)
      else if (run.first_day && run.last_day) c.ranges.push([run.first_day, run.last_day].sort()) // no days list: none of its days count as unseen
    }
  }
  return [...out.values()]
}

/** This run's own fine-tuned settings as candidates (their train days are this run's train days). */
export function candidatesOfResults(results) {
  return (results ?? []).filter((r) => r.best).map((r) => ({
    id: r.id, no: r.no, name: r.name, unit: r.unit ?? 'R', settingText: r.settingText, raw: rawOfParams(r.best.params), params: r.best.params,
    trainDates: new Set(r.trainDays ?? []), ranges: [], runs: ['this run'],
  }))
}

/** The two lists as one: a setting this run found again keeps the train days of every run that chose it. */
export function mergeCandidates(...lists) {
  const out = new Map()
  for (const c of lists.flat()) {
    const key = `${c.id}|${c.unit}|${signatureOf(c.raw)}`
    const cur = out.get(key)
    if (!cur) { out.set(key, { ...c, trainDates: new Set(c.trainDates), ranges: [...c.ranges], runs: [...c.runs] }); continue }
    for (const d of c.trainDates) cur.trainDates.add(d)
    cur.ranges.push(...c.ranges)
    cur.runs.push(...c.runs)
    if (c.runs.includes('this run')) cur.settingText = c.settingText ?? cur.settingText
  }
  return [...out.values()]
}

/** Was `date` a day setting `c` was chosen on? */
export const chosenOn = (c, date) => c.trainDates.has(date) || c.ranges.some(([a, b]) => date >= a && date <= b)

/**
 * Every candidate measured on this run's `days` it was not chosen on - rows for {run}-checks.csv:
 * { id, no, name, unit, settingText, raw, date, n, total, wins, baseN, baseTotal }. `stop()` true ends it early (the
 * job's time budget) - what was checked is kept.
 */
export function crossCheck(days, candidates, trail = null, { stop = () => false } = {}) {
  const rows = []
  const asWritten = new Map() // per strategy and measure, worked out once
  for (const c of candidates) {
    if (stop()) break
    const unseen = days.filter((d) => !chosenOn(c, d.date))
    if (!unseen.length) continue
    const bk = `${c.id}|${c.unit}`
    if (!asWritten.has(bk)) asWritten.set(bk, perDay(days, c.id, asWrittenVariant(c.unit), c.unit, trail))
    for (const r of checkSetting(unseen, c.id, c.params, c.unit, trail, asWritten.get(bk))) {
      rows.push({ id: c.id, no: c.no, name: c.name, unit: c.unit, settingText: c.settingText, raw: c.raw, ...r })
    }
  }
  return rows
}
