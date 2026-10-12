// The scanner record's "If bought / If sold" for signals kept before those were recorded with them (src/recordLegs.js):
// rebuilt from that day's OI run with the live log's own rule (scannerCore.signalLegs - the ATM option bought and the ATM
// option sold at the signal's minute, held until its index trade exited) and saved by key. Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOiContext, optionTradesFor, premiumAt, valueAt } from '../src/strategyEngine.js'
import { MIN } from '../src/scannerCore.js'
import { fillRecordLegs, legsFromContext, needsLegs, recordRunUrl, signalFromRow } from '../src/recordLegs.js'
import { day } from './synthetic-day.mjs'

const { run, at } = day()
const ist = (ms) => new Date(ms + 330 * MIN).toISOString().slice(0, 19).replace('T', ' ')
const row = (m, extra = {}) => ({
  key: `NIFTY|2026-10-05|wallBreak|LONG|${at(m)}`, date: '2026-10-05', underlying: 'NIFTY', time_ist: ist(at(m)), strategy_id: 'wallBreak', side: 'LONG',
  entry: '22500', status: 'win', exit_time_ist: ist(at(m + 20)), exit_price: '22530', buy_points: '', sell_points: '', ...extra,
})

test('a closed signal row without them needs them; an open one or one that has them does not', () => {
  assert.equal(needsLegs(row(40)), true)
  assert.equal(needsLegs(row(40, { status: 'open', exit_time_ist: '' })), false)
  assert.equal(needsLegs(row(40, { buy_points: '12.5' })), false)
  assert.deepEqual(signalFromRow(row(40)), { side: 'LONG', t: at(40), entry: 22500, outcome: { status: 'win', exitAt: at(60), exitPrice: 22530 } })
})

test('rebuilt from the day\'s OI: the ATM pair at the signal\'s spot, from its minute to the end of its exit bar', () => {
  const ctx = buildOiContext(run, null, { live: false })
  const [legs] = legsFromContext([row(40)], ctx)
  const pair = optionTradesFor(ctx, 1, valueAt(ctx.spot, at(40)).close, at(40))
  for (const which of ['buy', 'sell']) {
    const o = pair[which]
    const entry = premiumAt(ctx, o.side, o.strike, at(40))
    const exit = premiumAt(ctx, o.side, o.strike, at(61))
    assert.equal(legs[`${which}Option`], `${o.action} ${o.strike} ${o.side}`)
    assert.deepEqual([legs[`${which}Entry`], legs[`${which}Exit`]], [entry, exit])
    assert.ok(Math.abs(legs[`${which}Points`] - (which === 'buy' ? exit - entry : entry - exit)) < 1e-9)
  }
  assert.equal(legs.key, row(40).key)
  assert.equal(legs.buyOption.split(' ')[2], 'CE', 'a long buys the call')
})

test('every index and day fetched once; a day without data is reported, not guessed', async () => {
  const fetched = []
  const rows = [row(40), row(70), row(90, { underlying: 'BANKNIFTY', key: 'b1' }), row(50, { buy_points: '3' })]
  const { legs, failed } = await fillRecordLegs(rows, {
    fetchRun: async (u, d) => { fetched.push(`${u} ${d}`); return u === 'NIFTY' ? run : { success: false, error: 'no data' } },
  })
  assert.deepEqual(fetched, ['NIFTY 2026-10-05', 'BANKNIFTY 2026-10-05'])
  assert.deepEqual(legs.map((l) => l.key), [row(40).key, row(70).key])
  assert.deepEqual(failed, [{ underlying: 'BANKNIFTY', date: '2026-10-05', reason: 'no data' }])
  assert.match(recordRunUrl('BANKNIFTY', '2026-10-05'), /^\/api\/oi-replay\/BANKNIFTY\/run\?date=2026-10-05&timeframeMinutes=1&expiryFlag=MONTH$/)
})
