// What is applied, as the Strategy lab's jobs to run (AppliedLab.jsx).
import { STRATEGY_BY_ID } from './strategyEngine.js'

export const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']

/** What is applied, as the jobs to run: one per index and kind (strategies applied on an index, split futures / spot), and
 *  the applied ids that cannot be run (retired since, or unknown) - listed, never run, never a reason to fail the rest. */
export function appliedPlan(cfg) {
  const pairs = []
  const leftOut = []
  for (const u of UNDERLYINGS) {
    const by = { futures: [], spot: [] }
    for (const id of Object.keys(cfg?.filtersByIndex?.[u] ?? {})) {
      const s = STRATEGY_BY_ID[id]
      if (!s) leftOut.push({ u, id, reason: 'no such strategy' })
      else if (s.retired) leftOut.push({ u, id, reason: 'retired' })
      else by[s.spot ? 'spot' : 'futures'].push(id)
    }
    for (const kind of ['futures', 'spot']) if (by[kind].length) pairs.push({ u, kind, ids: by[kind].sort((a, b) => STRATEGY_BY_ID[a].no - STRATEGY_BY_ID[b].no), key: `${u}|${kind}` })
  }
  return { pairs, leftOut }
}

const dayMs = 86_400_000
const shift = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10)

/** The LAST TUNING RUN of each index and kind, as the lab's jobs to run on the days BEFORE it - days its settings were
 *  never chosen or checked on. `runs` is { 'NIFTY|futures': the tuning result (GET /api/strategy-tuning/result), ... };
 *  `toParams(params, kind)` turns a best setting into the lab's params (strategyTuning.labParams). Each pair: the
 *  strategies the run found a setting for, each one's own setting (paramsById), whether the run recommended it, and the
 *  test window - as many calendar days as the run covered, ending the day before its first day. */
export function tunedPlan(runs, toParams) {
  const pairs = []
  const leftOut = []
  for (const u of UNDERLYINGS) {
    for (const kind of ['futures', 'spot']) {
      const run = runs?.[`${u}|${kind}`]
      const found = (run?.ok !== false ? run?.results ?? [] : []).filter((r) => r?.best?.params)
      const dates = (run?.days ?? []).map((d) => d.date).filter(Boolean).sort()
      if (!found.length || !dates.length) continue
      const ids = []
      const paramsById = {}
      const recommend = {}
      for (const r of found) {
        const s = STRATEGY_BY_ID[r.id]
        if (!s || s.retired) { leftOut.push({ u, id: r.id, reason: !s ? 'no such strategy' : 'retired' }); continue }
        if (!!s.spot !== (kind === 'spot')) continue
        ids.push(r.id)
        paramsById[r.id] = toParams(r.best.params, kind)
        recommend[r.id] = !!r.recommend
      }
      if (!ids.length) continue
      const first = dates[0]
      const last = dates.at(-1)
      const span = Math.round((Date.parse(last) - Date.parse(first)) / dayMs) + 1
      const testTo = shift(first, -1)
      pairs.push({
        u, kind, key: `${u}|${kind}`, ids: ids.sort((a, b) => STRATEGY_BY_ID[a].no - STRATEGY_BY_ID[b].no), paramsById, recommend,
        run: { runId: run.runId ?? null, finishedUtc: run.finishedUtc ?? null, first, last, days: dates.length, what: run.what ?? null },
        testFrom: shift(testTo, -(span - 1)), testTo,
      })
    }
  }
  return { pairs, leftOut }
}
