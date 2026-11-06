// A saved strategy's LIVE ORDERS history (history/{id}-orders.csv - SignalLiveOrders on the server) as the History's "Live
// orders" tab shows it: ONE ROW A TRADE - when its order was punched, at what LIMIT, its stop-loss and target, and when /
// at what price it was closed and why - joined from the file's entry and exit lines (asked for - "history about order
// punched at what time, exit, SL, target price").

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * The live order lines (as the server lists them, any order) joined a trade each, newest first:
 * { key, date, trade, side ('rule' | 'mirror'), option, action, lots, status (the entry's: placed / partly placed / not
 * placed / skipped), placedAt, price (the entry's LIMIT), sl, target, orderIds, reason (why not placed), message, open
 * (placed, no exit yet), exitStatus (exited / closed by Dhan's target / ... / exit failed), exitAt, exitPrice, exitReason
 * (the strategy's - Trailing stop, Cost SL, ...), exitMessage }.
 */
export function orderTrades(rows) {
  const byTrade = new Map()
  const lines = [...(rows ?? [])].sort((a, b) => String(a.timeUtc ?? '').localeCompare(String(b.timeUtc ?? '')))
  for (const r of lines) {
    const key = `${r.date}|${r.trade}`
    const t = byTrade.get(key) ?? {
      key, date: r.date, trade: r.trade, side: String(r.trade ?? '').split('|')[1] === 'mirror' ? 'mirror' : 'rule',
      option: r.option, action: r.action, lots: num(r.lots) ?? 0, status: null, placedAt: null, price: null, sl: null, target: null,
      orderIds: '', reason: '', message: '', exitStatus: null, exitAt: null, exitPrice: null, exitReason: '', exitMessage: '',
    }
    if (r.kind === 'entry') {
      Object.assign(t, {
        status: r.status, placedAt: r.timeUtc, price: num(r.price), sl: num(r.sl), target: num(r.target), orderIds: r.orderIds ?? '',
        reason: r.reason ?? '', message: r.message ?? '', lots: num(r.lots) ?? t.lots, option: r.option || t.option, action: r.action || t.action,
      })
    } else if (r.kind === 'exit') {
      Object.assign(t, { exitStatus: r.status, exitAt: r.timeUtc, exitPrice: num(r.price), exitReason: r.reason ?? '', exitMessage: r.message ?? '' })
    }
    byTrade.set(key, t)
  }
  return [...byTrade.values()]
    .map((t) => ({ ...t, open: Boolean(t.orderIds) && !t.exitStatus }))
    .sort((a, b) => String(b.placedAt ?? b.exitAt ?? '').localeCompare(String(a.placedAt ?? a.exitAt ?? '')))
}
