// The OI + Order Flow playbook's strategies as objective rules, run on the Order Flow page live and at
// the replay clock (and over a whole day by "Scan day"): OI + order flow (1-10, 16-21, 24-27, 29), pure option OI (28; 31-33 with the futures OI / VWAP), volume / market
// profile (11-15, 30) and range-bound mean reversion (7, 22, 23). Each strategy reads all five screens:
//
//   OI        - the OI Replay data for the day (/api/oi-replay/{u}/run): option OI per strike (walls,
//               OI change, writer migration, max pain) and the futures' own OI (build-up / covering).
//   Footprint - 1-minute analyzed bars: delta, cumulative delta, stacked imbalances, absorption,
//               exhaustion.
//   Tape      - Time & Sales prints: aggression over 30s / 1m, big prints, speed, sweeps.
//   DOM       - the book: bid share of the top levels, walls.
//   Heatmap   - liquidity signals (wall absorption, spoofing, magnet), pulled / stacked liquidity, icebergs.
//
// Rule: OI + Footprint + Tape required, DOM or Heatmap confirming. On a day ESTIMATED from 1-minute
// candles there is no tape, book or heatmap: the tape checks use each minute's estimated buy/sell
// split instead and the DOM/Heatmap confirmation is waived - such results are marked "estimated".
//
// Prices: order flow is read on the FUTURES; option strikes are in INDEX (spot) terms, so a strike is
// moved into futures terms with the current basis (futures - spot).
//
// Every setup carries an entry (the futures price), a stop and a target in futures points and a time
// stop, and can carry a trailing stop; simulateOutcome walks the minute bars after it to see which came
// first. The day's cut-off: no new setup after 14:45, every trade closed by 15:10 IST. That is the outcome
// of the futures move the strategy calls - the option you would trade moves with it, but its own
// P&L (premium, decay) is not modelled.

import { findSuddenWalls, suddenWallText } from './suddenOi.js'
import { liquidityMap } from './orderFlowMath.js'
import { optionTrailLevel, tighterStop } from './optionTrail.js'
import { adaptiveDecision, combineRegime, cvdDayVote, dayRegime, oiDayVote, sessionOpenMs } from './dayRegime.js'

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440) // minutes since IST midnight
const hm = (h, m) => h * 60 + m
/** No new setup after this (IST minutes since midnight)... */
export const LAST_ENTRY = hm(14, 45)
/** ...and every trade still open is closed at this cut-off. */
export const SQUARE_OFF = hm(15, 10)
/** Trailing stop-loss: once a trade is `startR` in profit, the stop follows the best price `gapR`
 *  behind it (with the defaults the stop reaches the entry - breakeven - at +1R, and only ever tightens).
 *  The trader can set it in futures points instead (`unit: 'pts'`, `startPts` / `gapPts` - trailPoints). */
export const DEFAULT_TRAIL = { startR: 1, gapR: 1 }
export const fmtHm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export const STRATEGIES = []
/** The SPOT + OPTIONS strategies (spotEngine.js): they trade the index price itself - spot candles and the option
 *  chain's OI, no futures and no order flow. Measured by the Strategy tuning ("Spot + options only"); the live
 *  scanner does not run them, so they are not in STRATEGIES / ACTIVE_STRATEGIES. */
export const SPOT_STRATEGIES = [
  // 101: the since-open CE - PE lines cross on the 1-minute clock (the alert), then the spot's 3-minute EMA crosses the trade's way and
  // the entry is taken when that candle closes - with the cumulative CE / PE change, the S / R OI near the ATM (writers adding on the
  // holding side, leaving on the other, a big net difference) and the strikes right round the ATM all in the trade's direction.
  { id: 'spotFlip', no: 101, name: 'Spot: CE / PE since-open crossover (1 min) -> spot 3-min EMA crossover, with the cumulative CE / PE change, S / R walls and ATM strikes in the trade\'s direction', short: 'Spot CE/PE cross + EMA', spot: true, blocks: ['exits'] },
]
export const STRATEGY_BY_ID = Object.fromEntries([...STRATEGIES, ...SPOT_STRATEGIES].map((s) => [s.id, s]))
/** The strategies in use - what the scanner runs, lists, alerts on and scores. */
export const ACTIVE_STRATEGIES = STRATEGIES.filter((s) => !s.retired)
// The playbook's own picks, used for alerts until enough trades have been scored to rank them.
export const DEFAULT_TOP5 = ['wallBreak', 'buildUp', 'openingBias']
export const DEFAULT_PROFILE_TOP5 = ['vaRejection', 'tpo80', 'pocReaction', 'lvnRun', 'ibBreakout']
export const RANGE_IDS = ACTIVE_STRATEGIES.filter((s) => s.group === 'range').map((s) => s.id)

// ---- per-strategy filters ----------------------------------------------------------------------------
/**
 * The filters the trader can tune per strategy (the scanner's Filters button). Each: key, label, type
 * ('number' | 'switch'), the default - the rule as written and tested, so an untouched strategy behaves
 * exactly as before - and for numbers min / max / step. More strategies get here by listing their
 * filters and reading them through strategyFilters() in their block.
 */
// The previous-session level rejections (34-37) share one rule and so one set of filters.
const PROFILE_REJECT_FILTERS = [
  { key: 'bandPct', label: 'Touch band around the level (% of price)', type: 'number', default: 0.06, min: 0.02, max: 0.3, step: 0.01 },
  { key: 'awayPct', label: 'Came from at least this far away in the last 30 min (% of price)', type: 'number', default: 0.2, min: 0.05, max: 1, step: 0.05 },
  { key: 'touchBars', label: 'Touched the level within the last (bars)', type: 'number', default: 3, min: 1, max: 10, step: 1 },
  { key: 'minWriting', label: 'Option writers\' lean near the money (15 min) at least', type: 'number', default: 0.1, min: 0, max: 1, step: 0.05 },
  { key: 'futuresNotAgainst', label: 'No fresh futures build-up against the trade (15 min)', type: 'switch', default: true },
  { key: 'needDelta', label: 'Rejection bar\'s delta with the trade', type: 'switch', default: true },
  { key: 'minRoomR', label: 'Room to the next profile level at least (x the stop)', type: 'number', default: 1.2, min: 0.5, max: 4, step: 0.1 },
  { key: 'maxTargetR', label: 'Target at most (x the stop)', type: 'number', default: 3, min: 1, max: 6, step: 0.25 },
  { key: 'timeStopMin', label: 'Time stop (minutes)', type: 'number', default: 60, min: 10, max: 240, step: 5 },
]

// Per-strategy entry filters: none - every strategy was removed (the trade filters below stay available to any new one).
// A strategy's OWN rules - what makes it that strategy. Everything else it can be given from PARAM_BLOCKS below.
const STRATEGY_OWN_FILTERS = {
  // #101: the since-open CE - PE lines cross on the 1-minute clock (the alert) -> wait for the spot's 3-minute EMA crossover, entry
  // when that candle closes -> with the cumulative CE / PE change, the S / R OI walls and the ATM +/- strikes all in the trade's direction.
  spotFlip: [
    { key: 'armMin', label: 'After the CE - PE crossover (the alert) wait for the spot EMA crossover for at most (minutes)', type: 'number', default: 30, min: 1, max: 120, step: 1 },
    { key: 'emaTf', label: 'Spot EMA candle (minutes) - the entry is taken when the crossover candle closes', type: 'select', default: 3, options: [1, 3, 5, 10, 15].map((m) => ({ value: m, label: `${m} min` })) },
    { key: 'emaFast', label: 'EMA fast (candles)', type: 'number', default: 7, min: 2, max: 50, step: 1 },
    { key: 'emaSlow', label: 'EMA slow (candles)', type: 'number', default: 21, min: 3, max: 100, step: 1 },
    { key: 'emaMode', label: 'Spot EMA: crossed on the candle that just closed, or (a trend under way) already in the trade\'s direction', type: 'select', default: 'cross', options: [{ value: 'cross', label: 'Crossed on the candle that just closed' }, { value: 'state', label: 'Already in direction counts too' }] },
    { key: 'wallMin', label: 'S / R OI near the ATM: over the last (minutes) the writers go the trade\'s way (puts added and calls leaving for a long)', type: 'number', default: 10, min: 3, max: 30, step: 1 },
    { key: 'nearStrikes', label: 'S / R OI counted over ATM +/- (strikes)', type: 'number', default: 2, min: 1, max: 5, step: 1 },
    { key: 'atmStrikes', label: 'The strikes right round the ATM (+/-) also go the trade\'s way', type: 'number', default: 1, min: 0, max: 3, step: 1 },
    { key: 'netMinPct', label: 'S / R OI net difference (PE - CE as a % of both) at least, in the trade\'s direction - a big gap, not a small one', type: 'number', default: 25, min: 0, max: 90, step: 1 },
  ],
}

/**
 * The PREDEFINED parameter blocks any strategy can be given (its `blocks` list in STRATEGIES / SPOT_STRATEGIES): ready-made
 * settings evaluated by one shared piece of code (spotBlocks in spotEngine.js) - so a new strategy writes only its own rule
 * and lists the blocks it wants; every setting then shows on the Strategies page, in the Strategy lab and in the Expired
 * Backtest the same way, per index. A strategy NOT listing a block does not get its settings. Defaults are the rule as written.
 *   exits - the index stop-loss and target in ATR.
 */
export const PARAM_BLOCKS = {
  exits: { label: 'Index stop-loss and target', filters: [
    { key: 'stopAtr', label: 'Index stop-loss (x ATR) - the trade leaves at it', type: 'number', default: 1.5, min: 0.5, max: 5, step: 0.25 },
    { key: 'targetAtr', label: 'Index target (x ATR)', type: 'number', default: 3, min: 0.5, max: 10, step: 0.25 },
  ] },
}
/** The blocks of a strategy, in the order they are listed. */
export const blocksOf = (id) => (STRATEGY_BY_ID[id]?.blocks ?? []).filter((b) => PARAM_BLOCKS[b])
export const STRATEGY_FILTERS = {}
/** Where a filter of STRATEGY_FILTERS belongs, for the dialogs: its strategy's own rules, one of its predefined blocks, or the
 *  trade filters every strategy has. */
