// The Signal backtest's 24 templates (signalTemplates.js - 20, and 4 on yesterday's option delta profile): every one a rule the page can hold whole - each condition known
// and kept, its logic read, a side for the mirror, its levels within the page's ranges - and the comparison of them all over
// the days loaded is each one's own report through the page's engine. The delta profile ones fire on their case - LONG and
// the mirror SHORT - and not when a key condition is missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { RULE_ACTIONS, TIMEFRAMES, deltaDaysNeeded, mirrorIsSame, normalizeRule, prepareDay, ruleLogic, ruleSignals, ruleText } from '../src/signalBacktest.js'
import { backtestReport, cleanBacktestSettings, dayOutcome, engineSettings } from '../src/signalBacktestJob.js'
import { RULE_TEMPLATES, TEMPLATE_FAMILIES, compareTemplates, templateById, templateRow, withTemplate } from '../src/signalTemplates.js'

const countLines = (g) => g.items.reduce((n, it) => n + (it.line ? 1 : countLines(it.group)), 0)

test('24 templates, each a whole rule: every condition kept, its logic read, a side for the mirror, its levels in range', () => {
  assert.equal(RULE_TEMPLATES.length, 24)
  assert.equal(new Set(RULE_TEMPLATES.map((t) => t.id)).size, 24)
  assert.equal(new Set(RULE_TEMPLATES.map((t) => t.name)).size, 24)
  // The delta profile family: 4, each reading yesterday's profile (the session before each day is loaded for it).
  const delta = RULE_TEMPLATES.filter((t) => t.family === 'delta')
  assert.deepEqual(delta.map((t) => t.id), ['dpBuyersDefend', 'dpSellersBroken', 'dpFailedBreak', 'dpSellPut'])
  for (const t of delta) assert.equal(deltaDaysNeeded(t.rule), 1, t.id)
  assert.ok(RULE_TEMPLATES.filter((t) => t.family !== 'delta').every((t) => deltaDaysNeeded(t.rule) === 0))
  const families = new Set(TEMPLATE_FAMILIES.map((f) => f.id))
  for (const t of RULE_TEMPLATES) {
    assert.ok(families.has(t.family), `${t.id} family`)
    assert.ok(t.idea.length > 40, `${t.id} says why`)
    assert.ok(RULE_ACTIONS.some((a) => a.value === t.rule.action), `${t.id} action`)
    const r = normalizeRule(t.rule)
    assert.equal(r.lines.length, countLines(t.rule.tree), `${t.id}: no condition dropped`)
    assert.equal(ruleLogic(r)?.error, undefined, `${t.id}: logic reads (${r.logic})`)
    assert.equal(mirrorIsSame(r.lines), false, `${t.id}: has a bearish mirror`)
    assert.ok(!/\(no condition/.test(ruleText(r.lines, r.action, r.logic)))
    // Its levels survive the page's ranges unchanged.
    const s = withTemplate(cleanBacktestSettings({ underlying: 'NIFTY' }), t)
    assert.ok(TIMEFRAMES.includes(t.settings.timeframe) && s.timeframe === t.settings.timeframe, `${t.id} timeframe`)
    for (const k of ['slPct', 'targetPct', 'trailGap', 'trailStart', 'timeStopMin']) assert.equal(s[k], t.settings[k] ?? 0, `${t.id} ${k}`)
    assert.equal(s.levelUnit, 'pct')
  }
  // Every family has templates; the in-order ones are THEN groups.
  for (const f of TEMPLATE_FAMILIES) assert.ok(RULE_TEMPLATES.some((t) => t.family === f.id), f.id)
  assert.match(normalizeRule(templateById('oiFlowReclaim').rule).logic, /^1 THEN 2 THEN 3 WITHIN 60 MIN$/)
  assert.match(normalizeRule(templateById('rsiWashout').rule).logic, /^\(1 THEN 2 WITHIN 45 MIN\) AND 3$/)
  assert.match(normalizeRule(templateById('dpFailedBreak').rule).logic, /^1 THEN 2 WITHIN 30 MIN$/)
  assert.equal(templateById('nope'), null)
})

test('a template on the page keeps the page\'s own index, lots, charges and limits - only its rule and levels change', () => {
  const page = cleanBacktestSettings({ underlying: 'BANKNIFTY', lots: 3, charges: false, maxDayLoss: 2000, maxTradesPerDay: 4, cooldownMin: 5, trailGap: 10, timeStopMin: 20, expiryDay: 'sell' })
  const s = withTemplate(page, templateById('vwapWriters'))
  assert.deepEqual([s.underlying, s.lots, s.charges, s.maxDayLoss, s.maxTradesPerDay, s.cooldownMin, s.expiryDay], ['BANKNIFTY', 3, false, 2000, 4, 5, 'sell'])
  // Its levels: a template with no trail / time stop turns the page's off.
  assert.deepEqual([s.timeframe, s.slPct, s.targetPct, s.trailGap, s.timeStopMin], [5, 30, 50, 0, 0])
  assert.equal(s.rule.action, 'buyCE')
})

test('compare all 24 over the days loaded: each one\'s own report through the page\'s engine, best net first', () => {
  const { run } = syntheticDay()
  const day = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  const results = [{ date: day.date, day }]
  const page = cleanBacktestSettings({ underlying: 'NIFTY' })
  const rows = compareTemplates(results, page)
  assert.equal(rows.length, 24)
  for (let k = 1; k < rows.length; k++) assert.ok(rows[k - 1].net >= rows[k].net)
  for (const r of rows) assert.ok(Number.isFinite(r.net) && Number.isInteger(r.trades) && r.days === 1, r.id)
  // A row is that template's own report: the same numbers as running it on the page.
  const t = templateById('emaRsiTrend')
  const engine = engineSettings(withTemplate(page, t))
  const report = backtestReport([dayOutcome(day.date, day, engine)], engine)
  const row = templateRow(results, page, t)
  assert.deepEqual([row.trades, row.net, row.winRate], [report.all.trades, report.all.net, report.all.winRate])
  assert.equal(row.ruleNet + (row.mirrorNet ?? 0), row.net)
  // Days that did not load count as not run, not as errors.
  assert.equal(templateRow([...results, { date: '2026-10-06', day: { ok: false, reason: 'holiday' } }], page, t).days, 1)
})

// ---- The delta profile templates on a day built by hand -------------------------------------------------------------
// Yesterday's option delta profile (NIFTY, 5-point rows): calls bought at 24900 - 24905 (the MOST BOUGHT row, its level
// 24902.5) and puts bought at 25100 - 25105 (the MOST SOLD row, 25102.5). Today: `path(i)` the spot bar of each minute,
// today's option flow `flow` a minute (+ calls bought, − puts bought) over that bar's range.
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const MIN = 60_000
const bar = (o, h, l, c) => ({ o, h, l, c })
const yesterday = () => {
  const minutes = []
  for (let k = 0; k < 30; k++) {
    const t = T915 - 86_400_000 + k * MIN
    minutes.push({ t, low: 24901, high: 24901, ceVol: 1000, peVol: 0, ce: 1000, pe: 0 })
    minutes.push({ t: t + 30 * MIN, low: 25101, high: 25101, ceVol: 0, peVol: 1000, ce: 0, pe: 1000 })
    minutes.push({ t: t + 60 * MIN, low: 24990, high: 25010, ceVol: 300, peVol: 300, ce: 0, pe: 0 })
  }
  return minutes
}
function deltaDay(path, { flow = 100, vwap = 25000, n = 120, past = true, straddle = null } = {}) {
  const b = Array.from({ length: n }, (_, i) => (typeof path(i) === 'number' ? bar(path(i), path(i), path(i), path(i)) : path(i)))
  const t = b.map((_, i) => T915 + i * MIN)
  const col = (k) => b.map((x) => x[k])
  const spot = { o: col('o'), h: col('h'), l: col('l'), c: col('c') }
  const f = typeof flow === 'function' ? flow : () => flow
  const odm = b.map((x, i) => ({ t: t[i], low: x.l, high: x.h, ceVol: Math.abs(f(i)), peVol: 0, ce: Math.max(0, f(i)), pe: Math.max(0, -f(i)) }))
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: spot.c.map((c) => Math.round(c / 50) * 50),
    spot, price: spot, vwap: t.map(() => vwap), odm, ...(past ? { odmPast: [yesterday()] } : {}),
    straddle: t.map((_, i) => (straddle ? straddle(i) : null)),
  }
}
const sig = (d, id) => ruleSignals(d, templateById(id).rule).map((x) => [x.i, x.side, x.action])
// A walk from 25000 to `to` over minutes 40 - 54, then `at55` (a bar), then `after` - flat before 40.
const walk = (to, at55, after) => (i) => (i < 40 ? 25000 : i < 55 ? 25000 + ((to - 25000) * (i - 40)) / 14 : i === 55 ? at55 : after)

