// The live data the strategy scanner reads, kept up to date from the server's pushes - without React, so
// the Order Flow page and the server-side scanner runner build exactly the same picture:
//   - the futures order flow (bars, prints, icebergs, sweeps, the heatmap's book columns) from a REST
//     snapshot plus each "orderFlowLive" push,
//   - the Time & Sales tape,
//   - the day's option / futures / index OI context from a REST load plus "oiReplayTicks",
//     "futuresTicks" and "spotUpdate".

import { bucketBook, mergeLiveMinutes, rebucketColumns } from './orderFlowMath.js'

const MIN = 60_000
export const HEATMAP_COLUMN_MS = 2000
export const MAX_HEATMAP_COLUMNS = 3000
export const MAX_TRADES = 5000
// Time & Sales prints kept/fetched for the tape (and its aggression windows).
export const TAPE_PRINTS = 1500

export const toColumn = (c) => ({ t: new Date(c.time).getTime(), bids: c.bids, asks: c.asks })

export const mergePrints = (a, b) => {
  const bySeq = new Map()
  for (const p of a) bySeq.set(p.seq, p)
  for (const p of b) bySeq.set(p.seq, p)
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq).slice(-TAPE_PRINTS)
}

// The order flow view from GET /api/order-flow/{underlying} (the live snapshot).
export function orderFlowFromSnapshot(body) {
  return {
    meta: body.meta, minuteBars: body.bars, trades: body.trades, icebergs: body.icebergs, book: body.book, sweeps: body.sweeps ?? [],
    heatmap: body.heatmap.map(toColumn), lastSeq: body.trades.at(-1)?.seq ?? 0, source: body.source,
    backfill: body.backfill ?? [], recordedFrom: body.recordedFrom ?? null,
  }
}

// The view with its heatmap fetched in `fineRow` rows (the server's heatmapRowSize - the heatmap card's own rows,
// heatmapFetchRow): that is kept as `heatFine` for the picture only, and `heatmap` - what the scanner, the liquidity
// reads and the replayed book use - is it re-bucketed into the footprint's `rowSize` rows, the same rows the server
// would have sent. Nothing changes when the rows are the same.
export function withFineHeatmap(view, fineRow, rowSize) {
  if (!view || !(fineRow > 0) || fineRow === rowSize) return view
  return { ...view, heatFine: view.heatmap, heatFineRow: fineRow, heatmap: rebucketColumns(view.heatmap, rowSize) }
}

// One "orderFlowLive" push folded into the view: new prints, icebergs and sweeps, the forming minute
// bars (in `rowSize` rows) and - every HEATMAP_COLUMN_MS - a new heatmap column of the whole book.
export function applyOrderFlowPush(prev, payload, rowSize) {
  if (!prev) return prev
  const now = payload.time ? new Date(payload.time).getTime() : Date.now()
  const freshTrades = (payload.trades ?? []).filter((t) => t.seq > prev.lastSeq)
  const trades = freshTrades.length ? [...prev.trades, ...freshTrades].slice(-MAX_TRADES) : prev.trades
  const icebergs = new Map(prev.icebergs.map((i) => [i.id, i]))
  for (const i of payload.icebergs ?? []) icebergs.set(i.id, i)
  const sweeps = new Map((prev.sweeps ?? []).map((w) => [w.id, w]))
  for (const w of payload.sweeps ?? []) sweeps.set(w.id, w)
  const lastColumn = prev.heatmap.at(-1)
  // The whole book for the heatmap: "heat" is every level (200 a side) in 0.5-point rows; the
  // "book" is the same whole book, level by level (the ladder and the strategies' DOM read).
  const heatBids = payload.heat?.bids ?? payload.book?.bids
  const heatAsks = payload.heat?.asks ?? payload.book?.asks
  const newColumn = !lastColumn || now - lastColumn.t >= HEATMAP_COLUMN_MS
  const heatmap = newColumn
    ? [...prev.heatmap, { t: now, bids: bucketBook(heatBids, rowSize), asks: bucketBook(heatAsks, rowSize) }].slice(-MAX_HEATMAP_COLUMNS)
    : prev.heatmap
  // The heatmap card's own finer rows (withFineHeatmap) get the same column.
  const heatFine = newColumn && prev.heatFine
    ? [...prev.heatFine, { t: now, bids: bucketBook(heatBids, prev.heatFineRow), asks: bucketBook(heatAsks, prev.heatFineRow) }].slice(-MAX_HEATMAP_COLUMNS)
    : prev.heatFine
  return {
    ...prev, meta: payload.meta, book: payload.book, trades, heatmap, ...(heatFine ? { heatFine } : {}),
    icebergs: [...icebergs.values()].sort((a, b) => a.id - b.id),
    sweeps: [...sweeps.values()].sort((a, b) => a.id - b.id).slice(-500),
    minuteBars: mergeLiveMinutes(prev.minuteBars, payload.bars, rowSize),
    lastSeq: freshTrades.at(-1)?.seq ?? prev.lastSeq,
  }
}

