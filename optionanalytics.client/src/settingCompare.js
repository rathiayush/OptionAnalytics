// "What runs now" against "the new setting" for one strategy on one index (Trades → Strategy performance → Compare) -
// to decide before applying. Both sides are read from the same tuning record (TuningPerformance): each tuned setting's
// trades on days it was never tuned on (its unseen days - every run's cross-check added up), its months, its score, and
// the strategy as written on the same cross-checked days.
import { settingParams, settingSignature } from './strategyTuning.js'

/**
 * What runs now on the index, as the compare reads it:
 *  - { kind: 'written' }: nothing applied - the strategy as written;
 *  - { kind: 'tuned', t }: a tuned setting applied that the runs kept know (t: its TunedSetting);
 *  - { kind: 'applied', filters }: filters applied that no run kept knows (an older setting, or set by hand).
 */
export function nowOf(liveFilters, tunedList, isLiveFn, tunedPartFn) {
  const t = (tunedList ?? []).find((x) => isLiveFn(liveFilters, x.row))
  if (t) return { kind: 'tuned', t }
  return Object.keys(tunedPartFn(liveFilters ?? {})).length ? { kind: 'applied', filters: liveFilters } : { kind: 'written' }
}

const unitOf = (t) => (t?.unit === 'pts' ? ' pts' : 'R')
const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`

/**
 * Which is better, and on what evidence: { better: 'new' | 'now' | 'same' | 'unknown', by (per trade, the setting's unit)
 * | null, basis, text }.
 *  - now = as written: the new setting against the strategy as written ON THE SAME DAYS (its cross-checked days) - like
 *    for like;
 *  - now = a tuned setting: their scores (each one's unseen-days average shrunk for few trades) - each on its own unseen
 *    days, so the one proven over more trades counts for more;
 *  - now = something the runs do not know: not measurable here (its live run is the only record).
 */
export function compareVerdict(now, next) {
  const u = unitOf(next)
  if (!next) return { better: 'unknown', by: null, basis: null, text: 'No new setting to compare.' }
  if (now.kind === 'tuned' && settingSignature(now.t.row) === settingSignature(next.row)) return { better: 'same', by: 0, basis: null, text: 'This is the setting running now.' }
  const caveat = next.best ? '' : ' - the new one is not proven yet'
  if (now.kind === 'written') {
    if (next.checkTrades > 0 && next.checkAvg != null && next.baseAvg != null) {
      const by = next.checkAvg - next.baseAvg
      return {
        better: by > 0 ? 'new' : 'now', by, basis: 'same days',
        text: `${by > 0 ? 'New is better' : 'As written (now) is better'}: ${signed(next.checkAvg)}${u} vs ${signed(next.baseAvg)}${u} a trade on the same days neither was tuned on (${next.checkTrades} vs ${next.baseTrades ?? '?'} trades) - ${signed(by)}${u} a trade${caveat}.`,
      }
    }
    if (next.score != null) {
      return {
        better: next.score > 0 ? 'new' : 'now', by: null, basis: 'score',
        text: `No same-day check against as written yet - the new one ${next.score > 0 ? 'makes' : 'loses'} ${signed(next.testAvg ?? 0)}${u} a trade on its ${next.testTrades} unseen trade(s)${caveat}. Run a Re-check to compare like for like.`,
      }
    }
    return { better: 'unknown', by: null, basis: null, text: 'The new setting has no trade on a day it was not tuned on yet - nothing to compare. Run a Re-check (Strategy tuning).' }
  }
  if (now.kind === 'tuned') {
    const a = now.t.score
    const b = next.score
    if (a == null || b == null) {
      return { better: b != null && b > 0 ? 'new' : a != null && a > 0 ? 'now' : 'unknown', by: null, basis: 'score', text: `${a == null ? 'What runs now' : 'The new one'} has no unseen-days trade yet - only ${a == null ? 'the new one' : 'what runs now'} can be judged${caveat}.` }
    }
    const by = b - a
    return {
      better: by > 0 ? 'new' : 'now', by, basis: 'score',
      text: `${by > 0 ? 'New scores higher' : 'What runs now scores higher - keep it'}: ${signed(b)}${u} vs ${signed(a)}${u} (each on its own unseen days: ${next.testTrades} vs ${now.t.testTrades} trades, shrunk for few trades)${caveat}.`,
    }
  }
  return { better: 'unknown', by: null, basis: null, text: 'What runs now is not a setting any run kept - it cannot be measured here; its run on the live scanner below is its record.' }
}

/** Every parameter, now against new: { key, label, now, next, changed } - changed = the value moves. */
export function paramDiff(now, next) {
  const before = now.kind === 'tuned' ? settingParams(now.t.row, 'row') : settingParams(now.kind === 'applied' ? now.filters : {}, 'filters')
  const after = settingParams(next.row, 'row')
  const keys = [...after.map((p) => p.key), ...before.map((p) => p.key).filter((k) => !after.some((p) => p.key === k))]
  const off = 'off / default'
  return keys.map((key) => {
    const a = before.find((p) => p.key === key)
    const b = after.find((p) => p.key === key)
    const nowV = a?.value ?? off
    const nextV = b?.value ?? off
    return { key, label: b?.label ?? a?.label ?? key, now: nowV, next: nextV, changed: nowV !== nextV }
  })
}
