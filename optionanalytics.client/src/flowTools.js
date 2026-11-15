// The Order Flow page's two reads of the futures' positioning and book flow (asked for - "build these in separate card
// components"; the cards are FlowToolCards.jsx). Pure - each from data up to the clock only; they feed no strategy or alert.
//
//  1. DELTA + OI POSITIONING (`positioningCandles`): each candle's aggressor delta (buy - sell) with the change in the
//     futures' open interest over it - who was aggressive AND whether positions were opened or closed:
//       buyers aggressive, OI up   = NEW LONGS (fresh buying - tends to continue)
//       buyers aggressive, OI down = SHORT COVERING (shorts buying back - tends to fade)
//       sellers aggressive, OI up  = NEW SHORTS
//       sellers aggressive, OI down = LONG LIQUIDATION
//     The futures chart's OI regimes read price x OI; this reads the AGGRESSOR x OI. A candle whose delta is under
//     `flatShare` of its volume is BALANCED (no one side aggressive); one with no OI change, or no OI reading, has no read.
//  2. ORDER FLOW IMBALANCE (`ofiSeries` / `ofiCandles`) - Cont, Kukanov & Stoikov's OFI (2014, "The price impact of
//     order book events"): between two pictures of the book, at the BEST bid and offer,
//       e = q_bid(now) x [bid now >= bid before] - q_bid(before) x [bid now <= bid before]
//         - q_ask(now) x [ask now <= ask before] + q_ask(before) x [ask now >= ask before]
//     (q the size at the best price). Buyers lifting the offer, bids joining or stepping up add; sellers hitting the bid,
//     offers joining or stepping down subtract - market orders, limit orders and cancels at the touch in one number. In
//     their study it explains most of the price's move over the same few seconds to minutes (it is the book's flow, the
//     tape's delta is only the market orders). The columns are a SAMPLE of the book (every 2 s live, further apart on a
//     loaded day), so it is the net of what happened between two of them.
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

// ---- Order flow imbalance at the touch ------------------------------------------------------------------------------

export const OFI_DEFAULTS = { maxGapMs: 60_000 }
export const OFI_TIMEFRAMES = [1, 3, 5, 15]

// A column's best bid / offer (in rows of `step`) and the size there - worked out once a column (and row size).
const parsedColumns = new WeakMap()
function best(column, step) {
  const kept = parsedColumns.get(column)
  if (kept?.step === step) return kept
  const key = (p) => Math.round(p / step)
  let bid = null, bidQ = 0, ask = null, askQ = 0
  for (const [p, q] of column.bids ?? []) {
    if (!(q > 0 && p > 0)) continue
    const k = key(p)
    if (bid == null || k > bid) { bid = k; bidQ = q } else if (k === bid) bidQ += q
  }
  for (const [p, q] of column.asks ?? []) {
    if (!(q > 0 && p > 0)) continue
    const k = key(p)
    if (ask == null || k < ask) { ask = k; askQ = q } else if (k === ask) askQ += q
  }
  const out = { step, bid, bidQ, ask, askQ, ok: bid != null && ask != null && ask > bid }
  parsedColumns.set(column, out)
  return out
}

/** Cont's OFI between two parsed books (`best`). */
export function ofiStep(a, b) {
  let e = 0
  if (b.bid >= a.bid) e += b.bidQ
  if (b.bid <= a.bid) e -= a.bidQ
  if (b.ask <= a.ask) e -= b.askQ
  if (b.ask >= a.ask) e += a.askQ
  return e
}

/**
 * OFI through the day, a point a column: `columns` - the heatmap's ({ t (ms), bids, asks } as [price, quantity] rows;
 * the page's, already cut at its clock), `rowSize` their rows. Each point { t, mid (points), ofi (since the column before
 * - 0 across a gap over `maxGapMs`, the first column and after one without both sides), cum (from the first column) }.
 * A column without both sides is left out. Each point from the columns up to it only.
 */
export function ofiSeries(columns, { rowSize, maxGapMs = OFI_DEFAULTS.maxGapMs, clockMs = null } = {}) {
  const step = rowSize > 0 ? rowSize : 0.05
  const out = []
  let prev = null, prevT = null, cum = 0
  for (const column of columns ?? []) {
    if (!column || !Number.isFinite(column.t) || (clockMs != null && column.t > clockMs)) continue
    if (prevT != null && column.t <= prevT) continue
    const c = best(column, step)
    if (!c.ok) { prev = null; continue }
    const ofi = prev && column.t - prevT <= maxGapMs ? ofiStep(prev, c) : 0
    cum += ofi
    out.push({ t: column.t, mid: ((c.bid + c.ask) / 2) * step, ofi, cum })
    prev = c
    prevT = column.t
  }
  return out
}

