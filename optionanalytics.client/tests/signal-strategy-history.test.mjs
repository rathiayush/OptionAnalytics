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

// ---- the list's order: strategies by total profit, trades by date and time (asked for) ------------------------------------------
import { sortStrategies, sortTrades, totalOf } from '../src/signalStrategyHistory.js'

test('strategies are sorted by TOTAL profit, best first, ties by name - a missing total reads as 0', () => {
  const list = [{ name: 'B', totalNet: -500 }, { name: 'C' }, { name: 'A', totalNet: 12000.5 }, { name: 'D', totalNet: '300' }, { name: 'E', totalNet: 0 }]
  assert.deepEqual(sortStrategies(list).map((s) => s.name), ['A', 'D', 'C', 'E', 'B'])
  assert.equal(totalOf({ totalNet: 'x' }), 0)
  assert.deepEqual(list.map((s) => s.name), ['B', 'C', 'A', 'D', 'E'])        // the list given is not changed
  assert.deepEqual(sortStrategies(undefined), [])
})

test('trades are sorted by date and then time of entry - newest first, or the other way', () => {
  const rows = [
    { date: '2026-11-27', entryTime: '09:49' }, { date: '2026-11-26', entryTime: '14:02' }, { date: '2026-11-27', entryTime: '12:24' },
    { date: '2026-11-27', entryTime: '09:34' }, { date: '2026-11-27', entryTime: '12:29' },
  ]
  assert.deepEqual(sortTrades(rows).map((t) => `${t.date.slice(8)} ${t.entryTime}`), ['27 12:29', '27 12:24', '27 09:49', '27 09:34', '26 14:02'])
  assert.deepEqual(sortTrades(rows, { ascending: true }).map((t) => `${t.date.slice(8)} ${t.entryTime}`), ['26 14:02', '27 09:34', '27 09:49', '27 12:24', '27 12:29'])
  assert.deepEqual(sortTrades(null), [])
})