export const filterGroup = (f) => (f.block ? PARAM_BLOCKS[f.block].label : f.key.startsWith('trade') ? 'How the trade is taken (every strategy)' : 'Its own rules')
// How any strategy's trades are taken (every strategy has these, after its own): long / short only, the
// entry time window, the stop-loss and target as a multiple of the strategy's own, a time stop, a trailing
// stop of its own. The defaults are the strategy exactly as written; the strategy tuning measures them.
const HHMM_OPTIONS = []
for (let m = 9 * 60 + 30; m <= 14 * 60 + 45; m += 15) HHMM_OPTIONS.push({ value: Math.floor(m / 60) * 100 + (m % 60), label: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` })
export const TRAIL_CHOICES = { '0.5/0.5': { startR: 0.5, gapR: 0.5 }, '1/1': { startR: 1, gapR: 1 }, '1.5/1': { startR: 1.5, gapR: 1 }, '2/1': { startR: 2, gapR: 1 } }
const SIDE_OI_OPTIONS = [{ value: 'any', label: 'Any' }, { value: 'notAgainst', label: 'The two sides not against the trade' }, { value: 'lean', label: 'At least one side with it, none against (PE rising / CE falling for a long)' }, { value: 'both', label: 'Both sides with it' }]
const OI_LEAN_OPTIONS = [{ value: 'any', label: 'Any' }, { value: 'notAgainst', label: 'Not against the trade' }, { value: 'with', label: 'With the trade (puts written for a long, calls for a short)' }]

/** The OI at a setup's minute, as numbers (`push` puts it on every setup): `flow` / `cum` - the whole chain's
 *  options OI lean over the last 15 minutes / since the open, -1..+1, + = puts written more than calls
 *  (bullish; net CE - PE negative); `futOiPct` / `futPricePct` - the futures' OI and price change over 15
 *  minutes; `support` / `resistance` - the biggest put / call OI strikes around the index (`spot`). */
const OI_LEAN = 0.2 // a lean this strong (either way) counts as with / against
const FUT_OI_MOVE = 0.001 // 0.1% of futures OI in 15 minutes - positions really added or closed
const SIDE_OI_MOVE = 0.003 // 0.3% of a side's (CE or PE) OI in 15 minutes - that side really rising or falling
const SIDE_OI_CUM_MOVE = 0.01 // 1% of it since the open
const WALL_OI_MOVE = 0.005 // 0.5% of a wall's OI in 15 minutes - writers really adding or leaving
const FUT_PRICE_MOVE = 0.0005 // 0.05% in 15 minutes - the price really moved (~12 NIFTY points)

/** The timeframes (minutes) the OI read is recorded on, and the one the scanner has always used. */
export const OI_WINDOWS = [1, 3, 5, 15]
export const OI_WINDOW = 15
const oiWindowOf = (m) => (OI_WINDOWS.includes(m) ? m : OI_WINDOW)
/** A setup's OI read on `window` minutes: { flow, futOiPct, futPricePct } - null when that window was not recorded.
 *  15 minutes is the top-level oiCtx; the shorter ones are in oiCtx.byWindow. */
function windowRead(ctx, window) {
  if (!ctx) return null
  return window === OI_WINDOW ? ctx : ctx.byWindow?.[window] ?? null
}

/** Futures OI over the last 15 minutes against the trade's direction `dir`: 'buildUp' (fresh positions its
 *  way: price with it, OI up), 'covering' (the other side closing: price with it, OI down), 'against'
 *  (fresh positions the other way: price against it, OI up), 'unwinding' (its side closing) or 'flat'. */
export function futuresOiStance(ctx, dir, window = OI_WINDOW) {
  const r = windowRead(ctx, window)
  const oi = r?.futOiPct
  const price = r?.futPricePct
  // The moves that count scale with the window (0.1% OI / 0.05% price are the 15-minute bars).
  const scale = Math.max(0.2, window / OI_WINDOW)
  if (!Number.isFinite(oi) || !Number.isFinite(price) || Math.abs(oi) < FUT_OI_MOVE * scale || Math.abs(price) < FUT_PRICE_MOVE * scale) return 'flat'
  const withIt = dir * price > 0
  if (oi > 0) return withIt ? 'buildUp' : 'against'
  return withIt ? 'covering' : 'unwinding'
}

/** Whether a setup passes the OI confirmation filters (TRADE_FILTERS tradeOiFlow / tradeOiCum / tradeFutOi /
 *  tradeWallRoom, values `f`) - all 'any' (the defaults) pass everything. A read the setup has no data for
 *  passes 'notAgainst' and fails 'with'; no wall that way is all the room in the world. */
export function oiGatePasses(s, f) {
  const dir = s.side === 'LONG' ? 1 : -1
  const ctx = s.oiCtx ?? null
  const lean = (v, mode) => mode === 'any' || mode == null || (Number.isFinite(v)
    ? (mode === 'with' ? dir * v >= OI_LEAN : dir * v > -OI_LEAN)
    : mode === 'notAgainst')
  const window = oiWindowOf(f.tradeOiWindow)
  if (!lean(windowRead(ctx, window)?.flow, f.tradeOiFlow) || !lean(ctx?.cum, f.tradeOiCum)) return false
  // CE and PE each rising or falling (a side's OI change as a fraction of its total): PE rising and CE falling are
  // both bullish, PE falling and CE rising both bearish. delta: on the options OI timeframe; cum: since the open.
  const sideOk = (mode, ce, pe, bar) => {
    if (mode === 'any' || mode == null) return true
    if (!Number.isFinite(ce) || !Number.isFinite(pe)) return mode === 'notAgainst'
    const st = (x) => (x >= bar ? 1 : x <= -bar ? -1 : 0)
    const score = dir * (st(pe) - st(ce)) // -2 .. 2, + = the two sides back the trade
    return mode === 'both' ? score === 2 : mode === 'lean' ? score >= 1 : score >= 0
  }
  const wr = windowRead(ctx, window)
  if (!sideOk(f.tradeSideOi, wr?.ceD, wr?.peD, SIDE_OI_MOVE * Math.max(0.2, window / OI_WINDOW))) return false
  if (!sideOk(f.tradeSideCum, ctx?.ceC, ctx?.peC, SIDE_OI_CUM_MOVE)) return false
  const fut = f.tradeFutOi ?? 'any'
  const futWindow = oiWindowOf(f.tradeFutWindow)
  if (fut !== 'any') {
    const st = futuresOiStance(ctx, dir, futWindow)
    if (fut === 'notAgainst' && st === 'against') return false
    if (fut === 'withMove' && st !== 'buildUp' && st !== 'covering') return false
    if (fut === 'buildUp' && st !== 'buildUp') return false
    // The other side closing with the move: a short squeeze for a long, a long unwinding for a short.
    if (fut === 'squeeze' && st !== 'covering') return false
  }
  // How far futures moved on its timeframe: a small move is under twice the bar a real move needs.
  const move = f.tradeMoveSize ?? 'any'
  if (move !== 'any') {
    const pct = windowRead(ctx, futWindow)?.futPricePct
    const bar = 2 * FUT_PRICE_MOVE * Math.max(0.2, futWindow / OI_WINDOW)
    if (!Number.isFinite(pct) || (move === 'small' ? Math.abs(pct) >= bar : Math.abs(pct) < bar)) return false
  }
  // The day type at the setup's minute (dayRegime.js: price + OI + CVD votes).
  const dayType = f.tradeDayType ?? 'any'
  if (dayType !== 'any') {
    const dt = ctx?.dayType
    const upDay = dt === 'trend-up'
    const downDay = dt === 'trend-down'
    if (dayType === 'notAgainstTrend') { if (dir > 0 ? downDay : upDay) return false }
    else if (dayType === 'trend') { if (!upDay && !downDay) return false }
    else if (dayType === 'withTrend') { if (dir > 0 ? !upDay : !downDay) return false }
    else if (dayType === 'range' && dt !== 'range' && dt !== 'two-sided') return false
  }
  // The OI of the wall in the trade's way (the biggest call strike above for a long, put strike below for a short)
  // on the options OI timeframe: shrinking = its writers are leaving, growing = more being written. Needs a read.
  const wallOi = f.tradeWallOi ?? 'any'
  if (wallOi !== 'any') {
    const chg = windowRead(ctx, window)?.[dir > 0 ? 'resChg' : 'supChg']
    const bar = WALL_OI_MOVE * Math.max(0.2, window / OI_WINDOW)
    if (!Number.isFinite(chg) || (wallOi === 'shrinking' ? chg > -bar : chg < bar)) return false
  }
  const room = f.tradeWallRoom ?? 'any'
  if (room !== 'any') {
    // The biggest wall strictly AHEAD of the price (a wall just broken sits behind it and is no obstacle);
    // an older setup without it falls back to the wall the strategy saw.
    const ahead = dir > 0 ? ctx?.resistanceAhead : ctx?.supportAhead
    const wall = ahead !== undefined ? ahead : dir > 0 ? ctx?.resistance : ctx?.support
    if (Number.isFinite(wall) && Number.isFinite(ctx?.spot)) {
      const space = dir * (wall - ctx.spot)
      const need = room === 'target' ? Math.abs(s.target - s.entry) : Math.abs(s.entry - s.stop)
      if (space < need) return false
    }
  }
  return true
}

export const TRADE_FILTERS = [
  { key: 'tradeSide', label: 'Trade (any strategy): sides', type: 'select', default: 'both', options: [{ value: 'both', label: 'Long and short' }, { value: 'long', label: 'Long only' }, { value: 'short', label: 'Short only' }] },
  { key: 'tradeFrom', label: 'Trade: entries from (IST)', type: 'select', default: 930, options: HHMM_OPTIONS },
  { key: 'tradeTo', label: 'Trade: entries until (IST)', type: 'select', default: 1445, options: HHMM_OPTIONS },
  { key: 'tradeStopX', label: 'Trade: stop-loss distance (x the strategy\'s own)', type: 'number', default: 1, min: 0.5, max: 2, step: 0.25 },
  { key: 'tradeTargetX', label: 'Trade: target distance (x the strategy\'s own)', type: 'number', default: 1, min: 0.5, max: 3, step: 0.25 },
  { key: 'tradeTimeStop', label: 'Trade: time stop in minutes (0 = the strategy\'s own)', type: 'number', default: 0, min: 0, max: 330, step: 5 },
  { key: 'tradeTrail', label: 'Trade: trailing stop', type: 'select', default: 'scanner', options: [{ value: 'scanner', label: 'The scanner\'s setting' }, { value: 'off', label: 'Off' }, ...Object.keys(TRAIL_CHOICES).map((k) => ({ value: k, label: `After ${k.split('/')[0]}R, ${k.split('/')[1]}R behind` }))] },
  // OI confirmation (oiGatePasses) - read at the setup's own minute (its `oiCtx`); 'any' = not checked.
  { key: 'tradeOiWindow', label: 'Trade: options OI timeframe, for the OI change and the wall OI (minutes)', type: 'select', default: 15, options: OI_WINDOWS.map((m) => ({ value: m, label: `${m} min` })) },
  { key: 'tradeFutWindow', label: 'Trade: futures OI timeframe (minutes)', type: 'select', default: 15, options: OI_WINDOWS.map((m) => ({ value: m, label: `${m} min` })) },
  { key: 'tradeOiFlow', label: 'Trade: options OI change on its timeframe (whole chain)', type: 'select', default: 'any', options: OI_LEAN_OPTIONS },
  { key: 'tradeOiCum', label: 'Trade: options OI since the open (cumulative, net CE - PE)', type: 'select', default: 'any', options: OI_LEAN_OPTIONS },
  { key: 'tradeWallOi', label: 'Trade: OI of the wall in the way (call strike above a long, put strike below a short)', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'shrinking', label: 'Shrinking (its writers are leaving)' }, { value: 'growing', label: 'Growing (more being written)' }] },
  { key: 'tradeSideOi', label: 'Trade: CE and PE OI each rising / falling on the options OI timeframe', type: 'select', default: 'any', options: SIDE_OI_OPTIONS },
  { key: 'tradeSideCum', label: 'Trade: CE and PE OI each rising / falling since the open (cumulative)', type: 'select', default: 'any', options: SIDE_OI_OPTIONS },
  { key: 'tradeFutOi', label: 'Trade: futures OI on its timeframe', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'notAgainst', label: 'Not a fresh build-up against it' }, { value: 'withMove', label: 'Moving with it (build-up or covering)' }, { value: 'buildUp', label: 'Fresh build-up with it' }, { value: 'squeeze', label: 'Other side closing with the move (short squeeze for a long, long unwinding for a short)' }] },
  { key: 'tradeMoveSize', label: 'Trade: futures price move on its timeframe', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'small', label: 'Small move' }, { value: 'large', label: 'Real move' }] },
  { key: 'tradeDayType', label: 'Trade: day type at the signal', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'trend', label: 'Trending day (up or down)' }, { value: 'withTrend', label: 'Trending day, my way' }, { value: 'notAgainstTrend', label: 'Not against a trend' }, { value: 'range', label: 'Range / two-sided day' }] },
  { key: 'tradeWallRoom', label: 'Trade: room to the next OI wall (support / resistance)', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'oneR', label: 'At least 1R' }, { value: 'target', label: 'Not inside the target' }] },
  // Order flow at the signal (its `market` - marketAt): the tape, big orders, the order book, delta and volume. Where the
  // data is not there (an estimated day has no tape or book) the filter cannot judge, so it lets the trade through.
  { key: 'tradeTape', label: 'Order flow: tape aggression (last minute) with the trade', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'notAgainst', label: 'Not against it (45%+ my way)' }, { value: 'with', label: 'With it (55%+ my way)' }, { value: 'strong', label: 'Strongly with it (60%+ my way)' }] },
  { key: 'tradeBig', label: 'Order flow: big orders in the last 5 min', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'notAgainst', label: 'Not net against it' }, { value: 'with', label: 'Net with it' }] },
  { key: 'tradeBook', label: 'Order flow: order book near the price (heatmap)', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'notAgainst', label: 'Not leaning against it' }, { value: 'with', label: 'Leaning my way (10%+ more on my side)' }] },
  { key: 'tradeCvd', label: 'Order flow: delta of the last 15 minutes', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'with', label: 'With it' }] },
  { key: 'tradeVolume', label: 'Order flow: volume of the last 15 minutes vs the day', type: 'select', default: 'any', options: [{ value: 'any', label: 'Any' }, { value: 'above', label: 'Above the day\'s average (1.2x+)' }, { value: 'below', label: 'Quiet (under the average)' }] },
  // How THIS strategy is taken in options, when it fires. 'default' / 0 means "whatever the scanner is set to", so a
  // strategy nobody has tuned behaves exactly as before. These are what the Strategy tuning page applies, and what the
  // paper trade - and a live order, when Auto-place is on - actually uses (optionPlanFor).
  { key: 'tradeOptLeg', label: 'Option: buy or sell when this strategy fires', type: 'select', default: 'default', options: [{ value: 'default', label: 'The scanner\'s setting' }, { value: 'buy', label: 'BUY the option that gains with the move' }, { value: 'sell', label: 'SELL (write) the one that loses value' }] },
  { key: 'tradeOptMoneyness', label: 'Option: which strike', type: 'select', default: 'default', options: [{ value: 'default', label: 'The scanner\'s setting' }, { value: 0, label: 'ATM' }, { value: 1, label: '1 in the money' }, { value: 2, label: '2 in the money' }, { value: -1, label: '1 out of the money' }, { value: -2, label: '2 out of the money' }] },
  // How the option leaves the trade - the tuning's optExit. Every strategy's option trade follows ITS OWN exit (never the
  // Trade settings' SL / target / trail - those are a manual trade's), held to the index's max rules (Max SL / Max target).
  // 'default': its % below decide - a target %: 'first'; an SL % only: 'indexSl'; neither: with the index trade.
  { key: 'tradeOptExit', label: 'Option: exit', type: 'select', default: 'default', options: [{ value: 'default', label: 'By its % below (none: with the index trade)' }, { value: 'index', label: 'With the index trade only' }, { value: 'indexSl', label: 'With the index trade, capped at its SL %' }, { value: 'first', label: 'Its SL % / target %, or the index exit, first' }, { value: 'option', label: 'Its SL % / target % only (else 15:10)' }] },
  { key: 'tradeOptSlPct', label: 'Option: SL as a % of the premium paid / received (0 = none of its own; with an exit that has one, 20%)', type: 'number', default: 0, min: 0, max: 90, step: 5 },
  { key: 'tradeOptTargetPct', label: 'Option: target as a % of the premium (0 = none of its own; with an exit that has one, 30%)', type: 'number', default: 0, min: 0, max: 300, step: 5 },
]

/** The keys above that decide how a strategy is taken in OPTIONS (not which setups it takes). */
export const OPTION_TRADE_FILTERS = ['tradeOptLeg', 'tradeOptMoneyness', 'tradeOptExit', 'tradeOptSlPct', 'tradeOptTargetPct']
/** An option exit of the strategy's own with no % set uses the tuning's own defaults (OPTION_DEFAULT). */
export const OWN_EXIT_SL_PCT = 20
export const OWN_EXIT_TARGET_PCT = 30
export const OPTION_EXITS = ['index', 'indexSl', 'first', 'option']

/**
 * A strategy's option exit (one of OPTION_EXITS) - every strategy has one: the Option: exit filter, else read from its %
 * the way the Strategy lab reads it back (paramsFromFilters): a target % = 'first', an SL % only = 'indexSl', neither =
 * 'index' (out with the index trade - its own index stop / target / trailing stop / time stop). `f` = strategyFilters(...).
 */
export function ownOptionExit(f) {
  if (OPTION_EXITS.includes(f?.tradeOptExit)) return f.tradeOptExit
  return f?.tradeOptTargetPct > 0 ? 'first' : f?.tradeOptSlPct > 0 ? 'indexSl' : 'index'
}

/** A strategy's own level (premium points, null = none of its own) held to the index's max rule (`max` > 0; 0 = no
 *  max): the tighter of the two - the max alone where the strategy has none. null = no level at all. */
export function capPoints(own, max) {
  if (max > 0) return own > 0 ? Math.min(own, max) : max
  return own > 0 ? own : null
}

/**
 * The trailing stop a strategy's applied setting carries (`_trail`, stored when it was applied with "the scanner's
 * setting": the scanner's trail then, null = none) - so a later change of the scanner's trailing stop does not change a
 * tuned strategy. undefined = none stored (the scanner's own, as before).
 */
export function pinnedTrailOf(raw) {
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, '_trail')) return undefined
  const t = raw._trail
  if (t === null) return null
  return t && typeof t === 'object' && (Number(t.gapR) > 0 || Number(t.gapPts) > 0) ? t : undefined
}

/**
 * The per-strategy filters the scanner runs with on ONE index. A fine-tuned setting is found per index (what wins on
 * NIFTY is not what wins on BANKNIFTY), so applying one stores it for that index only (`filtersByIndex[U][id]`): there
 * it replaces the strategy's all-index filters (`filters[id]`) whole; every other strategy, and every other index,
 * keeps the all-index ones. Nothing applied per index = exactly the all-index filters, as before.
 */
/**
 * How many lots a strategy's trades take on an index: its own lot size when one was applied with it there (`_lots` in
 * the strategy's filters for that index - Trades page, Apply with a lot size), else the index's lots (Trade settings).
 * `filters` = filtersForIndex(...) for that index. Paper and live alike; 1 - 500 (Trade settings' own range).
 */
export function lotsFor(id, filters, defaultLots = 1) {
  const own = Number(filters?.[id]?._lots)
  return Math.max(1, Math.min(500, Number.isInteger(own) && own >= 1 ? own : (Number(defaultLots) || 1)))
}

export function filtersForIndex(settings, underlying) {
  const all = settings?.filters ?? {}
  const own = underlying ? settings?.filtersByIndex?.[underlying] : null
  return own && Object.keys(own).length ? { ...all, ...own } : all
}

/**
 * How one strategy's signal should be taken in options: the leg (buy / sell), the strike (moneyness) and the SL /
 * target in PREMIUM POINTS for this trade. A strategy that was never tuned carries the defaults, which mean "whatever
 * the scanner is set to" - so nothing changes for it. `cfg` is the scanner's own settings (autoPaper, moneyness,
 * paperSl, paperTarget), `filters` the trader's per-strategy values (scannerSettings / the server config).
 */
export function optionPlanFor(id, filters, cfg = {}, premium = null, setup = null) {
  const f = strategyFilters(id, filters?.[id])
  const exit = ownOptionExit(f)
  // WHO DECIDES. A buy / sell chosen where the trading happens WINS - on the Order Flow page the trader is sitting
  // there and their choice is the last word, whatever a strategy was tuned to. Choosing "per strategy" (what the
  // server scanner runs on, since nobody is there to choose) hands the decision to the strategy's own tuned setting,
  // and falls back to selling when it has none. The strike and the SL / target follow the same rule.
  const chosen = cfg.autoPaper === 'buy' || cfg.autoPaper === 'sell' ? cfg.autoPaper : null
  const perStrategy = cfg.autoPaper === 'strategy'
  const tunedLeg = f.tradeOptLeg === 'buy' || f.tradeOptLeg === 'sell' ? f.tradeOptLeg : null
  // A signal that decides its own leg (a strategy with ownLeg - #115 buys on a trend day and sells on a range day): used
  // under "per strategy" when no tuned leg is applied. A side chosen for the index, or a tuned leg, still wins.
  const signalLeg = setup?.optLeg === 'buy' || setup?.optLeg === 'sell' ? setup.optLeg : null
  const leg = perStrategy ? tunedLeg ?? signalLeg ?? 'sell' : chosen
  const overrode = !!(chosen && tunedLeg && tunedLeg !== chosen)
  const tunedMoneyness = f.tradeOptMoneyness === 'default' || f.tradeOptMoneyness == null ? null : f.tradeOptMoneyness
  const moneyness = perStrategy ? tunedMoneyness ?? (cfg.moneyness ?? 0) : (cfg.moneyness ?? tunedMoneyness ?? 0)
  // A percentage is of the premium actually paid / received, so it only becomes points once that is known; until then
  // (and whenever it is 0) the index's own points setting stands.
  // ITS OWN exit, as the tuning measures it (optionOutcome): its SL only where its exit has one ('indexSl', 'first',
  // 'option'), its target only with 'first' / 'option', out with the index trade unless 'option' - never the Trade
  // settings' SL / target / trailing stop (a manual trade's). The index's max rules hold it: never a wider SL than Max SL
  // or a farther target than Max target (`cfg.paperMaxSl` / `paperMaxTarget`; 0 = none) - the max alone where it has
  // none. null = no such level. Its own levels are null until the premium is known.
  const ownPct = (p, d) => (premium > 0 ? (premium * (p > 0 ? p : d)) / 100 : null)
  const ownSlPts = exit === 'index' ? null : ownPct(f.tradeOptSlPct, OWN_EXIT_SL_PCT)
  const ownTargetPts = exit === 'first' || exit === 'option' ? ownPct(f.tradeOptTargetPct, OWN_EXIT_TARGET_PCT) : null
  const maxSl = Number(cfg.paperMaxSl) || 0
  const maxTarget = Number(cfg.paperMaxTarget) || 0
  return {
    leg, moneyness, exit, own: true,
    ownSlPts, ownTargetPts, maxSl, maxTarget,
    slPts: capPoints(ownSlPts, maxSl), targetPts: capPoints(ownTargetPts, maxTarget),
    trailStart: 0, trailGap: 0,
    // Whether this strategy has a tuned option setting at all, and whether the trader's own choice has just overruled
    // it (so the page can say so rather than quietly doing something else than the strategy was tuned for).
    fromStrategy: f.tradeOptLeg !== 'default' || f.tradeOptMoneyness !== 'default' || f.tradeOptSlPct > 0 || f.tradeOptTargetPct > 0 || f.tradeOptExit !== 'default',
    tunedLeg,
    overrode,
  }
}

/** One line for how a plan's option leaves the trade: its own exit, and where the index's max rule is what holds it. */
export function optionExitText(plan) {
  if (!plan) return ''
  const lvl = (v, own, max, word) => (v > 0 ? `${word} ${v.toFixed(1)}${max > 0 && !(own > 0 && own <= max) ? ' (the max)' : ''}` : `no ${word}`)
  const levels = `${lvl(plan.slPts, plan.ownSlPts, plan.maxSl, 'SL')} / ${lvl(plan.targetPts, plan.ownTargetPts, plan.maxTarget, 'target')} pts`
  if (plan.exit === 'option') return `option: its own SL / target only (${levels}), else 15:10`
  return `option out with the index trade${plan.slPts > 0 || plan.targetPts > 0 ? `, or ${levels} first` : ''}`
}
for (const st of [...STRATEGIES, ...SPOT_STRATEGIES]) {
  STRATEGY_FILTERS[st.id] = [...(STRATEGY_OWN_FILTERS[st.id] ?? []), ...blocksOf(st.id).flatMap((b) => PARAM_BLOCKS[b].filters.map((f) => ({ ...f, block: b }))), ...TRADE_FILTERS]
}

/** A strategy's filter values: its defaults with the trader's `overrides` on top - numbers clamped to
 *  their range, a choice not in the list, wrong types and unknown keys ignored. */
export function strategyFilters(id, overrides) {
  const out = {}
  for (const f of STRATEGY_FILTERS[id] ?? []) {
    const v = overrides?.[f.key]
    if (f.type === 'switch') out[f.key] = typeof v === 'boolean' ? v : f.default
    else if (f.type === 'select') out[f.key] = f.options.some((o) => o.value === v) ? v : f.default
    else out[f.key] = Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, v)) : f.default
  }
  return out
}

/** A setup taken the way the strategy's trade filters say (TRADE_FILTERS, values `f`): null when its side or
 *  its time is not traded; else with its stop / target scaled, its time stop and trailing stop - unchanged
 *  with the defaults. The scanner and the strategy tuning both use this, so a tuned setting trades as tested. */
export function applyTradeFilter(s, f) {
  if (!f) return s
  if ((f.tradeSide === 'long' && s.side !== 'LONG') || (f.tradeSide === 'short' && s.side !== 'SHORT')) return null
  const minute = istMinute(s.t)
  const hhmm = Math.floor(minute / 60) * 100 + (minute % 60)
  if (hhmm < (f.tradeFrom ?? 930) || hhmm > (f.tradeTo ?? 1445)) return null
  if (!flowGatePasses(s, f)) return null
  const oiGated = ['tradeOiFlow', 'tradeOiCum', 'tradeFutOi', 'tradeWallRoom', 'tradeWallOi', 'tradeSideOi', 'tradeSideCum', 'tradeMoveSize', 'tradeDayType'].some((k) => (f[k] ?? 'any') !== 'any')
  const stopX = f.tradeStopX ?? 1
  const targetX = f.tradeTargetX ?? 1
  const timeStop = f.tradeTimeStop ?? 0
  const trail = f.tradeTrail ?? 'scanner'
  if (stopX === 1 && targetX === 1 && !(timeStop > 0) && trail === 'scanner') return !oiGated ? s : oiGatePasses(s, f) ? { ...s, checks: { ...s.checks, Trade: oiGateText(f) } } : null
  const dir = s.side === 'LONG' ? 1 : -1
  const parts = []
  if (stopX !== 1) parts.push(`stop x${stopX}`)
  if (targetX !== 1) parts.push(`target x${targetX}`)
  if (timeStop > 0) parts.push(`time stop ${timeStop} min`)
  if (trail !== 'scanner') parts.push(trail === 'off' ? 'no trailing stop' : `trailing after ${trail.split('/')[0]}R, ${trail.split('/')[1]}R behind`)
  if (oiGated) parts.push(oiGateText(f))
  const taken = {
    ...s,
    stop: s.entry - dir * Math.abs(s.entry - s.stop) * stopX,
    target: s.entry + dir * Math.abs(s.target - s.entry) * targetX,
    timeStopMs: timeStop > 0 ? Math.min(s.t + timeStop * MIN, s.t + (SQUARE_OFF - minute) * MIN) : s.timeStopMs,
    ...(trail !== 'scanner' ? { trailOverride: trail === 'off' ? null : { ...TRAIL_CHOICES[trail] } } : {}),
    checks: { ...s.checks, Trade: parts.join(' · ') },
  }
  // The wall room is judged against the stop / target as traded (scaled above).
  return !oiGated || oiGatePasses(taken, f) ? taken : null
}

export const FLOW_FILTER_KEYS = ['tradeTape', 'tradeBig', 'tradeBook', 'tradeCvd', 'tradeVolume']

/** The order-flow filters (tape, big orders, book, delta, volume) on the setup's `market` - a number that is not there
 *  (an estimated day) passes: the filter cannot judge it. */
export function flowGatePasses(s, f) {
  const m = s.market
  if (!m || FLOW_FILTER_KEYS.every((k) => (f[k] ?? 'any') === 'any')) return true
  const dir = s.side === 'LONG' ? 1 : -1
  const ok = (v, test) => v == null || !Number.isFinite(v) || test(v)
  const tape = m.tape60 == null ? null : dir * (m.tape60 - 50) // points my way over 50%
  const checks = {
    tradeTape: { notAgainst: () => ok(tape, (v) => v >= -5), with: () => ok(tape, (v) => v >= 5), strong: () => ok(tape, (v) => v >= 10) },
    tradeBig: { notAgainst: () => ok(m.bigNet, (v) => dir * v >= 0), with: () => ok(m.bigNet, (v) => dir * v > 0) },
    tradeBook: { notAgainst: () => ok(m.bookImb, (v) => dir * v >= -0.1), with: () => ok(m.bookImb, (v) => dir * v >= 0.1) },
    tradeCvd: { with: () => ok(m.cvd15, (v) => dir * v > 0) },
    tradeVolume: { above: () => ok(m.volX, (v) => v >= 1.2), below: () => ok(m.volX, (v) => v < 1) },
  }
  return FLOW_FILTER_KEYS.every((k) => { const mode = f[k] ?? 'any'; return mode === 'any' || (checks[k][mode]?.() ?? true) })
}

/** The OI confirmation filters in force, in words. */
export function oiGateText(f) {
  const words = { with: 'with it', notAgainst: 'not against', withMove: 'moving with it', buildUp: 'fresh build-up with it', oneR: '1R+', target: 'beyond the target', shrinking: 'shrinking', growing: 'growing', lean: 'one side with it', both: 'both sides with it', squeeze: 'squeeze / unwinding', small: 'small', large: 'real', trend: 'trending', withTrend: 'trending my way', notAgainstTrend: 'not against a trend', range: 'range / two-sided' }
  const parts = []
  const w = oiWindowOf(f.tradeOiWindow)
  const fw = oiWindowOf(f.tradeFutWindow)
  if ((f.tradeOiFlow ?? 'any') !== 'any') parts.push(`options OI ${w}m ${words[f.tradeOiFlow]}`)
  if ((f.tradeOiCum ?? 'any') !== 'any') parts.push(`options OI since open ${words[f.tradeOiCum]}`)
  if ((f.tradeFutOi ?? 'any') !== 'any') parts.push(`futures OI${fw === OI_WINDOW ? '' : ` ${fw}m`} ${words[f.tradeFutOi]}`)
  if ((f.tradeSideOi ?? 'any') !== 'any') parts.push(`CE / PE ${w}m ${words[f.tradeSideOi]}`)
  if ((f.tradeSideCum ?? 'any') !== 'any') parts.push(`CE / PE since open ${words[f.tradeSideCum]}`)
  if ((f.tradeMoveSize ?? 'any') !== 'any') parts.push(`${words[f.tradeMoveSize]} futures move${fw === OI_WINDOW ? '' : ` ${fw}m`}`)
  if ((f.tradeDayType ?? 'any') !== 'any') parts.push(`day: ${words[f.tradeDayType]}`)
  if ((f.tradeWallOi ?? 'any') !== 'any') parts.push(`wall OI${w === OI_WINDOW ? '' : ` ${w}m`} ${words[f.tradeWallOi]}`)
  if ((f.tradeWallRoom ?? 'any') !== 'any') parts.push(`OI wall ${words[f.tradeWallRoom]}`)
  return parts.length ? `OI: ${parts.join(', ')}` : ''
}
/** The filters of `id` the trader changed from the defaults (for an "edited" mark). */
export function changedFilters(id, overrides) {
  const v = strategyFilters(id, overrides)
  return (STRATEGY_FILTERS[id] ?? []).filter((f) => v[f.key] !== f.default)
}

// ---- OI context -----------------------------------------------------------------------------------

function sortedSeries(points, lag = 0) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    // 0 is the feed's "no OI" reading, not an empty strike - a real one would read as everything unwound.
    if (!(p.openInterest > 0)) continue
    const strike = Number(p.strike)
    if (!byStrike.has(strike)) byStrike.set(strike, [])
    byStrike.get(strike).push({ t: msOf(p.time) + lag, oi: p.openInterest, price: p.price, high: p.high ?? p.price, low: p.low ?? p.price })
  }
  for (const list of byStrike.values()) list.sort((a, b) => a.t - b.t)
  return byStrike
}

export function valueAt(series, ms) {
  if (!series?.length || series[0].t > ms) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (series[mid].t <= ms) lo = mid; else hi = mid - 1
  }
  return series[lo]
}

// From an /api/oi-replay/{u}/run response (+ the day's expiry date, if known).
//
// Every point of a run is a 1-minute bar stamped at its START but holding its CLOSE (OI, premium,
// price at the minute's end). A replayed day (`live` false) stamps each point at its END instead
// (`lag`), so the replay clock - and Scan day - only ever read minutes that are over: at 12:11:00 the
// latest reading is 12:10's close, never 12:11's, which is a minute in the future. Live, the current
// minute's point holds the latest tick (useDayOi folds them in), so it is read as it comes.
export function buildOiContext(run, expiryDate = null, { live = false } = {}) {
  if (!run?.success) return null
  const lag = live ? 0 : MIN
  const futures = (run.futuresBars ?? []).map((b) => ({ t: msOf(b.time) + lag, close: b.close, oi: b.openInterest })).sort((a, b) => a.t - b.t)
  const spot = (run.spotCandlesOneMinute ?? run.spotCandles ?? []).map((c) => ({ t: msOf(c.time) + lag, close: c.close })).sort((a, b) => a.t - b.t)
  return {
    step: run.step || 50,
    lag,
    live,
    ce: sortedSeries(run.cePoints, lag),
    pe: sortedSeries(run.pePoints, lag),
    futures,
    spot,
    // Live: the listed expiry is today. A replayed day: whether THAT date was an expiry (wasExpiryDay) -
    // the listed expiry is a later date there, so the expiry-day strategy (#10) never ran on a past day.
    isExpiryDay: (expiryDate != null && expiryDate === run.date) || (!live && wasExpiryDay(run, expiryDate)),
    expiry: expiryDate,
    date: run.date,
  }
}

/** Whether a REPLAYED date was an options expiry day. The expiry calendar is known before the day (it is the
 *  contracts' own date, not market data), so this is no look-ahead. `expiryDate` is the expiry listed NOW (a
 *  later date for a past day); the run carries the futures contract that was the front month on that date
 *  (`futuresExpiry`) and the options cycle (`expiryFlag`). Conservative - a day only counts when the dates agree:
 *  - the date IS its front-month futures expiry (monthly options expire with the futures, every index); or
 *  - weekly options (NIFTY, SENSEX): the date falls on the weekly expiry's weekday - the listed weekly expiry's
 *    AND that month's futures expiry's weekday (so a holiday-shifted expiry, or a day from before an exchange
 *    moved its expiry day, is not counted) - with that futures contract within 35 days (that date's own front
 *    month, not a much later contract the instrument master fell back to).
 *  Anything missing -> false (as before). */
export function wasExpiryDay(run, expiryDate) {
  const date = run?.date
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  if (expiryDate != null && expiryDate === date) return true
  const fut = typeof run.futuresExpiry === 'string' ? run.futuresExpiry.slice(0, 10) : null
  if (fut == null) return false
  if (fut === date) return true
  if (run.expiryFlag !== 'WEEK' || typeof expiryDate !== 'string') return false
  const day = (d) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`)
  const gap = (day(fut) - day(date)) / 86_400_000
  if (!(gap > 0 && gap <= 35)) return false
  const dow = (d) => new Date(day(d)).getUTCDay()
  return dow(date) === dow(expiryDate) && dow(date) === dow(fut)
}