/**
 * `points` (ofiSeries) as candles of `minutes` (from the IST day's 09:15 - minutes since the epoch, which IST's
 * 5 h 30 min keeps aligned): { time (ms, the candle's start), open / high / low / close (the book's mid), ofi (the
 * candle's OFI), cum (the day's to its end), move (its close less the candle before's close - its open for the first) }.
 */
export function ofiCandles(points, minutes = 1) {
  const size = Math.max(1, minutes) * MIN
  const out = []
  for (const p of points ?? []) {
    const time = Math.floor(p.t / size) * size
    let c = out.at(-1)
    if (!c || c.time !== time) out.push(c = { time, open: p.mid, high: p.mid, low: p.mid, close: p.mid, ofi: 0, cum: p.cum, move: 0, base: out.at(-1)?.close ?? p.mid })
    c.high = Math.max(c.high, p.mid)
    c.low = Math.min(c.low, p.mid)
    c.close = p.mid
    c.ofi += p.ofi
    c.cum = p.cum
    c.move = c.close - c.base
  }
  return out.map(({ base, ...c }) => c)
}

const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0)

/**
 * How well OFI went with the price on these candles - measured, not assumed: `together` = the share of candles with both
 * an OFI and a move whose signs agree (the same candle - what Cont et al. found strong), `next` = the share where a
 * candle's OFI sign matched the NEXT candle's move (what it says ahead - near 50% = nothing), each with its count.
 */
export function ofiAgreement(candles) {
  let same = 0, n = 0, ahead = 0, m = 0
  for (let i = 0; i < (candles?.length ?? 0); i++) {
    const c = candles[i]
    if (sign(c.ofi) && sign(c.move)) { n++; if (sign(c.ofi) === sign(c.move)) same++ }
    const after = candles[i + 1]
    if (after && sign(c.ofi) && sign(after.move)) { m++; if (sign(c.ofi) === sign(after.move)) ahead++ }
  }
  return { together: n ? same / n : null, n, next: m ? ahead / m : null, m }
}

/**
 * The last `last` candles' OFI against their price move: { ofi, move, lean (ofi / the sum of their |ofi|, -1 ... 1),
 * kind, tone, text }. `kind`: 'buy' / 'sell' (the flow leans that way and price went with it), 'absorbedUp' (buying flow,
 * price not up - offers refilling: the buying is being absorbed), 'absorbedDown' (the mirror), 'even'. A lean counts from
 * `lean`; a move from `movePct` % of the price.
 */
export function ofiRead(candles, { last = 5, lean = 0.2, movePct = 0.03 } = {}) {
  const recent = (candles ?? []).slice(-last)
  if (!recent.length) return null
  let ofi = 0, gross = 0
  for (const c of recent) { ofi += c.ofi; gross += Math.abs(c.ofi) }
  const end = recent.at(-1)
  const move = end.close - (recent[0].close - recent[0].move)
  const share = gross ? ofi / gross : 0
  const moved = Math.abs(move) >= (movePct / 100) * end.close
  let kind = 'even'
  if (share >= lean) kind = moved && move > 0 ? 'buy' : 'absorbedUp'
  else if (share <= -lean) kind = moved && move < 0 ? 'sell' : 'absorbedDown'
  const pts = `${move > 0 ? '+' : ''}${move.toFixed(1)} pts`
  const text = {
    buy: `Buying flow at the touch (bids joining / stepping up, offers taken) and price went with it (${pts}) - the move is backed by the book's flow.`,
    sell: `Selling flow at the touch (offers joining / stepping down, bids hit) and price went with it (${pts}) - the move is backed by the book's flow.`,
    absorbedUp: `Buying flow at the touch but price ${moved ? 'fell' : 'did not move'} (${pts}) - the offers keep refilling: the buying is being absorbed.`,
    absorbedDown: `Selling flow at the touch but price ${moved ? 'rose' : 'did not move'} (${pts}) - the bids keep refilling: the selling is being absorbed.`,
    even: `No clear flow either way at the touch (${pts}).`,
  }[kind]
  return { ofi, move, lean: share, kind, tone: kind === 'buy' ? 1 : kind === 'sell' ? -1 : 0, text }
}
