// The Order Flow page's two reads of the futures' positioning and book (asked for - "build these in separate card
// components"; the cards are FlowToolCards.jsx). Pure - each from data up to the clock only; they feed no strategy or alert.
// (BOOK PRESSURE and the ORDER FLOW IMBALANCE were two more cards here and were REMOVED on request - "from order flow
// remove OFI, book pressure" - code and tests; `liquidityFlow` no longer carries a `pressure` at all.)
//
//  1. DELTA + OI POSITIONING (`positioningCandles`): each candle's aggressor delta (buy - sell) with the change in the
//     futures' open interest over it - who was aggressive AND whether positions were opened or closed:
//       buyers aggressive, OI up   = NEW LONGS (fresh buying - tends to continue)
//       buyers aggressive, OI down = SHORT COVERING (shorts buying back - tends to fade)
//       sellers aggressive, OI up  = NEW SHORTS
//       sellers aggressive, OI down = LONG LIQUIDATION
//     The futures chart's OI regimes read price x OI; this reads the AGGRESSOR x OI. A candle whose delta is under
//     `flatShare` of its volume is BALANCED (no one side aggressive); one with no OI change, or no OI reading, has no read.
//  2. NET LIQUIDITY ADDED vs PULLED (`liquidityFlow`'s `cumBid` / `cumAsk`): between two book columns, at the rows that
//     stayed AWAY from the touch in both (bids under both best bids, offers over both best offers, up to `bandRows` rows
//     out, and inside both columns' books - a level that left the book's far edge was not cancelled) nothing can have
//     traded: a rise there is orders ADDED, a drop orders PULLED - the pull / stack signals' own rule, here added up from
//     the day's first column as a running line a side. The columns are a sample of the book (every 2 s live, further
//     apart on a loaded day), so what was added and pulled again between two of them is not seen: a floor, not a count.

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

export const POSITIONING_TIMEFRAMES = [1, 3, 5, 15]
export const POSITIONING_DEFAULTS = { minutes: 5, flatShare: 0.05 }

/** The four reads (and the two with none), their words and colours. `bullish`: +1 / -1 / 0; `fresh`: positions opened. */
export const POSITIONING = {
  newLongs: { label: 'New longs', short: 'NL', text: 'buyers aggressive, OI up - fresh buying', color: '#26a69a', bullish: 1, fresh: true },
  shortCovering: { label: 'Short covering', short: 'SC', text: 'buyers aggressive, OI down - shorts buying back', color: '#9ad9d2', bullish: 1, fresh: false },
  newShorts: { label: 'New shorts', short: 'NS', text: 'sellers aggressive, OI up - fresh selling', color: '#ef5350', bullish: -1, fresh: true },
  longLiquidation: { label: 'Long liquidation', short: 'LL', text: 'sellers aggressive, OI down - longs selling out', color: '#f5b0ae', bullish: -1, fresh: false },
  balanced: { label: 'Balanced', short: '=', text: 'neither side aggressive', color: '#8c8c8c', bullish: 0, fresh: false },
  none: { label: 'No read', short: '-', text: 'no OI change (or no OI reading)', color: '#595959', bullish: 0, fresh: false },
}
export const POSITIONING_KEYS = ['newLongs', 'shortCovering', 'newShorts', 'longLiquidation']

/** The read of a candle from its `delta`, `volume` and OI change `dOi` (null = no reading). */
export function positioningOf(delta, volume, dOi, flatShare = POSITIONING_DEFAULTS.flatShare) {
  if (!(volume > 0) || !Number.isFinite(delta)) return 'none'
  if (Math.abs(delta) < flatShare * volume) return 'balanced'
  if (!Number.isFinite(dOi) || dOi === 0) return 'none'
  if (delta > 0) return dOi > 0 ? 'newLongs' : 'shortCovering'
  return dOi > 0 ? 'newShorts' : 'longLiquidation'
}

/**
 * The positioning candles of a day so far. `minuteBars`: the footprint's 1-minute bars ({ time, open, high, low, close,
 * buy, sell, estimated? }, ascending - the page's, already cut at its clock); `futuresOi`: the futures' OI readings
 * ([{ t, oi }], ascending - useDayOi's `futures`: a reading is stamped at its minute's start plus `lag`, the lag a
 * replayed day's minute is known after); `clockMs`: nothing stamped after it is read (null = all - live). Each candle
 * { time (ms, its start), open, high, low, close, buy, sell, delta, volume, oi (at its end), dOi (from the candle before's
 * end - the first candle: from the last reading before it, else its own first reading), kind, estimated }.
 */
