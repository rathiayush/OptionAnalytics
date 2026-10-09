// The option-trade tuning (strategyTuning.js, what: 'option'): how a signal is taken in options - buy / sell,
// moneyness, the option's own SL / target as a % of its premium - checked on the premium minute by minute from the
// first full minute after the entry (optionStopTargetHit, the scanner's rule), scored in premium points.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { optionStopTargetHit, optionTradeAt, premiumAt } from '../src/strategyEngine.js'
import { scanDaySetups } from '../src/scanDay.js'
import {
  DEFAULT_VARIANT, OPTION_DEFAULT, OPTION_GRID, optionDetails, optionOutcome, optionRun, optionText, optionVariantRedundant,
  tradeDetails, tuneStrategy, tuningDay, variants,
} from '../src/strategyTuning.js'
import { day } from './synthetic-day.mjs'

const MIN = 60_000
const syn = day()
const heatmap = syn.path.map((p, m) => ({ t: syn.at(m) + 30_000, bids: [[p - 1, 500]], asks: [[p + 1, 500]] }))
const replayDay = { meta: { lotSize: 75, lastPrice: syn.path.at(-1) }, minuteBars: syn.minuteBars, trades: [], icebergs: [], heatmap, sweeps: [], source: 'live' }
const all = await scanDaySetups({ day: replayDay, prints: syn.prints, oi: syn.oi, profile: null, rowSize: 1, lotSize: 75, largeLots: 10, estimated: false, filters: {}, keepAll: true })
const id = all[0].id
const d = tuningDay('2026-10-05', all, replayDay, syn.oi)
const days = Array.from({ length: 6 }, (_, i) => tuningDay(`2026-09-1${i}`, all, replayDay, syn.oi))
const v = (o) => ({ ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...o })

test('the option taken as before: ATM, sold, out with the index trade - the same as the sold leg shown so far', () => {
  const opt = optionDetails([d], id, v({}), null, 'NIFTY')
  const legs = tradeDetails([d], id, DEFAULT_VARIANT, null, 'NIFTY')
  assert.ok(opt.length > 0)
  assert.equal(opt.length, legs.filter((t) => t.sell?.exit != null).length)
  for (const [i, t] of opt.entries()) {
    const leg = legs.filter((x) => x.sell?.exit != null)[i].sell
    assert.equal(t.opt.label, leg.label)
    assert.equal(t.opt.entry, leg.entry)
    assert.equal(t.opt.exit, leg.exit)
    assert.ok(Math.abs(t.points - leg.points) < 1e-9)
    assert.equal(t.opt.reason, 'the index trade exited')
  }
})

