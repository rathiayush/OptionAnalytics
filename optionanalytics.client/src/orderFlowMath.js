// Order flow analysis for the Order Flow page - pure functions over the server's minute footprints
// (see OrderFlowEngine on the server), so every threshold can change live without a refetch.
//
// A footprint level is { price, buy, sell }: buy = volume that lifted the offer (buyers aggressive,
// traded at the ask), sell = volume that hit the bid (sellers aggressive).

const round2 = (v) => Math.round(v * 100) / 100

// The price row a price falls in - same floor(price / rowSize) * rowSize as the server's
// OrderFlowEngine.Row. rowSize 0 keeps the price itself.
export function rowOf(price, rowSize) {
  return rowSize > 0 ? round2(Math.floor(price / rowSize + 1e-9) * rowSize) : price
}

// A minute bar re-bucketed into rowSize rows - for live minutes, which arrive with native prices.
export function rebucketBar(bar, rowSize) {
  const rows = new Map()
  for (const level of bar.levels ?? []) {
    const row = rowOf(level.price, rowSize)
    const existing = rows.get(row)
    if (existing) { existing.buy += level.buy; existing.sell += level.sell } else rows.set(row, { price: row, buy: level.buy, sell: level.sell })
  }
  return { ...bar, levels: [...rows.values()].sort((a, b) => b.price - a.price) }
}

// Minute bars merged into timeframeMinutes bars (bucketed on the clock: a 5-minute bar is 09:15-09:20).
export function aggregateBars(minuteBars, timeframeMinutes) {
  const bucketMs = Math.max(1, timeframeMinutes) * 60_000
  const out = []
  let current = null
  let rows = null
  for (const bar of minuteBars) {
    const ms = typeof bar.time === 'number' ? bar.time : new Date(bar.time).getTime()
    const start = Math.floor(ms / bucketMs) * bucketMs
    if (!current || current.time !== start) {
      if (current) out.push(finish(current, rows))
      current = { time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close, buy: 0, sell: 0, trades: 0 }
      rows = new Map()
    }
    current.high = Math.max(current.high, bar.high)
    current.low = Math.min(current.low, bar.low)
    current.close = bar.close
    current.buy += bar.buy
    current.sell += bar.sell
    current.trades += bar.trades ?? 0
    for (const level of bar.levels ?? []) {
      const existing = rows.get(level.price)
      if (existing) { existing.buy += level.buy; existing.sell += level.sell } else rows.set(level.price, { price: level.price, buy: level.buy, sell: level.sell })
    }
  }
  if (current) out.push(finish(current, rows))
  return out

  function finish(bar, map) {
    return { ...bar, delta: bar.buy - bar.sell, volume: bar.buy + bar.sell, levels: [...map.values()].sort((a, b) => b.price - a.price) }
  }
}

export const DEFAULT_ANALYSIS = {
  imbalanceRatio: 3, // 300%
  stackedCount: 3,
  absorptionFactor: 2.5,
  exhaustionPct: 0.03,
  // An imbalanced row's aggressor volume must also be at least this share of the bar's average row:
  // 3 lots against nothing in a thin row is not a real imbalance.
  imbalanceMinShare: 0.5,
}

// Per bar: POC, diagonal imbalances, stacked imbalance zones, absorption, exhaustion, and the
// running cumulative delta.
//
// - Imbalance (diagonal, as footprint tools compare it): a BUY imbalance at price p when the buying
//   at p is at least `imbalanceRatio` x the selling one row BELOW (p - row) - buyers lifted offers
//   far harder than sellers hit the bid beneath; a SELL imbalance at p when the selling at p is at
//   least that ratio x the buying one row ABOVE. Both need at least `minVolume` AND
//   `imbalanceMinShare` (half) of the bar's average row volume - a thin row's few lots against nothing
//   is noise, not an imbalance - and the row compared against must exist in the bar.
// - Stacked imbalance: `stackedCount`+ consecutive rows imbalanced the same way - a buy stack is
//   support (aggressive buyers stepped up level after level), a sell stack resistance.
// - Absorption: heavy aggression into a NEW extreme that failed to move price on. At the low: the
//   bar traded below the previous bar's low, its bottom two rows took selling of at least
//   `absorptionFactor` x the bar's average row AND a quarter of all the bar's selling, more selling
//   than buying there, and it closed at least 30% of its range off the low (passive buyers absorbed
//   it - bullish). The mirror at the high (bearish).
// - Exhaustion: the aggressive side running OUT at a new extreme. At the high: the bar pushed above
//   the previous bar's high, buying at the top row is tiny - at most a quarter of the average buying
//   on the three rows under it and under `exhaustionPct` of the bar - and the bar closed at least 25%
//   of its range off the high (buyers gave up - bearish). The mirror at the low (bullish).
//   (A bar spanning many thin rows has a small top / bottom row almost every time - that alone is not
//   exhaustion, nor is a bar that did not reach past the one before.)
//
// `estimated` bars (a day rebuilt from 1-minute candles - their rows are an even spread, not real
// trades) get no per-row imbalances, and absorption / exhaustion from the candles instead - see
// candleSignals.
export function analyzeBars(bars, { rowSize, minVolume = 1, estimated = false, ...options } = {}) {
  const { imbalanceRatio, stackedCount, absorptionFactor, exhaustionPct, imbalanceMinShare } = { ...DEFAULT_ANALYSIS, ...options }
  const step = rowSize > 0 ? rowSize : null
  let cvd = 0
  if (estimated) {
    const signals = candleSignals(bars, step)
    // No per-bar POC either: the rows are an even spread, so no row really traded the most.
    return bars.map((bar, i) => {
      cvd += bar.delta
      return { ...bar, cvd, poc: null, imbalances: new Map(), stacked: [], ...signals[i] }
    })
  }
  return bars.map((bar, barIndex) => {
    cvd += bar.delta
    const prevBar = barIndex > 0 ? bars[barIndex - 1] : null
    const ascending = [...bar.levels].sort((a, b) => a.price - b.price)
    const byPrice = new Map(ascending.map((l) => [l.price, l]))
    const nextRow = (price, dir) => (step ? round2(price + dir * step) : null)

    let poc = null
    const imbalances = new Map()
    const minAggressor = Math.max(minVolume, ascending.length ? imbalanceMinShare * ((bar.buy + bar.sell) / ascending.length) : 0)
    for (const level of ascending) {
      if (!poc || level.buy + level.sell > poc.buy + poc.sell) poc = level
      const below = byPrice.get(nextRow(level.price, -1))
      const above = byPrice.get(nextRow(level.price, 1))
      // Only against a row that exists: at a bar's extreme there is nothing diagonal to compare with,
      // and flagging every top/bottom row would be noise.
      const buyImb = below != null && level.buy >= minAggressor && level.buy >= imbalanceRatio * below.sell
      const sellImb = above != null && level.sell >= minAggressor && level.sell >= imbalanceRatio * above.buy
      if (buyImb && !sellImb) imbalances.set(level.price, 'buy')
      else if (sellImb && !buyImb) imbalances.set(level.price, 'sell')
    }

    const stacked = []
    for (const side of ['buy', 'sell']) {
      let run = []
      const flush = () => {
        if (run.length >= stackedCount) stacked.push({ side, low: run[0], high: run[run.length - 1], rows: run.length })
        run = []
      }
      for (const level of ascending) {
        const consecutive = run.length === 0 || !step || Math.abs(level.price - run[run.length - 1] - step) < 1e-6
        if (imbalances.get(level.price) === side && consecutive) run.push(level.price)
        else { flush(); if (imbalances.get(level.price) === side) run.push(level.price) }
      }
      flush()
    }

    const absorption = []
    const exhaustion = []
    const rows = ascending.length
    const range = bar.high - bar.low
    // A new extreme: past the previous bar's (the first bar of the list always counts).
    const newHigh = !prevBar || bar.high > prevBar.high
    const newLow = !prevBar || bar.low < prevBar.low
    if (rows >= 3 && bar.volume > 0 && range > 0) {
      const avgRow = bar.volume / rows
      const bottom = ascending.slice(0, 2)
      const top = ascending.slice(-2)
      const sellLow = bottom.reduce((s, l) => s + l.sell, 0)
      const buyLow = bottom.reduce((s, l) => s + l.buy, 0)
      const buyHigh = top.reduce((s, l) => s + l.buy, 0)
      const sellHigh = top.reduce((s, l) => s + l.sell, 0)
      if (newLow && sellLow >= absorptionFactor * avgRow && sellLow >= 0.25 * (bar.sell ?? 0) && sellLow > buyLow && bar.close - bar.low >= 0.3 * range) {
        absorption.push({ side: 'buy', price: ascending[0].price, volume: sellLow })
      }
      if (newHigh && buyHigh >= absorptionFactor * avgRow && buyHigh >= 0.25 * (bar.buy ?? 0) && buyHigh > sellHigh && bar.high - bar.close >= 0.3 * range) {
        absorption.push({ side: 'sell', price: ascending[rows - 1].price, volume: buyHigh })
      }
    }
    if (rows >= 5 && bar.volume >= minVolume * 10 && range > 0) {
      const topRow = ascending[rows - 1]
      const bottomRow = ascending[0]
      const avg = (list, key) => list.reduce((sum, l) => sum + l[key], 0) / Math.max(1, list.length)
      const underTop = avg(ascending.slice(-4, -1), 'buy')
      const overBottom = avg(ascending.slice(1, 4), 'sell')
      if (newHigh && topRow.buy + topRow.sell <= exhaustionPct * bar.volume && topRow.buy <= 0.25 * underTop && underTop > 0 && bar.high - bar.close >= 0.25 * range) {
        exhaustion.push({ side: 'sell', price: topRow.price })
      }
      if (newLow && bottomRow.buy + bottomRow.sell <= exhaustionPct * bar.volume && bottomRow.sell <= 0.25 * overBottom && overBottom > 0 && bar.close - bar.low >= 0.25 * range) {
        exhaustion.push({ side: 'buy', price: bottomRow.price })
      }
    }

    return { ...bar, cvd, poc: poc?.price ?? null, imbalances, stacked, absorption, exhaustion }
  })
}