/** Today's LIVE context read the way a replay is (each minute once it is over) - for scanning today so
 *  far, minute by minute, without a minute's look-ahead. A replayed day's context is returned as is. */
export function asReplayContext(oi) {
  if (!oi || oi.lag === MIN) return oi
  const shift = (list) => list.map((p) => ({ ...p, t: p.t + MIN }))
  const shiftMap = (map) => new Map([...map].map(([k, list]) => [k, shift(list)]))
  return { ...oi, lag: MIN, live: false, ce: shiftMap(oi.ce), pe: shiftMap(oi.pe), futures: shift(oi.futures), spot: shift(oi.spot) }
}

export function oiOf(map, strike, ms) {
  return valueAt(map.get(strike), ms)?.oi ?? null
}

export function oiChange(map, strike, ms, minutes) {
  const now = oiOf(map, strike, ms)
  const then = oiOf(map, strike, ms - minutes * MIN)
  return now != null && then != null ? now - then : null
}

// Strike rows (CE / PE OI) as of `ms`.
export function oiRows(oi, ms) {
  const strikes = new Set([...oi.ce.keys(), ...oi.pe.keys()])
  return [...strikes].sort((a, b) => a - b).map((strike) => ({ strike, ceOi: oiOf(oi.ce, strike, ms) ?? 0, peOi: oiOf(oi.pe, strike, ms) ?? 0 }))
}

