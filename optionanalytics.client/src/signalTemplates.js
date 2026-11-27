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
  { id: 'clusters', name: 'Profile clusters (CDV / OBV / OI / futures)' },
  { id: 'delta', name: 'Delta profile (yesterday\'s buy / sell rows)' },
  { id: 'book', name: 'Liquidity heatmap (walls)' },
  { id: 'sequence', name: 'In order (THEN)' },
  { id: 'trend', name: 'Trend' },
  { id: 'reversal', name: 'Reversal' },
  { id: 'breakout', name: 'Breakout' },
  { id: 'options', name: 'Options & volatility' },
  { id: 'selling', name: 'Premium selling' },
]

// The levels a template sets when it is loaded (what it does not name is off: no trail, no time stop).
const LEVELS = { levelUnit: 'pct', trailGap: 0, trailStart: 0, timeStopMin: 0, spotStop: '', spotRR: 0, exitEma: 0 }
// The option delta profile a line reads: the PREVIOUS DAY's ("Profile of: Days before", 1 day - fixed all day, known before
// the open) or TODAY's so far (developing).
const PREV_DAY = { param3: 1, param4: 1 }
const TODAY = { param3: 1, param4: 0 }

/** The templates: { id, family, name, idea, rule: { tree, action, mirror }, settings: { timeframe, slPct, targetPct,
 *  trailGap?, trailStart?, timeStopMin? } }. */
