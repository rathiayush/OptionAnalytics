import test from 'node:test'
import assert from 'node:assert/strict'
import { profileLevels, shiftLevels, profileHits, profileAlertText } from '../src/profileAlerts.js'

const vp = { poc: 24500, vah: 24600, val: 24400, hvn: [24700], lvn: [24550] }
const tpo = { poc: 24502, vah: 24650, val: 24400 }
const opts = { tolerance: 5, rearmDistance: 20 }

test('volume and market profile levels at the same price are one confluence level', () => {
  const levels = profileLevels(vp, tpo, 5)
  const poc = levels.find((l) => l.labels.includes('VP POC'))
  assert.deepEqual(poc.labels, ['VP POC', 'TPO POC'])
  assert.equal(poc.confluence, true)
  assert.equal(poc.price, 24501)
  assert.equal(levels.find((l) => l.labels.includes('VP VAL')).confluence, true) // 24400 on both
  const lvn = levels.find((l) => l.labels.includes('VP LVN'))
  assert.equal(lvn.confluence, false)
  assert.equal(levels.length, 6) // VAL, POC, LVN, VP VAH, TPO VAH, HVN
})

test('profile levels from only one profile are never a confluence', () => {
  assert.ok(profileLevels(vp, null, 5).every((l) => !l.confluence))
  assert.ok(profileLevels(null, tpo, 5).every((l) => !l.confluence))
})

test('a hit alerts once, then not again until price has moved away', () => {
  const levels = profileLevels(vp, null, 5)
  const armed = new Set()
  assert.deepEqual(profileHits(levels, 0, 24450, armed, opts), []) // first look: only arms (price is >20 from VAH 24600 etc.)
  const hit = profileHits(levels, 24450, 24498, armed, opts)
  assert.deepEqual(hit.map((l) => l.labels[0]), ['VP POC'])
  assert.deepEqual(profileHits(levels, 24498, 24501, armed, opts), []) // still on it
  profileHits(levels, 24501, 24530, armed, opts) // 29 away: re-arms
  assert.equal(profileHits(levels, 24530, 24502, armed, opts).length, 1)
})

test('a gap straight through a level still alerts, and opening next to a level does not', () => {
  const levels = profileLevels(vp, null, 5)
  const armed = new Set()
  profileHits(levels, 0, 24300, armed, opts) // far below everything: all armed
  const hit = profileHits(levels, 24300, 24420, armed, opts) // jumps over VAL 24400
  assert.deepEqual(hit.map((l) => l.labels[0]), ['VP VAL'])
  const next = new Set()
  assert.deepEqual(profileHits(levels, 0, 24501, next, opts), []) // starts on POC: not armed
  assert.deepEqual(profileHits(levels, 24501, 24503, next, opts), [])
})

test('spot levels are the futures levels less the premium, with their own keys', () => {
  const levels = profileLevels(vp, tpo, 5)
  const spot = shiftLevels(levels, -30)
  assert.equal(spot[0].price, levels[0].price - 30)
  assert.notEqual(spot[0].key, levels[0].key)
  assert.match(profileAlertText(spot.find((l) => l.labels.includes('VP POC')), 24471, 'NIFTY spot'), /NIFTY spot 24471\.0 reached VP POC \+ TPO POC 24471\.0 \(volume \+ market profile confluence\)/)
})
