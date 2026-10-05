// Costs of an option trade (paper or live), so P&L is shown net: STT on the SELL side's premium
// turnover, a flat brokerage per order (one to open, one to close) and a flat amount per trade for
// everything else (exchange / SEBI charges, stamp duty, GST). The trader sets the rates in the
// scanner; the defaults are 0.15% STT, Rs 20 + Rs 20 brokerage and Rs 7 other.

export const DEFAULT_CHARGES = { sttPct: 0.15, brokeragePerOrder: 20, otherPerTrade: 7 }

/** The charge rates set (missing / invalid ones fall back to the defaults; 0 is a valid rate). */
export function chargeRates(cfg) {
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d)
  return {
    sttPct: num(cfg?.sttPct, DEFAULT_CHARGES.sttPct),
    brokeragePerOrder: num(cfg?.brokeragePerOrder, DEFAULT_CHARGES.brokeragePerOrder),
    otherPerTrade: num(cfg?.otherPerTrade, DEFAULT_CHARGES.otherPerTrade),
  }
}

/**
 * One trade's gross and net P&L. `trade`: { action 'BUY' | 'SELL' (the opening side), premium (entry),
 * current (the exit premium, or the latest one while open), lots, lotSize }.
 * STT is on the sell leg: the entry premium of a SELL, the exit / current premium of a BUY (none while
 * that is unknown). Brokerage counts both orders even while the trade is open (the round trip it will
 * cost). Returns { qty, points, gross, stt, brokerage, other, charges, net, netPerLot } - points are
 * premium points per unit, the rest rupees; null when the trade has no price yet.
 */
export function tradeCharges(trade, cfg) {
  const rates = chargeRates(cfg)
  const lots = Math.max(1, Number(trade.lots) || 1)
  const lotSize = Math.max(1, Number(trade.lotSize) || 1)
  const qty = lots * lotSize
  const entry = Number(trade.premium)
  const now = trade.current == null ? null : Number(trade.current)
  if (!Number.isFinite(entry) || now == null || !Number.isFinite(now)) return null
  const sell = trade.action === 'SELL'
  const points = sell ? entry - now : now - entry
  const gross = points * qty
  const sellPremium = sell ? entry : now
  const stt = (rates.sttPct / 100) * sellPremium * qty
  const brokerage = 2 * rates.brokeragePerOrder
  const other = rates.otherPerTrade
  const charges = stt + brokerage + other
  const net = gross - charges
  // The same trade done with one lot: its points x one lot, STT on one lot, the same flat charges.
  const netPerLot = points * lotSize - (rates.sttPct / 100) * sellPremium * lotSize - brokerage - other
  return { qty, points, gross, stt, brokerage, other, charges, net, netPerLot }
}

/** Totals over trades (those with a price): how many, total points captured (premium points, summed per
 *  trade), gross, charges, net, and the net per lot (each trade as if done with one lot, summed). */
export function chargesSummary(trades, cfg) {
  const sum = { trades: 0, points: 0, gross: 0, stt: 0, brokerage: 0, other: 0, charges: 0, net: 0, netPerLot: 0 }
  for (const t of trades ?? []) {
    const c = tradeCharges(t, cfg)
    if (!c) continue
    sum.trades++
    for (const k of ['points', 'gross', 'stt', 'brokerage', 'other', 'charges', 'net', 'netPerLot']) sum[k] += c[k]
  }
  return sum
}
