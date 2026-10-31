// OI Replay - trade in another index than the charts (tradeIndex.js): which index the paper trades go to, its expiry
// series, and its ATM strike at the replay clock with nothing after it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveTradeIndex, tradeAtmAt, tradeExpiryFlag, tradeRunKey } from '../src/tradeIndex.js'

const MIN = 60_000
const OPEN = Date.parse('2026-10-23T09:15:00+05:30')

test('the trade index: the one picked on a replayed day; the charts\' index live, or when none / the same is picked', () => {
  assert.equal(effectiveTradeIndex('SENSEX', 'NIFTY', false), 'SENSEX')
  assert.equal(effectiveTradeIndex('SENSEX', 'NIFTY', true), 'NIFTY')
  assert.equal(effectiveTradeIndex('', 'NIFTY', false), 'NIFTY')
  assert.equal(effectiveTradeIndex('NIFTY', 'NIFTY', false), 'NIFTY')
  assert.equal(effectiveTradeIndex('FINNIFTY', 'NIFTY', false), 'NIFTY')
})

test('its expiry series follows the charts\' - BANKNIFTY monthly only', () => {
  assert.equal(tradeExpiryFlag('SENSEX', 'WEEK'), 'WEEK')
  assert.equal(tradeExpiryFlag('SENSEX', 'MONTH'), 'MONTH')
  assert.equal(tradeExpiryFlag('BANKNIFTY', 'WEEK'), 'MONTH')
  assert.equal(tradeRunKey('SENSEX', '2026-10-23', 'WEEK'), 'SENSEX|2026-10-23|WEEK')
})

test('its ATM strike is read at the replay clock from its own spot - the minute shown, never a later one', () => {
  const bars = [81990, 82040, 82160, 82260].map((close, i) => ({ time: new Date(OPEN + i * MIN).toISOString(), close }))
  assert.equal(tradeAtmAt(bars, 100, OPEN), 82000)
  assert.equal(tradeAtmAt(bars, 100, OPEN + 1 * MIN), 82000)
  assert.equal(tradeAtmAt(bars, 100, OPEN + 2 * MIN), 82200)
  // Mid-minute: still the minute that started before the clock.
  assert.equal(tradeAtmAt(bars, 100, OPEN + 2 * MIN + 30_000), 82200)
  assert.equal(tradeAtmAt(bars, 100, OPEN + 9 * MIN), 82300)
  assert.equal(tradeAtmAt(bars, 100, OPEN - MIN), null)
  assert.equal(tradeAtmAt(bars, 0, OPEN), null)
  assert.equal(tradeAtmAt([], 100, OPEN), null)
  assert.equal(tradeAtmAt(bars, 100, null), null)
})