export function maxPainOf(rows) {
  let best = null
  let bestPain = Infinity
  for (const c of rows) {
    let pain = 0
    for (const r of rows) pain += r.ceOi * Math.max(0, c.strike - r.strike) + r.peOi * Math.max(0, r.strike - c.strike)
    if (pain < bestPain) { bestPain = pain; best = c.strike }
  }
  return best
}

/**
 * The OPTIONS OI read every strategy is checked against - over the WHOLE option chain loaded for the
 * day (every strike, not just the ones near the money), on two clocks: the last `minutes` and since
 * the open. Put writing ahead of call writing = writers expect support (bullish); call writing ahead =
 * resistance (bearish).
 *   lean / leanOpen: (put OI added - call OI added) / (both added), -1..+1 (+ = puts written more =
 *     bullish) - damped when the change is too small to mean anything (noise).
 *   combined: 45% the recent lean, 55% the since-open one, nudged by the PCR's move since the open.
 * `near` (strikes each side of ATM) restricts it to the money - used only as an optional confirmation.
 */
export function optionOiRead(oi, spot, ms, minutes = 15, near = null) {
  if (!oi || !spot) return null
  const atm = Math.round(spot / oi.step) * oi.step
  const openMs = dayOpenMs(oi, ms)
  const strikes = near == null
    ? [...new Set([...oi.ce.keys(), ...oi.pe.keys()])]
    : Array.from({ length: 2 * near + 1 }, (_, i) => atm + (i - near) * oi.step)
  let peNow = 0, ceNow = 0, peChg = 0, ceChg = 0, peOpen = 0, ceOpen = 0, seen = 0
  for (const strike of strikes) {
    const pe = oiOf(oi.pe, strike, ms)
    const ce = oiOf(oi.ce, strike, ms)
    if (pe == null || ce == null) continue
    seen++
    peNow += pe
    ceNow += ce
    peChg += oiChange(oi.pe, strike, ms, minutes) ?? 0
    ceChg += oiChange(oi.ce, strike, ms, minutes) ?? 0
    peOpen += pe - (openOi(oi.pe, strike, openMs) ?? pe)
    ceOpen += ce - (openOi(oi.ce, strike, openMs) ?? ce)
  }
  if (!seen || peNow + ceNow <= 0 || ceNow <= 0) return null
  const total = peNow + ceNow
  const lean = (pe, ce, floor) => (pe - ce) / Math.max(Math.abs(pe) + Math.abs(ce), floor * total)
  const pcr = peNow / ceNow
  const pcrBefore = ceNow - ceChg > 0 ? (peNow - peChg) / (ceNow - ceChg) : pcr
  const pcrAtOpen = ceNow - ceOpen > 0 ? (peNow - peOpen) / (ceNow - ceOpen) : pcr
  const recent = lean(peChg, ceChg, 0.003)
  const sinceOpen = lean(peOpen, ceOpen, 0.01)
  const combined = Math.max(-1, Math.min(1, 0.45 * recent + 0.55 * sinceOpen + 0.2 * Math.max(-1, Math.min(1, (pcr - pcrAtOpen) / 0.2))))
  return {
    atm, minutes, near, strikes: seen, peNow, ceNow, peChg, ceChg, peOpen, ceOpen, net: peChg - ceChg,
    lean: recent, leanOpen: sinceOpen, combined, pcr, pcrChange: pcr - pcrBefore, pcrOpenChange: pcr - pcrAtOpen,
  }
}