export function positioningCandles(minuteBars, futuresOi, { minutes = POSITIONING_DEFAULTS.minutes, flatShare = POSITIONING_DEFAULTS.flatShare, lag = 0, clockMs = null } = {}) {
  const size = Math.max(1, Math.round(minutes)) * MIN
  const candles = []
  for (const b of minuteBars ?? []) {
    const ms = msOf(b.time)
    if (!Number.isFinite(ms) || !(b.open > 0)) continue
    const start = Math.floor(ms / size) * size
    let c = candles.at(-1)
    if (!c || c.time !== start) candles.push(c = { time: start, open: b.open, high: b.high, low: b.low, close: b.close, buy: 0, sell: 0, estimated: false })
    c.high = Math.max(c.high, b.high)
    c.low = Math.min(c.low, b.low)
    c.close = b.close
    c.buy += b.buy ?? 0
    c.sell += b.sell ?? 0
    if (b.estimated) c.estimated = true
  }
  // The OI readings known at the clock, by the minute they are of.
  const readings = []
  for (const p of futuresOi ?? []) {
    if (!(p?.oi > 0) || !Number.isFinite(p.t) || (clockMs != null && p.t > clockMs)) continue
    readings.push({ start: p.t - lag, oi: p.oi })
  }
  let k = 0
  let oi = null
  let first = true
  return candles.map((c) => {
    const end = c.time + size
    // The base of the first candle: the last reading before it, else its own first reading.
    let base = oi
    if (first) {
      while (k < readings.length && readings[k].start < c.time) oi = readings[k++].oi
      base = oi ?? (k < readings.length && readings[k].start < end ? readings[k].oi : null)
      first = false
    }
    let seen = false
    while (k < readings.length && readings[k].start < end) { oi = readings[k++].oi; seen = true }
    const delta = c.buy - c.sell
    const volume = c.buy + c.sell
    const dOi = seen && base != null && oi != null ? oi - base : null
    return { ...c, delta, volume, oi: seen ? oi : null, dOi, kind: positioningOf(delta, volume, dOi, flatShare) }
  })
}

/** What the candles add up to: per read { candles, delta (the |delta| done under it), oi (the |OI change|) }, `net` =
 *  fresh buying less fresh selling (new longs' delta - new shorts'), `closing` = short covering's less long
 *  liquidation's, and `lead` - the read with the most delta (null when none). `last` candles only when given. */
export function positioningSummary(candles, last = null) {
  const list = last > 0 ? (candles ?? []).slice(-last) : candles ?? []
  const by = Object.fromEntries(Object.keys(POSITIONING).map((key) => [key, { candles: 0, delta: 0, oi: 0 }]))
  for (const c of list) {
    const s = by[c.kind] ?? by.none
    s.candles++
    s.delta += Math.abs(c.delta ?? 0)
    s.oi += Math.abs(c.dOi ?? 0)
  }
  let lead = null
  for (const key of POSITIONING_KEYS) if (by[key].delta > 0 && (!lead || by[key].delta > by[lead].delta)) lead = key
  return { by, candles: list.length, net: by.newLongs.delta - by.newShorts.delta, closing: by.shortCovering.delta - by.longLiquidation.delta, lead }
}

/** The read in words: what led, and whether the buying / selling was fresh or positions closing. */
export function positioningRead(summary) {
  if (!summary?.lead) return { tone: 0, text: 'No positioning read yet - it needs candles with a delta and a futures OI change.' }
  const { by } = summary
  const buy = by.newLongs.delta + by.shortCovering.delta
  const sell = by.newShorts.delta + by.longLiquidation.delta
  const side = buy >= sell ? 1 : -1
  const fresh = side > 0 ? by.newLongs.delta : by.newShorts.delta
  const closing = side > 0 ? by.shortCovering.delta : by.longLiquidation.delta
  const share = Math.round((fresh / Math.max(1, fresh + closing)) * 100)
  const what = side > 0
    ? (fresh >= closing ? `Buying is mostly FRESH LONGS (${share}% of the aggressive buying) - a rally on new positions tends to continue` : `Buying is mostly SHORT COVERING (${100 - share}%) - a rally on covering tends to fade once the shorts are out`)
    : (fresh >= closing ? `Selling is mostly FRESH SHORTS (${share}% of the aggressive selling) - a fall on new positions tends to continue` : `Selling is mostly LONG LIQUIDATION (${100 - share}%) - a fall on longs selling out tends to fade once they are out`)
  // The other side, when it is not far behind: the day is two-sided, and what it is doing matters as much.
  const [lesser, otherFresh, otherClosing] = side > 0 ? [sell, by.newShorts.delta, by.longLiquidation.delta] : [buy, by.newLongs.delta, by.shortCovering.delta]
  const twoSided = lesser >= 0.6 * Math.max(buy, sell)
  const other = !twoSided ? '' : ` The ${side > 0 ? 'selling' : 'buying'} is nearly as large, mostly ${otherFresh >= otherClosing ? (side > 0 ? 'fresh shorts' : 'fresh longs') : (side > 0 ? 'long liquidation' : 'short covering')} - two-sided.`
  return { tone: twoSided ? 0 : side * (fresh >= closing ? 1 : 0.5), text: `${what}.${other}` }
}

