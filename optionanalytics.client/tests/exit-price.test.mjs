// An option leaving a trade at its signal's exit is priced at the close of the minute the signal ended in - the same
// live as replayed - and once the scanner has announced the exit it is kept: what Telegram said is what the record keeps.
// (Live, the minute after the exit is still running and its price moves for a minute: reading it gave a Telegram exit of
// 535.9 and a record of 550.7 for the same trade.) Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { asReplayContext, buildOiContext, closePremiumAt, premiumAt } from '../src/strategyEngine.js'
import { newPosition, positionRows, scannerLogBody, MIN } from '../src/scannerCore.js'
import { IndexScanner, TAG } from '../scanner-runner/indexScanner.mjs'
import { ALL_IDS } from '../src/scannerCore.js'
import { day } from './synthetic-day.mjs'

const T = Date.parse('2026-10-13T03:45:00Z') // 09:15 IST
const at = (m) => T + m * MIN
const iso = (ms) => new Date(ms).toISOString()

/** A live day's option chain up to minute `upTo`: the 72400 CE's price each minute; the running minute (`upTo`) at
 *  `running` - what it has traded so far. */
function liveDay(prices, upTo, running) {
  const points = (side) => prices.slice(0, upTo + 1).map((p, m) => ({ time: iso(at(m)), strike: 72400, openInterest: 1e6, price: m === upTo ? running : p, side }))
  return buildOiContext({ success: true, date: '2026-10-13', step: 100, cePoints: points('CE'), pePoints: points('PE'), futuresBars: [], spotCandlesOneMinute: prices.slice(0, upTo + 1).map((_, m) => ({ time: iso(at(m)), open: 72400, high: 72400, low: 72400, close: 72400 })) }, null, { live: true })
}
// The CE: 508.4 at the entry minute, then up; the exit minute (minute 40) closes at 535.9; the next one runs to 550.7.
const PRICES = Array.from({ length: 50 }, (_, m) => (m < 30 ? 508.4 : m < 40 ? 508.4 + (m - 29) * 2 : m === 40 ? 535.9 : 550.7))

test('the close of the minute that ended at a time: live steps back to it, a replayed day reads it as is', () => {
  const early = liveDay(PRICES, 41, 538.0) // a few seconds into the minute after the exit
  const late = liveDay(PRICES, 41, 550.7) // that minute over
  assert.equal(premiumAt(early, 'CE', 72400, at(41)), 538.0, 'the old read: the NEXT minute, still running')
  assert.equal(premiumAt(late, 'CE', 72400, at(41)), 550.7, '... and a minute later it had moved')
  assert.equal(closePremiumAt(early, 'CE', 72400, at(41)), 535.9)
  assert.equal(closePremiumAt(late, 'CE', 72400, at(41)), 535.9, 'the exit minute\'s close - final')
  assert.equal(closePremiumAt(asReplayContext(late), 'CE', 72400, at(41)), 535.9, 'the same as the replayed day')
  assert.equal(closePremiumAt(buildOiContext({ success: true, date: '2026-10-13', step: 100, cePoints: PRICES.map((p, m) => ({ time: iso(at(m)), strike: 72400, openInterest: 1e6, price: p })), pePoints: [], futuresBars: [], spotCandlesOneMinute: [] }, null, { live: false }), 'CE', 72400, at(41)), 535.9)
})

test('a paper trade out with its signal: the exit minute\'s close, whenever it is read - and kept once announced', () => {
  const setup = { id: 'spotSides', t: at(30), side: 'LONG', entry: 72400, stop: 72300, target: 72600 }
  const trade = { action: 'BUY', side: 'CE', strike: 72400, premium: 508.4 }
  const p = newPosition({ setup, trade, which: 'buy', lots: 3, lotSize: 20, premium: 508.4, cfg: { paperSl: 0, paperTarget: 0 }, at: at(30), plan: { own: true, exit: 'index', slPts: null, targetPts: null } })
  // The signal's target was hit in minute 40 (its bar ends at 41).
  const ended = [{ ...setup, outcome: { status: 'win', r: 2, exitAt: at(40), exitPrice: 72600 } }]
  const rowAt = (oi, nowMs) => positionRows({ positions: [p], dayResults: ended, withOutcome: ended, oi, nowMs, settings: { paperLots: 3 } })[0]
  const first = rowAt(liveDay(PRICES, 41, 538.0), at(41) + 5_000)
  const later = rowAt(liveDay(PRICES, 45, 550.7), at(45) + 5_000)
  assert.equal(first.exitTime, at(41))
  assert.equal(first.current, 535.9, 'when Telegram announced it')
  assert.equal(later.current, 535.9, 'and in the record minutes later')
  assert.equal(first.points, 535.9 - 508.4)
  // Kept on the position (as the server scanner does) - a reload of the day with other prices changes nothing.
  const kept = { ...p, exitTime: first.exitTime, exitPremium: first.current, exitReason: first.exitReason, exitFinal: true }
  const reloaded = liveDay(PRICES.map((x) => x + 9), 45, 560)
  const [k] = positionRows({ positions: [kept], dayResults: ended, withOutcome: ended, oi: reloaded, nowMs: at(45), settings: { paperLots: 3 } })
  assert.equal(k.current, 535.9)
  assert.equal(k.exitReason, first.exitReason)
  assert.equal(k.rupees, (535.9 - 508.4) * 3 * 20)
})

test('the record: the option side a signal was traded on IS that trade - If bought equals the trade beside it', () => {
  const setup = { id: 'spotSides', t: at(30), side: 'LONG', entry: 72400, stop: 72300, target: 72600, options: { buy: { action: 'BUY', side: 'CE', strike: 72400, premium: 508.4 }, sell: { action: 'SELL', side: 'PE', strike: 72400, premium: 500 } } }
  const ended = { ...setup, outcome: { status: 'win', r: 2, exitAt: at(40), exitPrice: 72600 } }
  const row = { key: `spotSides-${at(30)}-buy`, setupKey: `spotSides-${at(30)}`, setupT: at(30), strategy: 'spotSides', setupSide: 'LONG', action: 'BUY', side: 'CE', strike: 72400,
    premium: 508.4, current: 535.9, exitTime: at(41), exitReason: 'Target hit', lots: 3, lotSize: 20, entryTime: at(30), points: 27.5, rupees: 1650 }
  const body = scannerLogBody({ underlying: 'SENSEX', date: '2026-10-13', source: 'server', dayResults: [ended], rows: [row], oi: liveDay(PRICES, 45, 550.7) })
  const sig = body.signals[0]
  assert.deepEqual([sig.buyEntry, sig.buyExit, sig.buyPoints, sig.buyExitTime, sig.buyExitReason], [508.4, 535.9, 535.9 - 508.4, at(41), 'Target hit'])
  assert.equal(body.trades[0].buyPoints, sig.buyPoints, 'the trade row\'s If bought is its own')
  assert.equal(body.trades[0].exitPremium, 535.9)
})