// The day's first minute (the open) - from the index series, else the first OI point.
function dayOpenMs(oi, ms) {
  const first = oi.spot?.[0]?.t ?? oi.futures?.[0]?.t
  return first != null && first <= ms ? first : ms
}
function openOi(map, strike, openMs) {
  const series = map.get(strike)
  return valueAt(series, openMs)?.oi ?? series?.[0]?.oi ?? null
}

/** Options OI vs a trade's direction: 'agrees', 'neutral' or 'against'. */
export function optionOiStance(read, dir) {
  if (!read) return 'neutral'
  const v = dir * read.combined
  if (v >= 0.25) return 'agrees'
  if (v <= -0.35) return 'against'
  return 'neutral'
}

const lakh = (v) => `${v >= 0 ? '+' : '-'}${(Math.abs(v) / 1e5).toFixed(1)}L`
export function optionOiText(read) {
  if (!read) return 'no options OI'
  const scope = read.near == null ? `chain (${read.strikes} strikes)` : `ATM ${read.atm} ±${read.near}`
  return `${scope}: since open puts ${lakh(read.peOpen)}, calls ${lakh(read.ceOpen)}, PCR ${read.pcr.toFixed(2)} (${read.pcrOpenChange >= 0 ? '+' : ''}${read.pcrOpenChange.toFixed(2)})`
    + ` · ${read.minutes}m puts ${lakh(read.peChg)}, calls ${lakh(read.ceChg)}`
}

// ---- the option to trade a setup with ----------------------------------------------------------------

/** An option's premium (last traded, from the OI replay series) at `ms`, or null. */
export function premiumAt(oi, side, strike, ms, maxStaleMs = 5 * MIN) {
  const series = (side === 'CE' ? oi?.ce : oi?.pe)?.get(strike)
  if (!series?.length || series[0].t > ms) return null
  // The last price AT OR BEFORE `ms`. A minute in which the strike did not trade carries no price (0), which is not
  // "no option" - it is "no trade in that minute", and the option is still worth its last traded price. So the last
  // real price is used, as long as it is recent (maxStaleMs): without this a trade whose exit minute happened to be
  // quiet showed no premium at all, and an option trade priced at that minute was dropped. A strike that has not
  // traded for longer than that is genuinely unknown, and still reads null rather than inventing a price.
  let i = 0
  for (let lo = 0, hi = series.length - 1; lo < hi;) {
    const mid = (lo + hi + 1) >> 1
    if (series[mid].t <= ms) lo = mid; else hi = mid - 1
    i = lo
  }
  for (; i >= 0 && ms - series[i].t <= maxStaleMs; i--) if (series[i].price > 0) return series[i].price
  return null
}

/** The premium a minute that ENDS at `ms` closed at - final once that minute is over, the same in a replayed day and
 *  live. A replayed day's points are stamped at their minute's end (lag), today's live ones at its START and still moving
 *  while it runs: a live read at `ms` would be the NEXT minute's running price, so it steps back to the minute that ended
 *  at `ms`. What an option is priced at when it leaves a trade at a minute's end (its signal's exit) - never a price from
 *  after it, which kept changing for a minute after the exit was announced. */
export function closePremiumAt(oi, side, strike, ms, maxStaleMs) {
  const at = (oi?.lag ?? 0) === MIN ? ms : ms - MIN
  return maxStaleMs === undefined ? premiumAt(oi, side, strike, at) : premiumAt(oi, side, strike, at, maxStaleMs)
}

/** The two ways to trade a setup with options, at the ATM strike: BUY the option that gains with the
 *  move (LONG: the call, SHORT: the put) or SELL (write) the one that loses value with it (LONG: the put,
 *  SHORT: the call) - the writer's side, which also earns the time decay. Null when there is no premium. */
export function optionTradesFor(oi, dir, spot, ms) {
  if (!oi || !spot) return null
  const strike = Math.round(spot / oi.step) * oi.step
  const buySide = dir > 0 ? 'CE' : 'PE'
  const sellSide = dir > 0 ? 'PE' : 'CE'
  const buy = premiumAt(oi, buySide, strike, ms)
  const sell = premiumAt(oi, sellSide, strike, ms)
  if (buy == null && sell == null) return null
  return {
    buy: buy == null ? null : { action: 'BUY', side: buySide, strike, premium: buy },
    sell: sell == null ? null : { action: 'SELL', side: sellSide, strike, premium: sell },
  }
}

/** A setup's option at a chosen moneyness: 0 = ATM (what the setup carries), +n = n strikes IN the money,
 *  -n = n strikes OUT of the money - for the option being traded (a call's ITM strikes are below the index,
 *  a put's above). Premium from the replay series at `ms` (the setup's time). Null when that strike has no
 *  premium. Execution only - which setups fire never depends on it. */
export function optionTradeAt(oi, setup, which, moneyness = 0, ms = setup?.t) {
  const base = setup?.options?.[which] ?? null
  if (!base || !moneyness || !oi?.step) return base
  const strike = base.strike + (base.side === 'CE' ? -1 : 1) * moneyness * oi.step
  const premium = premiumAt(oi, base.side, strike, ms)
  return premium == null ? null : { ...base, strike, premium, moneyness }
}

/** An option trade's result in premium points at `ms` (or at its exit): BUY gains when the premium
 *  rises, SELL when it falls. */
