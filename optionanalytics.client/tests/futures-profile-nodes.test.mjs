// The futures chart's previous-day profile marks its HVN and LVN like the entry charts do (profiles.profileNodes on
// a candle-spread profile), drawn as price lines in the previous session's colours (setProfileLines).
import test from 'node:test'
import assert from 'node:assert/strict'
import { volumeProfileFromCandles } from '../src/orderFlowMath.js'
import { profileNodes, sessionVolumeProfile } from '../src/profiles.js'
import { setProfileLines } from '../src/volumeProfilePrimitive.js'
import { PREV_PROFILE } from '../src/profileColors.js'

// Two busy areas (peaking at 100 and at 140, the lower one busiest) with a thin stretch between them: candles of every
// width around each centre, so the volume piles up towards it as in a real session.
function twoAreaDay() {
  const candles = []
  const around = (mid, volume) => { for (let w = 1; w <= 6; w++) for (let i = 0; i < 5; i++) candles.push({ open: mid - w, close: mid + w, high: mid + w, low: mid - w, volume }) }
  around(100, 9000)
  around(140, 6000)
  for (let i = 0; i < 6; i++) candles.push({ open: 106, close: 134, high: 134, low: 106, volume: 400 })
  return candles
}

test('a candle-spread profile gets its HVN (the second busy area) and LVN (the thin stretch between)', () => {
  const profile = volumeProfileFromCandles(twoAreaDay(), 2)
  assert.ok(profile.poc >= 94 && profile.poc <= 106, `POC in the busiest area (${profile.poc})`)
  const nodes = profileNodes(profile)
  assert.ok(nodes.hvnTop >= 134 && nodes.hvnTop <= 146, `HVN in the second area (${nodes.hvnTop})`)
  assert.ok(nodes.lvnTop > 106 && nodes.lvnTop < 134, `LVN between the two (${nodes.lvnTop})`)
})

test('no rows, no nodes', () => {
  assert.deepEqual(profileNodes(volumeProfileFromCandles([], 2)), { hvn: [], lvn: [], hvnTop: null, lvnTop: null })
  assert.deepEqual(profileNodes(null), { hvn: [], lvn: [], hvnTop: null, lvnTop: null })
})

test('sessionVolumeProfile keeps its nodes (the same rule, now shared)', () => {
  const vp = sessionVolumeProfile([])
  assert.deepEqual([vp.hvn, vp.lvn, vp.hvnTop, vp.lvnTop], [[], [], null, null])
})

test('the futures chart draws POC, VAH, VAL, HVN and LVN in the previous session\'s colours', () => {
  const created = []
  const removed = []
  const series = { createPriceLine: (o) => { created.push(o); return o }, removePriceLine: (l) => removed.push(l) }
  const profile = { ...volumeProfileFromCandles(twoAreaDay(), 2) }
  Object.assign(profile, profileNodes(profile))
  const lines = setProfileLines(series, ['old'], profile, 2, ' (27 Oct)')
  assert.deepEqual(removed, ['old'])
  const byTitle = Object.fromEntries(lines.map((l) => [l.title, l]))
  assert.deepEqual(Object.keys(byTitle).sort(), ['HVN', 'LVN', 'POC (27 Oct)', 'VAH', 'VAL'])
  assert.equal(byTitle['POC (27 Oct)'].color, PREV_PROFILE.poc)
  assert.equal(byTitle.VAH.color, PREV_PROFILE.va)
  assert.equal(byTitle.HVN.color, PREV_PROFILE.hvn)
  assert.equal(byTitle.LVN.color, PREV_PROFILE.lvn)
  assert.equal(byTitle.HVN.price, profile.hvnTop + 1) // the row's middle
  assert.equal(byTitle.LVN.price, profile.lvnTop + 1)
})

test('a profile without nodes draws just POC / VAH / VAL', () => {
  const series = { createPriceLine: (o) => o, removePriceLine: () => {} }
  const profile = volumeProfileFromCandles([{ open: 100, close: 102, high: 102, low: 100, volume: 1000 }], 2)
  const titles = setProfileLines(series, [], { ...profile, ...profileNodes(profile) }, 2).map((l) => l.title).sort()
  assert.deepEqual(titles, ['POC', 'VAH', 'VAL'])
})