// Absorption / exhaustion read from candles alone (volume spread analysis), for estimated days:
// - Absorption: a heavy bar (volume >= 2x the median) that barely moved (body <= 35% of its range) -
//   the aggression was soaked up. A longer lower wick = selling absorbed at the low (bullish), a
//   longer upper wick = buying absorbed at the high (bearish).
// - Exhaustion: a new high (or low) of the last 10 bars made on thin volume (<= 0.6x the median) and
//   closing back off it - the push ran out of participants.
export function candleSignals(bars, step) {
  const volumes = bars.map((b) => b.volume).filter((v) => v > 0).sort((a, b) => a - b)
  const median = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 0
  const row = (price) => (step ? rowOf(price, step) : price)
  return bars.map((bar, i) => {
    const absorption = []
    const exhaustion = []
    const range = bar.high - bar.low
    if (median > 0 && range > 0) {
      const body = Math.abs(bar.close - bar.open)
      const lowerWick = Math.min(bar.open, bar.close) - bar.low
      const upperWick = bar.high - Math.max(bar.open, bar.close)
      if (bar.volume >= 2 * median && body <= 0.35 * range) {
        const x = (bar.volume / median).toFixed(1)
        if (lowerWick >= upperWick) absorption.push({ side: 'buy', price: row(bar.low), volume: bar.volume, text: `Selling absorbed at ${bar.low} - ${x}x normal volume but the bar held (est.)` })
        else absorption.push({ side: 'sell', price: row(bar.high), volume: bar.volume, text: `Buying absorbed at ${bar.high} - ${x}x normal volume but the bar was capped (est.)` })
      }
      const prior = bars.slice(Math.max(0, i - 10), i)
      if (prior.length >= 3 && bar.volume <= 0.6 * median) {
        if (bar.high > Math.max(...prior.map((b) => b.high)) && bar.close < bar.high - range / 3) {
          exhaustion.push({ side: 'sell', price: row(bar.high), text: `Buying exhausted at the new high ${bar.high} - thin volume, closed off it (est.)` })
        }
        if (bar.low < Math.min(...prior.map((b) => b.low)) && bar.close > bar.low + range / 3) {
          exhaustion.push({ side: 'buy', price: row(bar.low), text: `Selling exhausted at the new low ${bar.low} - thin volume, closed off it (est.)` })
        }
      }
    }
    return { absorption, exhaustion }
  })
}

// Resting orders much larger than the rest of the book: at least `factor` x the median level size.
export function findWalls(book, factor = 4) {
  const all = [...(book?.bids ?? []), ...(book?.asks ?? [])].map((l) => l.quantity).filter((q) => q > 0).sort((a, b) => a - b)
  if (all.length < 4) return { bids: new Set(), asks: new Set() }
  const median = all[Math.floor(all.length / 2)]
  const pick = (levels) => new Set((levels ?? []).filter((l) => l.quantity >= factor * median).map((l) => l.price))
  return { bids: pick(book.bids), asks: pick(book.asks), median }
}

// The bids' share of the resting quantity in the top `levels` levels of each side (null when there is none) - the
// book's lean near the price (top 20) against its lean through the whole of it (200 levels on Dhan's full depth).
export function bidShare(book, levels = Infinity) {
  const sum = (side) => (side ?? []).slice(0, levels).reduce((s, l) => s + (Array.isArray(l) ? l[1] : l.quantity ?? 0), 0)
  const bids = sum(book?.bids)
  const asks = sum(book?.asks)
  return bids + asks > 0 ? bids / (bids + asks) : null
}

// A book (or heatmap column) as rowSize rows: [[price, quantity], ...].
export function bucketBook(levels, rowSize) {
  const rows = new Map()
  for (const level of levels ?? []) {
    const price = Array.isArray(level) ? level[0] : level.price
    const quantity = Array.isArray(level) ? level[1] : level.quantity
    const row = rowOf(price, rowSize)
    rows.set(row, (rows.get(row) ?? 0) + quantity)
  }
  return [...rows.entries()]
}

// True when a `row`-point row is a whole number of `base`-point rows - re-bucketing `base` rows into it is then
// exact (the same floor rows as bucketing the book into `row` directly).
export function rowsNest(row, base) {
  const n = row / base
  return base > 0 && n >= 1 - 1e-9 && Math.abs(n - Math.round(n)) < 1e-9
}

// The heatmap's own rows (the dropdown on its card) can differ from the footprint's. When they are a whole number of
// footprint rows the page re-buckets the heatmap it already has; otherwise (finer, or 2 vs 5) the server is asked for
// the heatmap in the largest row both are made of (every row size is a whole number of half points) - returned here,
// and `rowSize` when nothing finer is needed.
export function heatmapFetchRow(rowSize, heatRow) {
  if (!(rowSize > 0) || !(heatRow > 0) || rowsNest(heatRow, rowSize)) return rowSize
  const a = Math.round(rowSize * 2)
  const b = Math.round(heatRow * 2)
  if (Math.abs(a - rowSize * 2) > 1e-9 || Math.abs(b - heatRow * 2) > 1e-9) return rowSize
  let x = a
  let y = b
  while (y) [x, y] = [y, x % y]
  return x / 2
}

// Heatmap columns ({ t, bids, asks } of [price, quantity] rows) re-bucketed into `rowSize` rows. Each column is done
// once per row size (kept beside it), so a live push or a replay step only buckets the new columns.
const rebucketed = new WeakMap()
export function rebucketColumns(columns, rowSize) {
  return (columns ?? []).map((column) => {
    let byRow = rebucketed.get(column)
    if (!byRow) { byRow = new Map(); rebucketed.set(column, byRow) }
    let out = byRow.get(rowSize)
    if (!out) {
      out = { t: column.t, bids: bucketBook(column.bids, rowSize), asks: bucketBook(column.asks, rowSize) }
      byRow.set(rowSize, out)
    }
    return out
  })
}

// Merges live minutes (native prices) into the loaded minute bars, replacing by time.
export function mergeLiveMinutes(minuteBars, liveBars, rowSize) {
  if (!liveBars?.length) return minuteBars
  const next = minuteBars.slice()
  for (const live of liveBars) {
    const bar = rebucketBar(live, rowSize)
    const ms = new Date(bar.time).getTime()
    let i = next.length - 1
    while (i >= 0 && new Date(next[i].time).getTime() > ms) i--
    if (i >= 0 && new Date(next[i].time).getTime() === ms) next[i] = bar
    else next.splice(i + 1, 0, bar)
  }
  return next
}

// Session volume profile: the volume traded at each price row over `bars` (footprint bars, whose
// levels are already rows), with the POC (the most traded row) and the value area - the rows around
// the POC holding `valueAreaPct` of the volume, grown one row at a time toward whichever neighbour
// traded more (the usual CBOT method). VAH / VAL are its top and bottom rows.
export function volumeProfile(bars, valueAreaPct = 0.7) {
  const rows = new Map()
  for (const bar of bars ?? []) {
    for (const level of bar.levels ?? []) {
      if (!(level.price > 0)) continue
      const row = rows.get(level.price)
      if (row) { row.buy += level.buy; row.sell += level.sell } else rows.set(level.price, { price: level.price, buy: level.buy, sell: level.sell })
    }
  }
  return finishProfile([...rows.values()], valueAreaPct)
}