test('delta template - yesterday\'s most-bought row holds: a dip into it closing back above with buying at the price; the mirror at the most-sold row', () => {
  const dip = walk(24930, bar(24930, 24935, 24905, 24915), 24920)
  assert.deepEqual(sig(deltaDay(dip), 'dpBuyersDefend'), [[55, 'rule', 'buyCE']])
  // Not without each part: today's flow at the price selling, the dip stopping short of the row, no previous day loaded.
  assert.deepEqual(sig(deltaDay(dip, { flow: -100 }), 'dpBuyersDefend'), [])
  assert.deepEqual(sig(deltaDay(walk(24930, bar(24930, 24935, 24925, 24930), 24930)), 'dpBuyersDefend'), [])
  assert.deepEqual(sig(deltaDay(dip, { past: false }), 'dpBuyersDefend'), [])
  // A close back under the row is no hold.
  assert.deepEqual(sig(deltaDay(walk(24930, bar(24930, 24935, 24895, 24898), 24898)), 'dpBuyersDefend'), [])
  // The mirror: a rally into yesterday's most-sold row, closing back below, with selling at the price - buy the put.
  const pop = walk(25080, bar(25080, 25100, 25075, 25090), 25085)
  assert.deepEqual(sig(deltaDay(pop, { flow: -100 }), 'dpBuyersDefend'), [[55, 'mirror', 'buyPE']])
  assert.deepEqual(sig(deltaDay(pop, { flow: 100 }), 'dpBuyersDefend'), [])
})

