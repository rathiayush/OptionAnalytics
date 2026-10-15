// The scanner record's "If bought / If sold" for signals kept before those were recorded with them, or under the older rule
// (held to the index exit - src/recordLegs.js): rebuilt from that day's OI run with the live log's own rule
// (scannerCore.signalLegs - the option bought and the option sold at the strategy's strike, each out at the strategy's own
// option exit held to the index's max rules, with each index's settings now) and saved by key. Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOiContext, optionTradesFor, premiumAt, valueAt } from '../src/strategyEngine.js'
import { MIN, runnerSettingsOf } from '../src/scannerCore.js'
import { fillRecordLegs, legsFromContext, needsLegs, oldRuleLegs, recordRunUrl, signalFromRow } from '../src/recordLegs.js'
import { day } from './synthetic-day.mjs'

const { run, at } = day()
const ist = (ms) => new Date(ms + 330 * MIN).toISOString().slice(0, 19).replace('T', ' ')
const row = (m, extra = {}) => ({
  key: `NIFTY|2026-10-05|wallBreak|LONG|${at(m)}`, date: '2026-10-05', underlying: 'NIFTY', time_ist: ist(at(m)), strategy_id: 'wallBreak', side: 'LONG',
  entry: '22500', status: 'win', exit_time_ist: ist(at(m + 20)), exit_price: '22530', buy_points: '', sell_points: '', ...extra,
})

test('a closed signal row without them needs them, and one under the older rule (no exit reason) again; an open one or one done does not', () => {
  assert.equal(needsLegs(row(40)), true)
  assert.equal(oldRuleLegs(row(40)), false)
  assert.equal(needsLegs(row(40, { status: 'open', exit_time_ist: '' })), false)
  assert.equal(needsLegs(row(40, { buy_points: '12.5' })), true, 'held to the index exit: done again')
  assert.equal(oldRuleLegs(row(40, { buy_points: '12.5' })), true)
  // HALF a pair is not done: this one has the option bought but nothing for the option sold, which is what left "-"
  // down the If sold column. Both sides worked out is done.
  assert.equal(needsLegs(row(40, { buy_points: '12.5', buy_exit_reason: 'Max SL 20 pts hit' })), true, 'the sell side is still missing')
  assert.equal(oldRuleLegs(row(40, { buy_points: '12.5', buy_exit_reason: 'Max SL 20 pts hit' })), false, 'not the older rule - one side simply never had a price')
  assert.equal(needsLegs(row(40, { buy_points: '12.5', buy_exit_reason: 'Max SL 20 pts hit', sell_points: '-4', sell_exit_reason: 'with the index trade - Target hit' })), false, 'both sides done')
  // A side the day's data could not price is written as that, so it is not offered again.
  assert.equal(needsLegs(row(40, { buy_points: '12.5', buy_exit_reason: 'Max SL 20 pts hit', sell_exit_reason: 'no option price on the day' })), false)
  assert.deepEqual(signalFromRow(row(40)), { id: 'wallBreak', side: 'LONG', t: at(40), entry: 22500, outcome: { status: 'win', exitAt: at(60), exitPrice: 22530 } })
})

test('rebuilt from the day\'s OI: no settings - the ATM pair at the signal\'s spot, from its minute to the end of its exit bar', () => {
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
    assert.equal(legs[`${which}ExitTime`], at(61))
    assert.match(legs[`${which}ExitReason`], /^with the index trade - /)
  }
  assert.equal(legs.key, row(40).key)
  assert.equal(legs.buyOption.split(' ')[2], 'CE', 'a long buys the call')
})

test('with the index\'s settings: each leg out at the strategy\'s own option exit - its SL / target, held to the max rules', () => {
  const ctx = buildOiContext(run, null, { live: false })
  const [plain] = legsFromContext([row(40)], ctx)
  // wallBreak applied on NIFTY with a 1% SL / 1% target of its own (first of that or the index exit); no max rules.
  const config = { filtersByIndex: { NIFTY: { wallBreak: { tradeOptExit: 'first', tradeOptSlPct: 1, tradeOptTargetPct: 1 } } }, levels: { NIFTY: { maxSl: 0, maxTarget: 0 } } }
  const cfg = runnerSettingsOf(config, 'NIFTY')
  assert.equal(cfg.filters.wallBreak.tradeOptExit, 'first')
  const [own] = legsFromContext([row(40)], ctx, cfg)
  for (const which of ['buy', 'sell']) {
    const entry = own[`${which}Entry`]
    assert.equal(entry, plain[`${which}Entry`], 'the same option, at the same premium')
    assert.match(own[`${which}ExitReason`], /^(Max SL|Target) /, `${which}: ${own[`${which}ExitReason`]}`)
    assert.ok(own[`${which}ExitTime`] <= at(61), 'never after the index trade\'s exit')
    assert.ok(Math.abs(Math.abs(own[`${which}Points`]) - entry / 100) < 1e-9, `out at 1% of ${entry}: ${own[`${which}Points`]}`)
  }
  // The index's max rules alone (no exit of its own): each leg leaves at the Max SL / Max target it reaches first.
  const [capped] = legsFromContext([row(40)], ctx, runnerSettingsOf({ levels: { NIFTY: { maxSl: 0.25, maxTarget: 0.25 } } }, 'NIFTY'))
  for (const which of ['buy', 'sell']) {
    assert.match(capped[`${which}ExitReason`], /^(Max SL|Target) 0.25 pts hit$/)
    assert.ok(Math.abs(Math.abs(capped[`${which}Points`]) - 0.25) < 1e-9)
  }
})

test('every index and day fetched once; a day without data is reported, not guessed', async () => {
  const fetched = []
  const asked = []
  const rows = [row(40), row(70), row(90, { underlying: 'BANKNIFTY', key: 'b1' }), row(50, { buy_points: '3' }), row(55, { buy_points: '3', sell_exit_reason: 'Target 9 pts hit' })]
  const { legs, failed } = await fillRecordLegs(rows, {
    fetchRun: async (u, d) => { fetched.push(`${u} ${d}`); return u === 'NIFTY' ? run : { success: false, error: 'no data' } },
    settingsOf: (u) => { asked.push(u); return {} },
  })
  assert.deepEqual(fetched, ['NIFTY 2026-10-05', 'BANKNIFTY 2026-10-05'])
  assert.deepEqual(asked, ['NIFTY'], 'each index\'s settings, for the days it has')
  assert.deepEqual(legs.map((l) => l.key), [row(40).key, row(70).key, row(50).key, row(55).key],
    'the older rule\'s done again, and so is the one with only ONE of its two options worked out')
  assert.deepEqual(failed, [{ underlying: 'BANKNIFTY', date: '2026-10-05', reason: 'no data' }])
  assert.match(recordRunUrl('BANKNIFTY', '2026-10-05'), /^\/api\/oi-replay\/BANKNIFTY\/run\?date=2026-10-05&timeframeMinutes=1&expiryFlag=MONTH$/)
})