// The same from plain candles (no footprint): each candle's volume spread evenly over the rows its
// high-low range covers - an approximation, but all a candle can say about where it traded.
export function volumeProfileFromCandles(candles, rowSize, valueAreaPct = 0.7) {
  const rows = new Map()
  if (!(rowSize > 0)) return finishProfile([], valueAreaPct)
  for (const c of candles ?? []) {
    const volume = c.volume ?? 0
    if (!(volume > 0) || !(c.high >= c.low)) continue
    const top = rowOf(c.high, rowSize)
    const bottom = rowOf(c.low, rowSize)
    const n = Math.round((top - bottom) / rowSize) + 1
    const up = c.close >= c.open
    for (let i = 0; i < n; i++) {
      const price = round2(bottom + i * rowSize)
      const share = volume / n
      const row = rows.get(price) ?? { price, buy: 0, sell: 0 }
      if (up) row.buy += share; else row.sell += share
      rows.set(price, row)
    }
  }
  return finishProfile([...rows.values()], valueAreaPct)
}

function finishProfile(list, valueAreaPct) {
  const rows = list.sort((a, b) => a.price - b.price).map((r) => ({ ...r, total: r.buy + r.sell }))
  const total = rows.reduce((s, r) => s + r.total, 0)
  if (!rows.length || total <= 0) return { rows: [], poc: null, vah: null, val: null, total: 0, maxRow: 0 }
  const counts = rows.map((r) => r.total)
  const pocIndex = pocIndexOf(counts)
  const { lo, hi } = valueAreaOf(counts, pocIndex, valueAreaPct)
  return { rows, poc: rows[pocIndex].price, vah: rows[hi].price, val: rows[lo].price, total, maxRow: rows[pocIndex].total }
}

/** The point of control: the row with the most volume (TPOs); on a tie, the one nearest the middle of
 *  the profile's range (the standard rule). `counts` run from the lowest price row up. */
export function pocIndexOf(counts) {
  const mid = (counts.length - 1) / 2
  let best = 0
  counts.forEach((c, i) => {
    if (c > counts[best] || (c === counts[best] && Math.abs(i - mid) < Math.abs(best - mid))) best = i
  })
  return best
}

/** The value area (CBOT / Steidlmayer): from the POC, compare the volume of the TWO rows above the area
 *  with the TWO rows below it and add the larger pair (one row when only one is left on that side;
 *  above first on a tie), until `pct` (70%) of the total is inside. Returns the row indexes. */
export function valueAreaOf(counts, pocIndex, pct = 0.7) {
  const total = counts.reduce((s, c) => s + c, 0)
  let lo = pocIndex
  let hi = pocIndex
  let inside = counts[pocIndex]
  while (inside < pct * total && (lo > 0 || hi < counts.length - 1)) {
    const upN = Math.min(2, counts.length - 1 - hi)
    const downN = Math.min(2, lo)
    const up = upN > 0 ? counts.slice(hi + 1, hi + 1 + upN).reduce((s, c) => s + c, 0) : -1
    const down = downN > 0 ? counts.slice(lo - downN, lo).reduce((s, c) => s + c, 0) : -1
    if (up >= down) { hi += upN; inside += up } else { lo -= downN; inside += down }
  }
  return { lo, hi }
}

// ---- Replay ---------------------------------------------------------------------------------

const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

// How many items of a time-sorted array are at or before `clockMs`.
function countUpTo(items, clockMs, timeOf) {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (timeOf(items[mid]) <= clockMs) lo = mid + 1; else hi = mid
  }
  return lo
}

// A recorded day as it stood at `clockMs`, in the page's live data shape: minutes that had
// COMPLETED by then (a minute's footprint is only known once it is over), prints, icebergs as they
// were known then (one that ended later is still active), the heatmap so far, and the book from the
// latest heatmap snapshot (bucketed into the page's rows - a recording keeps the book that way).
export function replayView(day, clockMs) {
  if (!day || clockMs == null) return null
  const minuteBars = day.minuteBars.slice(0, countUpTo(day.minuteBars, clockMs - 60_000, (b) => msOf(b.time)))
  const trades = day.trades.slice(0, countUpTo(day.trades, clockMs, (t) => msOf(t.time)))
  const heatmap = day.heatmap.slice(0, countUpTo(day.heatmap, clockMs, (c) => c.t))
  // The heatmap's picture in its own finer rows (withFineHeatmap), when there is one - up to the clock as well.
  const heatFine = day.heatFine?.slice(0, countUpTo(day.heatFine, clockMs, (c) => c.t))
  const sweeps = (day.sweeps ?? []).filter((w) => msOf(w.endedAt) <= clockMs)
  const icebergs = day.icebergs
    .filter((i) => msOf(i.detectedAt) <= clockMs)
    .map((i) => (i.endedAt && msOf(i.endedAt) > clockMs ? { ...i, endedAt: null } : i))
  const column = heatmap.at(-1)
  const book = column
    ? {
        bids: [...column.bids].sort((a, b) => b[0] - a[0]).map(([price, quantity]) => ({ price, quantity, orders: 0 })),
        asks: [...column.asks].sort((a, b) => a[0] - b[0]).map(([price, quantity]) => ({ price, quantity, orders: 0 })),
      }
    : { bids: [], asks: [] }
  // The price at the clock: the NEWER of the last print shown and the last completed minute's close. A
  // replayed day holds only the big prints (an estimated day only its volume-spike minutes), so the
  // last of those alone can be far behind - every setup would enter at that one old price.
  const lastTrade = trades.at(-1)
  const lastBar = minuteBars.at(-1)
  const tradeAt = lastTrade ? msOf(lastTrade.time) : -Infinity
  const barAt = lastBar ? msOf(lastBar.time) + 59_000 : -Infinity
  const lastPrice = (tradeAt >= barAt ? lastTrade?.price : lastBar?.close) ?? lastBar?.close ?? 0
  return {
    ...day,
    meta: { ...day.meta, lastPrice, lastTradeAt: lastTrade?.time ?? null },
    minuteBars, trades, heatmap, icebergs, book, sweeps, ...(heatFine ? { heatFine } : {}),
  }
}

// The span a recorded day can be replayed over: [first data, last data].
export function replayRange(day) {
  if (!day) return null
  const starts = [day.minuteBars[0] && msOf(day.minuteBars[0].time), day.heatmap[0]?.t].filter((v) => v != null)
  const ends = [day.minuteBars.at(-1) && msOf(day.minuteBars.at(-1).time) + 60_000, day.heatmap.at(-1)?.t].filter((v) => v != null)
  if (!starts.length) return null
  return { start: Math.min(...starts), end: Math.max(...ends) }
}

// ---- Liquidity signals (heatmap + prints + footprint) ------------------------------------------
//
// What the depth heatmap shows, read as signals with a confidence (0-100) - from the heatmap
// columns ({ t, bids, asks } as [price, quantity] rows), the big prints, and the minute footprints:
//
// - Magnet (liquidity attraction): price has been closing in on a thick wall that is still there -
//   price tends to seek liquidity. Confidence from how strong the wall is, how steadily price closed
//   in, and how near it is now.
// - Wall absorption (reversal): price reached a wall, big prints hit it, and the wall held - price
//   turned away by at least 3 rows. Confidence from the prints, the wall's strength and the turn.
// - Exhaustion into a wall (reversal): price closed in on a wall on shrinking volume and stalled
//   before touching it. Confidence from how far volume dropped and how close price got.
// - Spoofing: a wall that sat near price vanished as price came within two rows of it, with little
//   traded there - pulled, not filled. Confidence from its size, how close price was and how little
//   of it traded.
//
// A wall is a row holding at least WALL_FACTOR x the column's median resting quantity; it must last
// at least WALL_MIN_MS to count. Each signal: { key, kind, t, price, bullish, confidence, text }.
export const LIQUIDITY_DEFAULTS = { wallFactor: 4, wallMinMs: 20_000, windowMs: 180_000 }

