// The Signal backtest's TEMPLATES - 20, and 4 more on the option delta profile (asked for - "be a non linear thinker ... create top 20 strategy and add it in dropdown
// ... so that u run those as well i can modify"): ready rules built from the page's own conditions, each read through a
// different lens - positioning (OI), flow (cumulative Δ), dealer hedging (GEX), volatility (the straddle), auction structure
// (yesterday's profile, the IB, pivots / CPR), momentum (EMA / RSI) and the option premiums' own tape - and some through
// several at once - and the OPTION DELTA PROFILE (asked for next - "add strategy for delta profile ... previous day's highest
// buy and sell"): yesterday's most bought / most sold rows. Each is written for the BULLISH side with the Mirror on (the bearish side read the other way round),
// with its own timeframe and SL / target / trail; loading one puts it on the page to run and change like any rule. They
// are starting points to measure, not measured edges: `compareTemplates` runs all of them over the days loaded, each
// through the same engine and report as the page (`tests/signal-templates.test.mjs`).
import { normalizeRule } from './signalBacktest.js'
import { backtestReport, cleanBacktestSettings, dayOutcome, engineSettings } from './signalBacktestJob.js'

const L = (id, value, more = {}) => ({ line: { id, value, ...more } })
const group = (op, items, more = {}) => ({ op, not: false, items, ...more })
const ALL = (...items) => group('and', items)
const THEN = (within, ...items) => group('then', items, { within })
const nest = (g) => ({ group: g })

export const TEMPLATE_FAMILIES = [
  { id: 'delta', name: 'Delta profile (yesterday\'s buy / sell rows)' },
  { id: 'sequence', name: 'In order (THEN)' },
  { id: 'trend', name: 'Trend' },
  { id: 'reversal', name: 'Reversal' },
  { id: 'breakout', name: 'Breakout' },
  { id: 'options', name: 'Options & volatility' },
  { id: 'selling', name: 'Premium selling' },
]

// The levels a template sets when it is loaded (what it does not name is off: no trail, no time stop).
const LEVELS = { levelUnit: 'pct', trailGap: 0, trailStart: 0, timeStopMin: 0 }
// The option delta profile a line reads: the PREVIOUS DAY's ("Profile of: Days before", 1 day - fixed all day, known before
// the open) or TODAY's so far (developing).
const PREV_DAY = { param3: 1, param4: 1 }
const TODAY = { param3: 1, param4: 0 }

/** The templates: { id, family, name, idea, rule: { tree, action, mirror }, settings: { timeframe, slPct, targetPct,
 *  trailGap?, trailStart?, timeStopMin? } }. */
