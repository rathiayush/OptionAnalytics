// A saved strategy's live orders history (signalStrategyHistory.js): the server's entry / exit lines joined ONE ROW A
// TRADE - punched when, at what LIMIT, its stop-loss and target, closed when / at what price / why.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderTrades } from '../src/signalStrategyHistory.js'

const line = (o) => ({ date: '2026-11-06', underlying: 'NIFTY', option: 'NIFTY 24500 CE', action: 'BUY', lots: '2', price: '', sl: '', target: '', reason: '', orderIds: '', message: '', ...o })

test('an entry and its exit are one trade: punched at, LIMIT, SL, target, exit time, price and reason', () => {
  // As the server lists them: newest first.
  const rows = [
    line({ timeUtc: '2026-11-06T05:40:05Z', trade: '2026-11-06|rule|1', kind: 'exit', status: 'exited', price: '131.5', reason: 'Trailing stop', orderIds: '5251', message: 'SELL x150 at LIMIT 131.5' }),
    line({ timeUtc: '2026-11-06T05:12:05Z', trade: '2026-11-06|mirror|2', kind: 'entry', status: 'skipped', option: 'NIFTY 24500 PE', lots: '0', reason: 'the strategy\'s live trade has no exit yet' }),
    line({ timeUtc: '2026-11-06T04:31:05Z', trade: '2026-11-06|rule|1', kind: 'entry', status: 'placed', price: '121.5', sl: '84.5', target: '181', orderIds: '5250', message: 'BUY x150 at LIMIT 121.5' }),
  ]
  const [skipped, first] = orderTrades(rows)
  assert.deepEqual(
    { status: first.status, placedAt: first.placedAt, price: first.price, sl: first.sl, target: first.target, lots: first.lots, orderIds: first.orderIds, side: first.side },
    { status: 'placed', placedAt: '2026-11-06T04:31:05Z', price: 121.5, sl: 84.5, target: 181, lots: 2, orderIds: '5250', side: 'rule' },
  )
  assert.deepEqual(
    { exitStatus: first.exitStatus, exitAt: first.exitAt, exitPrice: first.exitPrice, exitReason: first.exitReason, open: first.open },
    { exitStatus: 'exited', exitAt: '2026-11-06T05:40:05Z', exitPrice: 131.5, exitReason: 'Trailing stop', open: false },
  )
  // Newest first; a skipped entry says why and is never "open".
  assert.equal(skipped.side, 'mirror')
  assert.equal(skipped.status, 'skipped')
  assert.match(skipped.reason, /no exit yet/)
  assert.equal(skipped.open, false)
  assert.equal(skipped.price, null)
})

test('a placed trade with no exit yet is open; a line written before the price columns reads with no prices', () => {
  const [t] = orderTrades([line({ timeUtc: '2026-11-06T04:31:05Z', trade: '2026-11-06|rule|1', kind: 'entry', status: 'placed', orderIds: '5250', price: undefined, sl: undefined })])
  assert.equal(t.open, true)
  assert.equal(t.price, null)
  assert.equal(t.sl, null)
  assert.deepEqual(orderTrades(undefined), [])
})