export function optionPnlPoints(trade, oi, ms) {
  const now = premiumAt(oi, trade.side, trade.strike, ms)
  if (now == null) return null
  return { premium: now, points: trade.action === 'BUY' ? now - trade.premium : trade.premium - now }
}

/** Premium points as a trade's exit reason says them: to two decimals at most (a % of the premium is 7.76, not
 *  7.763999999999942; 0.25 stays 0.25). */
const ptsText = (v) => String(+Number(v).toFixed(2))

/** A paper option trade's own premium stop-loss / target, in premium points (0 = none): the first
 *  minute after `entryMs` (and before `untilMs`) whose range reaches either level. A SELL loses when the
 *  premium rises, a BUY when it falls; the stop counts first when one minute touches both. Filled at
 *  the level itself. Returns { at (ms, the minute's end), premium, reason } or null.
 *  `levelLog` ([{ t, sl, target, trailStart, trailGap }], oldest first): the trader changed the levels
 *  while the trade was open - each minute is judged with the levels in force when it STARTED (a change
 *  applies from its minute on, never to what already passed). */
export function optionStopTargetHit(oi, trade, entryMs, untilMs, slPoints, targetPoints, trail = null, levelLog = null) {
  const logged = levelLog?.length > 0
  const trailOn = trail?.gap > 0
  if (!logged && !(slPoints > 0) && !(targetPoints > 0) && !trailOn) return null
  const series = (trade.side === 'CE' ? oi?.ce : oi?.pe)?.get(trade.strike)
  if (!series?.length) return null
  const sell = trade.action === 'SELL'
  // From the first FULL minute after the entry (a minute already running at the entry partly came
  // before it); `lag`: a replayed day's points are stamped at their minute's end.
  const lag = oi?.lag ?? 0
  const firstMinute = Math.ceil(entryMs / MIN) * MIN
  // Trailing (optionTrail.js): the stop in force in a minute comes from the best premium of the minutes
  // BEFORE it - it moves after each completed minute, only tightening (for one trail setting).
  let best = trade.premium
  for (const p of series) {
    const start = p.t - lag
    if (start < firstMinute) continue
    if (start + MIN > untilMs) break
    const high = p.high ?? p.price
    // A 0 low is a packet without a price, never a premium that fell to nothing (it would hit every BUY stop).
    const low = p.low > 0 ? p.low : p.price
    if (!(high > 0) || !(low > 0)) continue
    let sl = slPoints
    let tgt = targetPoints
    let tr = trail
    if (logged) for (const c of levelLog) if (c.t <= start) { sl = c.sl; tgt = c.target; tr = { start: c.trailStart ?? 0, gap: c.trailGap ?? 0 } }
    const stop = sl > 0 ? (sell ? trade.premium + sl : trade.premium - sl) : null
    const target = tgt > 0 ? (sell ? trade.premium - tgt : trade.premium + tgt) : null
    const trailed = tr?.gap > 0 ? optionTrailLevel(trade.action, trade.premium, best, tr.start, tr.gap) : null
    const inForce = tighterStop(trade.action, stop, trailed)
    if (inForce != null && (sell ? high >= inForce : low <= inForce)) {
      return { at: start + MIN, premium: inForce, reason: inForce === trailed && trailed !== stop ? `Trailing SL hit (${ptsText(tr.gap)} pts behind the best ${best.toFixed(1)})` : `Max SL ${ptsText(sl)} pts hit` }
    }
    if (target != null && (sell ? low <= target : high >= target)) return { at: start + MIN, premium: target, reason: `Target ${ptsText(tgt)} pts hit` }
    best = sell ? Math.min(best, low) : Math.max(best, high)
  }
  return null
}

export const optionTradeText = (t) => (t ? `${t.action === 'BUY' ? 'Buy' : 'Sell'} ${t.strike} ${t.side} @ ${t.premium.toFixed(1)}` : null)

/** Options OI and futures OI as parts of the order flow read (orderFlowBias's `extra`), each on two
 *  clocks - the last 15 min and since the open:
 *  options - put vs call writing over the whole chain, with the PCR's move (+ = puts written = bullish);
 *  futures - the price / OI regime (long build-up strongest bullish, short covering weaker; short
 *  build-up strongest bearish, long unwinding weaker). */
export function oiBiasParts(oi, ms) {
  const parts = []
  const spot = oi ? valueAt(oi.spot, ms)?.close : null
  if (!spot) return parts
  const read = optionOiRead(oi, spot, ms, 15)
  if (read) {
    const pcrNudge = (v) => 0.2 * Math.max(-1, Math.min(1, v / 0.15))
    parts.push({ name: 'Options OI · since open', weight: 15, score: Math.max(-1, Math.min(1, read.leanOpen + pcrNudge(read.pcrOpenChange))),
      detail: `chain puts ${lakh(read.peOpen)}, calls ${lakh(read.ceOpen)} · PCR ${read.pcr.toFixed(2)} (${read.pcrOpenChange >= 0 ? '+' : ''}${read.pcrOpenChange.toFixed(2)})` })
    parts.push({ name: 'Options OI · 15 min', weight: 10, score: Math.max(-1, Math.min(1, read.lean + pcrNudge(read.pcrChange))),
      detail: `chain puts ${lakh(read.peChg)}, calls ${lakh(read.ceChg)} · PCR ${read.pcrChange >= 0 ? '+' : ''}${read.pcrChange.toFixed(2)}` })
  }
  const futuresPart = (name, weight, f, scale, when) => {
    if (f?.oiPct == null) return
    const move = Math.max(-1, Math.min(1, f.pricePct / scale))
    const conviction = f.oiPct >= 0 ? 1 : 0.6
    const regime = f.pricePct >= 0 ? (f.oiPct >= 0 ? 'long build-up' : 'short covering') : (f.oiPct >= 0 ? 'short build-up' : 'long unwinding')
    parts.push({ name, weight, score: move * conviction, detail: `${regime} · price ${(f.pricePct * 100).toFixed(2)}%, OI ${f.oiPct >= 0 ? '+' : ''}${(f.oiPct * 100).toFixed(2)}% ${when}` })
  }
  futuresPart('Futures OI · since open', 10, futuresSince(oi, ms, dayOpenMs(oi, ms)), 0.005, 'since open')
  futuresPart('Futures OI · 15 min', 10, futuresChange(oi, ms, 15), 0.002, 'in 15m')
  return parts
}

/** Sudden OI walls (see suddenOi.js) on the chain at `ms`, biggest add first - none in the first 10
 *  minutes of the session (the open reshuffles OI everywhere). */
export function suddenOiWalls(oi, ms, options = {}) {
  const spot = oi ? valueAt(oi.spot, ms)?.close : null
  if (!spot || istMinute(ms) < hm(9, 25)) return []
  const strikes = [...new Set([...oi.ce.keys(), ...oi.pe.keys()])]
  return findSuddenWalls({ strikes, oiAt: (side, k, t) => oiOf(side === 'CE' ? oi.ce : oi.pe, k, t), ms, spot, step: oi.step, ...options })
}

/** What the scanner shows as the market's OI picture right now. */
export function oiSummary(oi, ms) {
  const spot = oi ? valueAt(oi.spot, ms)?.close : null
  if (!spot) return null
  const rows = oiRows(oi, ms)
  const { support, resistance } = wallsAt(oi, rows, spot)
  const f = futuresChange(oi, ms, 15)
  const regime = !f || f.oiPct == null ? null
    : f.pricePct >= 0 ? (f.oiPct >= 0 ? 'long build-up' : 'short covering') : (f.oiPct >= 0 ? 'short build-up' : 'long unwinding')
  return {
    spot, options: optionOiRead(oi, spot, ms, 15),
    support, supportChg: support != null ? oiChange(oi.pe, support, ms, 15) : null,
    resistance, resistanceChg: resistance != null ? oiChange(oi.ce, resistance, ms, 15) : null,
    maxPain: maxPainOf(rows.filter((r) => Math.abs(r.strike - spot) <= 15 * oi.step)),
    futures: f ? { ...f, regime } : null,
    sudden: suddenOiWalls(oi, ms).slice(0, 6),
  }
}

// The market at a signal, in a few numbers (MARKET_KEYS) - each read only from what was known at `nowMs`: the tape up
// to it, the completed bars, the finished minutes' OI and the last heatmap column at or before it. null where the data
// is not there (an estimated day has no tape or book). Signed as the market is (+ = buyers / longs / puts written);
// the learning turns them to "with the trade" by the signal's side.
//   tape30 / tape60 / tape300  % of the tape's volume bought at the offer, last 30 s / 1 min / 5 min
//   bigNet / bigCount          big prints (>= the big-order lots) in the last 5 min: net lots bought - sold, how many
//   cvd15                      the last 15 completed bars' delta, in lots
//   volX                       the last 15 bars' volume vs the day's 15-minute average so far
//   futPx15 / futOi15 / futOi5 futures price % and OI % change over 15 / 5 min
//   writers15 / writersOpen    option writers' lean near the money, 15 min / since the open (+ = puts written)
//   pcr                        put / call OI near the money
//   bookImb                    order book near the price (±0.15%): (bids - asks) / (bids + asks)
//   vwapDist                   price vs the day's VWAP, %
export const MARKET_KEYS = ['tape30', 'tape60', 'tape300', 'bigNet', 'bigCount', 'cvd15', 'volX', 'futPx15', 'futOi15', 'futOi5', 'writers15', 'writersOpen', 'pcr', 'bookImb', 'vwapDist']

export function marketAt({ nowMs, price, bars, tapePrints, oi, heatmap, lotSize, largeLots }) {
  const lots = (q) => q / Math.max(1, lotSize || 1)
  const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d)
  const prints = (tapePrints ?? []).filter((p) => msOf(p.time) <= nowMs)
  const aggOf = (ms) => {
    const w = prints.filter((p) => msOf(p.time) > nowMs - ms)
    const total = w.reduce((a, p) => a + (p.quantity ?? 0), 0)
    return total > 0 ? (100 * w.filter((p) => p.buy).reduce((a, p) => a + (p.quantity ?? 0), 0)) / total : null
  }
  const bigMin = Math.max(1, largeLots || 10) * Math.max(1, lotSize || 1)
  const big = prints.filter((p) => msOf(p.time) > nowMs - 5 * MIN && (p.quantity ?? 0) >= bigMin)
  const volOf = (b) => ((b.buy ?? 0) + (b.sell ?? 0)) || b.volume || 0
  const last15 = (bars ?? []).slice(-15)
  const dayVol = (bars ?? []).reduce((a, b) => a + volOf(b), 0)
  const per15 = (bars ?? []).length >= 15 ? dayVol / ((bars ?? []).length / 15) : null
  let pv = 0, v = 0
  for (const b of bars ?? []) { const vol = volOf(b); pv += ((b.high + b.low + b.close) / 3) * vol; v += vol }
  const vwap = v > 0 ? pv / v : null
  const f15 = oi ? futuresChange(oi, nowMs, 15) : null
  const f5 = oi ? futuresChange(oi, nowMs, 5) : null
  const spot = oi?.spot?.length ? oi.spot.filter((x) => x.t <= nowMs).at(-1)?.close : null
  const read = oi && spot ? optionOiRead(oi, spot, nowMs, 15, 3) : null
  const col = (heatmap ?? []).filter((c) => msOf(c.t ?? c.time) <= nowMs).at(-1)
  const near = (rows) => (rows ?? []).reduce((a, r) => (Math.abs(r[0] - price) <= price * 0.0015 ? a + r[1] : a), 0)
  const bids = col ? near(col.bids) : 0
  const asks = col ? near(col.asks) : 0
  return {
    tape30: round(aggOf(30_000), 0), tape60: round(aggOf(60_000), 0), tape300: round(aggOf(300_000), 0),
    bigNet: tapePrints ? round(lots(big.reduce((a, p) => a + (p.buy ? 1 : -1) * p.quantity, 0)), 0) : null, bigCount: tapePrints ? big.length : null,
    cvd15: last15.length ? round(lots(last15.reduce((a, b) => a + (b.delta ?? 0), 0)), 0) : null,
    volX: per15 > 0 ? round(last15.reduce((a, b) => a + volOf(b), 0) / per15) : null,
    futPx15: round(f15?.pricePct != null ? f15.pricePct * 100 : null, 3), futOi15: round(f15?.oiPct != null ? f15.oiPct * 100 : null, 3), futOi5: round(f5?.oiPct != null ? f5.oiPct * 100 : null, 3),
    writers15: round(read?.lean), writersOpen: round(read?.leanOpen), pcr: round(read?.pcr),
    bookImb: bids + asks > 0 ? round((bids - asks) / (bids + asks)) : null,
    vwapDist: vwap ? round(((price - vwap) / vwap) * 100, 3) : null,
  }
}