export const RULE_TEMPLATES = [
  // DELTA PROFILE: yesterday's option delta profile on spot (OI Replay's card) - its MOST BOUGHT row, where yesterday's
  // bullish option flow (calls bought / puts sold) piled up - a support its buyers have a position to defend - and its
  // MOST SOLD row, where the bearish flow did - resistance. Read four ways: the level holds, it breaks, a break of it fails,
  // a quiet market sits on it. They read the session before each day: the page's run, Compare all, a background run and the
  // live scan load it for them.
  {
    id: 'dpBuyersDefend', family: 'delta', name: 'Yesterday\'s most-bought row holds',
    idea: 'Yesterday\'s bullish option flow piled up at one price row - its buyers have a position to defend there. Price dips into that row and closes back above it while today\'s option flow at the price is buying too: support defended, taken quickly with a time stop. Mirror: rejected at yesterday\'s most-sold row with selling at the price.',
    rule: { tree: ALL(L('odpBuy', 'heldAbove', { param: 0.05, windowMin: 10, ...PREV_DAY }), L('odpDelta', 'buying', TODAY)), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 40, timeStopMin: 45 },
  },
  {
    id: 'dpSellersBroken', family: 'delta', name: 'Through yesterday\'s most-sold row',
    idea: 'Yesterday\'s bearish option flow was heaviest at one row - the sellers\' line. A close above it, with today\'s net option flow bullish and price over VWAP, says they were absorbed: the breakout, carried by a trail. Mirror: a break below yesterday\'s most-bought row with today\'s flow bearish, under VWAP.',
    rule: { tree: ALL(L('odpSell', 'crossedAbove', { windowMin: 10, ...PREV_DAY }), L('odpDelta', 'netPositive', TODAY), L('vwap', 'above')), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 60, trailGap: 20, trailStart: 30 },
  },
  {
    id: 'dpFailedBreak', family: 'delta', name: 'Failed break of yesterday\'s buyers',
    idea: 'Price breaks below yesterday\'s most-bought row, then closes back above it within 30 minutes - the breakdown failed and the sellers who chased it are trapped under the buyers\' level. Mirror: a failed break above yesterday\'s most-sold row.',
    rule: { tree: THEN(30, L('odpBuy', 'crossedBelow', { windowMin: 10, ...PREV_DAY }), L('odpBuy', 'crossedAbove', { windowMin: 5, ...PREV_DAY })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 45 },
  },
  {
    id: 'dpSellPut', family: 'delta', name: 'Quiet over yesterday\'s buyers: sell the put',
    idea: 'Price holding over yesterday\'s most-bought row with today\'s net option flow bullish, sideways for 30 minutes, the straddle under its decay-only line (IV being sold): the buyers\' row is a floor under a quiet market - sell the ATM put, the time stop caps the stay. Mirror: under yesterday\'s most-sold row with the flow bearish, sell the call.',
    rule: { tree: ALL(L('odpBuy', 'above', { param: 0.05, ...PREV_DAY }), L('odpDelta', 'netPositive', TODAY), L('spotMove', 'sideways', { param: 0.15, windowMin: 30 }), L('straddle', 'belowDecay')), action: 'sellPE', mirror: true },
    settings: { timeframe: 5, slPct: 40, targetPct: 60, timeStopMin: 90 },
  },
  {
    id: 'oiFlowReclaim', family: 'sequence', name: 'OI flip → divergence → EMA reclaim',
    idea: 'Writers switch sides first (PE overtakes CE since the open), the OI flow then refuses to follow a dip (bullish divergence), and price confirms by losing and reclaiming its 20 EMA - three different witnesses, in that order, within an hour.',
    rule: { tree: THEN(60, L('oiOpen', 'peCross', { windowMin: 15 }), L('cumNet', 'divBull', { param: 0.15, param2: 15, windowMin: 15 }), L('emaPrice', 'reclaimed', { param2: 20, windowMin: 30 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 50 },
  },
  {
    id: 'emaRsiTrend', family: 'trend', name: 'EMA 9 / 21 crossover, close beyond both, RSI > 55',
    idea: 'The plain trend entry, made stricter: the crossover only counts when the candle closes beyond both EMAs and momentum agrees (RSI over 55) - fewer, cleaner crossovers.',
    rule: { tree: ALL(L('emaCross', 'crossedUpClose', { param2: 9, param3: 21, windowMin: 10 }), L('rsi', 'above', { param: 55, param2: 14 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 5, slPct: 25, targetPct: 50, trailGap: 20, trailStart: 30 },
  },
  {
    id: 'narrowCpr', family: 'trend', name: 'Narrow CPR trend day',
    idea: 'A narrow central pivot range (yesterday balanced) often comes before a trending day: take the break of the CPR in the direction the EMAs already lean, and let a trail carry it.',
    rule: { tree: ALL(L('cpr', 'narrow', { param: 0.2 }), L('cpr', 'crossedAbove', { windowMin: 15 }), L('emaCross', 'fastAbove', { param2: 9, param3: 21 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 5, slPct: 25, targetPct: 70, trailGap: 25, trailStart: 40 },
  },
  {
    id: 'ibIvBreak', family: 'trend', name: 'IB breakout with IV expanding',
    idea: 'A break of the first hour\'s range is real when options are being bought (the straddle over its decay-only line) and the put side carries more OI - breakouts on a volatility crush tend to fail.',
    rule: { tree: ALL(L('ib', 'aboveHigh', { param: 0.03 }), L('totalOi', 'peAbove'), L('straddle', 'aboveDecay')), action: 'buyCE', mirror: true },
    settings: { timeframe: 5, slPct: 30, targetPct: 60, trailGap: 20, trailStart: 30 },
  },
  {
    id: 'vwapWriters', family: 'trend', name: 'Over VWAP with put writers in charge',
    idea: 'Price above VWAP, more puts written than calls since the open, and the Net cumulative Δ still falling (put writers gaining) - price, positioning and fresh flow all on one side.',
    rule: { tree: ALL(L('vwap', 'above', { param: 0.05 }), L('oiOpen', 'peAhead', { param: 10 }), L('cumNet', 'falling', { param: 10, windowMin: 15 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 5, slPct: 30, targetPct: 50 },
  },
  {
    id: 'morningFlip', family: 'trend', name: 'Morning OI flip over the 20 EMA',
    idea: 'Call writers led all morning, then PE crossed above - the morning\'s story changed. Trade the new side only while price is over its 20 EMA.',
    rule: { tree: ALL(L('oiOpen', 'peFlip', { param: 5, param2: 0, windowMin: 15 }), L('emaPrice', 'above', { param2: 20 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 5, slPct: 30, targetPct: 60 },
  },
  {
    id: 'pivotBounce', family: 'reversal', name: 'S1 holds, RSI turns up',
    idea: 'A touch of yesterday\'s S1 that closes back above it, with RSI turning up through 40 - a support test that buyers defended, taken quickly with a time stop.',
    rule: { tree: ALL(L('pivotS1', 'heldAbove', { param: 0.05, windowMin: 10 }), L('rsi', 'crossedAbove', { param: 40, param2: 14, windowMin: 10 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 40, timeStopMin: 45 },
  },
  {
    id: 'divAtSupport', family: 'reversal', name: 'Divergence at the OI support',
    idea: 'Price dips into the strike with the most put OI while the Net cumulative Δ does not follow it down - writers are not giving up the level.',
    rule: { tree: ALL(L('cumNet', 'divBull', { param: 0.2, param2: 10, windowMin: 15 }), L('oiWalls', 'nearSupport', { param: 0.1, windowMin: 15 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 50 },
  },
  {
    id: 'rsiWashout', family: 'reversal', name: 'RSI washout, then puts dumped',
    idea: 'RSI falls under 30 then climbs back through it, and the ATM put premium loses its 20 EMA after a spike - the fear trade being closed out.',
    rule: {
      tree: ALL(nest(THEN(45, L('rsi', 'below', { param: 30, param2: 14 }), L('rsi', 'crossedAbove', { param: 30, param2: 14, windowMin: 10 }))), L('pePremEma', 'lost', { param2: 20, windowMin: 15 })),
      action: 'buyCE', mirror: true,
    },
    settings: { timeframe: 3, slPct: 25, targetPct: 50 },
  },
  {
    id: 'gammaPin', family: 'reversal', name: 'Long-gamma bounce off the put wall',
    idea: 'With dealers long gamma they buy dips and sell rips, so the put wall tends to hold: buy the first candle that crosses back up through the 9 EMA there, small target, short time stop.',
    rule: { tree: ALL(L('gexRegime', 'long'), L('gexLevel', 'nearPutWall', { param: 0.15, windowMin: 10 }), L('emaPrice', 'candleCrossUp', { param2: 9, windowMin: 5 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 35, timeStopMin: 40 },
  },
  {
    id: 'backIntoValue', family: 'reversal', name: 'Back into yesterday\'s value',
    idea: 'Price that went below yesterday\'s value area and crosses back above its VAL, with puts being written and price over VWAP, often travels across value toward the VAH.',
    rule: { tree: ALL(L('prevVal', 'crossedAbove', { windowMin: 15 }), L('cumPe', 'rising', { param: 10, windowMin: 15 }), L('vwap', 'above')), action: 'buyCE', mirror: true },
    settings: { timeframe: 5, slPct: 25, targetPct: 50 },
  },
  {
    id: 'gammaSqueeze', family: 'breakout', name: 'Short-gamma squeeze through the call wall',
    idea: 'Dealers short gamma must chase: a break above the call wall while the straddle is bought over its VWAP can run further than any OI level suggests.',
    rule: { tree: ALL(L('gexRegime', 'short'), L('gexLevel', 'brokeCallWall', { windowMin: 10 }), L('straddle', 'aboveVwap')), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 60, trailGap: 20, trailStart: 30 },
  },
  {
    id: 'pivotPullback', family: 'breakout', name: 'Pivot break, pullback, go',
    idea: 'Price breaks above the day\'s pivot, pulls back under its 9 EMA and reclaims it - the second leg after a shake-out, within 45 minutes of the break.',
    rule: { tree: THEN(45, L('pivotP', 'crossedAbove', { windowMin: 5 }), L('emaPrice', 'reclaimed', { param2: 9, windowMin: 15 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 45 },
  },
  {
    id: 'lvnSlip', family: 'breakout', name: 'Fast through yesterday\'s LVN',
    idea: 'A low-volume node is a price yesterday did not accept - price tends to travel through it quickly. Enter when a whole candle sits above the 9 EMA after crossing the LVN.',
    rule: { tree: ALL(L('prevLvn', 'crossedAbove', { windowMin: 10 }), L('emaPrice', 'wholeAbove', { param2: 9 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 50 },
  },
  {
    id: 'cumBreakout', family: 'breakout', name: 'PE cumulative Δ breaks out, spot rising',
    idea: 'The PE cumulative OI line breaking its own resistance means put writing accelerating; with spot already rising, the flow leads the price.',
    rule: { tree: ALL(L('cumPe', 'brokeResistance', { windowMin: 10 }), L('spotMove', 'rising', { param: 0.1, windowMin: 10 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 50 },
  },
  {
    id: 'premiumTape', family: 'options', name: 'Call premium over its VWAP, puts under',
    idea: 'Read the options themselves: the ATM call reclaims its own VWAP with its 9 EMA over its 21 while the ATM put stays under its VWAP - the option buyers have picked a side.',
    rule: { tree: ALL(L('cePremVwap', 'crossedAbove', { windowMin: 5 }), L('cePremEmaCross', 'fastAbove', { param2: 9, param3: 21 }), L('pePremVwap', 'below')), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 40, trailGap: 15, trailStart: 20 },
  },
  {
    id: 'ivExpansion', family: 'options', name: 'IV expansion move',
    idea: 'The straddle crosses above its VWAP and over the decay-only line (premium bought beyond time decay) while spot moves - option buyers paying up for direction.',
    rule: { tree: ALL(L('straddle', 'crossedAbove', { windowMin: 5 }), L('straddle', 'aboveDecay'), L('spotMove', 'rising', { param: 0.15, windowMin: 10 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 60 },
  },
  {
    id: 'hpVwap', family: 'options', name: '🎯 high probability over VWAP',
    idea: 'The app\'s own 🎯 (a cumulative-line break with the OI at ATM ± 1 shifting the same way), taken only on the side of VWAP.',
    rule: { tree: ALL(L('hp', 'bullish', { windowMin: 10 }), L('vwap', 'above')), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 50 },
  },
  {
    id: 'gammaTurn', family: 'options', name: 'Turned short gamma, VWAP cross',
    idea: 'When net GEX turns negative, dealer hedging starts to add to moves: a VWAP cross in the EMAs\' direction right after can run.',
    rule: { tree: ALL(L('gexRegime', 'turnedShort', { windowMin: 15 }), L('vwap', 'crossedAbove', { windowMin: 10 }), L('emaCross', 'fastAbove', { param2: 9, param3: 21 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 60, trailGap: 20, trailStart: 30 },
  },
  {
    id: 'quietSell', family: 'selling', name: 'Quiet range: sell the put',
    idea: 'Spot sideways for 30 minutes and the straddle under its decay-only line (IV being sold): sell the ATM put on the VWAP side - theta does the work, the time stop caps the stay.',
    rule: { tree: ALL(L('straddle', 'belowDecay'), L('spotMove', 'sideways', { param: 0.15, windowMin: 30 }), L('vwap', 'above')), action: 'sellPE', mirror: true },
    settings: { timeframe: 5, slPct: 40, targetPct: 60, timeStopMin: 90 },
  },
]

const TEMPLATE = Object.fromEntries(RULE_TEMPLATES.map((t) => [t.id, t]))
export const templateById = (id) => TEMPLATE[id] ?? null

/** The page's settings with a template on them: its rule and its own levels (what it does not name is off), everything
 *  else - the index, the days, lots, charges, day limits, max trades, cooldown, expiry day - kept; held to the page's
 *  ranges (`cleanBacktestSettings`). */
export function withTemplate(pageSettings, tpl) {
  return cleanBacktestSettings({ ...pageSettings, ...LEVELS, ...tpl.settings, rule: { ...tpl.rule, tree: normalizeRule(tpl.rule).tree } })
}

/** One template over the days loaded (`results` - the page's [{ date, day, tradeDay }] - `tradeDay` the trade-in index's,
 *  when the page trades in another): its row - the report's "both" numbers, and the rule's and the mirror's own net. */
export function templateRow(results, pageSettings, tpl) {
  const engine = engineSettings(withTemplate(pageSettings, tpl))
  const outcomes = (results ?? []).map((r) => dayOutcome(r.date, r.day, engine, r.tradeDay ?? null))
  const report = backtestReport(outcomes, engine)
  const side = (id) => report.rows.find((r) => r.id === id) ?? null
  const all = report.all
  return {
    key: tpl.id, id: tpl.id, family: tpl.family, name: tpl.name, idea: tpl.idea, timeframe: engine.timeframe,
    trades: all.trades, winRate: all.winRate, net: all.net, profitFactor: all.profitFactor, maxDrawdown: all.maxDrawdown,
    expectancy: all.expectancy, days: report.okDays, ruleNet: side('rule')?.net ?? 0, mirrorNet: side('mirror')?.net ?? null,
  }
}

/** Every template over the days loaded, best net first (ties: more trades first). */
export function compareTemplates(results, pageSettings, templates = RULE_TEMPLATES) {
  return templates.map((t) => templateRow(results, pageSettings, t)).sort((a, b) => b.net - a.net || b.trades - a.trades)
}
