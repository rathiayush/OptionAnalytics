// SCORED absorption and exhaustion on the footprint (asked for - "is there any better way to identify exhaustion /
// absorption on the footprint ... please work on this area"; "yes, you fix absorption exhaustion"). The footprint's first
// rules (orderFlowMath.analyzeBars) read ONE bar: heavy aggression in its end rows with a close off the extreme
// (absorption), a nearly empty end row (exhaustion). They stay as they are for the strategy scanner and the bias - which
// are measured on them. What the FOOTPRINT shows is this read instead, each mark with a 0 - 100 score of how many
// independent things agree:
//
//   ABSORPTION - an EFFORT that FAILED at a price. At a bar's low (bullish; the high is the mirror):
//     effort     - the aggressive SELLING in the bar's bottom zone (its lowest third, at least two rows), with what was
//                  sold at those same prices in the two bars before it (absorption is a fight at a price, often over
//                  several bars), against a typical bar's selling - the bar's own at least half a usual bar's, and the
//                  selling there 1.5x the buying;
//     result     - how far the bar closed back off its low (it must close above the zone);
//     efficiency - the delta that did not move price: sellers ahead on the bar yet it closed up, or it moved far less a
//                  lot of delta than bars usually do;
//     context    - the low is a new low of the last bars (a real test, not noise inside the range) and / or sits at a
//                  level given (VWAP, a wall, yesterday's value area ...);
//     book       - with the order book: what traded into the bids there against what they SHOWED, and whether they
//                  are still there (traded more than was ever shown, bids still standing = refilled: the real thing).
//   EXHAUSTION - PARTICIPATION FADING at a new extreme. At a new high of the last bars (bearish; the low is the mirror):
//     volume     - less volume than the push before it (the last bar that made a new high);
//     delta      - less buying delta than that push (or none at all), and a lower cumulative delta at a higher high;
//     thin top   - little traded in the top two rows (two, not one: Dhan's one-second packets put a whole second's
//                  volume on one price, so a single thin row is often an artefact);
//     value      - the bar's busiest price (POC) did not follow price up;
//     rejection  - how far it closed back off the high (it must close off it).
//
// A part that cannot be read (no book, no push before) is left out and the rest re-weighted. Every bar is read from
// itself and the bars BEFORE it - nothing after (`tests/flow-reads.test.mjs`). A read on the chart: it feeds no strategy,
// alert or order.

const round2 = (v) => Math.round(v * 100) / 100
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0)
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : 0 }
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

export const FLOW_READ_DEFAULTS = {
  minScore: 50,      // a mark is drawn from this score
  lookback: 10,      // bars a "new" high / low is new against
  norm: 20,          // bars the typical selling / buying / move per delta are read over
  zoneBars: 2,       // bars before this one whose trading at the zone's prices counts as the same fight
  nearRows: 2,       // rows within which a given level counts as "at" the extreme
}
export const FLOW_READ_SCORES = [40, 50, 60, 70]
const ABSORPTION_WEIGHTS = { effort: 30, result: 20, efficiency: 20, context: 15, book: 15 }
const EXHAUSTION_WEIGHTS = { volume: 20, delta: 25, thin: 15, value: 15, rejection: 25 }
export const FLOW_READ_PARTS = {
  effort: 'heavy aggression at the price', result: 'closed back off it', efficiency: 'delta did not move price', context: 'at a new extreme / a level',
  book: 'resting orders held or refilled', volume: 'less volume than the last push', delta: 'less delta than the last push', thin: 'little traded at the extreme',
  value: 'the busiest price did not follow', rejection: 'closed back off it',
}

// The score of the parts read (null = not read): their weights' share, 0 - 100.
function scoreOf(parts, weights) {
  let got = 0, of = 0
  for (const [key, w] of Object.entries(weights)) if (parts[key] != null) { got += w * parts[key]; of += w }
  return of > 0 ? Math.round((got / of) * 100) : 0
}

