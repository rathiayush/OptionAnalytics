import test from 'node:test'
import assert from 'node:assert/strict'
import { profileLevels, shiftLevels, profileHits, profileAlertText, spotProfileLevels, alertOptions, newProfileWatch, watchProfiles, spotLevelsOf } from '../src/profileAlerts.js'
import { lowNodeGaps, profileGaps, sessionVolumeProfile, singlePrintGaps, tpoProfile } from '../src/profiles.js'

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

// ---- Gaps: LVN gaps (volume and market profile) and single prints ------------------------------------

// A previous session with a fast move: a morning range 22502-22538, ten minutes straight up 22540 -> 22600 on
// thin volume, an afternoon range 22602-22638. Footprint rows of 1 point (the futures' volume profile) and
// OHLC for the market profile.
const T915 = Date.parse('2026-10-08T03:45:00Z')
function gapBar(m, low, high, volume) {
  const levels = []
  for (let p = Math.ceil(low); p <= Math.floor(high); p++) levels.push({ price: p, buy: volume / 2, sell: volume / 2 })
  return { time: new Date(T915 + m * 60_000).toISOString(), open: low, high, low, close: high, volume: volume * levels.length, levels }
}
function gapDay(offset = 0) {
  const bars = []
  for (let m = 0; m < 120; m++) { const c = 22520 + offset + 15 * Math.sin(m / 7); bars.push(gapBar(m, c - 3, c + 3, 100)) }
  for (let m = 120; m < 130; m++) { const lo = 22540 + offset + (m - 120) * 6; bars.push(gapBar(m, lo, lo + 6, 20)) }
  for (let m = 130; m < 375; m++) { const c = 22620 + offset + 15 * Math.sin(m / 9); bars.push(gapBar(m, c - 3, c + 3, 100)) }
  return bars
}
const gapLevels = () => { const bars = gapDay(); return profileLevels(sessionVolumeProfile(bars), tpoProfile(bars, 5), 5) }
const gapOf = (levels) => levels.find((l) => l.gap)

test('a fast move leaves a gap: the volume profile\'s LVN gap and the market profile\'s single prints, one confluence zone', () => {
  const levels = gapLevels()
  const gap = gapOf(levels)
  assert.ok(gap, levels.map((l) => l.labels.join('+')).join(' | '))
  assert.deepEqual(gap.labels, ['VP LVN gap', 'TPO single prints'])
  assert.equal(gap.confluence, true)
  assert.ok(gap.low >= 22535 && gap.low <= 22542, `low ${gap.low}`)
  assert.ok(gap.high >= 22595 && gap.high <= 22605, `high ${gap.high}`)
  assert.equal(levels.filter((l) => l.gap).length, 1, 'one zone, not one per LVN')
  assert.ok(levels.some((l) => l.labels.includes('VP POC')) && levels.some((l) => l.labels.includes('TPO VAH')), 'POC / VAH / VAL still alert')
  assert.ok(!levels.some((l) => l.labels.includes('VP LVN')), 'the LVNs are their gap')
  assert.match(profileAlertText(gap, 22603.5, 'NIFTY futures'), /^NIFTY futures 22603\.5 entered VP LVN gap \+ TPO single prints 225\d\d\.0-22\d\d\d\.0 \(volume \+ market profile confluence\)$/)
})

test('entering a gap alerts once, from above or below - not again while price moves through it', () => {
  const levels = gapLevels()
  const gap = gapOf(levels)
  const watch = newProfileWatch()
  const gapHits = (futures) => watchProfiles(watch, { levels: { futures: levels }, prices: { futures }, tpoRow: 5 }).filter((h) => h.level.gap)
  assert.deepEqual(gapHits(22640), []) // away: armed
  assert.deepEqual(gapHits(22625), [])
  assert.equal(gapHits(gap.high + 2).length, 1, 'entered from above')
  for (const p of [22590, 22570, 22550, 22541]) assert.deepEqual(gapHits(p), [], `inside at ${p}`)
  assert.deepEqual(gapHits(22520), []) // out below, far enough to re-arm
  assert.deepEqual(gapHits(22505), [])
  assert.equal(gapHits(gap.low - 1).length, 1, 'entered from below')
  // A jump clean over the whole gap still counts.
  const jump = newProfileWatch()
  watchProfiles(jump, { levels: { futures: levels }, prices: { futures: 22500 }, tpoRow: 5 })
  assert.ok(watchProfiles(jump, { levels: { futures: levels }, prices: { futures: 22640 }, tpoRow: 5 }).some((h) => h.level.gap))
})

test('single prints at the day\'s high or low are a tail, not a gap; a gap needs more than one period on both sides', () => {
  const rows = [1, 1, 3, 4, 1, 1, 5, 4, 1, 0, 1, 6, 2, 1, 1].map((count, i) => ({ price: 100 + i * 5, count }))
  assert.deepEqual(singlePrintGaps({ rows }), [{ low: 120, high: 125 }, { low: 140, high: 150 }])
  assert.deepEqual(singlePrintGaps({ rows: [1, 1, 2, 3, 1].map((count, i) => ({ price: i * 5, count })) }), [])
})

