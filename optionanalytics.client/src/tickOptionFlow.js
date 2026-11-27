// The Tick Flow page's OPTION CDV / OBV, from TrueData's option ticks (TickOptionFlowCard.jsx; this page's OWN maths - nothing of OI Replay's / Dhan's
// optionFlow.js). The server (OptionBigOrderWatch.FlowSince) sends every option's trading minute by minute: the quantity bought at the ask / sold at the
// bid (the side the quote BEFORE each tick gives - real aggressor sides, not a bar proxy) and the premium's first / last price.
//   CDV = bought - sold, in lots, added over every option of the side (CE / PE) and cumulated from the day's first minute.
//   OBV = each option's minute volume (lots) signed by whether its premium ROSE (+) or FELL (-) from its previous minute's close (the first minute: from its
//         own open), added over the side and cumulated.
// Net = CE - PE. Buckets of `tf` minutes; a bucket is counted once its last minute has started (nothing from a minute still forming is dropped - it is
// the newest point, labelled live). Pure.

const MIN = 60_000

/** The rows of the options' minutes into `tf`-minute buckets with CDV / OBV for CE and PE: `[{ t, ce: {cdv, obv}, pe: {cdv, obv} }]` (per-bucket, not cumulative). */
export function optionFlowBuckets(rows, tf = 1, { upToMs = null } = {}) {
  const size = Math.max(1, tf) * MIN
  const byOption = new Map()
  for (const r of rows ?? []) {
    if (upToMs != null && r.t + MIN > upToMs) continue
    if (!byOption.has(r.symbol)) byOption.set(r.symbol, [])
    byOption.get(r.symbol).push(r)
  }
  const buckets = new Map()
  for (const list of byOption.values()) {
    list.sort((a, b) => a.t - b.t)
    let prevClose = null
    for (const r of list) {
      const lot = Math.max(1, r.lot || 1)
      const cdv = (r.buy - r.sell) / lot
      const ref = prevClose ?? r.open
      const sign = r.close > ref ? 1 : r.close < ref ? -1 : 0
      const obv = sign * ((r.buy + r.sell) / lot)
      prevClose = r.close
      const t = Math.floor(r.t / size) * size
      let b = buckets.get(t)
      if (!b) { b = { t, ce: { cdv: 0, obv: 0 }, pe: { cdv: 0, obv: 0 } }; buckets.set(t, b) }
      const side = r.type === 'CE' ? b.ce : b.pe
      side.cdv += cdv
      side.obv += obv
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t)
}

/** The cumulative lines from the buckets: `{ cdv: { ce: [{time, value}], pe, net }, obv: {...}, last: { cdv: {ce, pe, net}, obv: {...} } }` (time = the bucket's start, epoch ms). */
export function optionFlowLines(buckets) {
  const out = { cdv: { ce: [], pe: [], net: [] }, obv: { ce: [], pe: [], net: [] } }
  const run = { cdv: { ce: 0, pe: 0 }, obv: { ce: 0, pe: 0 } }
  for (const b of buckets) {
    for (const m of ['cdv', 'obv']) {
      run[m].ce += b.ce[m]
      run[m].pe += b.pe[m]
      out[m].ce.push({ time: b.t, value: run[m].ce })
      out[m].pe.push({ time: b.t, value: run[m].pe })
      out[m].net.push({ time: b.t, value: run[m].ce - run[m].pe })
    }
  }
  const last = (m) => ({ ce: run[m].ce, pe: run[m].pe, net: run[m].ce - run[m].pe })
  return { ...out, last: { cdv: last('cdv'), obv: last('obv') } }
}

/** Merge the server's newer rows into the rows kept: a row (option + minute) the answer repeats replaces the old one (the forming minute is sent each time). */
export function mergeFlowRows(kept, fresh) {
  if (!fresh?.length) return kept
  const map = new Map(kept.map((r) => [`${r.symbol}|${r.t}`, r]))
  for (const r of fresh) map.set(`${r.symbol}|${r.t}`, r)
  return [...map.values()].sort((a, b) => a.t - b.t)
}

/** A bare number of lots as text ("+1,234"). */
export const lotsText = (v) => `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v)).toLocaleString('en-IN')}`
