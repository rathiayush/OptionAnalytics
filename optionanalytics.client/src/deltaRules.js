// The Order Flow page's Delta rules card's figures (OrderFlowDeltaRules.jsx) - pure, so they are tested.

/** The share of `rows`' packets holding more than one trade, and of their volume: { packets, multi, packetPct, volumePct }
 *  over the rows that have the counts (a candle recorded before them has none) - null when none has. */
export function multiTradeShare(rows) {
  let packets = 0, multi = 0, volume = 0, multiVolume = 0, counted = 0
  for (const r of rows ?? []) {
    if (r?.packets == null || r.multiPackets == null) continue
    counted++
    packets += r.packets
    multi += r.multiPackets
    volume += r.volume ?? 0
    multiVolume += r.multiVolume ?? 0
  }
  if (!counted || !(packets > 0)) return null
  return { packets, multi, packetPct: (multi / packets) * 100, volumePct: volume > 0 ? (multiVolume / volume) * 100 : null }
}