// ---- The book: liquidity added / pulled ---------------------------------------------------------------

export const LIQUIDITY_FLOW_DEFAULTS = { bandRows: 10, maxGapMs: 60_000 }
/** How far out the added / pulled card counts, in rows (its picker): a wall 20 - 30 rows away being built or pulled is
 *  what the line is for. */
export const LIQUIDITY_BANDS = [10, 20, 30, 50]
export const LIQUIDITY_BAND_DEFAULT = 30

// A column's sides by row number, with each side's best and far edge - worked out once a column (and row size).
const parsedColumns = new WeakMap()
function parse(column, step) {
  const kept = parsedColumns.get(column)
  if (kept?.step === step) return kept
  const key = (p) => Math.round(p / step)
  const side = (levels) => {
    const map = new Map()
    for (const [p, q] of levels ?? []) if (q > 0 && p > 0) map.set(key(p), (map.get(key(p)) ?? 0) + q)
    return map
  }
  const bids = side(column.bids)
  const asks = side(column.asks)
  let bestBid = null, lowBid = null, bestAsk = null, highAsk = null
  for (const k of bids.keys()) { if (bestBid == null || k > bestBid) bestBid = k; if (lowBid == null || k < lowBid) lowBid = k }
  for (const k of asks.keys()) { if (bestAsk == null || k < bestAsk) bestAsk = k; if (highAsk == null || k > highAsk) highAsk = k }
  const out = { step, t: column.t, bids, asks, bestBid, lowBid, bestAsk, highAsk, ok: bestBid != null && bestAsk != null && bestAsk > bestBid }
  parsedColumns.set(column, out)
  return out
}

// What was added / pulled a side between two columns (parsed), away from the touch in both and inside both books.
const pairEvents = new WeakMap()
function eventOf(columnA, columnB, a, b, bandRows) {
  // Kept a band.
  let byBand = pairEvents.get(columnB)
  if (!byBand || byBand.from !== columnA || byBand.step !== b.step) pairEvents.set(columnB, byBand = { from: columnA, step: b.step, events: new Map() })
  const kept = byBand.events.get(bandRows)
  if (kept) return kept
  const ev = { bidAdded: 0, bidPulled: 0, askAdded: 0, askPulled: 0 }
  const bidCut = Math.min(a.bestBid, b.bestBid)
  const bidEdge = Math.max(a.lowBid, b.lowBid)
  for (let k = Math.max(bidCut - bandRows, bidEdge); k <= bidCut - 1; k++) {
    const change = (b.bids.get(k) ?? 0) - (a.bids.get(k) ?? 0)
    if (change > 0) ev.bidAdded += change; else ev.bidPulled -= change
  }
  const askCut = Math.max(a.bestAsk, b.bestAsk)
  const askEdge = Math.min(a.highAsk, b.highAsk)
  for (let k = askCut + 1; k <= Math.min(askCut + bandRows, askEdge); k++) {
    const change = (b.asks.get(k) ?? 0) - (a.asks.get(k) ?? 0)
    if (change > 0) ev.askAdded += change; else ev.askPulled -= change
  }
  byBand.events.set(bandRows, ev)
  return ev
}

/**
 * The book through the day, a point a column: `columns` - the heatmap's ({ t (ms), bids, asks } as [price, quantity]
 * rows, ascending; the page's, already cut at its clock), `rowSize` their rows, `bandRows` how far out added / pulled
 * are counted. Each point { t, mid, bidAdded, bidPulled, askAdded, askPulled (since the column before - 0 across a gap over `maxGapMs`
 * or a column with no book), cumBid, cumAsk (added - pulled a side, from the first column) }. A column without both
 * sides is left out. Each point from the columns up to it only.
 */