export function futuresChange(oi, ms, minutes) {
  return futuresSince(oi, ms, ms - minutes * MIN)
}

function futuresSince(oi, ms, fromMs) {
  const now = valueAt(oi.futures, ms)
  const then = valueAt(oi.futures, fromMs) ?? (oi.futures?.[0]?.t <= ms ? oi.futures[0] : null)
  if (!now || !then || !then.close) return null
  return {
    pricePct: (now.close - then.close) / then.close,
    oiPct: now.oi && then.oi ? (now.oi - then.oi) / then.oi : null,
  }
}

// Walls around the index price: the biggest PUT OI strike at / below it (support) and the biggest
// CALL OI strike at / above it (resistance), within 8 strikes.
export function wallsAt(oi, rows, spot) {
  const near = rows.filter((r) => Math.abs(r.strike - spot) <= 8 * oi.step)
  const below = near.filter((r) => r.strike <= spot + oi.step * 0.5)
  const above = near.filter((r) => r.strike >= spot - oi.step * 0.5)
  const support = below.reduce((a, r) => (r.peOi > (a?.peOi ?? 0) ? r : a), null)
  const resistance = above.reduce((a, r) => (r.ceOi > (a?.ceOi ?? 0) ? r : a), null)
  return { support: support?.strike ?? null, resistance: resistance?.strike ?? null }
}

// The biggest CALL OI strike strictly above the spot and the biggest PUT OI strike strictly below it (within
// 8 strikes) - the walls in a trade's way, whatever wall the price has just broken.
export function wallsAhead(oi, rows, spot) {
  const near = rows.filter((r) => Math.abs(r.strike - spot) <= 8 * oi.step)
  const above = near.filter((r) => r.strike > spot)
  const below = near.filter((r) => r.strike < spot)
  const resistance = above.reduce((a, r) => (r.ceOi > (a?.ceOi ?? 0) ? r : a), null)
  const support = below.reduce((a, r) => (r.peOi > (a?.peOi ?? 0) ? r : a), null)
  return { resistanceAhead: resistance?.strike ?? null, supportAhead: support?.strike ?? null }
}

// A side's (CE / PE) OI change as a fraction of its OI - over the read's window, or since the open.
export function sideOiChanges(read, sinceOpen) {
  const f = (chg, now) => (read && now > 0 ? chg / now : null)
  return sinceOpen
    ? { ceC: f(read?.ceOpen, read?.ceNow), peC: f(read?.peOpen, read?.peNow) }
    : { ceD: f(read?.ceChg, read?.ceNow), peD: f(read?.peChg, read?.peNow) }
}

// How much the OI of the walls ahead (wallsAhead) changed over `minutes`, as a fraction of what it was:
// { resChg } the call wall above, { supChg } the put wall below; null when there is no wall or no OI then.
export function wallOiChanges(oi, ahead, ms, minutes) {
  const pct = (map, strike) => {
    if (strike == null) return null
    const now = oiOf(map, strike, ms)
    const then = oiOf(map, strike, ms - minutes * MIN)
    return now != null && then > 0 ? (now - then) / then : null
  }
  return { resChg: pct(oi.ce, ahead.resistanceAhead), supChg: pct(oi.pe, ahead.supportAhead) }
}

// The strike with the biggest PUT (or CALL) OI ADDED since the open, as of `ms`.
function topWriting(map, ms, openMs, spot, step) {
  let best = null
  let bestAdd = 0
  for (const [strike, series] of map) {
    if (Math.abs(strike - spot) > 10 * step) continue
    const now = valueAt(series, ms)?.oi
    const open = valueAt(series, openMs)?.oi ?? series[0]?.oi
    if (now == null || open == null) continue
    if (now - open > bestAdd) { bestAdd = now - open; best = strike }
  }
  return best
}

// ---- order-flow helpers ---------------------------------------------------------------------------

/** The average 1-minute range of the last 14 completed bars (null under 5 bars). */
export function atrOf(bars) {
  if (!bars || bars.length < 5) return null
  const last = bars.slice(-14)
  return last.reduce((sum, b) => sum + (b.high - b.low), 0) / last.length
}


export function vwapOf(minuteBars, ms) {
  let pv = 0
  let v = 0
  for (const b of minuteBars) {
    if (msOf(b.time) > ms) break
    const vol = (b.buy ?? 0) + (b.sell ?? 0)
    pv += ((b.high + b.low + b.close) / 3) * vol
    v += vol
  }
  return v > 0 ? pv / v : null
}

/** The session VWAP and the volume-weighted standard deviation of price around it (for the ±1σ / ±2σ
 *  bands), from the 1-minute bars up to `ms`. Null before any volume. */
export function vwapBands(minuteBars, ms) {
  let pv = 0
  let pv2 = 0
  let v = 0
  for (const b of minuteBars ?? []) {
    if (msOf(b.time) > ms) break
    const vol = (b.buy ?? 0) + (b.sell ?? 0) || b.volume || 0
    const tp = (b.high + b.low + b.close) / 3
    pv += tp * vol
    pv2 += tp * tp * vol
    v += vol
  }
  if (!(v > 0)) return null
  const vwap = pv / v
  return { vwap, sd: Math.sqrt(Math.max(0, pv2 / v - vwap * vwap)) }
}

/** How many times the 1-minute closes crossed the running VWAP in the `minutes` before `ms` - a
 *  balanced (two-sided) day keeps crossing it, a trend day does not. */
export function vwapCrosses(minuteBars, ms, minutes) {
  let pv = 0
  let v = 0
  let side = 0
  let crosses = 0
  for (const b of minuteBars ?? []) {
    const t = msOf(b.time)
    if (t > ms) break
    const vol = (b.buy ?? 0) + (b.sell ?? 0) || b.volume || 0
    pv += ((b.high + b.low + b.close) / 3) * vol
    v += vol
    if (!(v > 0) || t < ms - minutes * MIN) continue
    const s = Math.sign(b.close - pv / v)
    if (s !== 0 && side !== 0 && s !== side) crosses++
    if (s !== 0) side = s
  }
  return crosses
}

function tapeRead(prints, ms, lot, bigLots, lastBar) {
  if (!prints?.length) {
    // Estimated / no tape: the last minute's buy/sell split stands in for aggression.
    const total = (lastBar?.buy ?? 0) + (lastBar?.sell ?? 0)
    const pct = total > 0 ? Math.round((lastBar.buy / total) * 100) : 50
    return { agg30: pct, agg60: pct, bigBuy: 0, bigSell: 0, speedRatio: 1, proxy: true }
  }
  let b30 = 0, s30 = 0, b60 = 0, s60 = 0, n60 = 0, n300 = 0, bigBuy = 0, bigSell = 0
  for (let i = prints.length - 1; i >= 0; i--) {
    const p = prints[i]
    const t = msOf(p.time)
    if (t > ms) continue
    if (t < ms - 5 * MIN) break
    n300++
    if (t >= ms - MIN) {
      n60++
      if (p.buy) b60 += p.quantity; else s60 += p.quantity
      if (p.quantity >= bigLots * lot) { if (p.buy) bigBuy++; else bigSell++ }
      if (t >= ms - 30_000) { if (p.buy) b30 += p.quantity; else s30 += p.quantity }
    }
  }
  const pct = (b, s) => (b + s > 0 ? Math.round((b / (b + s)) * 100) : 50)
  return { agg30: pct(b30, s30), agg60: pct(b60, s60), bigBuy, bigSell, speedRatio: n300 > 0 ? n60 / (n300 / 5) : 1, proxy: false }
}

function bookShare(book) {
  const bids = (book?.bids ?? []).slice(0, 20).reduce((s, l) => s + (l.quantity ?? l[1] ?? 0), 0)
  const asks = (book?.asks ?? []).slice(0, 20).reduce((s, l) => s + (l.quantity ?? l[1] ?? 0), 0)
  return bids + asks > 0 ? bids / (bids + asks) : null
}

const recent = (items, ms, within, timeOf) => items.filter((x) => { const t = timeOf(x); return t <= ms && t >= ms - within })

// ---- evaluation -------------------------------------------------------------------------------------

/**
 * Every strategy whose checklist passes at `nowMs`. Input:
 *   nowMs, price (futures last), bars (1-minute analyzed bars, completed only), minuteBars (raw, up to now),
 *   prints (tape, oldest first, or null), book, liquidity, pullStack (signals), sweeps, icebergs,
 *   oi (buildOiContext), estimated, lotSize, bigLots; heatmap (book snapshots up to nowMs) and rowSize for #26;
 *   filters - { [strategy id]: the trader's filter overrides } (STRATEGY_FILTERS; missing = the defaults).
 * Returns setups: { id, name, side, t, entry, stop, target, timeStopMs, checks: { OI, Footprint, Tape, DOM, Heatmap } }.
 */
export function evaluateStrategies() {
  // No strategies: every rule was removed. The scanner, the OI reads and the live plumbing stay; nothing signals.
  return []
}

/** A long and a short at the same moment: both are traded (no confidence to pick one by), each noting
 *  the other. */
export function resolveConflicts(setups) {
  const longs = setups.filter((s) => s.side === 'LONG')
  const shorts = setups.filter((s) => s.side === 'SHORT')
  if (!longs.length || !shorts.length) return setups
  const names = (list) => list.map((s) => STRATEGY_BY_ID[s.id]?.short ?? s.id).join(', ')
  return setups.map((s) => ({ ...s, checks: { ...s.checks, Conflict: `opposite ${names(s.side === 'LONG' ? shorts : longs)} at the same time - both sides are traded` } }))
}

// ---- day type --------------------------------------------------------------------------------------

/** The day type at `nowMs` (dayRegime.js): the price read from the session's completed bars, the OI vote
 *  (the whole chain's writers since the open and in the last 30 min, the ATM straddle, the futures since
 *  the open - finished minutes only) and the CVD vote, combined. Tracking only. */