export function liquiditySignals({ columns, trades = [], minuteBars = [], rowSize, lotSize = 1, ...options }) {
  const { wallFactor, wallMinMs, windowMs } = { ...LIQUIDITY_DEFAULTS, ...options }
  const step = rowSize > 0 ? rowSize : 0.05
  if (!columns?.length || columns.length < 5) return []
  const lots = (q) => Math.round(q / Math.max(1, lotSize))
  const rowKey = (p) => Math.round(p / step)

  // Per column: mid, median resting size, and every row's quantity.
  const cols = columns.map((c) => {
    const rows = new Map()
    let bestBid = null
    let bestAsk = null
    for (const [p, q] of c.bids ?? []) { rows.set(rowKey(p), (rows.get(rowKey(p)) ?? 0) + q); if (q > 0 && (bestBid == null || p > bestBid)) bestBid = p }
    for (const [p, q] of c.asks ?? []) { rows.set(rowKey(p), (rows.get(rowKey(p)) ?? 0) + q); if (q > 0 && (bestAsk == null || p < bestAsk)) bestAsk = p }
    const sizes = [...rows.values()].filter((q) => q > 0).sort((a, b) => a - b)
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk
    return { t: c.t, rows, mid, median: sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0 }
  }).filter((c) => c.mid != null && c.median > 0)
  if (cols.length < 5) return []

  // Walls tracked over time.
  const active = new Map()
  const walls = []
  for (const c of cols) {
    for (const [key, q] of c.rows) {
      if (q < wallFactor * c.median) continue
      const price = key * step
      const wall = active.get(key)
      if (wall) { wall.last = c.t; wall.maxQty = Math.max(wall.maxQty, q); wall.strength = Math.max(wall.strength, q / c.median); wall.seen.push({ t: c.t, mid: c.mid, q }) }
      else active.set(key, { key, price: Math.round(price * 100) / 100, first: c.t, last: c.t, maxQty: q, strength: q / c.median, side: price < c.mid ? 'bid' : 'ask', seen: [{ t: c.t, mid: c.mid, q }], endedAt: null })
    }
    for (const [key, wall] of active) {
      if (wall.last === c.t) continue
      const q = c.rows.get(key) ?? 0
      if (q < 0.3 * wall.maxQty) {
        wall.endedAt = c.t
        wall.endMid = c.mid
        active.delete(key)
        if (wall.last - wall.first >= wallMinMs) walls.push(wall)
      }
    }
  }
  const lastCol = cols.at(-1)
  for (const wall of active.values()) if (wall.last - wall.first >= wallMinMs) walls.push(wall)

  const clamp = (v) => Math.round(Math.max(1, Math.min(95, v)))
  // How far beyond the wall threshold a wall is, as 0..2 (4x the median = 0, 16x+ = 2).
  const strengthScore = (wall) => Math.max(0, Math.min(2, Math.log2(wall.strength / wallFactor)))
  const tradedAt = (price, from, to) => {
    let volume = 0
    for (const bar of minuteBars) {
      const ms = typeof bar.time === 'number' ? bar.time : new Date(bar.time).getTime()
      if (ms + 60_000 < from || ms > to) continue
      for (const level of bar.levels ?? []) if (Math.abs(level.price - price) < step / 2) volume += level.buy + level.sell
    }
    return volume
  }
  const signals = []
  const rowsAway = (mid, price) => Math.abs(mid - price) / step

  for (const wall of walls) {
    const sideText = wall.side === 'bid' ? 'bid wall (support)' : 'offer wall (resistance)'
    const size = `${lots(wall.maxQty).toLocaleString('en-IN')} lots`

    // Spoofing: vanished while price was within two rows, little traded there.
    if (wall.endedAt != null && rowsAway(wall.endMid, wall.price) <= 2 && wall.strength >= wallFactor * 1.25) {
      const traded = tradedAt(wall.price, wall.last - 60_000, wall.endedAt)
      const filledShare = traded / wall.maxQty
      if (filledShare < 0.3) {
        const confidence = clamp(35 + 8 * strengthScore(wall) + 25 * (1 - filledShare / 0.3) + 5 * (2 - rowsAway(wall.endMid, wall.price)))
        signals.push({ key: `spoof-${wall.key}-${wall.first}`, kind: 'Spoofing', t: wall.endedAt, price: wall.price, bullish: wall.side === 'ask', confidence,
          text: `${size} ${sideText} at ${wall.price} vanished as price came within ${rowsAway(wall.endMid, wall.price).toFixed(0)} row(s) - only ${Math.round(filledShare * 100)}% of it traded: pulled, not filled` })
      }
    }

    // Wall absorption: touched, hit by big prints, held, price turned away.
    const touch = wall.seen.find((s) => rowsAway(s.mid, wall.price) <= 1)
    if (touch) {
      const near = trades.filter((t) => {
        const ms = new Date(t.time).getTime()
        return Math.abs(ms - touch.t) <= 60_000 && Math.abs(t.price - wall.price) <= step * 1.5
      })
      const after = cols.filter((c) => c.t > touch.t && c.t <= touch.t + windowMs)
      const turned = after.find((c) => (wall.side === 'bid' ? c.mid - wall.price : wall.price - c.mid) >= 3 * step)
      const brokeBefore = after.some((c) => (turned == null || c.t < turned.t) && (wall.side === 'bid' ? c.mid < wall.price - step : c.mid > wall.price + step))
      if (near.length >= 2 && turned && !brokeBefore) {
        const volume = near.reduce((s, t) => s + t.quantity, 0)
        const confidence = clamp(30 + 5 * Math.min(near.length, 6) + 8 * Math.min(2, volume / wall.maxQty) + 4 * strengthScore(wall) + 2 * Math.min(5, rowsAway(turned.mid, wall.price)))
        signals.push({ key: `abs-${wall.key}-${touch.t}`, kind: 'Wall absorption', t: turned.t, price: wall.price, bullish: wall.side === 'bid', confidence,
          text: `${size} ${sideText} at ${wall.price} absorbed ${near.length} big print(s) (${lots(volume).toLocaleString('en-IN')} lots) and held - price turned away` })
      }
    }

    // Magnet / exhaustion: price closing in on a wall that is still there.
    const alive = wall.endedAt == null && wall.last === lastCol.t
    if (alive) {
      const window = wall.seen.filter((s) => s.t >= lastCol.t - windowMs)
      if (window.length >= 5) {
        const d0 = rowsAway(window[0].mid, wall.price)
        const d1 = rowsAway(window.at(-1).mid, wall.price)
        let closer = 0
        for (let i = 1; i < window.length; i++) if (rowsAway(window[i].mid, wall.price) <= rowsAway(window[i - 1].mid, wall.price)) closer++
        const steadiness = closer / (window.length - 1)
        const approaching = d0 >= 4 && d1 <= 0.6 * d0 && d1 >= 1 && steadiness >= 0.6
        if (approaching) {
          // Volume while closing in: first half vs second half of the window's minutes.
          const bars = minuteBars.filter((b) => {
            const ms = typeof b.time === 'number' ? b.time : new Date(b.time).getTime()
            return ms >= window[0].t - 60_000 && ms <= lastCol.t
          })
          const half = Math.floor(bars.length / 2)
          const early = half > 0 ? bars.slice(0, half).reduce((s, b) => s + (b.volume ?? b.buy + b.sell), 0) / half : 0
          const late = bars.length - half > 0 ? bars.slice(half).reduce((s, b) => s + (b.volume ?? b.buy + b.sell), 0) / (bars.length - half) : 0
          const fading = bars.length >= 3 && early > 0 && late < 0.6 * early
          const stalled = Math.abs(rowsAway(window.at(-1).mid, wall.price) - rowsAway(window[Math.max(0, window.length - 4)].mid, wall.price)) < 1
          if (fading && stalled) {
            const confidence = clamp(30 + 35 * (1 - late / early) + 10 * steadiness + 5 * (d1 <= 2 ? 1 : 0))
            signals.push({ key: `exh-${wall.key}-${wall.first}`, kind: 'Exhaustion into wall', t: lastCol.t, price: wall.price, bullish: wall.side === 'bid', confidence,
              text: `Price stalled ${d1.toFixed(0)} row(s) short of the ${size} ${sideText} at ${wall.price} as volume faded ${Math.round((1 - late / early) * 100)}% - momentum running out` })
          } else {
            const confidence = clamp(30 + 20 * steadiness + 5 * strengthScore(wall) + 15 * (1 - d1 / d0))
            signals.push({ key: `mag-${wall.key}-${wall.first}`, kind: 'Magnet', t: lastCol.t, price: wall.price, bullish: wall.side === 'ask', confidence,
              text: `Price drifting toward the ${size} ${sideText} at ${wall.price} (${d0.toFixed(0)} → ${d1.toFixed(0)} rows away) - liquidity attracting price` })
          }
        }
      }
    }
  }
  return signals.sort((a, b) => b.t - a.t)
}

