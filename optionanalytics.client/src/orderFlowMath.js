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
}

// Per bar: POC, diagonal imbalances, stacked imbalance zones, absorption, exhaustion, and the
// running cumulative delta.
//
// - Imbalance (diagonal, as footprint tools compare it): a BUY imbalance at price p when the buying
//   at p is at least `imbalanceRatio` x the selling one row BELOW (p - row) - buyers lifted offers
//   far harder than sellers hit the bid beneath; a SELL imbalance at p when the selling at p is at
//   least that ratio x the buying one row ABOVE. Both need at least `minVolume`, and the row compared
//   against must exist in the bar.
// - Stacked imbalance: `stackedCount`+ consecutive rows imbalanced the same way - a buy stack is
//   support (aggressive buyers stepped up level after level), a sell stack resistance.
// - Absorption: heavy aggression into a bar's extreme that failed to move price - selling at the
//   bottom two rows of at least `absorptionFactor` x the bar's average row volume while the bar
//   closed off its low (buyers absorbed it - bullish), or the mirror at the top (bearish).
// - Exhaustion: almost nothing traded at the bar's extreme - the top row under `exhaustionPct` of the
//   bar's volume means buyers ran out at the high (bearish), the bottom row the same for sellers.
//
// `estimated` bars (a day rebuilt from 1-minute candles - their rows are an even spread, not real
// trades) get no per-row imbalances, and absorption / exhaustion from the candles instead - see
// candleSignals.
export function analyzeBars(bars, { rowSize, minVolume = 1, estimated = false, ...options } = {}) {
  const { imbalanceRatio, stackedCount, absorptionFactor, exhaustionPct } = { ...DEFAULT_ANALYSIS, ...options }
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
  return bars.map((bar) => {
    cvd += bar.delta
    const ascending = [...bar.levels].sort((a, b) => a.price - b.price)
    const byPrice = new Map(ascending.map((l) => [l.price, l]))
    const nextRow = (price, dir) => (step ? round2(price + dir * step) : null)

    let poc = null
    const imbalances = new Map()
    for (const level of ascending) {
      if (!poc || level.buy + level.sell > poc.buy + poc.sell) poc = level
      const below = byPrice.get(nextRow(level.price, -1))
      const above = byPrice.get(nextRow(level.price, 1))
      // Only against a row that exists: at a bar's extreme there is nothing diagonal to compare with,
      // and flagging every top/bottom row would be noise.
      const buyImb = below != null && level.buy >= minVolume && level.buy >= imbalanceRatio * below.sell
      const sellImb = above != null && level.sell >= minVolume && level.sell >= imbalanceRatio * above.buy
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
    if (rows >= 3 && bar.volume > 0) {
      const avgRow = bar.volume / rows
      const bottom = ascending.slice(0, 2)
      const top = ascending.slice(-2)
      const sellLow = bottom.reduce((s, l) => s + l.sell, 0)
      const buyLow = bottom.reduce((s, l) => s + l.buy, 0)
      const buyHigh = top.reduce((s, l) => s + l.buy, 0)
      const sellHigh = top.reduce((s, l) => s + l.sell, 0)
      const lowRow = ascending[0].price
      const highRow = ascending[rows - 1].price
      const closeRow = step ? rowOf(bar.close, step) : bar.close
      if (sellLow >= absorptionFactor * avgRow && sellLow > buyLow && closeRow > (step ? round2(lowRow + step) : lowRow)) {
        absorption.push({ side: 'buy', price: lowRow, volume: sellLow })
      }
      if (buyHigh >= absorptionFactor * avgRow && buyHigh > sellHigh && closeRow < (step ? round2(highRow - step) : highRow)) {
        absorption.push({ side: 'sell', price: highRow, volume: buyHigh })
      }
    }
    if (rows >= 4 && bar.volume >= minVolume * 10) {
      const topRow = ascending[rows - 1]
      const bottomRow = ascending[0]
      if (topRow.buy + topRow.sell <= exhaustionPct * bar.volume) exhaustion.push({ side: 'sell', price: topRow.price })
      if (bottomRow.buy + bottomRow.sell <= exhaustionPct * bar.volume) exhaustion.push({ side: 'buy', price: bottomRow.price })
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
  let pocIndex = 0
  rows.forEach((r, i) => { if (r.total > rows[pocIndex].total) pocIndex = i })
  let lo = pocIndex
  let hi = pocIndex
  let inArea = rows[pocIndex].total
  while (inArea < valueAreaPct * total && (lo > 0 || hi < rows.length - 1)) {
    const below = lo > 0 ? rows[lo - 1].total : -1
    const above = hi < rows.length - 1 ? rows[hi + 1].total : -1
    if (above >= below) { hi++; inArea += rows[hi].total } else { lo--; inArea += rows[lo].total }
  }
  return { rows, poc: rows[pocIndex].price, vah: rows[hi].price, val: rows[lo].price, total, maxRow: rows[pocIndex].total }
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
  const lastTrade = trades.at(-1)
  const lastBar = minuteBars.at(-1)
  return {
    ...day,
    meta: { ...day.meta, lastPrice: lastTrade?.price ?? lastBar?.close ?? 0, lastTradeAt: lastTrade?.time ?? null },
    minuteBars, trades, heatmap, icebergs, book,
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