export function dayTypeAt(oi, minuteBars, nowMs) {
  const open = sessionOpenMs(nowMs)
  const price = dayRegime(minuteBars, nowMs, open)
  let oiVote = { type: null, text: 'no OI' }
  const spot = oi ? valueAt(oi.spot, nowMs)?.close : null
  if (oi && spot) {
    const read = optionOiRead(oi, spot, nowMs, 30)
    const atm = Math.round(spot / oi.step) * oi.step
    const openMs = dayOpenMs(oi, nowMs)
    const added = (map) => {
      const now = oiOf(map, atm, nowMs)
      const atOpen = openOi(map, atm, openMs)
      return now != null && atOpen > 0 ? (now - atOpen) / atOpen : null
    }
    const ce = added(oi.ce)
    const pe = added(oi.pe)
    oiVote = oiDayVote({
      options: read ? { leanOpen: read.leanOpen, lean30: read.lean } : null,
      straddle: ce != null && pe != null ? { ce, pe, ceRising: (oiChange(oi.ce, atm, nowMs, 30) ?? -1) >= 0, peRising: (oiChange(oi.pe, atm, nowMs, 30) ?? -1) >= 0 } : null,
      futures: futuresSince(oi, nowMs, openMs),
    })
  }
  return combineRegime(price, oiVote, cvdDayVote(minuteBars, nowMs, open))
}

// ---- outcome --------------------------------------------------------------------------------------

/** A trail's start and distance in futures points for a trade risking `risk` points: in R (`startR` /
 *  `gapR` x the risk) or, with `unit: 'pts'`, in points as set (`startPts` / `gapPts`). */
export function trailPoints(trail, risk) {
  return trail.unit === 'pts'
    ? { start: Number(trail.startPts) || 0, gap: Number(trail.gapPts) || 0 }
    : { start: trail.startR * risk, gap: trail.gapR * risk }
}

/** The stop-loss in force once price has reached `best` (the most favourable price since entry): the
 *  original stop until the trade is the trail's start in profit, then the trail's distance behind `best`
 *  - never looser than the original. No `setup.trail`: a fixed stop. */
export function trailedStop(setup, best) {
  const trail = setup.trail
  if (!trail) return setup.stop
  const dir = setup.side === 'LONG' ? 1 : -1
  const risk = Math.abs(setup.entry - setup.stop)
  const { start, gap } = trailPoints(trail, risk)
  if (!(risk > 0) || !(gap > 0) || dir * (best - setup.entry) < start) return setup.stop
  const trailed = best - dir * gap
  return dir > 0 ? Math.max(setup.stop, trailed) : Math.min(setup.stop, trailed)
}

/** The 15:10 cut-off on the setup's own day, in ms. */
export function squareOffMs(t) {
  const ms = msOf(t)
  return ms - (ms % MIN) + (SQUARE_OFF - istMinute(ms)) * MIN
}

/** The trailing SL in force at `ms` for a setup: the one it fired with, then each change in `setup.trailLog`
 *  ([{ t, trail }], oldest first, t after the setup's own time) whose time has come. */
export function trailIn(setup, ms) {
  let trail = setup.trail
  for (const c of setup.trailLog ?? []) if (c.t > setup.t && c.t <= ms) trail = c.trail
  return trail
}

/** What happened after a setup, from the minute bars up to `untilMs`: stop first if a bar touches both
 *  (the stop as it stood when the bar opened - a trailing stop moves after each completed bar). Closed
 *  at its time stop, and always by the 15:10 cut-off. `dayOver`: the day's data is complete (a scanned
 *  past day) - a trade still running when the data ends is closed at the last price.
 *  Bars count from the one starting at the entry (a Scan day / Go-to entry is on the minute: the
 *  previous minute's close); a bar already running at the entry (a live alert mid-minute) is not
 *  counted - part of its range came before the trade. A bar OPENING beyond the stop fills at its open
 *  (the gap), not at the stop.
 *  Returns { status: 'open' | 'win' | 'loss' | 'flat', r, mfe, stop (in force now), trailed, exitAt
 *  (the exit bar's start), exitPrice, timeStop }. */
export function simulateOutcome(setup, minuteBars, untilMs, dayOver = false) {
  const dir = setup.side === 'LONG' ? 1 : -1
  const risk = Math.abs(setup.entry - setup.stop)
  const rTarget = Math.abs(setup.target - setup.entry) / risk
  // "Let winners run" (trail.runner, off by default): no fixed target and no time stop - only the
  // (trailing) stop and the 15:10 cut-off end the trade.
  const runner = !!setup.trail?.runner
  const timeStopMs = runner ? squareOffMs(setup.t) : Math.min(setup.timeStopMs ?? Infinity, squareOffMs(setup.t))
  const statusOf = (r) => (r > 0.005 ? 'win' : r < -0.005 ? 'loss' : 'flat')
  let mfe = 0
  let lastClose = setup.entry
  let lastAt = null // the last bar the trade actually saw - where a dayOver close happens
  let best = setup.entry
  let stop = setup.stop
  const state = () => ({ stop, trailed: stop !== setup.stop })
  for (const b of minuteBars) {
    const t = msOf(b.time)
    if (t < setup.t) continue
    if (t + MIN > untilMs) return { status: 'open', r: (dir * (lastClose - setup.entry)) / risk, mfe, ...state() }
    const adverse = dir > 0 ? b.low <= stop : b.high >= stop
    const favourable = !runner && (dir > 0 ? b.high >= setup.target : b.low <= setup.target)
    mfe = Math.max(mfe, (dir * ((dir > 0 ? b.high : b.low) - setup.entry)) / risk)
    if (adverse) {
      const fill = b.open == null ? stop : dir > 0 ? Math.min(stop, b.open) : Math.max(stop, b.open)
      const r = (dir * (fill - setup.entry)) / risk
      return { status: statusOf(r), r, mfe, exitAt: t, exitPrice: fill, stopHit: true, ...state() }
    }
    if (favourable) return { status: 'win', r: rTarget, mfe, exitAt: t, exitPrice: setup.target, ...state() }
    lastClose = b.close
    lastAt = t
    best = dir > 0 ? Math.max(best, b.high) : Math.min(best, b.low)
    // The trail in force once this bar is done: the one the setup fired with, or the latest change (setup.trailLog,
    // [{ t, trail }]) up to then - a mid-trade change of the trailing SL applies from its time on, the stop only
    // ever tightening.
    // A change made just as this bar closed is applied to it too, but never loosens what the previous trail had
    // just earned (widening or switching it off keeps the stop; the new distance rules from the next bar).
    for (const trail of new Set([trailIn(setup, t + MIN), trailIn(setup, t + MIN - 1)])) {
      const trailed = trail === setup.trail ? trailedStop(setup, best) : trailedStop({ ...setup, trail }, best)
      stop = dir > 0 ? Math.max(stop, trailed) : Math.min(stop, trailed)
    }
    if (t + MIN >= timeStopMs) {
      const r = (dir * (b.close - setup.entry)) / risk
      return { status: statusOf(r), r, mfe, exitAt: t, exitPrice: b.close, timeStop: true, squareOff: t + MIN >= squareOffMs(setup.t), ...state() }
    }
  }
  const r = (dir * (lastClose - setup.entry)) / risk
  // The day's data ends before the trade did: it leaves at the last minute it saw, at that minute's close - so it has a
  // real exit time, and its option is priced where the day's data actually reaches.
  return dayOver ? { status: statusOf(r), r, mfe, exitAt: lastAt ?? undefined, exitPrice: lastClose, timeStop: true, ...state() } : { status: 'open', r, mfe, ...state() }
}

/** How an outcome ended, for alerts and the list. */
export function exitLabel(outcome) {
  if (!outcome || outcome.status === 'open') return null
  if (outcome.timeStop) return outcome.squareOff ? `${fmtHm(SQUARE_OFF)} square-off` : 'Time exit'
  if (outcome.stopHit) return outcome.trailed ? 'Trailing SL hit' : 'Stop loss hit'
  return 'Target hit'
}

// ---- scoring --------------------------------------------------------------------------------------

export function strategyStats(trades) {
  const by = Object.fromEntries(ACTIVE_STRATEGIES.map((s) => [s.id, { id: s.id, trades: 0, wins: 0, totalR: 0, bestR: 0, grossWin: 0, grossLoss: 0 }]))
  for (const t of trades) {
    const s = by[t.id]
    if (!s || t.outcome?.status === 'open' || !t.outcome) continue
    s.trades++
    s.totalR += t.outcome.r
    s.bestR = Math.max(s.bestR, t.outcome.r)
    if (t.outcome.r > 0) { s.wins++; s.grossWin += t.outcome.r } else s.grossLoss += -t.outcome.r
  }
  return ACTIVE_STRATEGIES.map((meta) => {
    const s = by[meta.id]
    const winRate = s.trades ? s.wins / s.trades : null
    const avgR = s.trades ? s.totalR / s.trades : null
    // Rank: expectancy (average R per trade) - win rate and size of wins together - shrunk toward 0
    // for a small sample so three lucky trades do not top the table.
    const score = s.trades ? avgR * (s.trades / (s.trades + 5)) : null
    return { ...meta, ...s, winRate, avgR, profitFactor: s.grossLoss > 0 ? s.grossWin / s.grossLoss : s.grossWin > 0 ? Infinity : null, score }
  })
}

export const MIN_TRADES_TO_RANK = 5

/** The five strategies to alert on in a group ('oi' = the OI + order flow ten, 'profile' = the
 *  volume / market profile five): the best-scoring PROFITABLE ones once enough trades are scored,
 *  topped up with the playbook's picks not measured yet - never one whose scored trades lose money. */
export function topFive(stats, group = 'oi') {
  const inGroup = stats.filter((s) => (s.group ?? 'oi') === group)
  // (never a retired strategy, whatever the default list says)
  const defaults = (group === 'profile' ? DEFAULT_PROFILE_TOP5 : DEFAULT_TOP5).filter((id) => ACTIVE_STRATEGIES.some((a) => a.id === id))
  const ranked = inGroup.filter((s) => s.trades >= MIN_TRADES_TO_RANK && s.score > 0).sort((a, b) => b.score - a.score)
  const losers = new Set(inGroup.filter((s) => s.trades >= MIN_TRADES_TO_RANK && !(s.score > 0)).map((s) => s.id))
  const ids = ranked.slice(0, 5).map((s) => s.id)
  for (const id of defaults) if (ids.length < 5 && !ids.includes(id) && !losers.has(id)) ids.push(id)
  return { ids, measured: ranked.length >= 5 }
}

/** The top 15: the five best OI + order flow strategies, the five best profile strategies... and the
 *  next five best of all the rest (any group, range-bound included), so the alert list is always the 15
 *  strongest. Among strategies not scored yet the institutional ones (17-21) come first. */
export function topFifteen(stats) {
  const oi = topFive(stats, 'oi')
  const profile = topFive(stats, 'profile')
  const chosen = new Set([...oi.ids, ...profile.ids])
  const rest = stats.filter((s) => !chosen.has(s.id) && !(s.trades >= MIN_TRADES_TO_RANK && !(s.score > 0)))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (+b.priority || 0) - (+a.priority || 0))
  for (const s of rest) if (chosen.size < 15) chosen.add(s.id)
  // On trial: new strategies not measured yet, alerted beside the 15.
  const trial = stats.filter((s) => s.trial && !chosen.has(s.id) && !(s.trades >= MIN_TRADES_TO_RANK)).map((s) => s.id)
  return { ids: [...chosen], trial, measured: oi.measured && profile.measured, oi, profile }
}