// One read of everything on the page: a bias (-100 bearish .. +100 bullish) with what drove it.
// Each part is scored -1..+1 and weighted:
//   cumulative delta trend (last 10 bars, vs their volume)  30
//   recent delta (last 3 bars, vs their volume)             15
//   stacked imbalances (last 10 bars: buy - sell stacks)     15
//   absorption / exhaustion (last 15 bars)                  15
//   liquidity signals (last 15 min, by confidence)          15
//   big orders (last 15 min: buy - sell quantity)           10
//   options OI, whole chain (since open 15 + 15 min 10)      25   - passed in `extra`
//   futures OI (since open 10 + 15 min 10)                   20   - passed in `extra`
// Confidence is how far from neutral the total is, scaled by how many parts agree on its side.
export function orderFlowBias({ bars = [], liquidity = [], bigTrades = [], nowMs = Date.now(), aggressionNow = null, sweeps = [], pullStack = [], extra = [] }) {
  const parts = []
  const add = (name, weight, score, detail) => { if (Number.isFinite(score)) parts.push({ name, weight, score: Math.max(-1, Math.min(1, score)), detail }) }
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0)

  const last10 = bars.slice(-10)
  if (last10.length >= 3) {
    const volume = sum(last10, (b) => b.volume)
    const cvdChange = last10.at(-1).cvd - (last10[0].cvd - last10[0].delta)
    add('Cumulative delta', 30, volume > 0 ? (cvdChange / volume) * 4 : 0, `${cvdChange >= 0 ? '+' : ''}${Math.round(cvdChange)} over ${last10.length} bars`)
  }
  const last3 = bars.slice(-3)
  if (last3.length) {
    const volume = sum(last3, (b) => b.volume)
    const delta = sum(last3, (b) => b.delta)
    add('Recent delta', 15, volume > 0 ? (delta / volume) * 4 : 0, `${delta >= 0 ? '+' : ''}${Math.round(delta)} over ${last3.length} bars`)
  }
  if (last10.length) {
    const buy = sum(last10, (b) => (b.stacked ?? []).filter((z) => z.side === 'buy').length)
    const sell = sum(last10, (b) => (b.stacked ?? []).filter((z) => z.side === 'sell').length)
    if (buy + sell > 0) add('Stacked imbalances', 15, (buy - sell) / Math.max(2, buy + sell), `${buy} buy / ${sell} sell stacks`)
  }
  const last15 = bars.slice(-15)
  {
    const bullish = sum(last15, (b) => [...(b.absorption ?? []), ...(b.exhaustion ?? [])].filter((x) => x.side === 'buy').length)
    const bearish = sum(last15, (b) => [...(b.absorption ?? []), ...(b.exhaustion ?? [])].filter((x) => x.side === 'sell').length)
    if (bullish + bearish > 0) add('Absorption / exhaustion', 15, (bullish - bearish) / Math.max(2, bullish + bearish), `${bullish} bullish / ${bearish} bearish`)
  }
  const recent = liquidity.filter((s) => nowMs - s.t <= 15 * 60_000)
  if (recent.length) {
    const score = sum(recent, (s) => (s.bullish ? 1 : -1) * (s.confidence / 100) * (1 - (nowMs - s.t) / (15 * 60_000) * 0.5))
    add('Liquidity (heatmap)', 15, score / Math.max(1, recent.length * 0.6), `${recent.length} signal(s)`)
  }
  const recentTrades = bigTrades.filter((t) => nowMs - new Date(t.time).getTime() <= 15 * 60_000)
  if (recentTrades.length) {
    const buy = sum(recentTrades.filter((t) => t.buy), (t) => t.quantity)
    const sell = sum(recentTrades.filter((t) => !t.buy), (t) => t.quantity)
    add('Big orders', 10, (buy - sell) / Math.max(1, buy + sell), `${recentTrades.length} in 15 min`)
  }

  // Tape: who is aggressive over the last minute, and recent sweeps (market orders through levels).
  const minute = aggressionNow?.find((w) => w.ms === 60_000)
  if (minute && minute.total > 0) add('Aggressive buyers / sellers', 15, (minute.buyPct - 50) / 25, `${minute.buyPct}% bought at the offer (1 min)`)
  const recentSweeps = sweeps.filter((w) => nowMs - msOf(w.endedAt) <= 15 * 60_000 && msOf(w.endedAt) <= nowMs)
  if (recentSweeps.length) {
    const buy = sum(recentSweeps.filter((w) => w.buy), (w) => w.quantity)
    const sell = sum(recentSweeps.filter((w) => !w.buy), (w) => w.quantity)
    add('Sweeps', 10, (buy - sell) / Math.max(1, buy + sell), `${recentSweeps.length} in 15 min`)
  }
  const recentPull = pullStack.filter((x) => nowMs - x.t <= 10 * 60_000 && x.t <= nowMs)
  if (recentPull.length) {
    const score = sum(recentPull, (x) => (x.bullish ? 1 : -1) * (x.confidence / 100))
    add('Liquidity pulling / stacking', 10, score / Math.max(1, recentPull.length * 0.6), `${recentPull.length} in 10 min`)
  }

  // Options OI and futures OI (strategyEngine's oiBiasParts) - the positioning behind the flow.
  for (const p of extra) add(p.name, p.weight, p.score, p.detail)

  const totalWeight = sum(parts, (p) => p.weight) || 1
  const score = Math.round((sum(parts, (p) => p.weight * p.score) / totalWeight) * 100)
  const side = Math.sign(score)
  const agreeing = parts.filter((p) => Math.sign(p.score) === side && Math.abs(p.score) > 0.1).length
  const confidence = side === 0 || parts.length === 0 ? 0 : Math.round(Math.min(95, Math.abs(score) * (0.5 + 0.5 * agreeing / parts.length) * 1.4))
  const bias = score >= 20 ? 'Bullish' : score <= -20 ? 'Bearish' : 'Neutral'
  return { score, bias, confidence, parts }
}

// ---- Tape reading: aggressive buyers & sellers, sweeps, liquidity pulling & stacking -------------
//
// Aggression: of the prints in each window ending at `nowMs`, how much was BOUGHT at the offer (buyers
// aggressive - market buy orders) vs SOLD at the bid; plus the tape's speed. Prints: the Time & Sales
// rows ({ time, price, quantity, buy }), oldest first.
export const AGGRESSION_WINDOWS = [{ label: '1m', ms: 60_000 }, { label: '3m', ms: 180_000 }, { label: '5m', ms: 300_000 }, { label: '15m', ms: 900_000 }]

/** Buying vs selling aggression over each window. From the prints when the tape held reaches back that
 *  far; a longer window than the tape covers (it keeps the latest prints only) is read from the minute
 *  bars' buy / sell volume instead (`fromBars`) - the same aggressor split, a minute at a time. */
export function aggression(prints, nowMs, windows = AGGRESSION_WINDOWS, minuteBars = null) {
  const oldest = prints?.length ? msOf(prints[0].time) : Infinity
  return windows.map(({ label, ms }) => {
    let buy = 0
    let sell = 0
    let count = 0
    const fromBars = oldest > nowMs - ms && minuteBars?.length > 0
    if (fromBars) {
      for (let i = minuteBars.length - 1; i >= 0; i--) {
        const t = msOf(minuteBars[i].time)
        if (t > nowMs) continue
        if (t + 60_000 <= nowMs - ms) break
        buy += minuteBars[i].buy ?? 0
        sell += minuteBars[i].sell ?? 0
      }
    } else {
      for (let i = (prints?.length ?? 0) - 1; i >= 0; i--) {
        const t = msOf(prints[i].time)
        if (t > nowMs) continue
        if (t < nowMs - ms) break
        if (prints[i].buy) buy += prints[i].quantity; else sell += prints[i].quantity
        count++
      }
    }
    const total = buy + sell
    return { label, ms, buy, sell, total, prints: count, fromBars, buyPct: total > 0 ? Math.round((buy / total) * 100) : 50, perMin: Math.round((count / ms) * 60_000) }
  })
}

// Sweeps (detected on the server - see OrderFlowEngine.SweepGap) as signals with a confidence: bigger
// and through more levels = stronger.
export function sweepSignals(sweeps, lotSize = 1) {
  return (sweeps ?? []).map((w) => {
    const lots = Math.round(w.quantity / Math.max(1, lotSize))
    const secs = Math.max(0.1, (msOf(w.endedAt) - msOf(w.startedAt)) / 1000)
    const confidence = Math.round(Math.max(40, Math.min(92, 50 + 14 * Math.log2(Math.max(1, lots / 10)) + 3 * (w.levels - 3))))
    return {
      key: `sw-${w.id}`, kind: w.buy ? 'Buy sweep' : 'Sell sweep', t: msOf(w.endedAt), price: w.toPrice, bullish: w.buy, confidence,
      text: `${lots.toLocaleString('en-IN')} lots ${w.buy ? 'lifted' : 'hit'} through ${w.levels} levels ${w.fromPrice}→${w.toPrice} in ${secs.toFixed(1)}s - aggressive market ${w.buy ? 'buyers' : 'sellers'} (stops / breakout)`,
    }
  })
}

