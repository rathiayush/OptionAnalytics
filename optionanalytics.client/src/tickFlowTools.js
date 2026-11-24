// TICK FLOW TOOLS (asked for - "volume profile, VWAP, auction, COT, absorption, exhaustion, imbalances, iceberg on the tick page"): the footprint platforms'
// reads worked out from the Tick Flow page's OWN data - TrueData's footprint bars ({ time, open, high, low, close, buy, sell, levels: [{ price, buy, sell }] },
// levels high to low), its order bubbles ({ time, price, qty, buy, prints }) and its best bid / ask trail ({ time, bid, bidQty, ask, askQty }). Pure and
// self-contained: nothing here is shared with the Order Flow page (a separate implementation on purpose - TrueData and Dhan data are never mixed).
// Each read of a bar uses only that bar and the ones before it (and, for the status of a mark, the bars after - a mark's status is the one known at the clock),
// so a day cut at any clock gives the same reads as the whole day up to it. TrueData's NSE feed is LEVEL 1 only (the best bid / ask): the reads that
// platforms make from a deep book are not here, and an iceberg is read from the refills of the best quote.
import { MIN, diagonalImbalances, msOf } from './tickFlowMath.js'

const sum = (list, f) => list.reduce((a, x) => a + f(x), 0)
const median = (list) => {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const rowsOf = (bar) => bar.levels ?? []

// ---- VWAP -------------------------------------------------------------------------------------------------------------------

/** The session's VWAP at the end of every bar: the price x quantity of every row up to it over the quantity (a row's price is its middle with `rowSize`).
 *  null before anything traded. */
export function barVwaps(bars, rowSize = 0) {
  let pv = 0
  let v = 0
  return (bars ?? []).map((b) => {
    for (const l of rowsOf(b)) { const q = l.buy + l.sell; pv += (l.price + rowSize / 2) * q; v += q }
    return v > 0 ? pv / v : null
  })
}

// ---- Volume profile ---------------------------------------------------------------------------------------------------------

/** The volume profile of the bars: every price row's buy / sell / total, the POC (the busiest row, the higher on a tie) and the VALUE AREA (`share`, 70%, of
 *  the volume around the POC - the busier neighbouring row added until it holds the share): { rows (high to low), poc, vah, val, total }. */
export function volumeProfile(bars, share = 0.7) {
  const map = new Map()
  for (const b of bars ?? []) for (const l of rowsOf(b)) {
    const r = map.get(l.price) ?? { price: l.price, buy: 0, sell: 0, total: 0 }
    r.buy += l.buy; r.sell += l.sell; r.total += l.buy + l.sell
    map.set(l.price, r)
  }
  const rows = [...map.values()].sort((a, b) => b.price - a.price)
  if (!rows.length) return { rows, poc: null, vah: null, val: null, total: 0 }
  let pocIdx = 0
  rows.forEach((r, i) => { if (r.total > rows[pocIdx].total) pocIdx = i })
  const total = sum(rows, (r) => r.total)
  let hi = pocIdx
  let lo = pocIdx
  let have = rows[pocIdx].total
  while (have < share * total && (hi > 0 || lo < rows.length - 1)) {
    const up = hi > 0 ? rows[hi - 1].total : -1
    const down = lo < rows.length - 1 ? rows[lo + 1].total : -1
    if (up >= down) { hi--; have += up } else { lo++; have += down }
  }
  return { rows, poc: rows[pocIdx].price, vah: rows[hi].price, val: rows[lo].price, total }
}

// ---- Auctions ---------------------------------------------------------------------------------------------------------------

/** A bar's AUCTIONS at its extremes, read on its rows: at the HIGH, no selling at the top row = FINISHED (the buyers ran out), both sides trading there =
 *  UNFINISHED (business left there); the LOW the mirror (no buying at the bottom row = finished). { high, low }: 'finished' | 'unfinished' | null. */
export function auctionOf(bar) {
  const rows = rowsOf(bar)
  if (!rows.length) return { high: null, low: null }
  const top = rows[0]
  const bottom = rows[rows.length - 1]
  const high = top.buy > 0 && top.sell === 0 ? 'finished' : top.buy > 0 && top.sell > 0 ? 'unfinished' : null
  const low = bottom.sell > 0 && bottom.buy === 0 ? 'finished' : bottom.buy > 0 && bottom.sell > 0 ? 'unfinished' : null
  return { high, low }
}

/** Every UNFINISHED auction with where it ended: the first later bar that traded in that row (`until`, an index into `bars`) or null while still open. */
export function unfinishedAuctions(bars) {
  const out = []
  ;(bars ?? []).forEach((b, i) => {
    const a = auctionOf(b)
    for (const side of ['high', 'low']) {
      if (a[side] !== 'unfinished') continue
      const price = side === 'high' ? rowsOf(b)[0].price : rowsOf(b).at(-1).price
      let until = null
      for (let j = i + 1; j < bars.length; j++) if (rowsOf(bars[j]).some((l) => l.price === price && l.buy + l.sell > 0)) { until = j; break }
      out.push({ index: i, side, price, until })
    }
  })
  return out
}

// ---- Stacked imbalances ----------------------------------------------------------------------------------------------------

/** STACKED IMBALANCES: `minRun` (3) or more ADJACENT rows (one row size apart) in the same diagonal imbalance (diagonalImbalances) - { buy, sell }, each a list of
 *  { from (the top row's price), to (the bottom row's), rows }. */
export function stackedImbalances(levels, rowSize, ratio = 3, minRun = 3) {
  const imb = diagonalImbalances(levels, ratio, 1)
  const out = { buy: [], sell: [] }
  for (const side of ['buy', 'sell']) {
    const prices = (levels ?? []).map((l) => l.price).filter((p) => imb[side].has(p)).sort((a, b) => b - a)
    let run = []
    const flush = () => { if (run.length >= minRun) out[side].push({ from: run[0], to: run.at(-1), rows: run.length }); run = [] }
    for (const p of prices) {
      if (run.length && Math.abs(run.at(-1) - p - rowSize) > rowSize * 1e-6) flush()
      run.push(p)
    }
    flush()
  }
  return out
}

// ---- COT (commitment of traders, the footprint platforms' high / low delta) -----------------------------------------------

/** COT HIGH / LOW of every bar from the orders that traded in it, in order: COT H = the delta (buy - sell) traded AFTER the bar's last NEW high, COT L = after its
 *  last new low (a trade that makes a new extreme starts the count at 0 and is not counted). `spanMs` = the bar's length. null for a bar with no order. */
export function cotOfBars(bars, bubbles, spanMs = MIN) {
  const list = [...(bubbles ?? [])].map((b) => ({ ms: b.ms ?? msOf(b.time), price: b.price, signed: b.buy ? b.qty : -b.qty })).sort((a, b) => a.ms - b.ms)
  let from = 0
  return (bars ?? []).map((bar) => {
    const start = bar.ms ?? msOf(bar.time)
    while (from < list.length && list[from].ms < start) from++
    let high = -Infinity
    let low = Infinity
    let cH = 0
    let cL = 0
    let any = false
    for (let k = from; k < list.length && list[k].ms < start + spanMs; k++) {
      const o = list[k]
      any = true
      if (o.price > high) { high = o.price; cH = 0 } else cH += o.signed
      if (o.price < low) { low = o.price; cL = 0 } else cL += o.signed
    }
    return any ? { high: cH, low: cL } : null
  })
}

export const COT_SHARE = 0.2

/** The COT READ, as the footprint platforms read it - what the aggressors did AFTER the extreme against where the bar CLOSED, counted only at >= 20% of the bar's
 *  volume. At the HIGH: sellers after it + a close in the lower half = REJECTED (bearish); buyers after it + a close in the lower half = BUYERS TRAPPED (bearish);
 *  buyers after it + a close in the top 30% = STILL PUSHING (bullish). The LOW the mirror. Both ways: the larger for the volume; equal = none.
 *  { side +1 / -1, kind, at: 'high' | 'low', text } or null. */
export function cotRead(bar, cot, share = COT_SHARE) {
  if (!cot) return null
  const range = bar.high - bar.low
  const total = bar.buy + bar.sell
  if (!(range > 0) || !(total > 0)) return null
  const pos = (bar.close - bar.low) / range
  const reads = []
  const h = cot.high
  if (Math.abs(h) >= share * total) {
    if (h < 0 && pos < 0.5) reads.push({ side: -1, kind: 'rejected', at: 'high', size: Math.abs(h), text: 'sellers after the high, closed low - rejected' })
    else if (h > 0 && pos < 0.5) reads.push({ side: -1, kind: 'buyers trapped', at: 'high', size: Math.abs(h), text: 'buyers after the high, closed low - buyers trapped' })
    else if (h > 0 && pos >= 0.7) reads.push({ side: 1, kind: 'still pushing', at: 'high', size: Math.abs(h), text: 'buyers after the high, closed near it - still pushing' })
  }
  const l = cot.low
  if (Math.abs(l) >= share * total) {
    if (l > 0 && pos > 0.5) reads.push({ side: 1, kind: 'rejected', at: 'low', size: Math.abs(l), text: 'buyers after the low, closed high - rejected' })
    else if (l < 0 && pos > 0.5) reads.push({ side: 1, kind: 'sellers trapped', at: 'low', size: Math.abs(l), text: 'sellers after the low, closed high - sellers trapped' })
    else if (l < 0 && pos <= 0.3) reads.push({ side: -1, kind: 'still pushing', at: 'low', size: Math.abs(l), text: 'sellers after the low, closed near it - still pushing' })
  }
  if (!reads.length) return null
  reads.sort((a, b) => b.size - a.size)
  if (reads.length > 1 && reads[0].size === reads[1].size) return null
  return reads[0]
}

// ---- Absorption / exhaustion ------------------------------------------------------------------------------------------------

/** What a USUAL bar looks like at bar `i`: the median of the bars BEFORE it (volume, selling, buying, range) - no fixed count, the day so far. */
function usualBefore(bars, i) {
  const prev = bars.slice(0, i)
  return {
    vol: median(prev.map((b) => b.buy + b.sell)),
    sell: median(prev.map((b) => b.sell)),
    buy: median(prev.map((b) => b.buy)),
    range: median(prev.map((b) => b.high - b.low)),
  }
}

/**
 * SCORED ABSORPTION / EXHAUSTION on the footprint (the Tick Flow page's own, on Level 1 data - no book part, so the weights are those of the parts that exist):
 *  - ABSORPTION = an effort that failed at a price: at the low, SELLING in the bar's bottom third (at least two rows) of >= 1.5x a usual bar's selling and of
 *    >= 1.5x the buying there, yet the bar CLOSED >= 30% off the low (bullish; the high the mirror - bearish). Score 0 - 100 from the effort, the result, the
 *    efficiency (sellers ahead yet it closed up) and the context (a new low of the session).
 *  - EXHAUSTION = participation fading at a new high of the session (bearish; the low the mirror): closed >= 25% off it, with less volume and less delta than the
 *    last push, little in the top two rows and a close away from the high.
 * A mark's STATUS is the one known at the clock: 'confirmed' once a later bar CLOSES past the signal bar's other end, 'failed' once a later bar trades past the
 * zone's far edge (checked first). Returns [{ index, time, kind: 'ABS' | 'EXH', side +1 / -1, score, status, text }] of the marks at `minScore` or more.
 */
export function absorptionExhaustion(bars, { minScore = 50 } = {}) {
  const list = bars ?? []
  const out = []
  let sessionHigh = -Infinity
  let sessionLow = Infinity
  let pushVol = null
  let pushDelta = null
  let lowPushVol = null
  let lowPushDelta = null
  list.forEach((b, i) => {
    const rows = rowsOf(b)
    const range = b.high - b.low
    const vol = b.buy + b.sell
    const u = usualBefore(list, i)
    const newHigh = b.high > sessionHigh
    const newLow = b.low < sessionLow
    if (i >= 3 && range > 0 && vol > 0 && rows.length >= 2) {
      const pos = (b.close - b.low) / range
      const bottom = rows.filter((l) => l.price <= b.low + range / 3)
      const top = rows.filter((l) => l.price >= b.high - range / 3)
      const delta = b.buy - b.sell
      // ABSORPTION at the low (bullish): sellers' effort that failed.
      const sellB = sum(bottom, (l) => l.sell)
      const buyB = sum(bottom, (l) => l.buy)
      if (bottom.length >= 2 && u.sell > 0 && sellB >= 1.5 * u.sell && sellB >= 1.5 * buyB && pos >= 0.3) {
        const effort = Math.min(1, sellB / (3 * u.sell))
        const result = Math.min(1, (pos - 0.3) / 0.4)
        const efficiency = b.sell > b.buy && b.close > b.open ? 1 : Math.abs(b.close - b.open) < 0.5 * Math.max(u.range, 1e-9) ? 0.6 : 0.2
        const context = newLow ? 0.8 : b.low <= sessionLow + 0.25 * Math.max(u.range, 1e-9) ? 0.5 : 0.2
        const score = Math.round(100 * (0.35 * effort + 0.25 * result + 0.25 * efficiency + 0.15 * context))
        if (score >= minScore) out.push({ index: i, time: b.time, kind: 'ABS', side: 1, score, text: `sellers' effort failed at the low (${Math.round(sellB / Math.max(u.sell, 1e-9) * 10) / 10}x a usual bar's selling), closed ${Math.round(pos * 100)}% up the bar` })
      }
      // ABSORPTION at the high (bearish): buyers' effort that failed.
      const buyT = sum(top, (l) => l.buy)
      const sellT = sum(top, (l) => l.sell)
      if (top.length >= 2 && u.buy > 0 && buyT >= 1.5 * u.buy && buyT >= 1.5 * sellT && pos <= 0.7) {
        const effort = Math.min(1, buyT / (3 * u.buy))
        const result = Math.min(1, (0.7 - pos) / 0.4)
        const efficiency = b.buy > b.sell && b.close < b.open ? 1 : Math.abs(b.close - b.open) < 0.5 * Math.max(u.range, 1e-9) ? 0.6 : 0.2
        const context = newHigh ? 0.8 : b.high >= sessionHigh - 0.25 * Math.max(u.range, 1e-9) ? 0.5 : 0.2
        const score = Math.round(100 * (0.35 * effort + 0.25 * result + 0.25 * efficiency + 0.15 * context))
        if (score >= minScore) out.push({ index: i, time: b.time, kind: 'ABS', side: -1, score, text: `buyers' effort failed at the high (${Math.round(buyT / Math.max(u.buy, 1e-9) * 10) / 10}x a usual bar's buying), closed ${Math.round(pos * 100)}% up the bar` })
      }
      // EXHAUSTION at a new high (bearish).
      if (newHigh && pos <= 0.75) {
        const refVol = pushVol ?? u.vol
        const refDelta = pushDelta ?? Math.max(delta, 0)
        const lessVol = refVol > 0 ? Math.max(0, Math.min(1, 1 - vol / refVol)) : 0
        const lessDelta = refDelta > 0 ? (delta <= 0 ? 1 : Math.max(0, Math.min(1, 1 - delta / refDelta))) : 0
        const topTwo = rows.slice(0, 2)
        const topShare = sum(topTwo, (l) => l.buy + l.sell) / vol
        const little = topShare < 0.1 ? 1 : topShare < 0.3 ? 0.6 : 0
        const finished = auctionOf(b).high === 'finished' ? 1 : 0.4
        const score = Math.round(100 * (0.3 * lessVol + 0.3 * lessDelta + 0.2 * little + 0.2 * Math.min(1, (0.75 - pos) / 0.5)) * (0.6 + 0.4 * finished))
        if (pos <= 0.75 && score >= minScore) out.push({ index: i, time: b.time, kind: 'EXH', side: -1, score, text: `a new high on ${Math.round(lessVol * 100)}% less volume and ${Math.round(lessDelta * 100)}% less delta than the last push, closed ${Math.round(pos * 100)}% up the bar` })
      }
      // EXHAUSTION at a new low (bullish).
      if (newLow && pos >= 0.25) {
        const refVol = lowPushVol ?? u.vol
        const refDelta = lowPushDelta ?? Math.max(-delta, 0)
        const lessVol = refVol > 0 ? Math.max(0, Math.min(1, 1 - vol / refVol)) : 0
        const lessDelta = refDelta > 0 ? (-delta <= 0 ? 1 : Math.max(0, Math.min(1, 1 - -delta / refDelta))) : 0
        const bottomTwo = rows.slice(-2)
        const bottomShare = sum(bottomTwo, (l) => l.buy + l.sell) / vol
        const little = bottomShare < 0.1 ? 1 : bottomShare < 0.3 ? 0.6 : 0
        const finished = auctionOf(b).low === 'finished' ? 1 : 0.4
        const score = Math.round(100 * (0.3 * lessVol + 0.3 * lessDelta + 0.2 * little + 0.2 * Math.min(1, (pos - 0.25) / 0.5)) * (0.6 + 0.4 * finished))
        if (score >= minScore) out.push({ index: i, time: b.time, kind: 'EXH', side: 1, score, text: `a new low on ${Math.round(lessVol * 100)}% less volume and ${Math.round(lessDelta * 100)}% less selling than the last push, closed ${Math.round(pos * 100)}% up the bar` })
      }
    }
    if (newHigh) { sessionHigh = b.high; pushVol = vol; pushDelta = b.buy - b.sell }
    if (newLow) { sessionLow = b.low; lowPushVol = vol; lowPushDelta = b.sell - b.buy }
  })
  // The status of each mark: the first later bar that closes past its other end (confirmed) or trades past its far edge (failed - checked first).
  for (const m of out) {
    const b = list[m.index]
    m.status = 'pending'
    for (let j = m.index + 1; j < list.length; j++) {
      const f = list[j]
      if (m.side > 0 ? f.low < b.low : f.high > b.high) { m.status = 'failed'; break }
      if (m.side > 0 ? f.close > b.high : f.close < b.low) { m.status = 'confirmed'; break }
    }
  }
  return out
}

// ---- Icebergs ---------------------------------------------------------------------------------------------------------------

/**
 * ICEBERG ORDERS, read on Level 1: a big order hidden behind a small quote shows as the SAME price traded again and again on one side while the best quote there keeps
 * coming back. At one price and side, orders (bubbles) at most `gapMs` apart form a run; a run is an iceberg when it traded >= `minLots` lots, at least `ratio` times
 * the biggest size the quote ever showed there, with >= `minPrints` orders and >= `minRefills` REFILLS (the quote's size rising again after being taken).
 * A buy trades at the ask, a sell at the bid. Returns [{ time (the run's end, ms), from, price, buy, qty, lots, shown, refills, prints }], oldest first.
 */
export function icebergs(bubbles, quotes, { lotSize = 1, minLots = 20, ratio = 4, minPrints = 3, minRefills = 2, gapMs = 20_000 } = {}) {
  const q = (quotes ?? []).map((x) => ({ ms: x.ms ?? msOf(x.time), bid: x.bid, bidQty: x.bidQty, ask: x.ask, askQty: x.askQty })).sort((a, b) => a.ms - b.ms)
  const at = (ms) => { let lo = 0; let hi = q.length; while (lo < hi) { const m = (lo + hi) >> 1; if (q[m].ms < ms) lo = m + 1; else hi = m } return lo }
  const groups = new Map()
  for (const b of bubbles ?? []) {
    const key = `${b.price}|${b.buy ? 1 : 0}`
    ;(groups.get(key) ?? groups.set(key, []).get(key)).push({ ms: b.ms ?? msOf(b.time), price: b.price, buy: !!b.buy, qty: b.qty, prints: b.prints ?? 1 })
  }
  const out = []
  for (const list of groups.values()) {
    list.sort((a, b) => a.ms - b.ms)
    let run = []
    const flush = () => {
      if (run.length >= minPrints) {
        const first = run[0]
        const last = run.at(-1)
        const qty = sum(run, (r) => r.qty)
        const lots = qty / Math.max(1, lotSize)
        // The sizes the quote showed at this price on this side while the run lasted, and how often it came back.
        let shown = 0
        let refills = 0
        let prev = null
        for (let k = at(first.ms - 2000); k < q.length && q[k].ms <= last.ms + 2000; k++) {
          const sameSide = first.buy ? q[k].ask === first.price : q[k].bid === first.price
          if (!sameSide) continue
          const size = first.buy ? q[k].askQty : q[k].bidQty
          shown = Math.max(shown, size)
          if (prev != null && size > prev) refills++
          prev = size
        }
        if (lots >= minLots && refills >= minRefills && qty >= ratio * Math.max(shown, 1)) out.push({ time: last.ms, from: first.ms, price: first.price, buy: first.buy, qty, lots, shown, refills, prints: run.length })
      }
      run = []
    }
    for (const o of list) {
      if (run.length && o.ms - run.at(-1).ms > gapMs) flush()
      run.push(o)
    }
    flush()
  }
  return out.sort((a, b) => a.time - b.time)
}