export function liquidityFlow(columns, { rowSize, bandRows = LIQUIDITY_FLOW_DEFAULTS.bandRows, maxGapMs = LIQUIDITY_FLOW_DEFAULTS.maxGapMs, clockMs = null } = {}) {
  const step = rowSize > 0 ? rowSize : 0.05
  const out = []
  let prev = null, prevColumn = null
  let cumBid = 0, cumAsk = 0
  for (const column of columns ?? []) {
    if (!column || !Number.isFinite(column.t) || (clockMs != null && column.t > clockMs)) continue
    const c = parse(column, step)
    if (!c.ok) continue
    const ev = prev && c.t - prev.t <= maxGapMs && c.t > prev.t ? eventOf(prevColumn, column, prev, c, bandRows) : { bidAdded: 0, bidPulled: 0, askAdded: 0, askPulled: 0 }
    cumBid += ev.bidAdded - ev.bidPulled
    cumAsk += ev.askAdded - ev.askPulled
    out.push({ t: c.t, mid: ((c.bestBid + c.bestAsk) / 2) * step, ...ev, cumBid, cumAsk })
    prev = c
    prevColumn = column
  }
  return out
}

/** `points` (liquidityFlow) as one point every `seconds`: the bucket's last mid and running totals, and what was added /
 *  pulled in it - { t (ms, the bucket's start), ... }. */
export function bucketFlow(points, seconds = 10) {
  const size = Math.max(1, seconds) * 1000
  const out = []
  for (const p of points ?? []) {
    const t = Math.floor(p.t / size) * size
    let b = out.at(-1)
    if (!b || b.t !== t) out.push(b = { t, mid: p.mid, bidAdded: 0, bidPulled: 0, askAdded: 0, askPulled: 0, cumBid: p.cumBid, cumAsk: p.cumAsk })
    b.mid = p.mid
    b.cumBid = p.cumBid
    b.cumAsk = p.cumAsk
    b.bidAdded += p.bidAdded; b.bidPulled += p.bidPulled; b.askAdded += p.askAdded; b.askPulled += p.askPulled
  }
  return out
}

/** An EMA of `values` over `length` points (the first value starts it) - each from itself and those before. */
export function emaLine(values, length) {
  if (!(length > 1)) return [...(values ?? [])]
  const k = 2 / (length + 1)
  let ema = null
  return (values ?? []).map((v) => (ema = ema == null ? v : v * k + ema * (1 - k)))
}

const lastAtOrBefore = (points, t) => {
  let lo = 0, hi = points.length - 1, found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= t) { found = points[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

/**
 * What was added and pulled over the last `windowMin` minutes of `points` (liquidityFlow): { bidNet, askNet (added -
 * pulled a side), bidAdded, bidPulled, askAdded, askPulled, move (the mid's change), kind, tone, text }. `kind`: what
 * leads - 'bidStack' (bids added: support building), 'bidPull' (bids pulled: support withdrawn), 'askStack' (offers
 * added: resistance building), 'askPull' (offers pulled: resistance withdrawn), 'quiet'. A side's net counts when it is
 * at least `share` of everything that changed on both sides.
 */
export function liquidityRead(points, { windowMin = 5, share = 0.15 } = {}) {
  if (!points?.length) return null
  const end = points.at(-1)
  const from = end.t - windowMin * MIN
  const start = lastAtOrBefore(points, from) ?? points[0]
  const sum = { bidAdded: 0, bidPulled: 0, askAdded: 0, askPulled: 0 }
  for (let i = points.length - 1; i >= 0 && points[i].t > from; i--) for (const key of Object.keys(sum)) sum[key] += points[i][key]
  const bidNet = sum.bidAdded - sum.bidPulled
  const askNet = sum.askAdded - sum.askPulled
  const total = sum.bidAdded + sum.bidPulled + sum.askAdded + sum.askPulled
  const move = end.mid - start.mid
  let kind = 'quiet'
  if (total > 0) {
    const big = Math.abs(bidNet) >= Math.abs(askNet) ? ['bid', bidNet] : ['ask', askNet]
    if (Math.abs(big[1]) >= share * total) kind = `${big[0]}${big[1] > 0 ? 'Stack' : 'Pull'}`
  }
  const up = move > 0 ? 'rising' : move < 0 ? 'falling' : 'flat'
  const text = {
    bidStack: `Bids are being ADDED under the price (support building) - price ${up}.`,
    bidPull: `Bids are being PULLED from under the price (support withdrawn) - price ${up}${move < 0 ? ': a fall with the bids stepping away can run' : ''}.`,
    askStack: `Offers are being ADDED over the price (resistance building) - price ${up}${move > 0 ? ': a rise into stacking offers is being sold into' : ''}.`,
    askPull: `Offers are being PULLED from over the price (resistance withdrawn) - price ${up}${move > 0 ? ': a rise with the offers stepping away can run' : ''}.`,
    quiet: 'Little net change in the resting orders on either side.',
  }[kind]
  return { ...sum, bidNet, askNet, move, kind, tone: kind === 'bidStack' || kind === 'askPull' ? 1 : kind === 'bidPull' || kind === 'askStack' ? -1 : 0, text }
}

// ---- Order flow imbalance at the touch ------------------------------------------------------------------------------
