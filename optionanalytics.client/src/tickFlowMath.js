// TICK FLOW - the maths of the Tick Flow page (TrueData's tick feed). Pure and self-contained: nothing here is shared with the Order
// Flow page. A bar is { time, open, high, low, close, buy, sell, prints, levels: [{ price, buy, sell }] } (levels high to low,
// quantities in units); a bubble is { time, price, qty, buy, prints }.

export const MIN = 60_000
export const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

/** Quantity as lots (one decimal under 10 lots) or as units. */
export function fmtQty(units, lotSize, showLots) {
  const v = showLots && lotSize > 0 ? units / lotSize : units
  const abs = Math.abs(v)
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`
  if (showLots && abs < 10 && v !== Math.round(v)) return v.toFixed(1)
  return String(Math.round(v))
}

/** The minute bars as `minutes`-minute bars, the levels added up price by price. */
export function aggregateTickBars(bars, minutes) {
  const size = Math.max(1, Math.round(minutes)) * MIN
  const out = []
  let cur = null
  let levels = null
  for (const b of bars ?? []) {
    const ms = msOf(b.time)
    if (!Number.isFinite(ms)) continue
    const start = Math.floor(ms / size) * size
    if (!cur || cur.time !== start) {
      if (cur) cur.levels = [...levels.values()].sort((x, y) => y.price - x.price)
      cur = { time: start, open: b.open, high: b.high, low: b.low, close: b.close, buy: 0, sell: 0, prints: 0, levels: [] }
      levels = new Map()
      out.push(cur)
    }
    cur.high = Math.max(cur.high, b.high)
    cur.low = Math.min(cur.low, b.low)
    cur.close = b.close
    cur.buy += b.buy
    cur.sell += b.sell
    cur.prints += b.prints ?? 0
    for (const l of b.levels ?? []) {
      const hit = levels.get(l.price)
      if (hit) { hit.buy += l.buy; hit.sell += l.sell } else levels.set(l.price, { price: l.price, buy: l.buy, sell: l.sell })
    }
  }
  if (cur) cur.levels = [...levels.values()].sort((x, y) => y.price - x.price)
  return out
}

/** A bar's delta, total and POC (the row with the most volume, the higher on a tie). */
export function barStats(bar) {
  let poc = null
  let best = -1
  for (const l of bar.levels ?? []) {
    const t = l.buy + l.sell
    if (t > best) { best = t; poc = l.price }
  }
  return { delta: bar.buy - bar.sell, total: bar.buy + bar.sell, poc }
}

/** Running delta, one value per bar from the first. */
export function cumulativeDelta(bars) {
  let sum = 0
  return (bars ?? []).map((b) => (sum += b.buy - b.sell))
}

/**
 * DIAGONAL IMBALANCES, as footprint platforms mark them: the buyers at a row against the sellers one row BELOW it (buyers lifted
 * the offer there while few sold under it), the sellers at a row against the buyers one row ABOVE. `ratio` (3 = 300%) and at
 * least `minQty` units on the winning side. Returns Sets of the rows' prices: { buy, sell }.
 */
export function diagonalImbalances(levels, ratio = 3, minQty = 1) {
  const buy = new Set()
  const sell = new Set()
  const rows = levels ?? []
  for (let i = 0; i < rows.length; i++) {
    const below = rows[i + 1]
    const above = rows[i - 1]
    if (below && rows[i].buy >= minQty && rows[i].buy >= ratio * Math.max(below.sell, 0) && rows[i].buy > below.sell) buy.add(rows[i].price)
    if (above && rows[i].sell >= minQty && rows[i].sell >= ratio * Math.max(above.buy, 0) && rows[i].sell > above.buy) sell.add(rows[i].price)
  }
  return { buy, sell }
}

/** The quantity that is the biggest bubble: the 99th percentile of the quantities in view (one giant print must not shrink every
 *  other bubble to a dot). At least 1. */
export function bubbleScaleMax(bubbles) {
  const q = (bubbles ?? []).map((b) => b.qty).filter((v) => v > 0).sort((a, b) => a - b)
  if (q.length === 0) return 1
  return Math.max(1, q[Math.min(q.length - 1, Math.floor(q.length * 0.99))])
}

/** A bubble's radius in px: the AREA follows the quantity (radius ~ sqrt), `rMin` for the smallest, `rMax` from the scale's max up. */
export function bubbleRadius(qty, maxQty, rMin = 3, rMax = 34) {
  if (!(qty > 0) || !(maxQty > 0)) return rMin
  return rMin + (rMax - rMin) * Math.min(1, Math.sqrt(qty / maxQty))
}

/** Bubbles whose time is inside [from, to]. */
export function bubblesIn(bubbles, from, to) {
  return (bubbles ?? []).filter((b) => { const t = msOf(b.time); return t >= from && t <= to })
}

/** Round axis ticks across [lo, hi], about `count` of them. */
export function axisTicks(lo, hi, count = 8) {
  const span = hi - lo
  if (!(span > 0)) return [lo]
  const raw = span / Math.max(1, count)
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step)
  return out
}

// ---- Replay ------------------------------------------------------------------------------------------------------------------

const rowOf = (price, row) => Math.round(Math.floor(price / row + 1e-9) * row * 1e4) / 1e4

/** A day as the page holds it for replay: every time also as milliseconds (`ms`), so cutting it at a clock is a binary search. */
export function prepareTickDay(day) {
  if (!day) return null
  return {
    ...day,
    bars: (day.bars ?? []).map((b) => ({ ...b, ms: msOf(b.time) })),
    bubbles: (day.bubbles ?? []).map((b) => ({ ...b, ms: msOf(b.time) })),
    quotes: (day.quotes ?? []).map((q) => ({ ...q, ms: msOf(q.time) })),
  }
}

/** The count of items (sorted by `ms`) at or before `ms`. */
export function countUpTo(list, ms) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].ms <= ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A minute's bar built from the bubbles that traded in it (a bubble merges prints of one price and side, so the totals are exact). */
export function barFromBubbles(bubbles, minuteMs, rowSize) {
  const inMinute = (bubbles ?? []).filter((b) => b.ms >= minuteMs && b.ms < minuteMs + MIN)
  if (inMinute.length === 0) return null
  const levels = new Map()
  let buy = 0
  let sell = 0
  let prints = 0
  let high = -Infinity
  let low = Infinity
  for (const b of inMinute) {
    const price = rowOf(b.price, rowSize)
    const l = levels.get(price) ?? { price, buy: 0, sell: 0 }
    if (b.buy) { l.buy += b.qty; buy += b.qty } else { l.sell += b.qty; sell += b.qty }
    levels.set(price, l)
    prints += b.prints ?? 1
    high = Math.max(high, b.price)
    low = Math.min(low, b.price)
  }
  return {
    time: minuteMs, ms: minuteMs, open: inMinute[0].price, high, low, close: inMinute.at(-1).price, buy, sell, prints,
    levels: [...levels.values()].sort((a, b) => b.price - a.price),
  }
}

/**
 * The prepared day (prepareTickDay) as it stood at `clockMs`: the minute bars that had finished, the minute running built from the
 * bubbles up to the clock, the bubbles and the best bid / ask up to it. Nothing after the clock - a cut at any clock is the whole
 * day's up to it.
 */
export function replayCut(day, clockMs, rowSize) {
  if (!day || clockMs == null) return null
  const done = day.bars.slice(0, countUpTo(day.bars, clockMs - MIN)) // minutes that had finished: start + 1 min <= the clock
  const bubbleCount = countUpTo(day.bubbles, clockMs)
  const bubbles = day.bubbles.slice(0, bubbleCount)
  const minute = Math.floor(clockMs / MIN) * MIN
  const forming = barFromBubbles(bubbles.slice(countUpTo(bubbles, minute - 1)), minute, rowSize)
  const bars = forming ? [...done.filter((b) => b.ms < minute), forming] : done
  const quotes = day.quotes.slice(0, countUpTo(day.quotes, clockMs))
  const q = quotes.at(-1)
  return { bars, bubbles, quotes, lastPrice: bubbles.at(-1)?.price ?? 0, bid: q?.bid ?? 0, bidQty: q?.bidQty ?? 0, ask: q?.ask ?? 0, askQty: q?.askQty ?? 0 }
}

/** The last `count` weekdays up to `today` (a yyyy-MM-dd), newest first - the days a replay can be asked for (holidays just come back empty). */
export function weekdayChoices(today, count = 6) {
  const out = []
  const d = new Date(`${today}T00:00:00Z`)
  while (out.length < count) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return out
}

/** Exchange volume the feed delivered, as a percentage (null when the exchange's own total is not known). */
export function coveragePct(booked, exchange) {
  return exchange > 0 ? Math.min(100, (booked / exchange) * 100) : null
}
