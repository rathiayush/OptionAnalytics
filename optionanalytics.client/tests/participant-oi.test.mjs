// NSE's participant-wise open interest as the GEX sign (participantOi.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GEX_SIGNS, HEDGER_GROUPS, gexSignOf, gexSignOptions, participantShares, sharesText } from '../src/participantOi.js'

// NSE's own file of 13 Nov 2026, as the server gives it.
const DAY = {
  date: '2026-11-13',
  rows: [
    { type: 'Client', callLong: 3780052, putLong: 3498034, callShort: 3648876, putShort: 3942456 },
    { type: 'DII', callLong: 2363, putLong: 104506, callShort: 1350, putShort: 1200 },
    { type: 'FII', callLong: 755197, putLong: 1137053, callShort: 972780, putShort: 749988 },
    { type: 'Pro', callLong: 1321341, putLong: 1162085, callShort: 1235947, putShort: 1208034 },
    { type: 'TOTAL', callLong: 5858953, putLong: 5901678, callShort: 5858953, putShort: 5901678 },
  ],
}
const near = (a, b) => Math.abs(a - b) < 1e-12

test('the hedgers\' share of a side = (their longs - their shorts) / all the open interest of that side', () => {
  const pro = participantShares(DAY, 'pro')
  assert.ok(near(pro.call, (1321341 - 1235947) / 5858953))
  assert.ok(near(pro.put, (1162085 - 1208034) / 5901678))
  assert.equal(pro.callNet, 85394)
  assert.equal(pro.date, '2026-11-13')
  const both = participantShares(DAY, 'proFii')
  assert.ok(near(both.call, (1321341 - 1235947 + 755197 - 972780) / 5858953))
  // Everyone but the clients holds exactly the other side of the clients' book.
  const rest = participantShares(DAY, 'nonClient')
  assert.ok(near(rest.call, -(3780052 - 3648876) / 5858953))
  assert.ok(near(rest.put, -(3498034 - 3942456) / 5901678))
  // An unknown group reads as the default; every group is one of the picker's.
  assert.deepEqual(participantShares(DAY, 'nobody'), pro)
  assert.deepEqual(HEDGER_GROUPS.map((g) => g.value), ['pro', 'proFii', 'nonClient'])
})

test('no TOTAL row: the groups\' longs are the open interest; nothing to read = none', () => {
  const noTotal = { ...DAY, rows: DAY.rows.slice(0, 4) }
  assert.ok(near(participantShares(noTotal, 'pro').call, participantShares(DAY, 'pro').call))
  assert.equal(participantShares({ date: '2026-11-13', rows: [] }), null)
  assert.equal(participantShares(null), null)
  assert.equal(participantShares({ rows: DAY.rows.filter((r) => r.type !== 'Pro') }, 'pro'), null)
  assert.equal(participantShares({ rows: [{ type: 'Pro', callLong: 0, callShort: 0, putLong: 0, putShort: 0 }] }), null)
})

test('the shares in words', () => {
  assert.equal(sharesText(participantShares(DAY, 'pro')), 'Pro desks net LONG 1.5% of the calls, net SHORT 0.8% of the puts')
  assert.equal(sharesText(participantShares(DAY, 'nonClient')), 'All but clients net SHORT 2.2% of the calls, net LONG 7.5% of the puts')
  assert.equal(sharesText(null), '')
})

test('the sign shown: the NSE ones only when the day was worked out with them - else Standard', () => {
  const assumed = { standard: [], buildup: [] }
  const withNse = { ...assumed, participant: [], participantBuildup: [] }
  assert.deepEqual(gexSignOptions(assumed).map((o) => o.value), ['standard', 'buildup'])
  assert.deepEqual(gexSignOptions(withNse).map((o) => o.value), GEX_SIGNS.map((s) => s.value))
  assert.equal(gexSignOf(withNse, 'participant'), 'participant')
  assert.equal(gexSignOf(assumed, 'participant'), 'standard')
  assert.equal(gexSignOf(assumed, 'buildup'), 'buildup')
  assert.equal(gexSignOf(withNse, 'nonsense'), 'standard')
  assert.equal(gexSignOf(null, 'buildup'), 'standard')
})