test('moneyness and leg: the strike moves into / out of the money for the option traded', () => {
  const s = all.find((x) => x.id === id && x.options?.sell)
  const atm = optionTradeAt(syn.oi, s, 'sell', 0)
  const itm = optionTradeAt(syn.oi, s, 'sell', 1)
  const otm = optionTradeAt(syn.oi, s, 'sell', -1)
  const step = syn.oi.step
  // A call's ITM strikes are below the index, a put's above.
  const sign = atm.side === 'CE' ? -1 : 1
  if (itm) assert.equal(itm.strike, atm.strike + sign * step)
  if (otm) assert.equal(otm.strike, atm.strike - sign * step)
  const bought = optionTradeAt(syn.oi, s, 'buy', 0)
  assert.notEqual(bought.side, atm.side, 'buying takes the other option')
  assert.match(optionText(v({ optLeg: 'buy', optMoneyness: -2, optExit: 'first', optSlPct: 25, optTargetPct: 50 })), /^BUY 2 OTM · SL 25% \/ target 50% of the premium, or the index trade's exit first$/)
  assert.equal(optionText(v({})), 'SELL ATM · out with the index trade')
})

test('the option\'s own SL / target: checked on its premium from the first full minute, filled at the level', () => {
  let checked = 0
  for (const s of all.filter((x) => x.id === id).slice(0, 15)) {
    for (const exit of ['first', 'option']) {
      const vv = v({ optExit: exit, optSlPct: 15, optTargetPct: 20 })
      const outcome = { exitAt: s.t + 20 * MIN, r: 0 }
      const o = optionOutcome(d, s, outcome, vv)
      if (!o) continue
      const until = exit === 'first' ? s.t + 21 * MIN : Math.min(d.endMs, Math.floor(s.t / MIN) * MIN + (910 - Math.floor((s.t / MIN + 330) % 1440)) * MIN)
      const hit = optionStopTargetHit(syn.oi, o.trade, s.t, until, o.trade.premium * 0.15, o.trade.premium * 0.2)
      if (hit) {
        assert.equal(o.exitPremium, hit.premium, 'filled at the level')
        assert.equal(o.exitMs, hit.at)
        assert.match(o.reason, /SL|Target/)
        const sell = o.trade.action === 'SELL'
        if (/SL/.test(o.reason)) assert.ok(Math.abs(o.points + o.trade.premium * 0.15) < 1e-9, 'a stop loses exactly the SL')
        else assert.ok(Math.abs(o.points - o.trade.premium * 0.2) < 1e-9, `${sell ? 'sell' : 'buy'} target makes exactly the target`)
      } else {
        assert.equal(o.exitPremium, premiumAt(syn.oi, o.trade.side, o.trade.strike, until))
        assert.equal(o.reason, exit === 'first' ? 'the index trade exited' : 'square-off 15:10')
      }
      if (exit === 'first') assert.ok(o.exitMs <= s.t + 21 * MIN, 'never after the index trade\'s exit')
      checked++
    }
  }
  assert.ok(checked > 5)
})

test('the option grid: 510 combinations (out with the index trade has no SL / target to try)', () => {
  const n = [...variants(OPTION_GRID, OPTION_DEFAULT)].filter((x) => !optionVariantRedundant(x)).length
  assert.equal(n, 2 * 5 * (1 + 25 + 25))
  assert.equal(optionVariantRedundant(v({ optExit: 'index', optSlPct: 30 })), true)
  assert.equal(optionVariantRedundant(v({ optExit: 'first', optSlPct: 30 })), false)
})

test('tuning the option trade: premium points, the option as before as the baseline, a suggestion in premium points', () => {
  const r = tuneStrategy(days, id, { what: 'option', minTrades: 2, underlying: 'NIFTY' })
  assert.equal(r.unit, 'pts')
  assert.equal(r.tried, 510)
  assert.deepEqual({ leg: r.baseline.params.optLeg, m: r.baseline.params.optMoneyness, exit: r.baseline.params.optExit }, { leg: 'sell', m: 0, exit: 'index' })
  assert.deepEqual(r.baseline.train.total, optionRun(days.slice(0, 4), id, v({}), null).reduce((a, b) => a + b, 0), 'scored in premium points')
  if (r.best) {
    assert.ok(r.best.trades.every((t) => t.opt && Number.isFinite(t.points)))
    if (r.best.params.optExit !== 'index') {
      assert.ok(r.best.suggest && r.best.suggest.slPoints > 0 && r.best.suggest.targetPoints > 0)
      assert.ok(Math.abs(r.best.suggest.slPoints - r.best.suggest.premium * r.best.params.optSlPct / 100) < 1e-9)
    }
  }
  // Everything: OI, then the trade settings, then the option on top of those.
  const e = tuneStrategy(days, id, { what: 'all', minTrades: 2, underlying: 'NIFTY' })
  assert.equal(e.what, 'all')
  assert.equal(e.unit, 'pts')
  assert.ok(e.oiStage && e.tradeStage)
  if (e.best && e.tradeStage.best) for (const k of ['tradeSide', 'tradeStopX', 'tradeTargetX', 'tradeTrail']) assert.equal(e.best.params[k], e.tradeStage.best.params[k], 'the option tuned on top of the chosen trade settings')
})