test('an LVN whose row is not thin is a level at its row, not a gap', () => {
  const rows = [20, 22, 21, 23, 18, 22, 21, 20, 24, 20].map((total, i) => ({ price: 22500 + i, total }))
  assert.deepEqual(lowNodeGaps(rows, [22504]), [{ low: 22504, high: 22504 }])
  const gaps = profileGaps({ rows, lvn: [22504] }, null)
  assert.deepEqual(gaps[0].labels, ['VP LVN'])
  const level = profileLevels({ poc: 22508, rows, lvn: [22504] }, null, 1).find((l) => l.labels.includes('VP LVN'))
  assert.equal(level.gap, false)
  assert.match(profileAlertText(level, 22504.5, 'NIFTY futures'), /reached VP LVN 22504\.0 \(profile level\)/)
})

// The server's previous-day spot profile (OiReplayService.ComputeVolumeProfile): 60 bins over the day's range,
// each bar's volume in its close's bin, the two deepest strict dips as LVNs - plus the bins and the bars.
function serverSpotProfile(bars, profileDate) {
  const low = Math.min(...bars.map((b) => b.low))
  const size = (Math.max(...bars.map((b) => b.high)) - low) / 60
  const volume = Array(60).fill(0)
  for (const b of bars) volume[Math.max(0, Math.min(59, Math.floor((b.close - low) / size)))] += b.volume
  const price = (i) => low + (i + 0.5) * size
  const poc = volume.indexOf(Math.max(...volume))
  const dips = []
  for (let i = 1; i < 59; i++) if (i !== poc && volume[i] < volume[i - 1] && volume[i] < volume[i + 1]) dips.push(i)
  const lvn = dips.sort((a, b) => volume[a] - volume[b]).slice(0, 2).map(price)
  return {
    success: true, poc: price(poc), vah: price(Math.min(59, poc + 3)), val: price(Math.max(0, poc - 3)), hvn: [], lvn, profileDate,
    bins: volume.map((v, i) => ({ price: Math.round(price(i) * 100) / 100, volume: v })),
    bars: bars.map(({ time, open, high, low: l, close, volume: v }) => ({ time, open, high, low: l, close, volume: v })),
  }
}

test('spot: the server\'s spot volume profile gives LVN gaps from its bins, its bars the spot market profile', () => {
  const spotVp = serverSpotProfile(gapDay(-60), '2026-10-08T00:00:00')
  const levels = spotProfileLevels(spotVp, 5)
  assert.ok(levels.every((l) => l.id.startsWith('spot:') && l.date === '2026-10-08'))
  assert.ok(levels.some((l) => l.labels.includes('Spot VP POC')))
  assert.ok(levels.some((l) => l.labels.includes('Spot TPO POC') || l.labels.includes('Spot TPO VAH')), 'the spot market profile')
  const gap = gapOf(levels)
  assert.ok(gap, levels.map((l) => l.labels.join('+')).join(' | '))
  assert.ok(gap.labels.includes('Spot VP LVN gap') && gap.labels.includes('Spot TPO single prints'), gap.labels.join('+'))
  assert.equal(gap.confluence, true)
  assert.ok(gap.low <= 22482 && gap.high >= 22535, `${gap.low}-${gap.high}`)
  assert.match(profileAlertText(gap, gap.high + 1, 'NIFTY spot'), /^NIFTY spot \d+\.\d entered Spot VP LVN gap \+ Spot TPO single prints \d+\.\d-\d+\.\d \(2026-10-08\) \(volume \+ market profile confluence\)$/)
  // An older server (no bins / bars): its levels as before - one LVN, no market profile.
  const old = spotProfileLevels({ ...spotVp, bins: undefined, bars: undefined }, 5)
  assert.ok(!old.some((l) => l.gap || l.labels.some((x) => x.startsWith('Spot TPO'))))
})

test('spot uses its own profiles when it has them; the futures levels moved onto spot only without them', () => {
  const futures = gapLevels()
  const own = spotProfileLevels(serverSpotProfile(gapDay(-60), '2026-10-08'), 5)
  assert.equal(spotLevelsOf(futures, 60, own), own)
  const moved = spotLevelsOf(futures, 60, [])
  assert.equal(moved.length, futures.length)
  const gap = gapOf(moved)
  // A gap moved onto spot keeps its width and its identity, whatever the premium.
  assert.equal(gap.high - gap.low, gapOf(futures).high - gapOf(futures).low)
  assert.equal(gap.low, gapOf(futures).low - 60)
  assert.equal(gapOf(spotLevelsOf(futures, 61, [])).id, gap.id)
  assert.deepEqual(spotLevelsOf(futures, null, []), [])
})
