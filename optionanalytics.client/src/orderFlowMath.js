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
export function analyzeBars(bars, { rowSize, minVolume = 1, ...options } = {}) {
  const { imbalanceRatio, stackedCount, absorptionFactor, exhaustionPct } = { ...DEFAULT_ANALYSIS, ...options }
  const step = rowSize > 0 ? rowSize : null
  let cvd = 0
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