// Liquidity PULLING and STACKING: resting limit orders taken away from, or added to, the book near
// price - from consecutive heatmap columns. Only rows that stayed away from the touch in both columns
// count (bids below both best bids, offers above both best offers, up to `bandRows` rows out), so a
// change there cannot be trading - any drop was cancelled (pulled), any rise was added (stacked).
// Over `windowMs`, a side whose pulled (or stacked) quantity reaches `factor` x its usual near-touch
// depth, at least `minLots` lots and `dominance` x the opposite change, is a signal:
//   bids pulled = support withdrawn (bearish) · offers pulled = resistance withdrawn (bullish)
//   bids stacked = support building (bullish) · offers stacked = resistance building (bearish)
// Returns { signals, pressure } - pressure: the last window's added/removed per side vs the usual depth.
export const PULL_STACK_DEFAULTS = { bandRows: 10, windowMs: 20_000, factor: 0.35, minLots: 20, dominance: 2, maxGapMs: 60_000 }

export function pullStackSignals({ columns, rowSize, lotSize = 1, ...options }) {
  const { bandRows, windowMs, factor, minLots, dominance, maxGapMs } = { ...PULL_STACK_DEFAULTS, ...options }
  const step = rowSize > 0 ? rowSize : 0.05
  const empty = { signals: [], pressure: null }
  if (!columns || columns.length < 3) return empty
  const key = (p) => Math.round(p / step)
  const lots = (q) => Math.round(q / Math.max(1, lotSize))
  const cols = columns.map((c) => {
    const bids = new Map()
    const asks = new Map()
    for (const [p, q] of c.bids ?? []) if (q > 0) bids.set(key(p), (bids.get(key(p)) ?? 0) + q)
    for (const [p, q] of c.asks ?? []) if (q > 0) asks.set(key(p), (asks.get(key(p)) ?? 0) + q)
    return { t: c.t, bids, asks, bestBid: bids.size ? Math.max(...bids.keys()) : null, bestAsk: asks.size ? Math.min(...asks.keys()) : null }
  }).filter((c) => c.bestBid != null && c.bestAsk != null)

  const side = () => ({ added: 0, removed: 0, addPx: 0, remPx: 0, lo: Infinity, hi: -Infinity })
  const events = []
  for (let i = 1; i < cols.length; i++) {
    const a = cols[i - 1]
    const b = cols[i]
    if (b.t - a.t > maxGapMs) continue
    const ev = { t: b.t, bid: side(), ask: side(), depthBid: 0, depthAsk: 0 }
    const band = (from, to, aMap, bMap, s, depthKey) => {
      for (let k = from; k <= to; k++) {
        const qa = aMap.get(k) ?? 0
        const qb = bMap.get(k) ?? 0
        ev[depthKey] += qa
        if (qb > qa) { s.added += qb - qa; s.addPx += (qb - qa) * k * step }
        else if (qa > qb) { s.removed += qa - qb; s.remPx += (qa - qb) * k * step; s.lo = Math.min(s.lo, k * step); s.hi = Math.max(s.hi, k * step) }
      }
    }
    const bidCut = Math.min(a.bestBid, b.bestBid)
    band(bidCut - bandRows, bidCut - 1, a.bids, b.bids, ev.bid, 'depthBid')
    const askCut = Math.max(a.bestAsk, b.bestAsk)
    band(askCut + 1, askCut + bandRows, a.asks, b.asks, ev.ask, 'depthAsk')
    events.push(ev)
  }
  if (events.length < 2) return empty

  const median = (xs) => { const v = xs.filter((x) => x > 0).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0 }
  const signals = []
  const lastEmit = {}
  const round2 = (v) => Math.round(v * 100) / 100
  let startIdx = 0
  const win = { bid: side(), ask: side() }
  const addTo = (w, s, sign) => { w.added += sign * s.added; w.removed += sign * s.removed; w.addPx += sign * s.addPx; w.remPx += sign * s.remPx }
  let baseBid = 0
  let baseAsk = 0
  for (let j = 0; j < events.length; j++) {
    const ev = events[j]
    addTo(win.bid, ev.bid, 1)
    addTo(win.ask, ev.ask, 1)
    while (events[startIdx].t < ev.t - windowMs) { addTo(win.bid, events[startIdx].bid, -1); addTo(win.ask, events[startIdx].ask, -1); startIdx++ }
    // The usual near-touch depth so far (re-measured every 10 columns, over the last 300).
    if (j % 10 === 0 || !baseBid || !baseAsk) {
      const recent = events.slice(Math.max(0, j - 300), j + 1)
      baseBid = median(recent.map((e) => e.depthBid))
      baseAsk = median(recent.map((e) => e.depthAsk))
    }
    if (j < 5) continue
    for (const [name, w, base] of [['bid', win.bid, baseBid], ['ask', win.ask, baseAsk]]) {
      if (!(base > 0)) continue
      for (const kind of ['pulled', 'stacked']) {
        const amount = kind === 'pulled' ? w.removed : w.added
        const other = kind === 'pulled' ? w.added : w.removed
        const ratio = amount / base
        if (ratio < factor || lots(amount) < minLots || amount < dominance * Math.max(other, 1)) continue
        const id = `${name}-${kind}`
        if (lastEmit[id] != null && ev.t - lastEmit[id] < windowMs) continue
        lastEmit[id] = ev.t
        const price = round2((kind === 'pulled' ? w.remPx : w.addPx) / amount)
        const bullish = (name === 'bid') === (kind === 'stacked')
        const confidence = Math.round(Math.max(40, Math.min(92, 48 + 30 * Math.min(1, (ratio - factor) / (1 - factor)) + 3 * Math.min(4, amount / Math.max(other, 1) - dominance))))
        const where = name === 'bid' ? 'bids below price' : 'offers above price'
        const meaning = name === 'bid'
          ? (kind === 'pulled' ? 'support withdrawn' : 'support building')
          : (kind === 'pulled' ? 'resistance withdrawn - the way up is thinner' : 'resistance building')
        signals.push({
          key: `ps-${id}-${ev.t}`, kind: kind === 'pulled' ? 'Liquidity pulled' : 'Liquidity stacked', side: name, t: ev.t, price, bullish, confidence,
          text: `${lots(amount).toLocaleString('en-IN')} lots of ${where} ${kind === 'pulled' ? 'pulled' : 'added'} in ${Math.round(windowMs / 1000)}s around ${price} (${Math.round(ratio * 100)}% of the usual near-touch depth) - ${meaning}`,
        })
      }
    }
  }
  const pressure = {
    windowMs,
    bid: { added: lots(win.bid.added), removed: lots(win.bid.removed), usual: lots(baseBid) },
    ask: { added: lots(win.ask.added), removed: lots(win.ask.removed), usual: lots(baseAsk) },
  }
  return { signals, pressure }
}

// ---- big orders ------------------------------------------------------------------------------------

const NICE_LOTS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000]
/** "Big order" for the day as it trades: the size only the top 2.5% of prints reach, in lots, rounded
 *  up to a round number (5, 10, 15 ... 1000) and never under 5. A fixed number is wrong most of the
 *  time - 10 lots is a big print on a quiet afternoon and an ordinary one at the open or on expiry.
 *  Null with under 200 prints to judge from. */
export function autoBigLots(prints, lotSize) {
  const lot = Math.max(1, lotSize || 1)
  const sizes = (prints ?? []).map((p) => p.quantity / lot).filter((q) => q > 0)
  if (sizes.length < 200) return null
  sizes.sort((a, b) => a - b)
  const p975 = sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.975))]
  return NICE_LOTS.find((n) => n >= p975) ?? NICE_LOTS.at(-1)
}

