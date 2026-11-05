// The Signal backtest's 20 templates (signalTemplates.js): every one a rule the page can hold whole - each condition known
// and kept, its logic read, a side for the mirror, its levels within the page's ranges - and the comparison of them all over
// the days loaded is each one's own report through the page's engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { RULE_ACTIONS, TIMEFRAMES, mirrorIsSame, normalizeRule, prepareDay, ruleLogic, ruleText } from '../src/signalBacktest.js'
import { backtestReport, cleanBacktestSettings, dayOutcome, engineSettings } from '../src/signalBacktestJob.js'
import { RULE_TEMPLATES, TEMPLATE_FAMILIES, compareTemplates, templateById, templateRow, withTemplate } from '../src/signalTemplates.js'

const countLines = (g) => g.items.reduce((n, it) => n + (it.line ? 1 : countLines(it.group)), 0)

test('20 templates, each a whole rule: every condition kept, its logic read, a side for the mirror, its levels in range', () => {
  assert.equal(RULE_TEMPLATES.length, 20)
  assert.equal(new Set(RULE_TEMPLATES.map((t) => t.id)).size, 20)
  assert.equal(new Set(RULE_TEMPLATES.map((t) => t.name)).size, 20)
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

test('compare all 20 over the days loaded: each one\'s own report through the page\'s engine, best net first', () => {
  const { run } = syntheticDay()
  const day = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  const results = [{ date: day.date, day }]
  const page = cleanBacktestSettings({ underlying: 'NIFTY' })
  const rows = compareTemplates(results, page)
  assert.equal(rows.length, 20)
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
