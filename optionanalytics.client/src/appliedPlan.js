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
