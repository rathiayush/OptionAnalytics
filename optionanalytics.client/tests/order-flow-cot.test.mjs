// The footprint's COT high / low (Sierra Chart's "Commitment of Traders"): the server keeps each minute's delta after its
// last new high / low; a 3 / 5 / 15-minute bar adds them up exactly (aggregateBars).
import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateBars } from '../src/orderFlowMath.js'

const T = Date.parse('2026-10-05T04:00:00Z') // 09:30 IST
const m = (i, high, low, buy, sell, cotHigh, cotLow) => ({ time: T + i * 60_000, open: low, high, low, close: high, buy, sell, trades: 1, levels: [], cotHigh, cotLow })

test('a bar made of minutes: its COT is the minute that made the high / low plus every minute after', () => {
  const [bar] = aggregateBars([
    m(0, 100, 99, 50, 10, 5, 30),     // the low of the bar is made here (99)
    m(1, 102, 100, 80, 20, -15, 40),  // the high of the bar is made here (102): after it -15
    m(2, 101, 99.5, 10, 70, -60, 20), // no new high or low: its whole delta -60 adds
  ], 5)
  assert.equal(bar.high, 102)
  assert.equal(bar.low, 99)
  assert.equal(bar.cotHigh, -15 + (10 - 70))
  assert.equal(bar.cotLow, 30 + (80 - 20) + (10 - 70))
})

test('an equal high later is not a new one; a new low later restarts the count', () => {
  const [bar] = aggregateBars([m(0, 102, 100, 40, 10, 8, 12), m(1, 102, 98, 20, 60, -3, -7)], 5)
  assert.equal(bar.cotHigh, 8 + (20 - 60))
  assert.equal(bar.cotLow, -7)
})

test('a minute with no COT (estimated / saved before it) leaves the bar none only when it made the extreme', () => {
  const [bar] = aggregateBars([m(0, 101, 99, 40, 10, undefined, 6), m(1, 100.5, 99.5, 20, 30, undefined, undefined)], 5)
  assert.equal(bar.cotHigh, null)
  assert.equal(bar.cotLow, 6 + (20 - 30))
  const [one] = aggregateBars([m(0, 101, 99, 40, 10, 4, -2)], 1)
  assert.deepEqual([one.cotHigh, one.cotLow], [4, -2])
})