test('delta template - through yesterday\'s most-sold row: the cross with today\'s flow bullish over VWAP; the mirror under the most-bought row', () => {
  const up = walk(25090, bar(25090, 25112, 25088, 25110), 25112)
  assert.deepEqual(sig(deltaDay(up), 'dpSellersBroken'), [[55, 'rule', 'buyCE']])
  // Not with today's net flow bearish, under VWAP, without yesterday's profile, or short of the row.
  assert.deepEqual(sig(deltaDay(up, { flow: -100 }), 'dpSellersBroken'), [])
  assert.deepEqual(sig(deltaDay(up, { vwap: 25200 }), 'dpSellersBroken'), [])
  assert.deepEqual(sig(deltaDay(up, { past: false }), 'dpSellersBroken'), [])
  assert.deepEqual(sig(deltaDay(walk(25090, bar(25090, 25099, 25088, 25095), 25095)), 'dpSellersBroken'), [])
  // The mirror: a break below yesterday's most-bought row, today's flow bearish, under VWAP - buy the put.
  const down = walk(24910, bar(24910, 24912, 24890, 24892), 24890)
  assert.deepEqual(sig(deltaDay(down, { flow: -100 }), 'dpSellersBroken'), [[55, 'mirror', 'buyPE']])
  assert.deepEqual(sig(deltaDay(down, { flow: -100, vwap: 24800 }), 'dpSellersBroken'), [])
})

test('delta template - failed break of yesterday\'s buyers: under the most-bought row, back over it within 30 min; the mirror at the most-sold row', () => {
  // Under 24902.5 at minute 50, back over at 60 (and the mirror: over 25102.5, back under).
  const failed = (under, back, low, high) => (i) => (i < 50 ? (low + high) / 2 : i < back ? under : high)
  assert.deepEqual(sig(deltaDay(failed(24895, 60, 24895, 24910)), 'dpFailedBreak'), [[60, 'rule', 'buyCE']])
  // Back over it only after 30 minutes: no signal; never under it: none; without yesterday's profile: none.
  assert.deepEqual(sig(deltaDay(failed(24895, 90, 24895, 24910)), 'dpFailedBreak'), [])
  assert.deepEqual(sig(deltaDay(() => 24910), 'dpFailedBreak'), [])
  assert.deepEqual(sig(deltaDay(failed(24895, 60, 24895, 24910), { past: false }), 'dpFailedBreak'), [])
  // The mirror: over 25102.5 at 50, back under at 60 - buy the put.
  const mirror = (i) => (i < 50 ? 25098 : i < 60 ? 25110 : 25095)
  assert.deepEqual(sig(deltaDay(mirror), 'dpFailedBreak'), [[60, 'mirror', 'buyPE']])
})

test('delta template - quiet over yesterday\'s buyers: sell the put over the most-bought row with the flow bullish, sideways, the straddle under its decay line; the mirror under the most-sold row', () => {
  const quiet = (i) => ({ value: 100, vwap: 105, decay: i >= 60 ? 110 : 95 })
  assert.deepEqual(sig(deltaDay(() => 24960, { straddle: quiet }), 'dpSellPut'), [[60, 'rule', 'sellPE']])
  // Not under the row, not with the straddle over its decay line, not moving, not without yesterday's profile.
  assert.deepEqual(sig(deltaDay(() => 24890, { straddle: quiet }), 'dpSellPut'), [])
  assert.deepEqual(sig(deltaDay(() => 24960, { straddle: () => ({ value: 100, vwap: 105, decay: 95 }) }), 'dpSellPut'), [])
  assert.deepEqual(sig(deltaDay((i) => (i < 40 ? 24960 : 24960 + (i - 40) * 5), { straddle: quiet }), 'dpSellPut').filter(([i]) => i >= 60), [])
  assert.deepEqual(sig(deltaDay(() => 24960, { straddle: quiet, past: false }), 'dpSellPut'), [])
  // The mirror: under yesterday's most-sold row with today's flow bearish - sell the call (between the two rows the flow
  // picks the side - never both at once); over the most-sold row with the flow bearish, neither.
  assert.deepEqual(sig(deltaDay(() => 24960, { straddle: quiet, flow: -100 }), 'dpSellPut'), [[60, 'mirror', 'sellCE']])
  assert.deepEqual(sig(deltaDay(() => 25150, { straddle: quiet, flow: -100 }), 'dpSellPut'), [])
})
