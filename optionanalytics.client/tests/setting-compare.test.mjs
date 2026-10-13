// Trades → Strategy performance → Compare: what runs now on an index against a new tuned setting - which is better and on
// what evidence, and every parameter that would change (src/settingCompare.js). Run: npm test (node --test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVerdict, nowOf, paramDiff } from '../src/settingCompare.js'
import { settingSignature } from '../src/strategyTuning.js'

// A tuned setting as GET /api/strategy-tuning/performance gives it (TuningPerformance.TunedSetting).
const tuned = (row, x = {}) => ({
  row: { index: 'NIFTY', setting_text: Object.entries(row).map(([k, v]) => `${k} ${v}`).join(', '), ...row },
  unit: 'R', best: true, runs: 2, recommended: 1, testTrades: 40, testAvg: 0.3, trainTrades: 60, trainAvg: 0.5, score: 0.24,
  periods: 2, periodsWon: 2, checkTrades: 30, checkAvg: 0.35, checkWinRate: 0.55, baseTrades: 34, baseAvg: 0.1, checkedRuns: 1, notBestBecause: [], ...x,
})
// The page's own rules: a tuned setting is live when its identity was stored on apply; the tuned part of filters.
const isLive = (f, row) => !!f?._tuned && f._tuned === settingSignature(row)
const tunedPart = (f) => Object.fromEntries(Object.entries(f ?? {}).filter(([k]) => k.startsWith('trade')))

test('what runs now: as written, a tuned setting the runs know, or filters no run knows', () => {
  const a = tuned({ tradeSide: 'long' })
  const b = tuned({ tradeSide: 'short' })
  assert.deepEqual(nowOf({}, [a, b], isLive, tunedPart), { kind: 'written' })
  assert.deepEqual(nowOf(null, [a], isLive, tunedPart), { kind: 'written' })
  const now = nowOf({ tradeSide: 'short', _tuned: settingSignature(b.row) }, [a, b], isLive, tunedPart)
  assert.equal(now.kind, 'tuned')
  assert.equal(now.t, b)
  assert.equal(nowOf({ tradeStopX: 2 }, [a, b], isLive, tunedPart).kind, 'applied')
})

test('now as written: the new setting is judged against as written on the SAME days - like for like', () => {
  const better = compareVerdict({ kind: 'written' }, tuned({ tradeSide: 'long' }))
  assert.equal(better.better, 'new')
  assert.equal(better.basis, 'same days')
  assert.ok(Math.abs(better.by - 0.25) < 1e-9)
  assert.match(better.text, /\+0\.35R vs \+0\.10R a trade on the same days/)
  assert.match(better.text, /30 vs 34 trades/)

  const worse = compareVerdict({ kind: 'written' }, tuned({ tradeSide: 'long' }, { checkAvg: -0.05 }))
  assert.equal(worse.better, 'now')
  assert.match(worse.text, /As written \(now\) is better/)

  // Not yet checked against as written: only its own unseen days - said so, and how to fix it.
  const noSameDays = compareVerdict({ kind: 'written' }, tuned({ tradeSide: 'long' }, { checkTrades: 0, checkAvg: null, baseAvg: null }))
  assert.equal(noSameDays.basis, 'score')
  assert.equal(noSameDays.better, 'new')
  assert.match(noSameDays.text, /Re-check/)
  // No unseen trade at all: nothing to compare.
  assert.equal(compareVerdict({ kind: 'written' }, tuned({ tradeSide: 'long' }, { testTrades: 0, testAvg: null, score: null, checkTrades: 0, checkAvg: null, baseAvg: null })).better, 'unknown')
  // A setting not proven yet says so; an option-tuned one speaks premium points.
  assert.match(compareVerdict({ kind: 'written' }, tuned({ tradeSide: 'long' }, { best: false })).text, /not proven yet/)
  assert.match(compareVerdict({ kind: 'written' }, tuned({ tradeSide: 'long' }, { unit: 'pts', checkAvg: 4, baseAvg: 1.5 })).text, /\+4\.00 pts vs \+1\.50 pts/)
})

test('now a tuned setting: the two scores - each on its own unseen days, few trades counting for less', () => {
  const now = { kind: 'tuned', t: tuned({ tradeSide: 'short' }, { score: 0.1, testTrades: 12 }) }
  const v = compareVerdict(now, tuned({ tradeSide: 'long' }, { score: 0.24 }))
  assert.equal(v.better, 'new')
  assert.ok(Math.abs(v.by - 0.14) < 1e-9)
  assert.match(v.text, /40 vs 12 trades/)
  assert.equal(compareVerdict(now, tuned({ tradeSide: 'long' }, { score: 0.05 })).better, 'now')
  // The very setting that runs now.
  assert.equal(compareVerdict({ kind: 'tuned', t: tuned({ tradeSide: 'long' }) }, tuned({ tradeSide: 'long' })).better, 'same')
  // Filters no run kept: cannot be measured here.
  assert.equal(compareVerdict({ kind: 'applied', filters: { tradeStopX: 2 } }, tuned({ tradeSide: 'long' })).better, 'unknown')
})

test('every parameter, now against new - the ones that move are flagged', () => {
  const next = tuned({ tradeSide: 'long', tradeStopX: '1.5' })
  const fromWritten = paramDiff({ kind: 'written' }, next)
  const side = fromWritten.find((p) => p.key === 'tradeSide')
  assert.deepEqual([side.now, side.next, side.changed], ['Long and short', 'Long only', true])
  assert.equal(fromWritten.find((p) => p.key === 'tradeStopX').changed, true)
  assert.equal(fromWritten.find((p) => p.key === 'tradeFrom').changed, false)
  assert.equal(fromWritten.filter((p) => p.changed).length, 2)

  // From a tuned setting: only what differs between the two.
  const fromTuned = paramDiff({ kind: 'tuned', t: tuned({ tradeSide: 'long', tradeStopX: '2' }) }, next)
  assert.deepEqual(fromTuned.filter((p) => p.changed).map((p) => [p.key, p.now, p.next]), [['tradeStopX', '2', '1.5']])

  // From filters applied by hand (the scanner's tradeOpt* keys): an option leg only now shows as going away.
  const fromApplied = paramDiff({ kind: 'applied', filters: { tradeSide: 'long', tradeStopX: 1.5, tradeOptLeg: 'buy', tradeOptMoneyness: 0 } }, next)
  const leg = fromApplied.find((p) => p.key === 'optLeg')
  assert.deepEqual([leg.now, leg.next, leg.changed], ['BUY', 'off / default', true])
  assert.equal(fromApplied.find((p) => p.key === 'tradeSide').changed, false)
})