// ---- Liquidity map: the heatmap read as levels, zones, confluence and what is happening now ---------
//
// From the depth heatmap's last `windowMs` (10 min) of book snapshots, judged against the CURRENT price:
// - Support / resistance: rows whose resting bids (below the price) / offers (above it) average at
//   least `wallX` (3x) the book's median row and were that thick in `presence` (60%) of the snapshots -
//   walls that STAY, not flashes. Neighbouring rows join into one level. Trend: its last `recentMs`
//   (2 min) against the window - building (125%+), holding, or pulling (60% or less).
// - Zones: runs of 2+ rows at `highX` (1.8x) the median or more (high liquidity - price slows, stalls
//   or reverses there) or at `lowX` (0.35x) or less (low liquidity - thin, price moves fast through).
// - Confluence: the heatmap levels together with `extraLevels` (OI walls, sudden OI walls, POC, value
//   area, HVN, VWAP, the previous day's high / low, icebergs - in futures prices), grouped when within
//   max(2 rows, 0.03%) of each other and scored by what lines up there.
// - Now: what is happening at the wall price is at (within 3 rows) - from the minute footprints:
//     absorption  - heavy aggression INTO the wall (selling into a bid wall) and the wall holds or
//                   refills: the other side is absorbed - a turn away from it is likely;
//     exhaustion  - price pressing toward the wall on fading volume and a shrinking delta - the push is
//                   running out before the wall;
//     break       - the wall being eaten (its size falling while it trades) or price through it - the
//                   move continues into the next zone;
//     pulled      - the wall vanishing with little traded - it was not real (spoofing);
//   else, in (or right next to) a low-liquidity zone: a fast move the way the flow points (else the
//   book leans); else between the walls: the
//   drift the book and the delta lean to. Each with the possible move and the level it heads for.
// Only snapshots and completed minutes up to `nowMs` are read.
export const LIQUIDITY_MAP_DEFAULTS = { windowMs: 10 * 60_000, recentMs: 2 * 60_000, wallX: 3, presence: 0.6, highX: 1.8, lowX: 0.35 }
const CONFLUENCE_WEIGHT = { oi: 3, suddenOi: 3, poc: 2, vah: 1.5, val: 1.5, hvn: 1, vwap: 1.5, prevHigh: 1.5, prevLow: 1.5, iceberg: 2 }

export function liquidityMap({ columns, minuteBars = [], rowSize, lotSize = 1, price, nowMs, extraLevels = [], ...options }) {
  const o = { ...LIQUIDITY_MAP_DEFAULTS, ...options }
  const step = rowSize > 0 ? rowSize : 0.05
  const end = nowMs ?? columns?.at(-1)?.t
  const cols = (columns ?? []).filter((c) => c.t <= end && c.t >= end - o.windowMs)
  if (cols.length < 5 || !(price > 0)) return null
  const keyOf = (p) => Math.round(p / step)
  const priceOf = (k) => Math.round(k * step * 100) / 100
  const priceKey = keyOf(price)
  const lots = (q) => Math.round(q / Math.max(1, lotSize))

  // Per row: bids and offers summed over the window and the last `recentMs`, and in how many
  // snapshots it was a wall.
  const rows = new Map()
  const row = (k) => { let r = rows.get(k); if (!r) rows.set(k, (r = { bid: 0, ask: 0, bidRecent: 0, askRecent: 0, bidWall: 0, askWall: 0 })); return r }
  const recentFrom = end - o.recentMs
  let nRecent = 0
  for (const c of cols) {
    const recent = c.t >= recentFrom
    if (recent) nRecent++
    const sizes = []
    const bids = new Map()
    const asks = new Map()
    for (const [p, q] of c.bids ?? []) if (q > 0) bids.set(keyOf(p), (bids.get(keyOf(p)) ?? 0) + q)
    for (const [p, q] of c.asks ?? []) if (q > 0) asks.set(keyOf(p), (asks.get(keyOf(p)) ?? 0) + q)
    for (const q of [...bids.values(), ...asks.values()]) sizes.push(q)
    sizes.sort((a, b) => a - b)
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0
    for (const [k, q] of bids) { const r = row(k); r.bid += q; if (recent) r.bidRecent += q; if (median > 0 && q >= o.wallX * median) r.bidWall++ }
    for (const [k, q] of asks) { const r = row(k); r.ask += q; if (recent) r.askRecent += q; if (median > 0 && q >= o.wallX * median) r.askWall++ }
  }
  const n = cols.length
  // Each row read on the side it is on NOW: under the price its bids, over it its offers.
  const sideOf = (k) => (k < priceKey ? 'bid' : k > priceKey ? 'ask' : null)
  const view = new Map()
  for (const [k, r] of rows) {
    const side = sideOf(k)
    if (!side) continue
    const avg = r[side] / n
    view.set(k, { k, side, avg, recent: nRecent ? r[`${side}Recent`] / nRecent : avg, presence: r[`${side}Wall`] / n })
  }
  const positive = [...view.values()].map((v) => v.avg).filter((v) => v > 0).sort((a, b) => a - b)
  if (!positive.length) return null
  const median = positive[Math.floor(positive.length / 2)]

  // ---- walls -> levels
  const wallRows = [...view.values()].filter((v) => v.avg >= o.wallX * median && v.presence >= o.presence).sort((a, b) => a.k - b.k)
  const levels = []
  for (const v of wallRows) {
    const g = levels.at(-1)
    if (g && g.side === v.side && v.k - g.hiK === 1) { g.hiK = v.k; g.rows.push(v) } else levels.push({ side: v.side, loK: v.k, hiK: v.k, rows: [v] })
  }
  const walls = levels.map((g) => {
    const top = g.rows.reduce((a, v) => (v.avg > a.avg ? v : a))
    const ratio = top.avg > 0 ? top.recent / top.avg : 1
    return {
      side: g.side, kind: g.side === 'bid' ? 'support' : 'resistance', price: priceOf(top.k), low: priceOf(g.loK), high: priceOf(g.hiK),
      size: g.rows.reduce((s, v) => s + v.avg, 0), lots: lots(g.rows.reduce((s, v) => s + v.avg, 0)), strength: top.avg / median,
      presence: Math.max(...g.rows.map((v) => v.presence)), trend: ratio >= 1.25 ? 'building' : ratio <= 0.6 ? 'pulling' : 'holding', recentRatio: ratio,
      distance: priceOf(top.k) - price,
    }
  })
  const support = walls.filter((w) => w.kind === 'support').sort((a, b) => b.price - a.price)
  const resistance = walls.filter((w) => w.kind === 'resistance').sort((a, b) => a.price - b.price)

  // ---- zones (the book's range as it is now; the price row itself left out)
  const last = cols.at(-1)
  const bookKeys = [...(last.bids ?? []), ...(last.asks ?? [])].filter(([, q]) => q > 0).map(([p]) => keyOf(p))
  const zones = []
  if (bookKeys.length) {
    const lo = Math.min(...bookKeys)
    const hi = Math.max(...bookKeys)
    let run = null
    const flush = () => {
      if (run && run.hiK - run.loK >= 1) {
        zones.push({ kind: run.kind, side: run.side, low: priceOf(run.loK), high: priceOf(run.hiK), rows: run.hiK - run.loK + 1,
          rel: run.sum / (run.hiK - run.loK + 1) / median, distance: run.side === 'bid' ? priceOf(run.hiK) - price : priceOf(run.loK) - price })
      }
      run = null
    }
    for (let k = lo; k <= hi; k++) {
      const side = sideOf(k)
      const rel = side ? (view.get(k)?.avg ?? 0) / median : null
      const kind = rel == null ? null : rel >= o.highX ? 'high' : rel <= o.lowX ? 'low' : null
      if (run && (kind !== run.kind || side !== run.side)) flush()
      if (!kind) continue
      if (!run) run = { kind, side, loK: k, hiK: k, sum: 0 }
      run.hiK = k
      run.sum += rel * median
    }
    flush()
  }

  // ---- confluence
  const tol = Math.max(2 * step, price * 0.0003)
  const points = [
    ...walls.map((w) => ({ price: w.price, kind: 'heatmap', label: `${w.side === 'bid' ? 'bid' : 'offer'} wall ${w.lots.toLocaleString('en-IN')} lots (${w.strength.toFixed(1)}x, ${w.trend})`,
      weight: 2 + Math.min(2, Math.max(0, Math.log2(w.strength / o.wallX))) })),
    ...extraLevels.filter((x) => x.price > 0 && CONFLUENCE_WEIGHT[x.kind] != null).map((x) => ({ ...x, weight: x.weight ?? CONFLUENCE_WEIGHT[x.kind] })),
  ].sort((a, b) => a.price - b.price)
  const groups = []
  for (const p of points) {
    const g = groups.at(-1)
    if (g && p.price - g.first <= tol) { g.items.push(p) } else groups.push({ first: p.price, items: [p] })
  }
  const confluence = groups.map((g) => {
    const score = g.items.reduce((s, x) => s + x.weight, 0)
    const at = g.items.reduce((s, x) => s + x.price * x.weight, 0) / score
    const kinds = new Set(g.items.map((x) => x.kind))
    return {
      price: Math.round(Math.round(at / step) * step * 100) / 100, low: g.items[0].price, high: g.items.at(-1).price, score, kinds: [...kinds],
      items: g.items.map((x) => x.label), parts: g.items.map((x) => ({ kind: x.kind, label: x.label })), side: at < price - step / 2 ? 'support' : at > price + step / 2 ? 'resistance' : 'at price',
      strength: score >= 6 ? 'Strong' : score >= 3.5 ? 'Medium' : 'Weak', distance: at - price,
    }
  }).filter((g) => g.kinds.length >= 2 || g.score >= 3.5).sort((a, b) => b.score - a.score).slice(0, 10)

  // ---- book lean near the price (latest snapshot, within 10 rows)
  let nearBid = 0
  let nearAsk = 0
  for (const [p, q] of last.bids ?? []) if (Math.abs(keyOf(p) - priceKey) <= 10) nearBid += q
  for (const [p, q] of last.asks ?? []) if (Math.abs(keyOf(p) - priceKey) <= 10) nearAsk += q
  const lean = nearBid + nearAsk > 0 ? nearBid / (nearBid + nearAsk) : null

  // ---- now
  const done = minuteBars.filter((b) => (typeof b.time === 'number' ? b.time : new Date(b.time).getTime()) + 60_000 <= end).slice(-3)
  const flowDelta = done.reduce((s, b) => s + ((b.buy ?? 0) - (b.sell ?? 0)), 0)
  const volumes = done.map((b) => (b.buy ?? 0) + (b.sell ?? 0))
  const now = readNow({ price, step, support, resistance, zones, done, flowDelta, volumes, lean, lots })
  return { median, support, resistance, zones, confluence, lean, now, windowMin: Math.round(o.windowMs / 60_000) }
}