// Resting size shown at the zone's rows through the bar (the most, and at its end), from the book columns - null without any.
function bookAt(columns, fromMs, toMs, lo, hi, side, step) {
  if (!columns?.length) return null
  let a = 0, b = columns.length
  while (a < b) { const m = (a + b) >> 1; if (columns[m].t < fromMs) a = m + 1; else b = m }
  let most = 0, last = null
  for (let i = a; i < columns.length && columns[i].t < toMs; i++) {
    let q = 0
    for (const [p, qty] of columns[i][side] ?? []) if (p >= lo - step / 2 && p <= hi + step / 2) q += qty
    most = Math.max(most, q)
    last = q
  }
  return last == null ? null : { most, last }
}

/**
 * The scored reads of `bars` (analyzeBars' - time, open / high / low / close, buy, sell, delta, volume, cvd, poc, levels
 * [{ price, buy, sell }]; oldest first): an array beside them, each { absorption: [], exhaustion: [] } of { side ('buy' =
 * bullish - selling absorbed / exhausted at the low; 'sell' = bearish), price (the extreme's row), low, high (the zone),
 * volume (the aggression there), score, parts { name: 0 - 1 | null }, text }. `rowSize`: the footprint's rows;
 * `timeframe`: the bars' minutes (for the book); `columns`: the book's columns ({ t, bids, asks } as [price, quantity] -
 * optional); `levels`: prices that matter ([{ price, label }], or (barIndex) => those known AT that bar - a level
 * that moves, like VWAP, must be the bar's own; optional). An estimated day's rows are a spread, not
 * trades: none are read (the candle rules stay).
 */
