import test from 'node:test'
import assert from 'node:assert/strict'
import { profileLevels, shiftLevels, profileHits, profileAlertText, spotProfileLevels, alertOptions, newProfileWatch, watchProfiles, spotLevelsOf } from '../src/profileAlerts.js'

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

test('spot levels are the futures levels less the premium - the same level identity whatever the premium', () => {
  const levels = profileLevels(vp, tpo, 5)
  const spot = shiftLevels(levels, -30)
  assert.equal(spot[0].price, levels[0].price - 30)
  assert.equal(spot[0].id, levels[0].id)
  assert.equal(shiftLevels(levels, -31)[0].id, spot[0].id)
  assert.match(profileAlertText(spot.find((l) => l.labels.includes('VP POC')), 24471, 'NIFTY spot'), /NIFTY spot 24471\.0 reached VP POC \+ TPO POC 24471\.0 \(volume \+ market profile confluence\)/)
})

test('the bug that hid spot alerts: the premium ticking as spot walks up to the POC no longer disarms it', () => {
  const futures = profileLevels(vp, tpo, 5) // POC 24501 (VP + TPO)
  const watch = newProfileWatch()
  const look = (spot, basis) => watchProfiles(watch, { levels: { futures, spot: spotLevelsOf(futures, basis, []) }, prices: { spot }, tpoRow: 5 })
  assert.deepEqual(look(24400, 61), []) // far below: armed
  assert.deepEqual(look(24430, 62), [])
  assert.deepEqual(look(24436, 60), [])
  const hits = look(24438.5, 63) // POC on spot = 24501 - 63 = 24438 - a premium never seen while price was away
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].level.labels, ['VP POC', 'TPO POC'])
  assert.equal(hits[0].market, 'spot')
  assert.deepEqual(look(24439, 62), []) // once
})

test('the previous day\'s spot volume profile (the OI Replay lines) as spot levels', () => {
  const spotVp = { success: true, poc: 22473.98, vah: 22564.47, val: 22380.1, hvn: [22420, 22300], lvn: [22402.89, 22500], profileDate: '2026-10-08' }
  const levels = spotProfileLevels(spotVp, 5)
  assert.deepEqual(levels.map((l) => l.labels[0]), ['Spot VP VAL', 'Spot VP LVN', 'Spot VP HVN', 'Spot VP POC', 'Spot VP VAH'])
  assert.ok(levels.every((l) => l.id.startsWith('spot:') && l.date === '2026-10-08'))
  assert.deepEqual(spotProfileLevels(null, 5), [])
  // Spot at 22470.8 - 3.2 below that POC - counts as reaching it (NIFTY tolerance ~4 points).
  const watch = newProfileWatch()
  watchProfiles(watch, { levels: { spot: levels }, prices: { spot: 22440 }, tpoRow: 5 })
  const hits = watchProfiles(watch, { levels: { spot: levels }, prices: { spot: 22470.8 }, tpoRow: 5 })
  assert.deepEqual(hits.map((h) => h.level.labels[0]), ['Spot VP POC'])
  assert.match(profileAlertText(hits[0].level, 22470.8, 'NIFTY spot'), /NIFTY spot 22470\.8 reached Spot VP POC 22473\.98? \(2026-10-08\)|NIFTY spot 22470\.8 reached Spot VP POC 22474\.0 \(2026-10-08\)/)
})

test('tolerance: half a TPO row or 0.018% of the price, re-arming four times further away', () => {
  assert.deepEqual(alertOptions(5, 22470), { tolerance: 22470 * 0.00018, rearmDistance: 4 * 22470 * 0.00018 })
  assert.equal(alertOptions(10, 1000).tolerance, 5)
})

test('a market switched off is still tracked, so switching it on next to a level does not alert at once', () => {
  const futures = profileLevels(vp, null, 5)
  const watch = newProfileWatch()
  watchProfiles(watch, { levels: { futures }, prices: { futures: 24450 }, enabled: { futures: false }, tpoRow: 5 })
  assert.deepEqual(watchProfiles(watch, { levels: { futures }, prices: { futures: 24500 }, enabled: { futures: false }, tpoRow: 5 }), [])
  assert.deepEqual(watchProfiles(watch, { levels: { futures }, prices: { futures: 24501 }, enabled: { futures: true }, tpoRow: 5 }), [])
})
