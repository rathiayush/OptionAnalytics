// The Delta rules card's "Several trades" figures (deltaRules.js): the share of Dhan's market feed packets holding more than
// one trade (volume over the LTQ) and of their volume - over the candles that have the counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { multiTradeShare } from '../src/deltaRules.js'

test('the share of packets and volume holding more than one trade, over the candles with the counts', () => {
  const rows = [
    { volume: 10_000, packets: 40, multiPackets: 10, multiVolume: 6_000 },
    { volume: 5_000, packets: 10, multiPackets: 5, multiVolume: 4_000 },
    { volume: 9_999, packets: null, multiPackets: null, multiVolume: null },   // recorded before the counts: left out
  ]
  const s = multiTradeShare(rows)
  assert.equal(s.packets, 50)
  assert.equal(s.multi, 15)
  assert.equal(s.packetPct, 30)
  assert.ok(Math.abs(s.volumePct - (10_000 / 15_000) * 100) < 1e-9)
  // No candle with the counts, or no packet: nothing to say.
  assert.equal(multiTradeShare([{ volume: 1, packets: null, multiPackets: null }]), null)
  assert.equal(multiTradeShare([{ volume: 0, packets: 0, multiPackets: 0, multiVolume: 0 }]), null)
  assert.equal(multiTradeShare(null), null)
})