function readNow({ price, step, support, resistance, zones, done, flowDelta, volumes, lean, lots }) {
  const nextBeyond = (list, w) => list.find((x) => x !== w && (w.kind === 'support' ? x.price < w.low : x.price > w.high))
  const S = support[0] ?? null
  const R = resistance[0] ?? null
  const gapRows = (w) => (w.kind === 'support' ? (price - w.high) / step : (w.low - price) / step)
  const inPlay = [S, R].filter((w) => w && gapRows(w) <= 3).sort((a, b) => gapRows(a) - gapRows(b))[0]
  const fmt = (p) => (p == null ? '-' : Number.isInteger(p) ? `${p}` : p.toFixed(1))
  const move = (dir, target, text) => ({ dir, target: target?.price ?? null, text })

  if (inPlay) {
    const w = inPlay
    const up = w.kind === 'support'
    const name = `${up ? 'bid wall (support)' : 'offer wall (resistance)'} at ${fmt(w.price)}`
    // Aggression INTO the wall over the last 3 minutes at its rows (and the row next to it).
    let into = 0
    let traded = 0
    for (const b of done) for (const l of b.levels ?? []) {
      if (l.price < w.low - step - 1e-9 || l.price > w.high + step + 1e-9) continue
      traded += l.buy + l.sell
      into += up ? l.sell : l.buy
    }
    const away = up ? R : S
    const beyond = nextBeyond(up ? support : resistance, w)
    const through = up ? price < w.low - step : price > w.high + step
    const consumed = w.recentRatio <= 0.5
    if (through || (consumed && into >= 0.3 * w.size)) {
      return { state: 'break', bullish: !up, level: w, confidence: through ? 70 : 60,
        text: `${up ? 'Bid' : 'Offer'} wall at ${fmt(w.price)} ${through ? 'broken' : 'being eaten'} - ${lots(into).toLocaleString('en-IN')} lots ${up ? 'sold' : 'bought'} into it, its size down to ${Math.round(w.recentRatio * 100)}%`,
        move: move(up ? -1 : 1, beyond, `break ${up ? 'down' : 'up'}${beyond ? ` toward the next ${beyond.kind} at ${fmt(beyond.price)}` : ' - no wall beyond it in the book'}`) }
    }
    if (consumed) {
      return { state: 'pulled', bullish: !up, level: w, confidence: 55,
        text: `${up ? 'Bid' : 'Offer'} wall at ${fmt(w.price)} pulled - its size down to ${Math.round(w.recentRatio * 100)}% with little traded: it was not real`,
        move: move(up ? -1 : 1, beyond, `likely to slip ${up ? 'lower' : 'higher'}${beyond ? ` toward ${fmt(beyond.price)}` : ''}`) }
    }
    if (into >= 0.5 * w.size && w.recentRatio >= 0.7) {
      return { state: 'absorption', bullish: up, level: w, confidence: Math.min(90, 60 + Math.round(10 * Math.min(2, into / w.size)) + (w.trend === 'building' ? 8 : 0)),
        text: `Absorption at the ${name}: ${lots(into).toLocaleString('en-IN')} lots ${up ? 'sold' : 'bought'} into it in 3 min and it ${w.trend === 'building' ? 'grew' : 'held'} (${Math.round(w.recentRatio * 100)}% of its size) - ${up ? 'sellers' : 'buyers'} absorbed`,
        move: move(up ? 1 : -1, away, `possible ${up ? 'bounce up' : 'turn down'}${away ? ` toward ${fmt(away.price)}` : ''}`) }
    }
    const fading = volumes.length === 3 && volumes[2] < 0.7 * ((volumes[0] + volumes[1]) / 2)
    const deltas = done.map((b) => (b.buy ?? 0) - (b.sell ?? 0))
    const pushing = deltas.length === 3 && (up ? deltas[0] < 0 : deltas[0] > 0)
    const shrinking = pushing && (up ? deltas[2] > 0.6 * deltas[0] : deltas[2] < 0.6 * deltas[0])
    if (fading && shrinking) {
      return { state: 'exhaustion', bullish: up, level: w, confidence: 60,
        text: `${up ? 'Selling' : 'Buying'} exhausting into the ${name}: volume down ${Math.round((1 - volumes[2] / ((volumes[0] + volumes[1]) / 2)) * 100)}%, delta ${deltas.map((d) => `${d > 0 ? '+' : ''}${lots(d)}`).join(' → ')} lots`,
        move: move(up ? 1 : -1, away, `possible ${up ? 'bounce' : 'pullback'}${away ? ` toward ${fmt(away.price)}` : ''}`) }
    }
    return { state: 'testing', bullish: null, level: w, confidence: 45,
      text: `Price at the ${name} (${w.trend}) - no absorption or exhaustion read yet`,
      move: move(0, null, `holds: ${up ? 'bounce' : 'turn'}${away ? ` toward ${fmt(away.price)}` : ''} · breaks: ${beyond ? `toward ${fmt(beyond.price)}` : 'into thin book'}`) }
  }

  const flowDir = flowDelta > 0 ? 1 : flowDelta < 0 ? -1 : 0
  const thin = zones.find((z) => z.kind === 'low' && Math.abs(z.distance) <= step + 1e-9)
  if (thin) {
    const leanSide = lean != null && Math.abs(lean - 0.5) >= 0.05 ? (lean > 0.5 ? 1 : -1) : 0
    const dir = flowDir || leanSide
    const why = flowDir ? `the flow points ${dir > 0 ? 'up' : 'down'} (Δ ${flowDelta > 0 ? '+' : ''}${lots(flowDelta)} lots in 3 min)` : `the book leans ${dir > 0 ? 'bids' : 'offers'} (${Math.round(lean * 100)}% bids near the price)`
    const target = dir > 0 ? R : dir < 0 ? S : null
    return { state: 'vacuum', bullish: dir === 0 ? null : dir > 0, level: null, confidence: 50,
      text: `Price at a low-liquidity zone ${fmt(thin.low)}-${fmt(thin.high)}: little resting there - it can move fast`,
      move: move(dir, target, dir ? `${why}${target ? ` - likely to run to ${fmt(target.price)}` : ''}` : 'no direction in the flow or the book yet') }
  }
  const leanDir = lean == null ? 0 : lean >= 0.58 ? 1 : lean <= 0.42 ? -1 : 0
  const dir = leanDir && flowDir && leanDir !== flowDir ? 0 : leanDir || flowDir
  const target = dir > 0 ? R : dir < 0 ? S : null
  const where = S && R ? `Between support ${fmt(S.price)} and resistance ${fmt(R.price)}`
    : S ? `Over support ${fmt(S.price)}, no resistance wall above` : R ? `Under resistance ${fmt(R.price)}, no support wall below` : 'No wall has stayed in the book near the price'
  const why = [leanDir && leanDir === dir ? `book ${Math.round(lean * 100)}% bids near the price` : null,
    flowDir && flowDir === dir ? `Δ ${flowDelta > 0 ? '+' : ''}${lots(flowDelta)} lots in 3 min` : null].filter(Boolean).join(', ')
  return { state: 'between', bullish: dir === 0 ? null : dir > 0, level: null, confidence: leanDir && flowDir && leanDir === flowDir ? 50 : 40,
    text: `${where}${lean != null ? ` · book near price ${Math.round(lean * 100)}% bids` : ''}`,
    move: move(dir, target, dir ? `drift ${dir > 0 ? 'up' : 'down'}${target ? ` toward ${fmt(target.price)}` : ''} (${why})` : `range${S && R ? ` ${fmt(S.price)}-${fmt(R.price)}` : ''} - the book and the delta do not lean one way`) }
}
