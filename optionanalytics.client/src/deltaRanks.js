// The delta profiles' STANDOUT ROWS (asked for - "the delta profile you are showing: show the 1st highest and 2nd highest as
// well as the lowest in different colours, everywhere"): in each delta column the biggest BUYING row (1st) and the next (2nd),
// and the same for SELLING, each drawn in its own colour with a B1 / B2 / S1 / S2 tag - OI Replay's option / futures delta
// profile and CDV / OBV cards (every delta column of them) and the Profiles page's Delta column. Drawing only.

/** Ranked colours: 1st brighter / deeper than 2nd, buyers green-blue, sellers red-orange - clear of the ordinary bars. */
export const RANK_COLORS = {
  buy1: 'rgba(0,230,118,1)',     // bright green - the most buying
  buy2: 'rgba(64,196,255,1)',    // sky blue - the second most
  sell1: 'rgba(255,23,68,1)',    // bright red - the most selling
  sell2: 'rgba(255,145,0,1)',    // orange - the second most
}
export const RANK_TAGS = { buy1: 'B1', buy2: 'B2', sell1: 'S1', sell2: 'S2' }

/** Map price -> 'buy1' | 'buy2' | 'sell1' | 'sell2' for `rows` ([{ price, delta }]). The bullish side is delta > 0, or < 0
 *  with `bullishNegative` (the option OI's CE − PE: puts written = bullish). Ranked by |delta|; a row of 0 never ranks;
 *  equal sizes keep the higher price first. */
export function deltaRanks(rows, bullishNegative = false) {
  const out = new Map()
  const bull = []
  const bear = []
  for (const r of rows ?? []) {
    if (!Number.isFinite(r?.delta) || r.delta === 0 || !Number.isFinite(r.price)) continue
    ;((bullishNegative ? r.delta < 0 : r.delta > 0) ? bull : bear).push(r)
  }
  const order = (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.price - a.price
  bull.sort(order).slice(0, 2).forEach((r, i) => out.set(r.price, i ? 'buy2' : 'buy1'))
  bear.sort(order).slice(0, 2).forEach((r, i) => out.set(r.price, i ? 'sell2' : 'sell1'))
  return out
}

/** The tag beside a ranked bar, when the row is tall enough to read it (`height` and `minHeight` in bitmap pixels). */
export function drawRankTag(ctx, rank, { x, top, height, alignRight, vpr, minHeight }) {
  if (!rank || height < minHeight) return
  ctx.save()
  ctx.fillStyle = RANK_COLORS[rank]
  ctx.font = `bold ${Math.round(Math.min(10, Math.max(8, height / vpr - 1)) * vpr)}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = alignRight ? 'right' : 'left'
  ctx.fillText(RANK_TAGS[rank], x, top + height / 2)
  ctx.restore()
}