// ---- OI context (strategyEngine.buildOiContext) kept live ----------------------------------------

// The OI expiry flag the scanner reads per underlying (BANKNIFTY has no weekly).
export const expiryFlagOf = (underlying) => (underlying === 'BANKNIFTY' ? 'MONTH' : 'WEEK')

// "oiReplayTicks" into the context's strike series. True when something changed.
export function applyOiTicks(ctx, ticks, underlying, flag) {
  if (!ctx || !ticks?.length) return false
  let changed = false
  for (const tick of ticks) {
    if (tick?.underlying !== underlying || tick?.expiryFlag !== flag) continue
    const map = tick.side === 'CE' ? ctx.ce : ctx.pe
    // A packet without OI reads 0 - never let it wipe the minute's real OI.
    if (upsertMinute(map, Number(tick.strike), tick.time, { oi: tick.openInterest > 0 ? tick.openInterest : null, price: tick.price, high: tick.high ?? tick.price, low: tick.low ?? tick.price })) changed = true
  }
  return changed
}

// "futuresTicks" into the context's futures series.
export function applyFuturesTicks(ctx, ticks, underlying) {
  if (!ctx || !ticks?.length) return false
  let changed = false
  for (const tick of ticks) {
    if (tick?.underlying !== underlying) continue
    if (upsertSeries(ctx.futures, tick.time, { close: tick.price, oi: tick.openInterest > 0 ? tick.openInterest : null })) changed = true
  }
  return changed
}

// "spotUpdate" (the index's forming minute) into the context's spot series.
export function applySpotUpdate(ctx, snapshot, underlying) {
  if (!ctx || snapshot?.underlying !== underlying || !snapshot?.currentBar) return false
  return upsertSeries(ctx.spot, snapshot.currentBar.time, { close: snapshot.currentBar.close })
}

// A tick into a strike's minute series (the REST run is one point per minute): updates the current
// minute's point, or starts the next minute. True when something changed.
export function upsertMinute(map, strike, time, values) {
  if (!Number.isFinite(strike)) return false
  let series = map.get(strike)
  if (!series) { series = []; map.set(strike, series) }
  return upsertSeries(series, time, values)
}

export function upsertSeries(series, time, values) {
  const ms = new Date(time).getTime()
  if (!Number.isFinite(ms)) return false
  const t = Math.floor(ms / MIN) * MIN
  const last = series[series.length - 1]
  const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null && Number.isFinite(v)))
  if (last && last.t === t) {
    // Within the minute the range widens; everything else is the newest reading.
    if (clean.high != null && last.high != null) clean.high = Math.max(last.high, clean.high)
    if (clean.low != null && last.low != null) clean.low = Math.min(last.low, clean.low)
    Object.assign(last, clean)
    return true
  }
  if (last && last.t > t) return false
  series.push({ t, ...clean })
  return true
}
