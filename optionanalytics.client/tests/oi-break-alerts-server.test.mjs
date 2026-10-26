// The OI totals S/R break and high-probability alerts on the SERVER scanner (scanner-runner/indexScanner.mjs
// checkOiBreaks): the same step as the OI Replay page (oiLevelBreaks.js stepOiBreakAlerts) on the runner's live OI,
// Telegram tagged [Server] and keyed like the page's - so they arrive with no page open, once each.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner, TAG } from '../scanner-runner/indexScanner.mjs'
import { IST_OFFSET_SECONDS, perStrikeChanges, perStrikeLevels, newOiBreakAlertState, stepOiBreakAlerts, newBreakWatch, watchBreaks, completedLevelReads } from '../src/oiLevelBreaks.js'
import { buildOiTotalsRows } from '../src/oiTotalsHeatmap.js'

const MIN = 60_000
const DATE = '2026-10-26'
const T0 = Date.UTC(2026, 9, 26, 3, 45)   // 09:15 IST
// The ATM strike's CE cumulative: two swing lows at 60, then a hard fall through it at minute 16.
const BIG = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, -200, -210, -220]
const STRIKES = [24950, 25000, 25050]
// 3 lakh a strike: the fall takes the ATM ± 1 CE OI from 9.8 L to 7 L (-28.6%) - calls unwinding, bullish.
const BASE = 300_000

// The runner's live OI context after `n` minutes: strike -> [{ t, oi }] (minute start), spot at 25000.
function oiAfter(n, pattern = BIG) {
  const ce = new Map(STRIKES.map((k) => [k, []]))
  const pe = new Map(STRIKES.map((k) => [k, []]))
  for (let m = 0; m < n; m++) {
    for (const k of STRIKES) {
      ce.get(k).push({ t: T0 + m * MIN, oi: BASE + (k === 25000 ? 1000 * pattern[m] : 0) })
      pe.get(k).push({ t: T0 + m * MIN, oi: BASE })
    }
  }
  return { step: 50, live: true, ce, pe, futures: [], spot: [{ t: T0 + (n - 1) * MIN, close: 25000 }] }
}

function scannerWithIo(config = {}) {
  const io = { clock: T0, sent: [], logs: [], now: () => io.clock, log: (m) => io.logs.push(m), telegram: async (text, key) => { io.sent.push({ text, key }) } }
  const scanner = new IndexScanner('NIFTY', io)
  scanner.reset(DATE)
  scanner.setConfig({ settings: { telegram: true }, ...config })
  return { scanner, io }
}

// Each minute once it is over (plus a second), as the market clock would run.
async function runMinutes(scanner, io, upTo, pattern = BIG) {
  for (let n = 2; n <= upTo; n++) {
    io.clock = T0 + n * MIN + 1000
    await scanner.checkOiBreaks({ oi: oiAfter(n, pattern) }, io.clock)
  }
}

test('per-strike changes from a live series are each bucket\'s last OI less the bucket before', () => {
  const series = new Map([[25000, [{ t: T0, oi: 100 }, { t: T0 + MIN, oi: 130 }, { t: T0 + 2 * MIN, oi: 120 }, { t: T0 + 3 * MIN, oi: null }]]])
  const one = perStrikeChanges(series, 60).get(25000)
  const sec = (m) => (T0 + m * MIN) / 1000 + IST_OFFSET_SECONDS
  assert.deepEqual([...one], [[sec(1), 30], [sec(2), -10]])
  const three = perStrikeChanges(series, 180).get(25000)
  assert.equal(three.size, 0)   // all in one 3-min bucket: nothing before it
})

test('the shared step is the page\'s break watch plus the high-probability watch', () => {
  const ce = perStrikeChanges(oiAfter(17).ce, 60)
  const pe = perStrikeChanges(oiAfter(17).pe, 60)
  const nowSec = (T0 + 17 * MIN) / 1000 + IST_OFFSET_SECONDS
  const state = newOiBreakAlertState()
  const levels = (n) => ({ ceLevels: perStrikeLevels(oiAfter(n).ce, 60), peLevels: perStrikeLevels(oiAfter(n).pe, 60) })
  stepOiBreakAlerts(state, { ce: perStrikeChanges(oiAfter(16).ce, 60), pe: perStrikeChanges(oiAfter(16).pe, 60), ...levels(16), bucketSeconds: 60, nowSec: nowSec - 60, atmStrike: 25000 })
  const { breaks, signals } = stepOiBreakAlerts(state, { ce, pe, ...levels(17), bucketSeconds: 60, nowSec, atmStrike: 25000 })
  const watch = newBreakWatch()
  watchBreaks(watch, completedLevelReads(buildOiTotalsRows(perStrikeChanges(oiAfter(16).ce, 60), perStrikeChanges(oiAfter(16).pe, 60)), 60, nowSec - 60), 60)
  const direct = watchBreaks(watch, completedLevelReads(buildOiTotalsRows(ce, pe), 60, nowSec), 60)
  assert.deepEqual(breaks.map((b) => b.key), direct.map((b) => b.key))
  assert.equal(signals.length, 1)
  assert.equal(signals[0].hp.bullish, true)
})