export const RULE_TEMPLATES = [
  // THE VWAP + 9 EMA STRATEGY (asked for - "3 min, VWAP 9 EMA strategy, wick through: enter when the candle wicks through VWAP,
  // exit when candles break through the EMA, and the opposite for puts"). The usual retail write-up: VWAP is the trend line of
  // the day and the 9 EMA the momentum line - a pullback that wicks into VWAP and is rejected is the entry, the trade is held
  // while candles stay on the right side of the 9 EMA and is closed on the first candle that closes through it. The entry
  // candle must also close beyond the 9 EMA (else the exit would fire on the next candle). No premium SL / target. Unmeasured.
  {
    id: 'vwapEmaWick', family: 'trend', name: 'VWAP + 9 EMA - wick through VWAP, exit on the 9 EMA (3 min)',
    idea: 'The write-up\'s pullback entry: the trend first - the 9 EMA is ABOVE VWAP (momentum with the day\'s volume-weighted price under it). On 3-minute candles a candle then wicks BELOW VWAP (its low at or under it) and closes back above it and over the 9 EMA - sellers tried to push under VWAP and were rejected - buy the call. Exit when a 3-minute candle closes UNDER the 9 EMA (premium SL / target off; the 15:10 square-off still applies). Mirror: the 9 EMA below VWAP, a candle wicks ABOVE VWAP and closes back under it and under the 9 EMA - buy the put; exit when a candle closes OVER the 9 EMA. Set an SL on the page to cap a failed trade.',
    rule: { tree: ALL(L('emaVwap', 'above', { param: 0, param2: 9 }), L('vwapWick', 'wickUp', { param: 0, windowMin: 3 }), L('emaPrice', 'above', { param: 0, param2: 9 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 0, targetPct: 0, exitEma: 9 },
  },
  // GIANLUCA BRUNI'S "TRIPLE SPRINT" - THE VALUE AREA LOW-VOLUME BREAKOUT (asked for - the "Direction, Area, Trigger" breakdown of his setup:
  // previous session's VAH / VAL as the area, a 15-minute candle closing outside it on unusually LOW volume as the trigger,
  // entry at that close, stop at the breakout candle's low, a fixed 1:2 target; a ForexFactory write-up of the same setup adds
  // the close above the prior candle's high and volume under its 20-candle average). The public breakdowns are retail
  // summaries - his own interviews put half his results in position sizing / regime filters, which a backtest of the rule
  // alone does not have.
  {
    id: 'vaLowVolBreakout', family: 'breakout', name: 'Bruni Triple Sprint - value area low-volume breakout (15 min, 1:2)',
    idea: 'Area: the previous session\'s value area (VAH / VAL). Trigger: a 15-minute candle CLOSES above the VAH (just broke out - within that candle) and above the candle before\'s high, on LOW volume - at most its average over the last 20 candles: the sellers have dried up, so the path of least resistance is up. Entry at that close; the stop is on SPOT at the breakout candle\'s low, the target on spot twice that risk (1:2); no premium SL / target. Mirror: a close below the VAL and the candle before\'s low on low volume, the stop at the candle\'s high. Volume is the near futures\' (else the index\'s) - a day with none gives no signal.',
    rule: { tree: ALL(L('valueArea', 'crossedAboveVah', { param: 0, windowMin: 15 }), L('candleBreak', 'aboveHigh', { param: 0 }), L('candleVol', 'low', { param: 1, param2: 20 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 15, slPct: 0, targetPct: 0, spotStop: 'candle', spotRR: 2 },
  },
  {
    id: 'vaLowVolBreakoutSpot', family: 'breakout', name: 'Bruni Triple Sprint - value area low-volume breakout, SPOT volume (15 min, 1:2)',
    idea: 'The same setup as the futures-volume one, with the volume read on the INDEX itself (spot): the previous session\'s value area, a 15-minute candle that CLOSES above the VAH and above the candle before\'s high on LOW index volume - at most its average over the last 20 candles. Entry at that close; the stop on SPOT at the breakout candle\'s low, the target on spot twice that risk (1:2). Mirror: below the VAL and the candle before\'s low, the stop at its high. Needs the index\'s volume (Dhan sends it from January 2026) - a day with none gives no signal.',
    rule: { tree: ALL(L('valueArea', 'crossedAboveVah', { param: 0, windowMin: 15 }), L('candleBreak', 'aboveHigh', { param: 0 }), L('candleVol', 'low', { param: 1, param2: 20, param3: 1 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 15, slPct: 0, targetPct: 0, spotStop: 'candle', spotRR: 2 },
  },
  // JJ SIMON'S FAIR VALUE THEORY, ON NSE TIME (asked for - his 1-minute NQ scalps: the reference price just before a session opens
  // is "fair value"; price pushes away from it and comes back once momentum fades; entries on a DISPLACEMENT candle with a break
  // of structure; stop at the displacement candle's far end, target 1.5R, no management). In Indian market hours: the windows are
  // 09:15 - 10:45 (NY 9:30 - 11:00) and 14:00 - 15:00 (NY 2 - 3 pm) IST; fair value = the previous close before the morning open,
  // the 13:59 close before the afternoon one. 1-minute candles on the index (SPOT), the option bought in the signal's direction;
  // the stop is the displacement candle's low / high ON SPOT and the target 1.5 x that risk (spotStop / spotRR). Not taken from
  // the video: its ATR risk tiers and fixed point stops (a 25 / 38 point NQ evaluation set-up) and the three-loss limit on
  // reversions per session - the page has Max trades a day instead. News days (pre-news price / post-shock zone as fair value)
  // are not built either. Unmeasured: Compare all on real days ranks it.
  {
    id: 'fairValueContinuation', family: 'breakout', name: 'JJ Simon fair value - continuation (opening push, 1 min, 1:1.5)',
    idea: 'Fair value = the price before the session opens (the previous close for the 09:15 open, the 13:59 close for the 14:00 one). In the first 15 minutes of each window the market pushes away from it: when spot is at least 0.1% above fair value, a BULLISH displacement candle (body bigger than the last, closed past its high, little upper wick) also breaks the structure - closes over the highest high of the last 5 candles - buy the call; the stop on spot at the displacement candle\'s low, the target 1.5 times that risk, no other management. Mirror: below fair value, a bearish displacement closing under the last 5 candles\' low - the put. Entries from 09:16 to 14:55.',
    rule: { tree: ALL(L('fairValue', 'awayAbove', { param: 0.1, param2: 3, param3: 0, windowMin: 1 }), L('displacement', 'bullish', { param: 25 }), L('structureBreak', 'bosUp', { param: 5 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 1, slPct: 0, targetPct: 0, spotStop: 'candle', spotRR: 1.5, entryFrom: '09:16', lastEntry: '14:55' },
  },
  {
    id: 'fairValueReversion', family: 'reversal', name: 'JJ Simon fair value - reversion (back to fair value, 1 min, 1:1.5)',
    idea: 'After the push away loses momentum price comes back toward fair value. In either window (09:15 - 10:45 / 14:00 - 15:00 IST), when spot closed at least 0.2% ABOVE fair value (stretched) in the last 15 minutes and a BEARISH displacement candle closes under the lowest low of the last 10 candles (a market structure shift), buy the put - the stop on spot at the displacement candle\'s high, the target 1.5 times that risk. Mirror: stretched below fair value, a bullish displacement over the last 10 candles\' high - the call. Entries from 09:16 to 14:55 (the video\'s three-losses-per-session guardrail is not built - the page\'s Max trades a day limits it).',
    rule: { tree: ALL(L('fairValue', 'awayAbove', { param: 0.2, param2: 0, param3: 0, windowMin: 15 }), L('displacement', 'bearish', { param: 25 }), L('structureBreak', 'bosDown', { param: 10 })), action: 'buyPE', mirror: true },
    settings: { timeframe: 1, slPct: 0, targetPct: 0, spotStop: 'candle', spotRR: 1.5, entryFrom: '09:16', lastEntry: '14:55' },
  },
  {
    id: 'wallTouchCdvObv', family: 'book', name: 'CDV and OBV turning, 2nd / 3rd touch of a heatmap wall',
    idea: 'The options\' CDV and OBV lines both turn up (the flow has started going one way) while the futures\' liquidity heatmap shows a bid wall under the price - support - and price touches that same wall for the 2nd or 3rd time and closes back above it: the wall held twice already and the flow agrees, so the third try is taken. Mirror: CDV and OBV both falling, an offer wall (resistance) over the price touched the 2nd or 3rd time and rejected. A first touch is skipped on purpose; a 4th is not taken. Needs the order flow\'s book for the day.',
    rule: { tree: ALL(L('optFlow', 'bothRising', { param: 10, windowMin: 10 }), L('liqWalls', 'touchBid', { param: 0.05, windowMin: 3 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 40, timeStopMin: 45 },
  },
  // DELTA PROFILE: yesterday's option delta profile on spot (OI Replay's card) - its MOST BOUGHT row, where yesterday's
  // bullish option flow (calls bought / puts sold) piled up - a support its buyers have a position to defend - and its
  // MOST SOLD row, where the bearish flow did - resistance. Read four ways: the level holds, it breaks, a break of it fails,
  // a quiet market sits on it. They read the session before each day: the page's run, Compare all, a background run and the
  // live scan load it for them.
  // THE PROFILE CLUSTERS (asked for - "add top 5 strategy on this page now", after the profile groups and their green / red
  // clusters were added): each reads where option buyers / sellers / writers STACKED up - the CDV, OBV and OI profiles' green
  // (bullish) and red (bearish) clusters - and confirms with a second, different flow. Net (CE − PE) side throughout.
  {
    id: 'cluBuyersHold', family: 'clusters', name: 'Yesterday\'s buying cluster holds',
    idea: 'Yesterday\'s option buyers stacked up in one band of prices (the CDV profile\'s green cluster) - a zone they will defend. Price dips into it and closes back above, while today\'s option flow at the price is buying too: support defended. Quick, with a time stop. Mirror: rejected at yesterday\'s selling (red) cluster with selling at the price.',
    rule: { tree: ALL(L('cdpZone', 'heldAboveGreen', { param: 0.05, windowMin: 10, ...PREV_DAY }), L('cdpDelta', 'buying', TODAY)), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 40, timeStopMin: 45 },
  },
  {
    id: 'cluRedBrokenFutures', family: 'clusters', name: 'Through yesterday\'s selling cluster, futures buyers confirm',
    idea: 'Yesterday\'s option sellers stacked up in a red cluster - the ceiling. A cross above it with today\'s FUTURES delta profile net buying (aggressive buyers in the futures, a different market) and price over VWAP says the ceiling was absorbed: the breakout, trailed. Mirror: a break below yesterday\'s buying cluster with futures sellers in charge, under VWAP.',
    rule: { tree: ALL(L('cdpZone', 'crossedAboveRed', { windowMin: 10, ...PREV_DAY }), L('fdpDelta', 'netPositive', { param: 2, ...TODAY }), L('vwap', 'above')), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 25, targetPct: 60, trailGap: 20, trailStart: 30 },
  },
  {
    id: 'cluThreeFlows', family: 'clusters', name: 'CDV, OBV and OI agree over today\'s buying cluster',
    idea: 'Three reads of the options, one answer: price holds a dip into today\'s CDV buying cluster, sits above today\'s OBV buying cluster (premiums rising on volume) and the OI profile is net bullish (puts written ahead of calls). Buyers, momentum and writers all on one side. Mirror: all three bearish under the selling clusters.',
    rule: { tree: ALL(L('cdpZone', 'heldAboveGreen', { param: 0.05, windowMin: 15, ...TODAY }), L('obpZone', 'aboveGreen', TODAY), L('oipDelta', 'netBullish', { param: 2, ...TODAY })), action: 'buyCE', mirror: true },
    settings: { timeframe: 5, slPct: 25, targetPct: 50 },
  },
  {
    id: 'cluFailedBreak', family: 'clusters', name: 'Failed break of yesterday\'s buying cluster',
    idea: 'Price breaks below yesterday\'s CDV buying cluster, then crosses back above it within 30 minutes - the breakdown failed and the sellers who chased it are trapped under the buyers\' zone. Mirror: a failed break above yesterday\'s selling cluster.',
    rule: { tree: THEN(30, L('cdpZone', 'crossedBelowGreen', { windowMin: 10, ...PREV_DAY }), L('cdpZone', 'crossedAboveGreen', { windowMin: 5, ...PREV_DAY })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 45 },
  },
  {
    id: 'cluOiFloorSellPut', family: 'clusters', name: 'Over yesterday\'s put-writing cluster, quiet: sell the put',
    idea: 'Yesterday\'s put writers stacked up in one band (the OI profile\'s bullish cluster) - a floor they are paid to defend. Price holding above it, sideways for 30 minutes, the straddle under its decay-only line (IV being sold): sell the ATM put, the time stop caps the stay. Mirror: under yesterday\'s call-writing cluster, sell the call.',
    rule: { tree: ALL(L('oipZone', 'aboveGreen', { param: 0.05, ...PREV_DAY }), L('spotMove', 'sideways', { param: 0.15, windowMin: 30 }), L('straddle', 'belowDecay')), action: 'sellPE', mirror: true },
    settings: { timeframe: 5, slPct: 40, targetPct: 60, timeStopMin: 90 },
  },
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
    id: 'stickyStrike', family: 'reversal', name: 'Long-gamma bounce off the +GEX wall (net GEX)',
    idea: 'The strike with the most positive NET GEX is where dealer hedging damps price hardest: with dealers long gamma overall, the first candle that crosses back up through the 9 EMA there tends to hold - the GEX platforms\' "sticky strike".',
    rule: { tree: ALL(L('gexRegime', 'long'), L('gexLevel', 'nearPosGex', { param: 0.15, windowMin: 10 }), L('emaPrice', 'candleCrossUp', { param2: 9, windowMin: 5 })), action: 'buyCE', mirror: true },
    settings: { timeframe: 3, slPct: 20, targetPct: 35, timeStopMin: 40 },
  },
  {
    id: 'acceleratorBreak', family: 'breakout', name: 'Short-gamma run through the −GEX wall (net GEX)',
    idea: 'The strike with the most negative NET GEX is where dealer hedging adds to moves: with dealers short gamma, a close through it while the straddle is bought over its VWAP tends to run on to the next sticky strike.',
    rule: { tree: ALL(L('gexRegime', 'short'), L('gexLevel', 'brokeAboveNegGex', { windowMin: 10 }), L('straddle', 'aboveVwap')), action: 'buyCE', mirror: true },
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