export function scoredFlowReads(bars, { rowSize, timeframe = 1, columns = null, levels = [], ...options } = {}) {
  const o = { ...FLOW_READ_DEFAULTS, ...options }
  const step = rowSize > 0 ? rowSize : 0.05
  const list = bars ?? []
  const out = list.map(() => ({ absorption: [], exhaustion: [] }))
  const spanMs = Math.max(1, timeframe) * 60_000
  // The last bar that made a new high / low of its own lookback, as the bars go by.
  let lastPush = { high: null, low: null }
  for (let i = 0; i < list.length; i++) {
    const bar = list[i]
    const rows = [...(bar.levels ?? [])].sort((a, b) => a.price - b.price)
    const range = bar.high - bar.low
    const from = Math.max(0, i - o.norm)
    const before = list.slice(from, i)
    const prior = list.slice(Math.max(0, i - o.lookback), i)
    const priorHigh = prior.length ? Math.max(...prior.map((b) => b.high)) : null
    const priorLow = prior.length ? Math.min(...prior.map((b) => b.low)) : null
    const newHigh = priorHigh != null && bar.high > priorHigh
    const newLow = priorLow != null && bar.low < priorLow
    if (rows.length >= 3 && bar.volume > 0 && range > 0 && before.length >= 3) {
      const typical = { sell: median(before.map((b) => b.sell ?? 0)), buy: median(before.map((b) => b.buy ?? 0)) }
      // Points a bar usually moves a lot of delta.
      const perDelta = median(before.map((b) => (Math.abs(b.delta) > 0 ? Math.abs(b.close - b.open) / Math.abs(b.delta) : 0)))
      const zoneRows = Math.max(2, Math.ceil(rows.length / 3))
      const known = (typeof levels === 'function' ? levels(i) : levels) ?? []
      const near = (price) => known.find((l) => Number.isFinite(l?.price) && Math.abs(l.price - price) <= o.nearRows * step + 1e-9)

      for (const bull of [true, false]) {
        const zone = bull ? rows.slice(0, zoneRows) : rows.slice(-zoneRows)
        const lo = zone[0].price, hi = zone.at(-1).price
        const hit = bull ? 'sell' : 'buy'           // the aggression that was absorbed
        const other = bull ? 'buy' : 'sell'
        let effort = 0, against = 0
        for (const l of zone) { effort += l[hit]; against += l[other] }
        const own = effort
        // The same prices in the bars just before: the fight at this price so far.
        for (let j = Math.max(0, i - o.zoneBars); j < i; j++) {
          for (const l of list[j].levels ?? []) if (l.price >= lo - 1e-9 && l.price <= hi + 1e-9) { effort += l[hit]; against += l[other] }
        }
        const typ = typical[hit]
        // This bar's own aggression there must be real (half a usual bar's whole selling, in the zone alone) and one-sided:
        // ordinary two-way trading at the bottom of a quiet bar, added up over three bars, is not an effort.
        if (!(typ > 0) || own < 0.5 * typ || effort < 1.5 * against) continue
        const closedOff = bull ? (bar.close - bar.low) / range : (bar.high - bar.close) / range
        const clear = bull ? bar.close > hi + step - 1e-9 : bar.close < lo + 1e-9   // closed beyond the zone
        if (!clear || closedOff < 0.3) continue
        const parts = { effort: clamp01(effort / (1.5 * typ)), result: clamp01(closedOff), efficiency: null, context: null, book: null }
        // The delta that did not move price: the aggressor ahead on the bar, yet it closed the other way - or moved little.
        const pushed = bull ? -bar.delta : bar.delta      // + = the absorbed side was ahead on the bar
        const went = bull ? bar.open - bar.close : bar.close - bar.open   // + = price went the aggressor's way
        if (pushed > 0) parts.efficiency = went <= 0 ? 1 : perDelta > 0 ? clamp01(1 - (went / pushed) / perDelta) : 0
        else parts.efficiency = 0
        const level = near(bull ? bar.low : bar.high)
        const fresh = bull ? newLow : newHigh
        const prev = list[i - 1]
        const pastPrev = prev && (bull ? bar.low < prev.low : bar.high > prev.high)
        // Back at the last bars' extreme without passing it: a retest of the same price - the fight going on.
        const retest = !fresh && (bull ? priorLow != null && bar.low <= priorLow + 1e-9 : priorHigh != null && bar.high >= priorHigh - 1e-9)
        parts.context = Math.min(1, (fresh ? 0.7 : retest ? 0.5 : pastPrev ? 0.35 : 0) + (level ? 0.5 : 0))
        const start = msOf(bar.time)
        const shown = bookAt(columns, start, start + spanMs, lo, hi, bull ? 'bids' : 'asks', step)
        if (shown && shown.most > 0) parts.book = 0.5 * clamp01(own / shown.most) + 0.5 * clamp01(shown.last / shown.most)
        const score = scoreOf(parts, ABSORPTION_WEIGHTS)
        if (parts.effort < 0.5 || score < o.minScore) continue
        const where = lo === hi ? `${lo}` : `${lo}–${round2(hi + step)}`
        const why = [
          `${Math.round((effort / typ) * 10) / 10}x a usual bar's ${bull ? 'selling' : 'buying'} at ${where}${effort > own ? ' over the last bars' : ''}`,
          `closed ${Math.round(closedOff * 100)}% off the ${bull ? 'low' : 'high'}`,
          parts.efficiency >= 0.7 ? `${bull ? 'sellers' : 'buyers'} ahead but price did not follow` : null,
          fresh ? `a new ${o.lookback}-bar ${bull ? 'low' : 'high'}` : retest ? `a retest of the ${o.lookback}-bar ${bull ? 'low' : 'high'}` : null,
          level ? `at ${level.label ?? level.price}` : null,
          parts.book != null && parts.book >= 0.7 ? `the ${bull ? 'bids' : 'offers'} there held / refilled` : null,
        ].filter(Boolean).join(' · ')
        out[i].absorption.push({
          side: bull ? 'buy' : 'sell', price: bull ? rows[0].price : rows.at(-1).price, low: lo, high: hi, volume: effort, score, parts,
          text: `${bull ? 'Selling absorbed' : 'Buying absorbed'} (score ${score}): ${why}`,
        })
      }

      for (const bear of [true, false]) {
        if (bear ? !newHigh : !newLow) continue
        const closedOff = bear ? (bar.high - bar.close) / range : (bar.close - bar.low) / range
        if (closedOff < 0.25) continue
        const push = bear ? lastPush.high : lastPush.low
        const typVolume = median(before.map((b) => b.volume))
        const typDelta = median(before.map((b) => Math.abs(b.delta)))
        const way = bear ? bar.delta : -bar.delta          // + = the delta that made the push
        const pushWay = push ? (bear ? push.delta : -push.delta) : null
        const parts = { volume: null, delta: null, thin: null, value: null, rejection: clamp01(closedOff / 0.6) }
        const againstVolume = push ? push.volume : typVolume
        parts.volume = againstVolume > 0 ? clamp01(1 - bar.volume / againstVolume) : null
        const againstDelta = push && pushWay > 0 ? pushWay : typDelta
        let delta = way <= 0 ? 1 : againstDelta > 0 ? clamp01(1 - way / againstDelta) : null
        // A higher high on a lower cumulative delta (the mirror at a low): the divergence itself.
        if (delta != null && push && Number.isFinite(bar.cvd) && Number.isFinite(push.cvd) && (bear ? bar.cvd < push.cvd : bar.cvd > push.cvd)) delta = Math.min(1, delta + 0.3)
        parts.delta = delta
        const end = bear ? rows.slice(-2) : rows.slice(0, 2)
        const endVolume = end.reduce((s, l) => s + l.buy + l.sell, 0)
        parts.thin = clamp01(1 - (endVolume / bar.volume) / (2 / rows.length))
        if (Number.isFinite(bar.poc)) {
          const lowerHalf = bear ? bar.poc < bar.low + range / 2 : bar.poc > bar.low + range / 2
          const stalled = push && Number.isFinite(push.poc) ? (bear ? bar.poc <= push.poc : bar.poc >= push.poc) : false
          parts.value = stalled ? 1 : lowerHalf ? 0.6 : 0
        }
        const score = scoreOf(parts, EXHAUSTION_WEIGHTS)
        if (score < o.minScore) continue
        const why = [
          `a new ${o.lookback}-bar ${bear ? 'high' : 'low'}`,
          parts.volume >= 0.3 ? `${Math.round(parts.volume * 100)}% less volume than ${push ? 'the last push' : 'usual'}` : null,
          way <= 0 ? `no ${bear ? 'buying' : 'selling'} delta behind it` : parts.delta >= 0.3 ? `less ${bear ? 'buying' : 'selling'} delta than ${push ? 'the last push' : 'usual'}` : null,
          parts.thin >= 0.5 ? `little traded at the ${bear ? 'top' : 'bottom'}` : null,
          parts.value >= 0.6 ? 'the busiest price did not follow' : null,
          `closed ${Math.round(closedOff * 100)}% off it`,
        ].filter(Boolean).join(' · ')
        out[i].exhaustion.push({
          side: bear ? 'sell' : 'buy', price: bear ? rows.at(-1).price : rows[0].price, score, parts,
          text: `${bear ? 'Buying exhausted' : 'Selling exhausted'} (score ${score}): ${why}`,
        })
      }
    }
    // This bar is the push the next new extreme is compared with.
    if (newHigh) lastPush = { ...lastPush, high: bar }
    if (newLow) lastPush = { ...lastPush, low: bar }
  }
  return out
}

/** `bars` with their absorption / exhaustion replaced by the scored reads (`reads` - scoredFlowReads of the same bars). */
export function withScoredReads(bars, reads) {
  return (bars ?? []).map((bar, i) => ({ ...bar, absorption: reads?.[i]?.absorption ?? [], exhaustion: reads?.[i]?.exhaustion ?? [] }))
}