test('the server sends the break and the high-probability signal to Telegram, tagged and keyed, once each', async () => {
  const { scanner, io } = scannerWithIo()
  await runMinutes(scanner, io, 19)
  const breaks = io.sent.filter((m) => m.text.startsWith(`${TAG} 🧱 NIFTY OI CE cumulative Δ broke below support`))
  assert.equal(breaks.length, 1, JSON.stringify(io.sent.map((m) => m.text)))
  assert.match(breaks[0].text, /calls unwinding - bullish/)
  assert.match(breaks[0].key, /^oi-break\|NIFTY\|NIFTY-2026-10-26\|1\|ce\|down\|\d+$/)
  const hp = io.sent.filter((m) => m.text.startsWith(`${TAG} 🎯 HIGH PROBABILITY BULLISH · NIFTY`))
  assert.equal(hp.length, 1)
  assert.match(hp[0].text, /ATM ± 1 \(24950 \/ 25000 \/ 25050\) in 5 min: CE OI shifted -\d+\.\d%/)
  assert.match(hp[0].key, /^oi-hp\|NIFTY\|NIFTY-2026-10-26\|1\|bull\|\d+$/)
  assert.equal(new Set(io.sent.map((m) => m.key)).size, io.sent.length, 'every message once')
  // The page's status: settings and what was sent.
  const status = scanner.status().oiBreakAlerts
  assert.equal(status.on, true)
  assert.equal(status.sent.length, io.sent.length)
})

test('switched off on the page (config.oiBreakAlerts.on false) the server sends nothing', async () => {
  const { scanner, io } = scannerWithIo({ oiBreakAlerts: { on: false } })
  await runMinutes(scanner, io, 19)
  assert.equal(io.sent.length, 0)
})

test('the page\'s window and % reach the server: the ATM ± 1 % decides whether the same break is a 🎯', async () => {
  // The ATM ± 1 CE fall peaks around -33% in the window: a 40% bar is never cleared, 20% is.
  const strict = scannerWithIo({ oiBreakAlerts: { on: true, windowMinutes: 5, atmShiftPct: 40 } })
  await runMinutes(strict.scanner, strict.io, 19)
  assert.ok(strict.io.sent.some((m) => m.text.includes('🧱')))
  assert.ok(!strict.io.sent.some((m) => m.text.includes('🎯')), JSON.stringify(strict.io.sent.map((m) => m.text)))
  assert.deepEqual([strict.scanner.status().oiBreakAlerts.windowMinutes, strict.scanner.status().oiBreakAlerts.atmShiftPct], [5, 40])

  const loose = scannerWithIo({ oiBreakAlerts: { on: true, windowMinutes: 5, atmShiftPct: 20 } })
  await runMinutes(loose.scanner, loose.io, 19)
  assert.ok(loose.io.sent.some((m) => m.text.includes('🎯')), JSON.stringify(loose.io.sent.map((m) => m.text)))

  const capped = scannerWithIo({ oiBreakAlerts: { atmShiftPct: 100_000, windowMinutes: 99 } })
  assert.deepEqual([capped.scanner.status().oiBreakAlerts.atmShiftPct, capped.scanner.status().oiBreakAlerts.windowMinutes], [500, 15])
})

test('a break already there when the day loads is not sent, and Telegram off in the scanner settings sends nothing', async () => {
  const late = scannerWithIo()
  late.io.clock = T0 + 19 * MIN + 1000
  await late.scanner.checkOiBreaks({ oi: oiAfter(19) }, late.io.clock)   // first look: the day so far is only remembered
  late.io.clock += MIN
  await late.scanner.checkOiBreaks({ oi: oiAfter(19) }, late.io.clock)
  assert.equal(late.io.sent.length, 0)

  const quiet = scannerWithIo({ settings: { telegram: false } })
  await runMinutes(quiet.scanner, quiet.io, 19)
  assert.equal(quiet.io.sent.length, 0)
  assert.ok(quiet.scanner.status().oiBreakAlerts.sent.length >= 2, 'still logged for the page')
})
