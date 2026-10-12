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

export const STRATEGIES = [
  // retired: not run, alerted or listed; the rules stay (the tests still exercise them) so one can come
  // back by dropping the flag.
  { id: 'wallDefence', no: 1, name: 'OI wall defence', short: 'Wall defence', retired: true },
  { id: 'wallBreak', no: 2, name: 'OI wall break - writers run', short: 'Wall break' },
  { id: 'migration', no: 3, name: 'Writer migration', short: 'Migration', retired: true },
  { id: 'squeeze', no: 4, name: 'Short-covering squeeze', short: 'Squeeze' },
  // `trial` (see #27 below) on 5, 7, 10, 16, 22 and 23: they never made the default Top 15 (nothing scored
  // yet), so they were listed but never alerted - on trial they alert beside the 15 until measured.
  { id: 'flush', no: 5, name: 'Long-unwinding flush', short: 'Flush', trial: true },
  { id: 'buildUp', no: 6, name: 'Fresh build-up trend', short: 'Build-up trend' },
  { id: 'range', no: 7, name: 'Range between two growing walls', short: 'Range fade', group: 'range', trial: true },
  { id: 'openingBias', no: 8, name: 'Opening OI bias + range breakout', short: 'Opening bias ORB' },
  // retired: heavy icebergs are sent to Telegram instead (Order Flow page, "Iceberg Telegram"); the rules stay tested.
  { id: 'iceberg', no: 9, name: 'Iceberg on an OI strike', short: 'Iceberg at OI wall', retired: true },
  { id: 'maxPain', no: 10, name: 'Expiry-day max-pain pull', short: 'Max-pain pull', trial: true },
  // Volume profile (previous session) and market profile, each confirmed by OI and order flow.
  { id: 'vaRejection', no: 11, name: 'Previous value-area edge rejection', short: 'Value area rejection', group: 'profile' },
  { id: 'tpo80', no: 12, name: 'Market profile 80% rule', short: 'Eighty percent rule', group: 'profile' },
  { id: 'pocReaction', no: 13, name: 'Previous POC reaction', short: 'POC reaction', group: 'profile' },
  { id: 'lvnRun', no: 14, name: 'LVN run to the next HVN', short: 'LVN run', group: 'profile' },
  { id: 'ibBreakout', no: 15, name: 'Initial balance breakout', short: 'IB breakout', group: 'profile' },
  // OI + order flow again: a weak secondary wall giving way on its second test.
  { id: 'weakWall', no: 16, name: 'Weak OI wall - second retest break', short: 'Weak wall retest', trial: true },
  // Institutional OI + order flow setups: every one needs the option writers, the futures OI and the
  // footprint / tape / DOM-heatmap on the same side. Alerted by default until they are measured.
  { id: 'trap', no: 17, name: 'Failed breakout trap - liquidity sweep reversal', short: 'Breakout trap', priority: true },
  { id: 'cvdDivergence', no: 18, name: 'CVD divergence at the OI wall', short: 'CVD divergence', priority: true },
  { id: 'blockTrade', no: 19, name: 'Block-trade initiative follow-through', short: 'Block trades', priority: true },
  { id: 'imbalanceRetest', no: 20, name: 'Stacked-imbalance zone retest', short: 'Imbalance retest', priority: true },
  { id: 'atmFlip', no: 21, name: 'ATM OI crossover + VWAP reclaim', short: 'ATM OI flip', priority: true },
  // Range-bound (mean reversion) - only on a balanced day.
  { id: 'vwapFade', no: 22, name: 'VWAP ±2σ fade on a balanced day', short: 'VWAP band fade', group: 'range', trial: true },
  { id: 'ibFade', no: 23, name: 'Failed IB poke fade in a straddle-written range', short: 'IB poke fade', group: 'range', trial: true },
  // Short squeeze (long) and long squeeze (short) from the futures OI read minute by minute - first in
  // line for alerts until measured.
  { id: 'oiSqueeze', no: 24, name: 'Trapped-OI squeeze - short & long squeeze', short: 'OI squeeze', priority: 2 },
  // 25-28 came after the line-up the trader measured as good (05 Oct 03:13 IST) - kept, but retired
  // until the trader asks for them back (drop `retired`); #27 is back.
  // A wall that appears suddenly (heavy writing in the last 5 minutes) with the book leaning the same way.
  { id: 'suddenWall', no: 25, name: 'Sudden OI wall + DOM imbalance', short: 'Sudden wall + DOM', priority: 3, retired: true },
  // The heatmap's wall and the option writers' wall at the same price, with the futures: hold or break.
  { id: 'heatmapOi', no: 26, name: 'OI + liquidity heatmap confluence - hold or break', short: 'Heatmap + OI wall', priority: 3, retired: true },
  // The classic VWAP trend-day pullback, with the option writers / futures and the heatmap behind it -
  // back in the line-up (the trader asked for it with #29, 05 Oct).
  // `trial`: a new strategy alerts by default ON TOP of the Top 15 (pushing nothing out) until it has
  // MIN_TRADES_TO_RANK scored trades - live days are scored as their trades end, so it gets measured
  // without a Scan day - then it is ranked like the rest (and never alerted once it measures losing).
  { id: 'vwapPullback', no: 27, name: 'VWAP pullback - trend continuation (OI + heatmap)', short: 'VWAP pullback', trial: true },
  // Pure option OI, minute by minute: the support wall outweighs the resistance wall, the money leans
  // the same way, and the writers keep adding on that side every minute.
  { id: 'oiStructure', no: 28, name: 'OI structure - heavier wall, leaning ATM, writing every minute', short: 'OI structure', priority: 3, retired: true },
  // The well-known VWAP trade with both OI reads behind it - the option writers AND a futures build-up -
  // on every day (no heatmap needed; #27 is the same trade with the heatmap wall).
  { id: 'vwapOi', no: 29, name: 'VWAP + options & futures OI confluence', short: 'VWAP + OI', trial: true, retired: true },
  // Market profile: a break of the initial balance that leaves a tail / sweeps the liquidity out there
  // and comes back inside - a failed breakout; the range is revisited (toward the other IB edge).
  { id: 'ibFailed', no: 30, name: 'Failed IB breakout - back inside, revisit the range', short: 'Failed IB break', group: 'profile', trial: true, retired: true },
  // 31-33: the option chain read the trader values - CE / PE OI per strike, the S/R OI walls, the CE / PE added since
  // the open, the ATM straddle's premium - with the futures' price / OI and VWAP. No book, heatmap or tape needed
  // (SENSEX has only 5 depth levels) and every size in strike steps or % of price, so they read the same on NIFTY,
  // BANKNIFTY and SENSEX. On trial: alerted beside the Top 15 (pushing nothing out) until measured.
  { id: 'straddleFade', no: 31, name: 'ATM straddle decay - fade the OI wall back to the middle', short: 'Straddle decay fade', trial: true },
  { id: 'wallShift', no: 32, name: 'S/R OI wall shift - writers rolling with the price', short: 'Wall shift', trial: true },
  { id: 'cumFlip', no: 33, name: 'Since-open CE / PE flip + futures build-up on the VWAP side', short: 'Since-open OI flip', trial: true },
  // 34-37: rejections at the previous session's volume-profile levels, led by the option writers (OI) - lighter on
  // order flow than #11 / #13 (no absorption, DOM or heatmap needed), so they trade estimated days too.
  { id: 'pocReject', no: 34, name: 'Previous POC rejection + option writing', short: 'POC rejection + OI', group: 'profile', trial: true },
  { id: 'vaEdgeReject', no: 35, name: 'Previous VAH / VAL rejection + option writing', short: 'VAH/VAL rejection + OI', group: 'profile', trial: true },
  { id: 'hvnReject', no: 36, name: 'Previous HVN rejection + option writing', short: 'HVN rejection + OI', group: 'profile', trial: true },
  { id: 'lvnReject', no: 37, name: 'LVN rejection - the thin area refused + option writing', short: 'LVN rejection + OI', group: 'profile', trial: true },
]
/** The SPOT + OPTIONS strategies (spotEngine.js): they trade the index price itself - spot candles and the option
 *  chain's OI, no futures and no order flow. Measured by the Strategy tuning ("Spot + options only"); the live
 *  scanner does not run them, so they are not in STRATEGIES / ACTIVE_STRATEGIES. */
export const SPOT_STRATEGIES = [
  { id: 'spotWallBreak', no: 101, name: 'Spot: OI wall break - writers leaving', short: 'Spot wall break', spot: true },
  { id: 'spotWallHold', no: 102, name: 'Spot: OI wall holds - rejection at a growing wall', short: 'Spot wall hold', spot: true },
  { id: 'spotSides', no: 103, name: 'Spot: CE and PE sides with the move - range breakout', short: 'Spot CE/PE sides', spot: true },
  { id: 'spotAvgPullback', no: 104, name: 'Spot: pullback to the day\'s average on a trending day', short: 'Spot average pullback', spot: true },
  { id: 'spotFreshWriting', no: 105, name: 'Spot: fresh writing under the price, the other side covering (OI heatmap)', short: 'Spot fresh writing', spot: true },
  { id: 'spotCumFlip', no: 106, name: 'Spot: CE / PE added since the open flips sides', short: 'Spot since-open flip', spot: true },
  { id: 'spotLadder', no: 107, name: 'Spot: S/R OI ladder - support outgrowing resistance', short: 'Spot OI ladder', spot: true },
  { id: 'spotStraddleFade', no: 108, name: 'Spot: ATM straddle decaying, both sides written - fade the wall back to the middle', short: 'Spot straddle fade', spot: true },
  { id: 'spotWallShift', no: 109, name: 'Spot: writers migrating - the OI wall steps one strike with the price', short: 'Spot wall shift', spot: true },
  { id: 'spotPremDiverge', no: 110, name: 'Spot: new high / low the ATM premium does not confirm', short: 'Spot premium divergence', spot: true },
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

export const STRATEGY_FILTERS = {
  pocReject: PROFILE_REJECT_FILTERS,
  vaEdgeReject: PROFILE_REJECT_FILTERS,
  hvnReject: PROFILE_REJECT_FILTERS,
  lvnReject: PROFILE_REJECT_FILTERS,
  ibBreakout: [
    { key: 'closesBeyond', label: 'Closes in a row beyond the IB to accept the break', type: 'number', default: 2, min: 1, max: 5, step: 1 },
    { key: 'firstBreakOnly', label: 'First accepted break of each side per day only', type: 'switch', default: true },
    { key: 'breakVolumeX', label: 'Break bar volume at least x the IB\'s average minute (0 = off)', type: 'number', default: 1.5, min: 0, max: 5, step: 0.1 },
    { key: 'minWriting', label: 'Option writers\' lean (whole chain, last hour) at least', type: 'number', default: 0.15, min: 0, max: 1, step: 0.05 },
    { key: 'skipWideIb', label: 'Skip when the IB is as wide as yesterday\'s range', type: 'switch', default: true },
    { key: 'needFootprint', label: 'Last bar\'s delta with the break', type: 'switch', default: true },
    { key: 'needTape', label: 'Tape with the break (sweep or 1-min aggression 60%+)', type: 'switch', default: true },
    { key: 'targetIb', label: 'Target (x the IB range)', type: 'number', default: 1, min: 0.5, max: 3, step: 0.25 },
    { key: 'timeStopMin', label: 'Time stop (minutes)', type: 'number', default: 90, min: 10, max: 240, step: 5 },
  ],
  ibFailed: [
    { key: 'lookbackMin', label: 'The break beyond the IB happened within the last (minutes)', type: 'number', default: 15, min: 5, max: 60, step: 5 },
    { key: 'maxClosesBeyond', label: 'At most this many closes beyond the IB (more = an accepted breakout)', type: 'number', default: 5, min: 0, max: 30, step: 1 },
    { key: 'maxExcursionPct', label: 'How far beyond the IB it went, at most (%)', type: 'number', default: 0.4, min: 0.05, max: 1.5, step: 0.05 },
    { key: 'needTrapped', label: 'Trapped breakout traders: a tail, a sweep or big prints out there', type: 'switch', default: true },
    { key: 'tailPct', label: 'Tail: the extreme bar closes back at least (%) of its range', type: 'number', default: 50, min: 20, max: 95, step: 5 },
    { key: 'needWriters', label: 'Option writers defend the IB edge (adding at the strike past it, 15 min)', type: 'switch', default: true },
    { key: 'needDelta', label: 'Last bar\'s delta with the trade', type: 'switch', default: true },
    { key: 'targetFrac', label: 'Target: how far back across the IB (1 = the other edge, 0.5 = the middle)', type: 'number', default: 1, min: 0.25, max: 1.5, step: 0.25 },
    { key: 'minRR', label: 'Room to the target at least (R)', type: 'number', default: 1.5, min: 0.5, max: 4, step: 0.25 },
    { key: 'timeStopMin', label: 'Time stop (minutes)', type: 'number', default: 75, min: 10, max: 240, step: 5 },
  ],
  vwapOi: [
    { key: 'heldPct', label: 'Of the last 30 closes on the trend side of VWAP (%)', type: 'number', default: 75, min: 50, max: 100, step: 5 },
    { key: 'slopePct', label: 'VWAP slope in 30 min at least (%)', type: 'number', default: 0.03, min: 0, max: 0.3, step: 0.01 },
    { key: 'tagPct', label: 'Pullback reaches within (%) of VWAP', type: 'number', default: 0.05, min: 0.01, max: 0.3, step: 0.01 },
    { key: 'needWriters', label: 'Option writers back it', type: 'switch', default: true },
    { key: 'needFuturesBuild', label: 'Futures build-up since the open (price and OI with it)', type: 'switch', default: true },
    { key: 'needFuturesHolding', label: 'Futures OI not falling in the last 15 min', type: 'switch', default: true },
    { key: 'needDelta', label: 'Last bar\'s delta with the trade', type: 'switch', default: true },
    { key: 'targetR', label: 'Target (R)', type: 'number', default: 2, min: 1, max: 5, step: 0.5 },
    { key: 'maxR', label: 'Stretch toward the day\'s high / low up to (R)', type: 'number', default: 3, min: 1, max: 6, step: 0.5 },
    { key: 'timeStopMin', label: 'Time stop (minutes)', type: 'number', default: 60, min: 10, max: 240, step: 5 },
  ],
  straddleFade: [
    { key: 'fallPct', label: 'ATM straddle premium down at least (%) in 15 min', type: 'number', default: 2, min: 0, max: 10, step: 0.5 },
    { key: 'needBelowAvg', label: 'ATM straddle under its session average', type: 'switch', default: true },
    { key: 'oiRisePct', label: 'CE and PE OI at ATM ±1 each up at least (%) in 15 min', type: 'number', default: 0.5, min: 0, max: 5, step: 0.1 },
    { key: 'edgeStrikes', label: 'Futures within (strikes) of the wall', type: 'number', default: 0.5, min: 0.25, max: 1.5, step: 0.25 },
    { key: 'minRR', label: 'Room to the middle at least (R)', type: 'number', default: 1.2, min: 0.5, max: 3, step: 0.1 },
    { key: 'timeStopMin', label: 'Time stop (minutes)', type: 'number', default: 45, min: 10, max: 240, step: 5 },
  ],
  wallShift: [
    { key: 'withinMin', label: 'The wall moved within the last (minutes)', type: 'number', default: 15, min: 5, max: 30, step: 5 },
    { key: 'maxStrikes', label: 'Moved by at most (strikes)', type: 'number', default: 1, min: 1, max: 3, step: 1 },
    { key: 'newAddPct', label: 'OI added at the new wall strike in that time at least (%)', type: 'number', default: 1, min: 0, max: 10, step: 0.5 },
    { key: 'leadX', label: 'New wall\'s OI at least x the old strike\'s', type: 'number', default: 1.05, min: 1, max: 2, step: 0.05 },
    { key: 'followPct', label: 'Futures moved with it in that time at least (%)', type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.01 },
    { key: 'maxAwayStrikes', label: 'Futures at most (strikes) past the new wall', type: 'number', default: 1, min: 0.5, max: 3, step: 0.25 },
    { key: 'targetR', label: 'Target (R)', type: 'number', default: 2, min: 1, max: 4, step: 0.5 },
    { key: 'timeStopMin', label: 'Time stop (minutes)', type: 'number', default: 45, min: 10, max: 240, step: 5 },
  ],
  cumFlip: [
    { key: 'withinMin', label: 'Flipped within the last (minutes)', type: 'number', default: 15, min: 5, max: 30, step: 5 },
    { key: 'flipPct', label: 'Lead after the flip at least (% of the chain\'s OI)', type: 'number', default: 0.2, min: 0.05, max: 1, step: 0.05 },
    { key: 'needBuildUp', label: 'Futures build-up with it in 15 min (price and OI up for a long)', type: 'switch', default: true },
    { key: 'maxFromVwapPct', label: 'Futures at most (%) past VWAP', type: 'number', default: 0.3, min: 0.05, max: 1, step: 0.05 },
    { key: 'needDelta', label: 'Last bar\'s delta with the trade', type: 'switch', default: true },
    { key: 'targetR', label: 'Target (R)', type: 'number', default: 2, min: 1, max: 4, step: 0.5 },
    { key: 'timeStopMin', label: 'Time stop (minutes)', type: 'number', default: 60, min: 10, max: 240, step: 5 },
  ],
}
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
export function optionPlanFor(id, filters, cfg = {}, premium = null) {
  const f = strategyFilters(id, filters?.[id])
  const exit = ownOptionExit(f)
  // WHO DECIDES. A buy / sell chosen where the trading happens WINS - on the Order Flow page the trader is sitting
  // there and their choice is the last word, whatever a strategy was tuned to. Choosing "per strategy" (what the
  // server scanner runs on, since nobody is there to choose) hands the decision to the strategy's own tuned setting,
  // and falls back to selling when it has none. The strike and the SL / target follow the same rule.
  const chosen = cfg.autoPaper === 'buy' || cfg.autoPaper === 'sell' ? cfg.autoPaper : null
  const perStrategy = cfg.autoPaper === 'strategy'
  const tunedLeg = f.tradeOptLeg === 'buy' || f.tradeOptLeg === 'sell' ? f.tradeOptLeg : null
  const leg = perStrategy ? tunedLeg ?? 'sell' : chosen
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
for (const st of [...STRATEGIES, ...SPOT_STRATEGIES]) STRATEGY_FILTERS[st.id] = [...(STRATEGY_FILTERS[st.id] ?? []), ...TRADE_FILTERS]

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
      return { at: start + MIN, premium: inForce, reason: inForce === trailed && trailed !== stop ? `Trailing SL hit (${tr.gap} pts behind the best ${best.toFixed(1)})` : `Max SL ${sl} pts hit` }
    }
    if (target != null && (sell ? low <= target : high >= target)) return { at: start + MIN, premium: target, reason: `Target ${tgt} pts hit` }
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
export function evaluateStrategies(input) {
  const { nowMs, bars, minuteBars, oi, estimated } = input
  const price = input.price
  if (!oi || !bars?.length || !(price > 0)) return []
  const minute = istMinute(nowMs)
  if (minute < hm(9, 30) || minute > LAST_ENTRY) return []
  // 09:15:00 IST today - from the clock's MINUTE: a live clock is mid-minute (10:40:10), and without the
  // rounding "09:15" became 09:15:10, which dropped the 09:15 bar from the IB / opening range and took in
  // the 10:15 (09:30) one.
  const sessionStartMs = Math.floor(nowMs / MIN) * MIN - (minute - hm(9, 15)) * MIN
  const spotNow = valueAt(oi.spot, nowMs)?.close
  if (!spotNow) return []
  const basis = price - spotNow
  const rows = oiRows(oi, nowMs)
  if (!rows.length) return []
  const { support, resistance } = wallsAt(oi, rows, spotNow)
  const lot = Math.max(1, input.lotSize ?? 1)
  const last = bars.at(-1)
  const prev = bars.at(-2)
  const last3 = bars.slice(-3)
  const tape = tapeRead(input.prints, nowMs, lot, input.bigLots ?? 10, last)
  const share = estimated ? null : bookShare(input.book)
  const liq = recent(input.liquidity ?? [], nowMs, 3 * MIN, (s) => s.t)
  const ps = recent(input.pullStack ?? [], nowMs, 2 * MIN, (s) => s.t)
  const sweeps = recent(input.sweeps ?? [], nowMs, 2 * MIN, (w) => msOf(w.endedAt))
  const icebergs = (input.icebergs ?? []).filter((i) => msOf(i.detectedAt) <= nowMs && (!i.endedAt || msOf(i.endedAt) > nowMs))
  const vwap = vwapOf(minuteBars, nowMs)
  const pct = (v) => price * v
  const out = []

  const confirm = (dir, extraHeat = false) => {
    if (estimated) return { ok: true, dom: 'waived (estimated day)', heat: 'waived (estimated day)' }
    const domOk = share != null && (dir > 0 ? share >= 0.5 : share <= 0.5)
    const heatOk = extraHeat || ps.some((s) => s.bullish === dir > 0) || liq.some((s) => s.bullish === dir > 0)
    const domAgainst = share != null && (dir > 0 ? share < 0.4 : share > 0.6)
    const heatAgainst = ps.some((s) => s.bullish !== dir > 0 && s.confidence >= 70)
    return {
      ok: (domOk || heatOk) && !domAgainst && !heatAgainst,
      dom: share == null ? 'no book' : `bids ${Math.round(share * 100)}% of the book`,
      heat: heatOk ? 'liquidity on your side' : heatAgainst ? 'liquidity against' : 'neutral',
    }
  }
  const tapeText = `${tape.proxy ? 'est. ' : ''}aggression 30s ${tape.agg30}% / 1m ${tape.agg60}% buy`
  // Options OI is checked on EVERY strategy: a trade the option writers are clearly positioned
  // against is dropped (the read is shown on every setup).
  const optionRead = optionOiRead(oi, spotNow, nowMs, 15)
  const futuresRead = futuresChange(oi, nowMs, 15)
  const futuresText = futuresRead?.oiPct == null ? 'no futures OI'
    : `futures ${(futuresRead.pricePct * 100).toFixed(2)}% · OI ${futuresRead.oiPct >= 0 ? '+' : ''}${(futuresRead.oiPct * 100).toFixed(2)}% in 15m`
  // The nearest strikes (ATM ±2) - shown only, they never block a trade.
  const nearRead = optionOiRead(oi, spotNow, nowMs, 15, 2)
  // Volatility: the average 1-minute range of the last 14 bars.
  const atr = atrOf(bars)
  // opts: rTarget - the target is a multiple of the stop (it widens with a volatility-widened stop);
  //       stance 'recent' - judge the options OI on its last 15 minutes only (a squeeze: the since-open
  //       writing IS the trapped side now covering);
  //       firstRules - a strategy back on the rules it was first written with (#4): its own stop and
  //       target as planned (no volatility floor) and no options-OI veto (the read is still shown).
  // Every strategy still passes its old confidence score (the 6th argument); it is not used - no setup
  // carries a confidence any more (the trader's call, 08 Oct), and none waits for a cool-off.
  const wallAheadStrikes = wallsAhead(oi, rows, spotNow)
  // The day type is read once a minute, and only when a setup is there to carry it.
  let regimeMemo
  const regimeNow = () => (regimeMemo ??= dayTypeAt(oi, minuteBars, nowMs))
  const push = (id, dir, plannedStop, targetPts, timeStopMin, _score, checks, opts = {}) => {
    if (!(plannedStop > 0) || !(targetPts > 0)) return
    // Volatility floor: a stop inside 1.2x the average 1-minute range is hit by noise - widen it. An
    // R-based target widens with it; a structural one (a wall, VWAP, the POC) stays, and the setup is
    // dropped when it is then under 1.2R.
    const stopPts = !opts.firstRules && atr != null && plannedStop < 1.2 * atr ? 1.2 * atr : plannedStop
    let target = targetPts
    if (stopPts !== plannedStop) {
      if (opts.rTarget) target = targetPts * (stopPts / plannedStop)
      else if (targetPts < 1.2 * stopPts) return
    }
    const readFor = (r) => (r && opts.stance === 'recent' ? { ...r, combined: r.lean } : r)
    const stance = optionOiStance(readFor(optionRead), dir)
    if (stance === 'against' && !opts.firstRules) return
    const nearStance = optionOiStance(readFor(nearRead), dir)
    const timeStop = Math.min(nowMs + timeStopMin * MIN, nowMs + (SQUARE_OFF - minute) * MIN)
    const { OI: wallText, ...rest } = checks
    out.push({
      options: optionTradesFor(oi, dir, spotNow, nowMs),
      id, name: STRATEGY_BY_ID[id].name, side: dir > 0 ? 'LONG' : 'SHORT', t: nowMs, entry: price,
      stop: price - dir * stopPts, target: price + dir * target, timeStopMs: timeStop,
      estimated: !!estimated,
      // The OI at this minute as numbers - what the OI confirmation filters (oiGatePasses) read.
      oiCtx: {
        flow: optionRead?.lean ?? null, cum: optionRead?.leanOpen ?? null,
        futOiPct: futuresRead?.oiPct ?? null, futPricePct: futuresRead?.pricePct ?? null,
        ...wallOiChanges(oi, wallAheadStrikes, nowMs, 15),
        // CE and PE each: OI change on the timeframe (ceD / peD) and since the open (ceC / peC), as a fraction of its OI.
        ...sideOiChanges(optionRead, false), ...sideOiChanges(optionRead, true),
        dayType: regimeNow()?.type ?? null,
        // The same read on the shorter timeframes (3 / 5 / 1 min) - what the OI timeframe filter chooses between.
        byWindow: Object.fromEntries(OI_WINDOWS.filter((m) => m !== OI_WINDOW).map((m) => {
          const r = optionOiRead(oi, spotNow, nowMs, m)
          const fu = futuresChange(oi, nowMs, m)
          return [m, { flow: r?.lean ?? null, futOiPct: fu?.oiPct ?? null, futPricePct: fu?.pricePct ?? null, ...wallOiChanges(oi, wallAheadStrikes, nowMs, m), ...sideOiChanges(r, false) }]
        })),
        support, resistance, spot: spotNow, ...wallAheadStrikes,
      },
      checks: {
        'Options OI': `${stance === 'agrees' ? 'writers back it' : stance === 'against' ? 'writers lean against (not a veto on this strategy)' : 'neutral'}${opts.stance === 'recent' ? ' (last 15 min)' : ''} - ${optionOiText(optionRead)}`,
        'Near strikes': `${nearStance === 'agrees' ? 'confirm' : nearStance === 'against' ? 'lean against (not required)' : 'neutral'} - ${optionOiText(nearRead)}`,
        OI: wallText, 'Futures OI': futuresText,
        ...rest,
      },
    })
  }
  const absorbed = (dir) => last3.some((b) => (b.absorption ?? []).some((a) => (a.side === 'buy') === dir > 0))
  const exhausted = (dir) => last3.some((b) => (b.exhaustion ?? []).some((e) => (e.side === 'buy') === dir > 0))
  const stackWith = (dir, n = 3) => bars.slice(-n).some((b) => (b.stacked ?? []).some((z) => (z.side === 'buy') === dir > 0))
  const stackAgainst = (dir, n = 3) => stackWith(-dir, n)
  const sweepWith = (dir) => sweeps.some((w) => w.buy === dir > 0)
  const aggWith = (dir, level, which = 'agg60') => (dir > 0 ? tape[which] >= level : tape[which] <= 100 - level)
  const cvdNewExtreme = (dir, n = 15) => {
    const window = bars.slice(-n - 1, -1)
    if (!window.length) return false
    return dir > 0 ? last.cvd >= Math.max(...window.map((b) => b.cvd)) : last.cvd <= Math.min(...window.map((b) => b.cvd))
  }
  // A MEANINGFUL OI move: at least `frac` (0.5%) of the strike's OI - a few contracts are noise, not writers.
  const grew = (map, strike, mins, frac = 0.005) => {
    const chg = oiChange(map, strike, nowMs, mins)
    const base = oiOf(map, strike, nowMs)
    return chg != null && base > 0 && chg >= frac * base
  }
  const shrank = (map, strike, mins, frac = 0.005) => {
    const chg = oiChange(map, strike, nowMs, mins)
    const base = oiOf(map, strike, nowMs)
    return chg != null && base > 0 && chg <= -frac * base
  }
  const bands = vwapBands(minuteBars, nowMs)

  // 1. OI wall defence - 09:45-14:30.
  if (minute >= hm(9, 45) && minute <= hm(14, 30)) {
    for (const dir of [1, -1]) {
      const wall = dir > 0 ? support : resistance
      const other = dir > 0 ? resistance : support
      if (wall == null || other == null) continue
      const nearWall = dir > 0 ? spotNow - wall <= spotNow * 0.0012 && spotNow - wall >= -spotNow * 0.0005 : wall - spotNow <= spotNow * 0.0012 && wall - spotNow >= -spotNow * 0.0005
      const wallChg = oiChange(dir > 0 ? oi.pe : oi.ce, wall, nowMs, 15)
      if (!nearWall || !grew(dir > 0 ? oi.pe : oi.ce, wall, 15)) continue
      // Not into a strong opposite futures build-up (fresh shorts hammering a support, fresh longs a resistance).
      if (futuresRead?.oiPct != null && dir * futuresRead.pricePct < -0.002 && futuresRead.oiPct > 0.003) continue
      const stopPts = Math.max(pct(0.001), Math.abs(spotNow - wall) + pct(0.0008))
      const room = Math.abs(other - spotNow)
      if (room < 1.5 * stopPts) continue
      const footprint = (absorbed(dir) || liq.some((s) => s.kind === 'Wall absorption' && s.bullish === dir > 0)) && dir * last.delta > 0 && !stackAgainst(dir)
      const tapeOk = aggWith(dir, 55, 'agg30') && !sweepWith(-dir)
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      push('wallDefence', dir, stopPts, Math.min(room * 0.8, 2.5 * stopPts), 45, 62 + (tape.proxy ? 0 : 5) + (absorbed(dir) ? 8 : 0), {
        OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} (OI +${Math.round(wallChg).toLocaleString('en-IN')} in 15m), other wall ${other}`,
        Footprint: `${absorbed(dir) ? 'absorption' : 'wall absorption'}, last bar Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 2. OI wall break - writers run - 09:30-14:30.
  if (minute <= hm(14, 30)) {
    for (const dir of [1, -1]) {
      const wall = dir > 0 ? resistance : support
      if (wall == null) continue
      const broke = dir > 0 ? spotNow > wall && prev && prev.close - basis <= wall + oi.step * 0.6 : spotNow < wall && prev && prev.close - basis >= wall - oi.step * 0.6
      const wallChg = oiChange(dir > 0 ? oi.ce : oi.pe, wall, nowMs, 20)
      const otherWall = dir > 0 ? support : resistance
      const otherChg = otherWall != null ? oiChange(dir > 0 ? oi.pe : oi.ce, otherWall, nowMs, 20) : null
      if (!broke || !shrank(dir > 0 ? oi.ce : oi.pe, wall, 20) || otherWall == null || !grew(dir > 0 ? oi.pe : oi.ce, otherWall, 20)) continue
      // Futures with the break (the price leg of the regime on its side).
      if (!futuresRead || !(dir * futuresRead.pricePct > 0)) continue
      const footprint = dir * last.delta > 0 && (stackWith(dir, 2) || cvdNewExtreme(dir))
      const tapeOk = (sweepWith(dir) || aggWith(dir, 65)) && aggWith(dir, 60)
      const c = confirm(dir, liq.some((s) => s.kind === 'Spoofing' && s.bullish === dir > 0))
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = pct(0.0015)
      push('wallBreak', dir, stopPts, 2 * stopPts, 45, 60 + (sweepWith(dir) ? 12 : 0) + (stackWith(dir, 2) ? 6 : 0), {
        OI: `${dir > 0 ? 'CALL' : 'PUT'} wall ${wall} broken, its OI ${Math.round(wallChg).toLocaleString('en-IN')} in 20m (writers covering); ${dir > 0 ? 'PUT' : 'CALL'} ${otherWall} ${lakh(otherChg)} (writers following)`,
        Footprint: `${stackWith(dir, 2) ? 'stacked imbalance' : 'ΣΔ new extreme'}, Δ ${last.delta}`, Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 3. Writer migration - 10:00-14:30.
  if (minute >= hm(10, 0) && minute <= hm(14, 30) && vwap != null) {
    const openMs = sessionStartMs
    for (const dir of [1, -1]) {
      const map = dir > 0 ? oi.pe : oi.ce
      const nowTop = topWriting(map, nowMs, openMs, spotNow, oi.step)
      const thenTop = topWriting(map, nowMs - 45 * MIN, openMs, spotNow, oi.step)
      if (nowTop == null || thenTop == null || dir * (nowTop - thenTop) < oi.step) continue
      if (dir * (price - vwap) <= 0) continue
      const pulledBack = prev && dir * prev.delta < 0 && dir * last.delta > 0
      const footprint = stackWith(dir, 10) && pulledBack && !stackAgainst(dir, 2)
      const tapeOk = aggWith(dir, 55, 'agg30')
      const c = confirm(dir, icebergs.some((i) => i.isBid === dir > 0))
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = pct(0.0015)
      push('migration', dir, stopPts, 2 * stopPts, 60, 62, {
        OI: `${dir > 0 ? 'PUT' : 'CALL'} writing moved ${thenTop} → ${nowTop} in 45m`, Footprint: 'trend stack + pullback bar turned', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 4 / 5. Short-covering squeeze (long) / long-unwinding flush (short) - 10:00-14:45.
  //     #4 (the squeeze) is back to its FIRST rules (04 Oct, 1a5a95b - the trader's call, 08 Oct: it was
  //     not firing): none of the three gates added after it - the VWAP-stretch skip below, the
  //     volatility floor that widened its 0.12% stop and then dropped its 1.3R target, and the
  //     options-OI veto (in a short squeeze the calls written since the open ARE the trapped side now
  //     covering, which that read takes as against the long). #5 (the flush) keeps them.
  if (minute >= hm(10, 0)) {
    const f = futuresChange(oi, nowMs, 10)
    for (const dir of [1, -1]) {
      if (!f || f.oiPct == null || !(dir * f.pricePct > 0.001) || !(f.oiPct < -0.001)) continue
      const firstRules = dir > 0
      // Not chasing: already stretched beyond 2 sigma AND 0.4% from VWAP is late (on a quiet day the
      // 2-sigma band alone is only a few points).
      if (!firstRules && bands?.sd > 0 && dir * (price - bands.vwap) > Math.max(2 * bands.sd, pct(0.004))) continue
      const wall = dir > 0 ? resistance : support
      const wallChg = wall != null ? oiChange(dir > 0 ? oi.ce : oi.pe, wall, nowMs, 10) : null
      if (wallChg != null && wallChg > 0) continue
      const footprint = dir * last.delta > 0 && prev && dir * prev.delta > 0 && !exhausted(-dir)
      const tapeOk = aggWith(dir, 70) && (sweepWith(dir) || tape.speedRatio >= 1.5 || tape.proxy)
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = pct(0.0012)
      push(dir > 0 ? 'squeeze' : 'flush', dir, stopPts, 1.3 * stopPts, 20, 58 + (sweepWith(dir) ? 10 : 0), {
        OI: `futures ${dir > 0 ? '+' : ''}${(f.pricePct * 100).toFixed(2)}% with OI ${(f.oiPct * 100).toFixed(2)}% (${dir > 0 ? 'short covering' : 'long unwinding'})`,
        Footprint: 'two bars of Δ with the move, no exhaustion', Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
      }, { firstRules })
    }
  }

  // 6. Fresh build-up trend - 10:00-14:45.
  if (minute >= hm(10, 0) && vwap != null) {
    const f = futuresChange(oi, nowMs, 30)
    for (const dir of [1, -1]) {
      if (!f || f.oiPct == null || !(dir * f.pricePct > 0.0015) || !(f.oiPct > 0.003)) continue
      // The option writers must be building the same way over the 30 minutes (puts written under a
      // long build-up, calls over a short one) - futures OI alone can be hedges.
      const options30 = optionOiRead(oi, spotNow, nowMs, 30)
      if (optionOiStance(options30, dir) !== 'agrees') continue
      const nearVwap = dir * (price - vwap) >= 0 && Math.abs(price - vwap) <= pct(0.0008)
      if (!nearVwap) continue
      const footprint = (absorbed(dir) || stackWith(dir)) && dir * last.delta > 0
      const tapeOk = aggWith(dir, 55, 'agg30')
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = Math.abs(price - vwap) + pct(0.0008)
      push('buildUp', dir, stopPts, 2.5 * stopPts, 60, 64 + (absorbed(dir) ? 6 : 0), {
        OI: `futures ${(f.pricePct * 100).toFixed(2)}% with OI +${(f.oiPct * 100).toFixed(2)}% in 30m (${dir > 0 ? 'long' : 'short'} build-up), ${dir > 0 ? 'puts' : 'calls'} written: ${optionOiText(options30)}`,
        Footprint: `pullback to VWAP ${vwap.toFixed(1)} with ${absorbed(dir) ? 'absorption' : 'a stack'}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 7. Range between two growing walls - 10:30-14:30.
  if (minute >= hm(10, 30) && minute <= hm(14, 30) && support != null && resistance != null && resistance > support) {
    const f = futuresChange(oi, nowMs, 30)
    const sChg = oiChange(oi.pe, support, nowMs, 30)
    const rChg = oiChange(oi.ce, resistance, nowMs, 30)
    if (f && Math.abs(f.pricePct) < 0.0015 && grew(oi.pe, support, 30) && grew(oi.ce, resistance, 30)) {
      for (const dir of [1, -1]) {
        const edge = dir > 0 ? support : resistance
        if (Math.abs(spotNow - edge) > spotNow * 0.0012) continue
        const footprint = (exhausted(dir > 0 ? 1 : -1) || absorbed(dir)) && !stackAgainst(dir, 2)
        const tapeOk = dir > 0 ? tape.agg60 >= 45 : tape.agg60 <= 55
        const c = confirm(dir, liq.some((s) => s.kind === 'Exhaustion into wall' && s.bullish === dir > 0))
        if (!footprint || !tapeOk || !c.ok) continue
        const stopPts = Math.abs(spotNow - edge) + pct(0.0008)
        const mid = (support + resistance) / 2
        push('range', dir, stopPts, Math.max(stopPts * 1.2, Math.abs(mid - spotNow)), 45, 58, {
          OI: `both walls growing: PUT ${support} +${Math.round(sChg).toLocaleString('en-IN')}, CALL ${resistance} +${Math.round(rChg).toLocaleString('en-IN')} in 30m`,
          Footprint: 'exhaustion / absorption at the edge', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
      }
    }
  }

  // 8. Opening OI bias + range breakout - 09:30-11:00, first break only (the caller's cooldown).
  if (minute <= hm(11, 0)) {
    const dayOpen = sessionStartMs
    const rangeEnd = dayOpen + 15 * MIN
    const openBars = minuteBars.filter((b) => msOf(b.time) >= dayOpen && msOf(b.time) < rangeEnd)
    if (openBars.length >= 10) {
      const hi = Math.max(...openBars.map((b) => b.high))
      const lo = Math.min(...openBars.map((b) => b.low))
      // The bias: the WHOLE chain's put vs call writing over 09:15-09:30 (not just the strikes near ATM).
      const spotAtEnd = valueAt(oi.spot, rangeEnd)?.close
      const read = spotAtEnd ? optionOiRead(oi, spotAtEnd, rangeEnd, 15) : null
      const dir = read && Math.abs(read.combined) >= 0.2 ? Math.sign(read.combined) : 0
      const broke = dir > 0 ? last.close > hi && (prev?.close ?? hi) <= hi : dir < 0 && last.close < lo && (prev?.close ?? lo) >= lo
      if (dir !== 0 && broke) {
        const footprint = dir * last.delta > 0
        const tapeOk = sweepWith(dir) || aggWith(dir, 65)
        const c = confirm(dir)
        if (footprint && tapeOk && c.ok) {
          const stopPts = Math.max(pct(0.001), Math.min(pct(0.0035), Math.abs(price - (hi + lo) / 2)))
          push('openingBias', dir, stopPts, 2 * stopPts, 60, 60 + (sweepWith(dir) ? 10 : 0), {
            OI: `09:15-09:30 ${dir > 0 ? 'put' : 'call'} writing led across the chain - ${optionOiText(read)}`,
            Footprint: `close beyond the opening range ${lo}-${hi}, Δ ${last.delta}`, Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
          })
        }
      }
    }
  }

  // 9. Iceberg on an OI strike - any time in the window; exact days only.
  if (!estimated) {
    for (const ice of icebergs) {
      const dir = ice.isBid ? 1 : -1
      const wall = dir > 0 ? support : resistance
      if (wall == null) continue
      if (Math.abs(ice.price - (wall + basis)) > price * 0.0015 || Math.abs(price - ice.price) > price * 0.001) continue
      const wallChg = oiChange(dir > 0 ? oi.pe : oi.ce, wall, nowMs, 15)
      if (!grew(dir > 0 ? oi.pe : oi.ce, wall, 15)) continue
      const footprint = dir * last.delta > 0
      const tapeOk = aggWith(dir, 50, 'agg30')
      if (!footprint || !tapeOk) continue
      const stopPts = Math.abs(price - ice.price) + pct(0.001)
      push('iceberg', dir, stopPts, 2 * stopPts, 45, 66, {
        OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} (OI +${Math.round(wallChg).toLocaleString('en-IN')} in 15m)`,
        Footprint: `Δ ${last.delta} turning`, Tape: tapeText, DOM: `iceberg at ${ice.price} (${ice.refills} refills)`, Heatmap: 'iceberg active',
      })
    }
  }

  // 10. Expiry-day max-pain pull - 13:00-14:30 entries.
  if (oi.isExpiryDay && minute >= hm(13, 0) && minute <= hm(14, 30)) {
    const mp = maxPainOf(rows.filter((r) => Math.abs(r.strike - spotNow) <= 15 * oi.step))
    if (mp != null && Math.abs(mp - spotNow) >= spotNow * 0.003) {
      const dir = mp > spotNow ? 1 : -1
      const drift = bars.length > 10 ? last.cvd - bars.at(-11).cvd : 0
      const footprint = dir * drift > 0 && !stackAgainst(dir, 5)
      const tapeOk = aggWith(dir, 60)
      const c = confirm(dir, liq.some((s) => s.kind === 'Magnet' && s.bullish === dir > 0))
      if (footprint && tapeOk && c.ok) {
        const stopPts = pct(0.0015)
        const timeLeft = hm(14, 55) - minute
        push('maxPain', dir, stopPts, Math.abs(mp - spotNow) * 0.8, timeLeft, 56, {
          OI: `expiry day, max pain ${mp} vs index ${spotNow.toFixed(0)}`, Footprint: 'ΣΔ drifting toward max pain', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
      }
    }
  }
  // 16. Weak OI wall - second retest break - 09:45-14:30.
  //   A SECONDARY wall near price (a real wall, but not the biggest on its side) whose OI is not much
  //   above its neighbours' (no standout strike holding it), tested once already and now a second
  //   time, while that strike's and its neighbours' OI is being covered (calls) / unwound (puts) over
  //   the last 15 minutes: the writers are leaving - trade the break through it, with the futures OI
  //   regime and the order flow behind it.
  if (minute >= hm(9, 45) && minute <= hm(14, 30)) {
    const f15 = futuresChange(oi, nowMs, 15)
    for (const dir of [1, -1]) {
      const map = dir > 0 ? oi.ce : oi.pe
      const sideOi = (r) => (dir > 0 ? r.ceOi : r.peOi)
      const biggest = dir > 0 ? resistance : support
      if (biggest == null) continue
      const sideMax = Math.max(0, ...rows.filter((r) => Math.abs(r.strike - spotNow) <= 8 * oi.step).map(sideOi))
      const level = rows
        .filter((r) => (dir > 0 ? r.strike >= spotNow - oi.step * 0.25 : r.strike <= spotNow + oi.step * 0.25)
          && Math.abs(r.strike - spotNow) <= oi.step * 1.5 && r.strike !== biggest && sideOi(r) >= 0.3 * sideMax)
        .sort((a, b) => Math.abs(a.strike - spotNow) - Math.abs(b.strike - spotNow))[0]
      if (!level) continue
      // The biggest wall lies beyond it - the room the break runs into.
      if (!(dir * (biggest - level.strike) > 0)) continue
      // Weak: not much above the strikes just below / above it.
      const levelOi = sideOi(level)
      const neighbours = [level.strike - oi.step, level.strike + oi.step].map((k) => oiOf(map, k, nowMs) ?? 0)
      const ratio = levelOi / Math.max(1, ...neighbours)
      if (ratio > 1.6) continue
      // Writers leaving it over the last 15 minutes - the strike and around it.
      const chg = oiChange(map, level.strike, nowMs, 15)
      const around = [-1, 0, 1].reduce((sum, k) => sum + (oiChange(map, level.strike + k * oi.step, nowMs, 15) ?? 0), 0)
      if (!(chg < 0) || chg > -0.01 * levelOi || !(around < 0)) continue
      // Second test of the level (in futures terms): one earlier visit, away, and now back.
      const L = level.strike + basis
      // The band and the stop's buffer / floor are a % of price but the level window and the room are in
      // strikes: capped at a fraction of the strike step so they keep their size in strikes at every index
      // (SENSEX ~82,000 on a 100 step: 0.06% = 49 pts made "away" a full strike and the stop outgrow the
      // room). The caps sit above NIFTY's values (<= 16.2 / 27 pts up to 27,000; step 50), so NIFTY is unchanged.
      const buffer = Math.min(pct(0.0006), oi.step * 0.35)
      const band = Math.max(oi.step * 0.25, buffer)
      let touches = 0
      let away = true
      for (const b of bars) {
        const touching = dir > 0 ? b.high >= L - band : b.low <= L + band
        const gone = dir > 0 ? b.high < L - 2 * band : b.low > L + 2 * band
        if (touching && away) { touches++; away = false } else if (gone) away = true
      }
      const touchingNow = dir > 0 ? last.high >= L - band : last.low <= L + band
      if (touches !== 2 || !touchingNow || dir * (price - L) > band) continue
      // Futures OI: the regime must be on the trade's side (build-up strongest, covering weaker). Without
      // futures OI (a past day after its contract expired) the futures price direction alone.
      if (!f15 || !(dir * f15.pricePct > 0)) continue
      const futOi = f15.oiPct != null
      const buildUp = futOi && f15.oiPct >= 0
      // Order flow: aggression and delta through the level, nothing stacked against it.
      const footprint = dir * last.delta > 0 && (stackWith(dir, 3) || sweepWith(dir) || aggWith(dir, 60)) && !stackAgainst(dir, 2)
      const tapeOk = aggWith(dir, 55, 'agg30')
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = Math.max(Math.min(pct(0.001), oi.step * 0.6), dir * (price - L) + band + buffer)
      const room = dir * (biggest + basis - price)
      if (room < 1.5 * stopPts) continue
      push('weakWall', dir, stopPts, Math.min(room * 0.9, 2.5 * stopPts), 45,
        60 + (buildUp ? 6 : 2) + (sweepWith(dir) ? 6 : 0) + (stackWith(dir, 3) ? 4 : 0) + (chg < -0.05 * levelOi ? 4 : 0), {
          OI: `${dir > 0 ? 'CALL' : 'PUT'} ${level.strike} (not the biggest - that is ${biggest}): OI ${(levelOi / 1e5).toFixed(1)}L vs neighbours ${neighbours.map((n) => (n / 1e5).toFixed(1)).join(' / ')}L, ${lakh(chg)} in 15m (around ${lakh(around)}) - writers ${dir > 0 ? 'covering' : 'unwinding'}`,
          Retest: `2nd test of ${level.strike} (futures ${L.toFixed(1)})`,
          'Futures confirm': futOi
            ? `${dir > 0 ? (buildUp ? 'long build-up' : 'short covering') : (buildUp ? 'short build-up' : 'long unwinding')}: price ${(f15.pricePct * 100).toFixed(2)}%, OI ${f15.oiPct >= 0 ? '+' : ''}${(f15.oiPct * 100).toFixed(2)}% in 15m`
            : `futures price ${(f15.pricePct * 100).toFixed(2)}% in 15m (no futures OI - the price direction alone)`,
          Footprint: `Δ ${last.delta > 0 ? '+' : ''}${last.delta}${stackWith(dir, 3) ? ', stacked imbalance' : ''}`, Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
        })
    }
  }

  // ---- 11-15: volume profile (previous session) + market profile, with OI and order flow ----------
  const prof = input.profile
  if (prof?.vp?.poc != null) {
    const vp = prof.vp
    const near = (level, pctBand) => level != null && Math.abs(price - level) <= pct(pctBand)
    // A strike in futures terms, and the OI wall (if any) within 0.25% of a futures level.
    const wallNear = (level, side) => {
      const wall = side === 'put' ? support : resistance
      return wall != null && Math.abs(wall + basis - level) <= pct(0.0025) ? wall : null
    }
    const oiRising = (side, wall, mins = 15) => wall != null && grew(side === 'put' ? oi.pe : oi.ce, wall, mins)

    // 11. Previous value-area edge rejection - 09:45-14:30: price pokes beyond VAH (VAL) and is pushed
    //     back inside, at an OI wall, with the order flow turning.
    if (minute >= hm(9, 45) && minute <= hm(14, 30) && vp.vah != null && vp.val != null) {
      for (const dir of [1, -1]) {
        const edge = dir > 0 ? vp.val : vp.vah
        const poked = bars.slice(-5).some((b) => (dir > 0 ? b.low < edge : b.high > edge))
        const backInside = dir > 0 ? last.close > edge : last.close < edge
        if (!poked || !backInside || !near(edge, 0.0015)) continue
        const wall = wallNear(edge, dir > 0 ? 'put' : 'call')
        if (wall == null || !oiRising(dir > 0 ? 'put' : 'call', wall)) continue
        const footprint = (absorbed(dir) || exhausted(dir)) && dir * last.delta > 0
        const tapeOk = aggWith(dir, 55, 'agg30')
        const c = confirm(dir)
        if (!footprint || !tapeOk || !c.ok) continue
        const extreme = dir > 0 ? Math.min(...bars.slice(-5).map((b) => b.low)) : Math.max(...bars.slice(-5).map((b) => b.high))
        const stopPts = Math.abs(price - extreme) + pct(0.0005)
        const toPoc = Math.abs(vp.poc - price)
        if (toPoc < 1.2 * stopPts) continue
        push('vaRejection', dir, stopPts, toPoc, 60, 64 + (absorbed(dir) ? 6 : 0), {
          OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} at the previous ${dir > 0 ? 'VAL' : 'VAH'} ${edge}, its OI rising`,
          Profile: `previous session VA ${vp.val}-${vp.vah}, POC ${vp.poc} (target)`,
          Footprint: `${absorbed(dir) ? 'absorption' : 'exhaustion'} outside the value area, back inside`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
      }
    }

    // 12. Market profile 80% rule - 10:00-14:00: opened outside the previous TPO value area, back inside it
    //     for two 30-minute periods (here: the last 30 completed minutes all inside) -> the other edge.
    const tpo = prof.tpoPrev
    if (tpo && minute >= hm(10, 0) && minute <= hm(14, 0)) {
      const dayOpenMs = sessionStartMs
      const openBar = minuteBars.find((b) => msOf(b.time) >= dayOpenMs)
      const last30 = bars.slice(-30)
      if (openBar && last30.length >= 30) {
        for (const dir of [1, -1]) {
          const openedOutside = dir > 0 ? openBar.open < tpo.val : openBar.open > tpo.vah
          const held = last30.every((b) => b.close >= tpo.val && b.close <= tpo.vah)
          if (!openedOutside || !held) continue
          const target = dir > 0 ? tpo.vah : tpo.val
          const blocking = dir > 0 ? resistance : support
          if (blocking != null && dir * (blocking + basis - price) > 0 && dir * (blocking + basis - target) < 0 && oiRising(dir > 0 ? 'call' : 'put', blocking, 30)) continue
          const footprint = dir * (last.cvd - last30[0].cvd) > 0 && !stackAgainst(dir, 3)
          const tapeOk = aggWith(dir, 55)
          const c = confirm(dir)
          if (!footprint || !tapeOk || !c.ok) continue
          const stopPts = Math.max(pct(0.0012), Math.abs(price - (dir > 0 ? tpo.val : tpo.vah)) + pct(0.0005))
          if (Math.abs(target - price) < 1.2 * stopPts) continue
          push('tpo80', dir, stopPts, Math.abs(target - price), 90, 63, {
            OI: blocking != null ? `no growing ${dir > 0 ? 'CALL' : 'PUT'} wall before the target` : 'no wall in the way',
            Profile: `opened ${dir > 0 ? 'below' : 'above'} the previous TPO value area ${tpo.val}-${tpo.vah}, 30 min accepted inside`,
            Footprint: 'ΣΔ toward the far edge', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
          })
        }
      }
    }

    // 13. Previous POC reaction - 09:45-14:30: back at the previous session's POC after being away, an OI
    //     wall there, and the order flow defending it.
    if (minute >= hm(9, 45) && minute <= hm(14, 30) && near(vp.poc, 0.0006)) {
      const awayBefore = bars.slice(-30, -5).some((b) => Math.abs(b.close - vp.poc) >= pct(0.003))
      if (awayBefore) {
        const dir = bars.at(-6)?.close > vp.poc ? 1 : -1 // came down to it -> support (long); up to it -> resistance
        const wall = wallNear(vp.poc, dir > 0 ? 'put' : 'call')
        const footprint = absorbed(dir) && dir * last.delta > 0
        const tapeOk = aggWith(dir, 55, 'agg30')
        const c = confirm(dir)
        if (wall != null && oiRising(dir > 0 ? 'put' : 'call', wall) && footprint && tapeOk && c.ok) {
          const stopPts = pct(0.0012)
          const nextHvn = (vp.hvn ?? []).filter((h) => dir * (h - price) > stopPts * 1.5).sort((a, b) => dir * (a - b))[0]
          push('pocReaction', dir, stopPts, nextHvn != null ? Math.abs(nextHvn - price) : 2 * stopPts, 60, 62, {
            OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} at the previous POC ${vp.poc}, OI rising`,
            Profile: `previous POC ${vp.poc}${nextHvn != null ? `, next HVN ${nextHvn}` : ''}`,
            Footprint: 'absorption at the POC', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
          })
        }
      }
    }

    // 14. LVN run - 09:30-14:30: price breaks through a previous-session low-volume node with
    //     aggression - thin areas are crossed fast - toward the next high-volume node.
    if (minute <= hm(14, 30) && vp.lvn?.length) {
      for (const lvn of vp.lvn) {
        for (const dir of [1, -1]) {
          const crossed = prev && (dir > 0 ? prev.close <= lvn && last.close > lvn : prev.close >= lvn && last.close < lvn)
          if (!crossed) continue
          const hvn = [...(vp.hvn ?? []), vp.poc].filter((h) => dir * (h - lvn) > 0).sort((a, b) => dir * (a - b))[0]
          if (hvn == null) continue
          const wallAhead = dir > 0 ? resistance : support
          if (wallAhead != null && dir * (wallAhead + basis - price) > 0 && dir * (wallAhead + basis - hvn) < 0 && oiRising(dir > 0 ? 'call' : 'put', wallAhead)) continue
          const footprint = dir * last.delta > 0 && (stackWith(dir, 2) || cvdNewExtreme(dir, 10))
          const tapeOk = sweepWith(dir) || aggWith(dir, 65)
          const c = confirm(dir)
          if (!footprint || !tapeOk || !c.ok) continue
          const stopPts = Math.abs(price - lvn) + pct(0.0008)
          if (Math.abs(hvn - price) < 1.2 * stopPts) continue
          push('lvnRun', dir, stopPts, Math.abs(hvn - price), 45, 60 + (sweepWith(dir) ? 10 : 0), {
            OI: wallAhead != null ? `no growing ${dir > 0 ? 'CALL' : 'PUT'} wall before the HVN` : 'no wall ahead',
            Profile: `crossed ${dir > 0 ? 'UP' : 'DOWN'} through the LVN ${lvn} - the next HVN ${dir > 0 ? 'above' : 'below'} is ${hvn} (target)`,
            Footprint: stackWith(dir, 2) ? 'stacked imbalance through it' : 'ΣΔ new extreme', Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
          })
        }
      }
    }
  }

  // ---- 34-37: rejection at a previous-session profile level, with the option writers behind it ----------
  //   Price came to the level from at least `awayPct` away in the last 30 minutes, touched it within the last
  //   `touchBars` bars without a close through it, and the last (completed) bar turns away from it - a close back
  //   beyond the band, in the trade's direction, off the touch extreme. The option writers near the money lean the
  //   trade's way over 15 minutes (puts written under a support, calls over a resistance), and the futures show no
  //   fresh build-up against it. Stop beyond the touch extreme; target the next profile level in the trade's
  //   direction (room at least `minRoomR` x the stop, capped at `maxTargetR`).
  //    34 previous POC · 35 previous VAH / VAL · 36 previous HVNs · 37 LVNs (approached from an HVN and refused -
  //    back toward where it came from). Each level is a support from above (LONG) or a resistance from below (SHORT).
  if (prof?.vp?.poc != null && minute >= hm(9, 30) && minute <= hm(14, 30) && bars.length >= 31) {
    const vp = prof.vp
    const allLevels = [vp.poc, vp.vah, vp.val, ...(vp.hvn ?? [])].filter((x) => x != null)
    const f15 = futuresChange(oi, nowMs, 15)
    const read15 = optionOiRead(oi, spotNow, nowMs, 15, 3)
    const kinds = [
      ['pocReject', [['POC', vp.poc]]],
      ['vaEdgeReject', [['VAH', vp.vah], ['VAL', vp.val]]],
      ['hvnReject', (vp.hvn ?? []).filter((h) => h !== vp.poc).map((h) => ['HVN', h])],
      ['lvnReject', (vp.lvn ?? []).map((l) => ['LVN', l])],
    ]
    for (const [id, levels] of kinds) {
      const f = strategyFilters(id, input.filters?.[id])
      const band = pct(f.bandPct / 100)
      const awayDist = pct(f.awayPct / 100)
      const n = Math.max(1, Math.round(f.touchBars))
      const recent = bars.slice(-n)
      const earlier = bars.slice(-30, -n)
      for (const [label, L] of levels) {
        if (L == null) continue
        for (const dir of [1, -1]) {
          // Came from the trade's side (above a support / below a resistance), at least awayDist from it.
          if (!earlier.some((b) => dir * (b.close - L) >= awayDist)) continue
          const extreme = dir > 0 ? Math.min(...recent.map((b) => b.low)) : Math.max(...recent.map((b) => b.high))
          const touched = dir * (extreme - L) <= band
          const held = recent.every((b) => dir * (b.close - L) >= -band)
          const turned = dir * (last.close - L) >= band && dir * (last.close - last.open) > 0 && dir * (last.close - extreme) >= band
          if (!touched || !held || !turned) continue
          const writing = read15 ? read15.lean : null
          if (writing == null || dir * writing < f.minWriting) continue
          const against = f15 && f15.oiPct != null && dir * f15.pricePct < -0.002 && f15.oiPct > 0.002
          if (f.futuresNotAgainst && against) continue
          if (f.needDelta && !(dir * last.delta > 0)) continue
          const stopPts = Math.max(pct(0.001), dir * (price - extreme) + pct(0.0005))
          // The next profile level ahead (an LVN's target: the HVN / POC on the side it was refused back to).
          const ahead = allLevels.filter((x) => dir * (x - price) > 0.25 * stopPts).sort((a, b) => dir * (a - b))[0]
          const room = ahead != null ? dir * (ahead - price) : null
          if (room != null && room < f.minRoomR * stopPts) continue
          const targetPts = Math.min(room ?? f.maxTargetR * stopPts, f.maxTargetR * stopPts)
          push(id, dir, stopPts, targetPts, f.timeStopMin, 58 + Math.round(10 * Math.min(1, dir * writing)) + (sweepWith(dir) ? 4 : 0), {
            OI: `writers near the money lean ${dir > 0 ? 'PUT (support under the price)' : 'CALL (resistance over the price)'}: ${(writing * 100).toFixed(0)}% in 15m (PE ${lakh(read15.peChg)}, CE ${lakh(read15.ceChg)})`
              + (f15?.oiPct != null ? ` · futures price ${(f15.pricePct * 100).toFixed(2)}%, OI ${f15.oiPct >= 0 ? '+' : ''}${(f15.oiPct * 100).toFixed(2)}% in 15m` : ''),
            Profile: `rejected at the previous ${label} ${+L.toFixed(1)} (touch ${extreme.toFixed(1)}), came from ${dir > 0 ? 'above' : 'below'}; ${ahead != null ? `next level ${+ahead.toFixed(1)} (target)` : `no level ahead - ${f.maxTargetR}x the stop`}`,
            Footprint: `rejection bar ${last.open.toFixed(1)} -> ${last.close.toFixed(1)}, Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText,
          })
        }
      }
    }
  }

  // 15. Initial balance breakout (market profile) - 10:15-13:30: a 1-minute close beyond the first hour's
  //     range, with the option writers and the order flow behind it; target one IB range beyond. The IB
  //     statistics: a narrow IB breaks almost always and extends far, an extremely wide one breaks far
  //     less and barely extends - so not when the IB is already as wide as the previous day's whole range
  //     (the day's range proxy).
  //     Against the false breaks (the defaults; each can be loosened in Filters): the break must be ACCEPTED
  //     (two 1-minute closes in a row beyond the IB - a one-bar poke that closes back inside is the classic
  //     trap), only the FIRST accepted break of that side in the day is taken (a second one comes after a
  //     failed breakout), and the break bar must trade at least 1.5x the IB's average minute volume (real
  //     exchange volume, also on estimated days). Every threshold is a filter (STRATEGY_FILTERS.ibBreakout).
  if (minute >= hm(10, 15) && minute <= hm(13, 30)) {
    const f = strategyFilters('ibBreakout', input.filters?.ibBreakout)
    const dayOpenMs = sessionStartMs
    const ibBars = minuteBars.filter((b) => msOf(b.time) >= dayOpenMs && msOf(b.time) < dayOpenMs + 60 * MIN)
    if (ibBars.length >= 45) {
      const ibHigh = Math.max(...ibBars.map((b) => b.high))
      const ibLow = Math.min(...ibBars.map((b) => b.low))
      const range = ibHigh - ibLow
      // The writers' side: the WHOLE chain's put vs call writing over the last hour.
      const read60 = optionOiRead(oi, spotNow, nowMs, 60)
      const writing = read60 ? read60.lean : 0
      const volOf = (b) => (b.buy ?? 0) + (b.sell ?? 0) || b.volume || 0
      const ibEndMs = dayOpenMs + 60 * MIN
      const ibVols = bars.filter((b) => msOf(b.time) >= dayOpenMs && msOf(b.time) < ibEndMs).map(volOf)
      const ibAvgVol = ibVols.length ? ibVols.reduce((a, v) => a + v, 0) / ibVols.length : 0
      const n = f.closesBeyond
      const run = bars.slice(-n)
      const before = bars.at(-n - 1)
      const breakBar = run[0]
      const afterIb = bars.slice(0, -n).filter((b) => msOf(b.time) >= ibEndMs)
      for (const dir of [1, -1]) {
        const edge = dir > 0 ? ibHigh : ibLow
        const beyond = (b) => dir * (b.close - edge) > 0
        // The break (the first of the last n bars) and its acceptance: n closes beyond, the bar before inside.
        const broke = run.length === n && before && run.every(beyond) && !beyond(before)
        if (!broke || dir * writing < f.minWriting || range <= 0) continue
        // Not the first break: n closes in a row beyond that edge earlier in the day.
        if (f.firstBreakOnly && afterIb.some((b, i) => i >= n - 1 && afterIb.slice(i - n + 1, i + 1).every(beyond))) continue
        const breakVol = volOf(breakBar)
        if (f.breakVolumeX > 0 && (!(ibAvgVol > 0) || breakVol < f.breakVolumeX * ibAvgVol)) continue
        const prevRange = prof?.prevHigh > 0 && prof?.prevLow > 0 ? prof.prevHigh - prof.prevLow : null
        if (f.skipWideIb && prevRange && range >= prevRange) continue
        const narrow = prevRange != null && range <= 0.4 * prevRange
        const footprint = !f.needFootprint || dir * last.delta > 0
        const tapeOk = !f.needTape || sweepWith(dir) || aggWith(dir, 60)
        const c = confirm(dir)
        if (!footprint || !tapeOk || !c.ok) continue
        const stopPts = Math.max(pct(0.001), Math.min(range / 2, pct(0.004)))
        push('ibBreakout', dir, stopPts, Math.max(f.targetIb * range, 1.5 * stopPts), f.timeStopMin, 61 + (sweepWith(dir) ? 8 : 0) + (narrow ? 6 : 0), {
          OI: `${dir > 0 ? 'put' : 'call'} writing leads across the chain over the last hour - ${optionOiText(read60)}`,
          Profile: `initial balance ${ibLow}-${ibHigh} (range ${range.toFixed(1)}${prevRange ? `, ${Math.round((range / prevRange) * 100)}% of yesterday's range${narrow ? ' - narrow' : ''}` : ''}), target ${f.targetIb === 1 ? 'one range' : `${f.targetIb}x the range`} beyond`,
          Footprint: `${n} close${n > 1 ? 's' : ''} beyond the IB${f.firstBreakOnly ? ' (first break of the day)' : ''}, break bar ${ibAvgVol > 0 ? (breakVol / ibAvgVol).toFixed(1) : '-'}x the IB's average volume, Δ ${last.delta}`, Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
        })
      }
    }
  }

  // ---- 17-21: institutional OI + order flow setups -------------------------------------------------
  const sessionOpen = sessionStartMs
  const bigQty = (input.bigLots ?? 10) * lot
  // Big prints (block trades) on one side in the last `within` ms - how many, their size and their
  // average price - optionally only those at prices `where` accepts.
  const bigPrints = (dir, within, where = null) => {
    let count = 0
    let qty = 0
    let pv = 0
    const prints = input.prints ?? []
    for (let i = prints.length - 1; i >= 0; i--) {
      const p = prints[i]
      const t = msOf(p.time)
      if (t > nowMs) continue
      if (t < nowMs - within) break
      if (p.buy !== dir > 0 || p.quantity < bigQty || (where && !where(p.price))) continue
      count++
      qty += p.quantity
      pv += p.price * p.quantity
    }
    return { count, qty, avg: qty > 0 ? pv / qty : null }
  }
  // OI added at a strike since the open.
  const sinceOpen = (map, strike) => {
    const now = oiOf(map, strike, nowMs)
    const open = openOi(map, strike, dayOpenMs(oi, nowMs))
    return now != null && open != null ? now - open : null
  }
  // The biggest wall still AHEAD of price in the trade's direction (futures-points room to it), or null.
  const roomAhead = (dir) => {
    const wall = dir > 0 ? resistance : support
    const room = wall != null ? dir * (wall + basis - price) : null
    return room != null && room > 0 ? { wall, room } : null
  }

  // 17. Failed breakout trap (liquidity sweep reversal) - 09:45-14:30. Price runs the stops beyond a
  //     known extreme - the previous session's high / low, or today's high / low set 10+ minutes ago -
  //     the breakout side piles in (a sweep, big prints, a stacked imbalance out there) and is absorbed:
  //     price is back inside within five minutes, never accepted beyond, while the option writers add at
  //     the strike just past the extreme. The trapped side's stops fuel the reversal.
  if (minute >= hm(9, 45) && minute <= hm(14, 30) && bars.length >= 20) {
    const before = bars.slice(0, -5)
    const recent5 = bars.slice(-5)
    const sweeps5 = recent(input.sweeps ?? [], nowMs, 5 * MIN, (w) => msOf(w.endedAt))
    const f10 = futuresChange(oi, nowMs, 10)
    for (const dir of [1, -1]) {
      // dir = the trade: LONG after a failed break DOWN through a low, SHORT after a failed break UP.
      const levels = [
        { name: `the previous session ${dir > 0 ? 'low' : 'high'}`, price: dir > 0 ? input.profile?.prevLow : input.profile?.prevHigh },
        { name: `today's ${dir > 0 ? 'low' : 'high'}`, price: dir > 0 ? Math.min(...bars.slice(0, -10).map((b) => b.low)) : Math.max(...bars.slice(0, -10).map((b) => b.high)) },
      ].filter((l) => Number.isFinite(l.price))
      for (const level of levels) {
        const L = level.price
        // Untouched until the last five minutes, then swept by at most 0.25% (a stop run, not a trend)...
        if (before.some((b) => (dir > 0 ? b.low < L : b.high > L))) continue
        const extreme = dir > 0 ? Math.min(...recent5.map((b) => b.low)) : Math.max(...recent5.map((b) => b.high))
        const beyond = dir * (L - extreme)
        if (!(beyond > 0) || beyond > pct(0.0025)) continue
        // ...and rejected: closed back inside, at most two closes out there, entry still near the level.
        if (dir * (last.close - L) < pct(0.0003) || dir * (price - L) > pct(0.002)) continue
        if (recent5.filter((b) => dir * (b.close - L) < 0).length > 2) continue
        // The trapped side: breakout aggression beyond the level.
        const sweepBars = recent5.filter((b) => (dir > 0 ? b.low < L : b.high > L))
        // (a sweep counts when it reached the level: ToPrice = the last price it took)
        const trappedSweep = sweeps5.some((w) => w.buy === dir < 0 && (w.toPrice == null || -dir * (w.toPrice - L) >= -pct(0.0003)))
        const trappedBlocks = bigPrints(-dir, 5 * MIN, (px) => dir * (L - px) >= -pct(0.0003))
        const trappedStack = sweepBars.some((b) => (b.stacked ?? []).some((z) => (z.side === 'buy') === dir < 0))
        const trappedDelta = sweepBars.some((b) => -dir * b.delta > 0)
        if (!(trappedSweep || trappedBlocks.count >= 2 || trappedStack || (estimated && trappedDelta))) continue
        // The option writers sold the sweep: the strike just past the extreme (CALL above a failed high,
        // PUT below a failed low) added OI since the open and in the last 15 minutes.
        const map = dir > 0 ? oi.pe : oi.ce
        const strike = dir > 0 ? Math.floor((L - basis) / oi.step) * oi.step : Math.ceil((L - basis) / oi.step) * oi.step
        const added = sinceOpen(map, strike)
        if (!(added > 0) || !grew(map, strike, 15)) continue
        // The rejection in the footprint and the tape.
        const footprint = (absorbed(dir) || exhausted(dir)) && dir * last.delta > 0
        const tapeOk = aggWith(dir, 55, 'agg30')
        const c = confirm(dir, liq.some((sg) => (sg.kind === 'Exhaustion into wall' || sg.kind === 'Spoofing') && sg.bullish === dir > 0))
        if (!footprint || !tapeOk || !c.ok) continue
        // Fresh futures OI into the sweep = positions now trapped (their exits add to the move).
        const trappedOi = f10?.oiPct != null && f10.oiPct > 0
        const stopPts = dir * (price - extreme) + pct(0.0005)
        const toVwap = vwap != null ? dir * (vwap - price) : 0
        push('trap', dir, stopPts, Math.max(1.5 * stopPts, Math.min(3 * stopPts, toVwap)), 45,
          64 + (trappedSweep ? 6 : 0) + (trappedBlocks.count >= 2 ? 4 : 0) + (trappedOi ? 6 : 0) + (absorbed(dir) ? 4 : 0), {
            OI: `${dir > 0 ? 'PUT' : 'CALL'} ${strike} past ${level.name}: ${lakh(added)} since open, ${lakh(oiChange(map, strike, nowMs, 15))} in 15m - writers sold the sweep`,
            Trap: `swept ${level.name} ${L.toFixed(1)} by ${beyond.toFixed(1)} and closed back ${dir > 0 ? 'above' : 'below'} it - trapped ${dir > 0 ? 'sellers' : 'buyers'}: ${[trappedSweep && 'sweep', trappedBlocks.count >= 2 && `${trappedBlocks.count} big prints`, trappedStack && 'stacked imbalance', estimated && trappedDelta && 'est. delta'].filter(Boolean).join(', ')}`,
            'Futures confirm': trappedOi ? `futures OI +${(f10.oiPct * 100).toFixed(2)}% in 10m - fresh positions trapped` : 'no fresh futures OI into the sweep',
            Footprint: `${absorbed(dir) ? 'absorption' : 'exhaustion'} at the extreme, Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
          })
        break
      }
    }
  }

  // 18. CVD divergence at the OI wall - 10:00-14:30. Price makes a new high (low) for the last 40
  //     minutes INTO the biggest CALL (PUT) wall but cumulative delta does not: the push is not backed by
  //     aggressive buying (selling) - passive sellers (buyers) at the wall absorb it - while the wall's
  //     writers keep adding, since the open and in the last 15 minutes.
  if (minute >= hm(10, 0) && minute <= hm(14, 30) && bars.length >= 40) {
    for (const dir of [1, -1]) {
      // dir = the trade: SHORT at the CALL wall (higher high, lower CVD), LONG at the PUT wall (mirror).
      const wall = dir > 0 ? support : resistance
      if (wall == null || Math.abs(price - (wall + basis)) > pct(0.0015)) continue
      const pick = (list) => list.reduce((a, b) => (dir > 0 ? (b.low < a.low ? b : a) : (b.high > a.high ? b : a)))
      const A = pick(bars.slice(-40, -10))
      const B = pick(bars.slice(-10))
      const newExtreme = dir > 0 ? B.low < A.low : B.high > A.high
      if (!newExtreme || !(dir * (B.cvd - A.cvd) > 0)) continue
      const map = dir > 0 ? oi.pe : oi.ce
      const wallOi = oiOf(map, wall, nowMs)
      const added = sinceOpen(map, wall)
      const chg15 = oiChange(map, wall, nowMs, 15)
      if (!(wallOi > 0) || !(added >= 0.02 * wallOi) || !(chg15 >= 0)) continue
      const neighbours = [-1, 1].filter((k) => grew(map, wall + k * oi.step, 15)).length
      const footprint = dir * last.delta > 0 && !stackAgainst(dir, 2)
      const tapeOk = aggWith(dir, 52, 'agg30') && (tape.proxy || (dir > 0 ? tape.bigSell <= tape.bigBuy : tape.bigBuy <= tape.bigSell))
      const c = confirm(dir, liq.some((sg) => sg.kind === 'Wall absorption' && sg.bullish === dir > 0))
      if (!footprint || !tapeOk || !c.ok) continue
      const extreme = dir > 0 ? B.low : B.high
      const stopPts = dir * (price - extreme) + pct(0.0005)
      if (stopPts > pct(0.004)) continue
      const toVwap = vwap != null ? dir * (vwap - price) : 0
      push('cvdDivergence', dir, stopPts, Math.max(2 * stopPts, Math.min(3 * stopPts, toVwap)), 45,
        64 + (absorbed(dir) || exhausted(dir) ? 6 : 0) + 3 * neighbours, {
          OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${wall}: ${lakh(added)} since open (${((added / wallOi) * 100).toFixed(1)}% of its OI), ${lakh(chg15)} in 15m${neighbours ? `, ${neighbours} neighbour strike${neighbours > 1 ? 's' : ''} adding` : ''}`,
          Divergence: `${dir > 0 ? 'lower low' : 'higher high'} ${extreme.toFixed(1)} vs ${(dir > 0 ? A.low : A.high).toFixed(1)}, but ΣΔ ${B.cvd} vs ${A.cvd} - ${dir > 0 ? 'selling' : 'buying'} drying up into the wall`,
          Footprint: `${absorbed(dir) ? 'absorption, ' : exhausted(dir) ? 'exhaustion, ' : ''}Δ turned ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
    }
  }

  // 19. Block-trade initiative - 09:30-14:30, exact days only. Three or more big prints on one side in
  //     three minutes, twice the size of the other side's, is an institution taking liquidity: trade
  //     with it while price HOLDS beyond the blocks' average price, on the VWAP side, with the chain's
  //     writers since the open and a fresh futures build-up behind it.
  if (!estimated && input.prints?.length && minute <= hm(14, 30) && vwap != null) {
    const f15 = futuresChange(oi, nowMs, 15)
    for (const dir of [1, -1]) {
      const blocks = bigPrints(dir, 3 * MIN)
      const other = bigPrints(-dir, 3 * MIN)
      if (blocks.count < 3 || blocks.qty < 2 * other.qty) continue
      const held = dir * (price - blocks.avg)
      if (held < 0 || held > pct(0.0015) || dir * (price - vwap) <= 0) continue
      if (!optionRead || dir * optionRead.leanOpen < 0.15) continue
      if (!f15 || f15.oiPct == null || !(dir * f15.pricePct > 0) || !(f15.oiPct > 0)) continue
      const footprint = dir * last.delta > 0 && (stackWith(dir, 3) || cvdNewExtreme(dir, 10)) && !exhausted(-dir)
      const tapeOk = aggWith(dir, 58)
      const c = confirm(dir, sweepWith(dir) || icebergs.some((i) => i.isBid === dir > 0))
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = Math.max(pct(0.001), held + pct(0.0008))
      const ahead = roomAhead(dir)
      if (ahead && ahead.room < 2 * stopPts && grew(dir > 0 ? oi.ce : oi.pe, ahead.wall, 15)) continue
      if (ahead && ahead.room < 1.7 * stopPts) continue
      push('blockTrade', dir, stopPts, Math.min(2.5 * stopPts, ahead ? 0.9 * ahead.room : Infinity), 45,
        64 + Math.min(10, 2 * (blocks.count - 3)) + (sweepWith(dir) ? 4 : 0) + (stackWith(dir, 3) ? 4 : 0), {
          OI: `chain writing since the open leans ${dir > 0 ? 'bullish' : 'bearish'} (${optionRead.leanOpen.toFixed(2)}): puts ${lakh(optionRead.peOpen)}, calls ${lakh(optionRead.ceOpen)}`,
          Blocks: `${blocks.count} big ${dir > 0 ? 'buys' : 'sells'} (${Math.round(blocks.qty / lot)} lots, avg ${blocks.avg.toFixed(1)}) vs ${Math.round(other.qty / lot)} lots the other way in 3m - price holding ${dir > 0 ? 'above' : 'below'} them`,
          'Futures confirm': `${dir > 0 ? 'long' : 'short'} build-up: price ${(f15.pricePct * 100).toFixed(2)}%, OI +${(f15.oiPct * 100).toFixed(2)}% in 15m`,
          Footprint: `${stackWith(dir, 3) ? 'stacked imbalance' : 'ΣΔ new extreme'}, Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
        })
    }
  }

  // 20. Stacked-imbalance zone retest - 09:45-14:30. A stacked imbalance (consecutive price rows where
  //     the aggressive side traded 3x the other) marks where an institution was aggressive; when price
  //     leaves it and comes back for the FIRST time the same side defends it - with the option writers
  //     adding on that side around the zone and the futures not building the other way.
  if (minute >= hm(9, 45) && minute <= hm(14, 30) && bars.length >= 8) {
    const f15 = futuresChange(oi, nowMs, 15)
    const band = pct(0.0003)
    for (const dir of [1, -1]) {
      // The latest zone on dir's side, 3-20 bars back (the outermost one when a bar has several).
      let zone = null
      let zoneIdx = -1
      for (let i = bars.length - 4; i >= Math.max(0, bars.length - 21) && !zone; i--) {
        zone = (bars[i].stacked ?? []).filter((z) => (z.side === 'buy') === dir > 0).sort((a, b) => (dir > 0 ? b.high - a.high : a.low - b.low))[0] ?? null
        zoneIdx = i
      }
      if (!zone) continue
      const near = dir > 0 ? zone.high : zone.low // the edge price comes back to
      const far = dir > 0 ? zone.low : zone.high // the stop side
      const touches = (b) => (dir > 0 ? b.low <= near + band : b.high >= near - band)
      // Left it by 0.15%+, did not come back until the last two bars, and no close through it since.
      let away = -1
      for (let i = zoneIdx + 1; i < bars.length - 2 && away < 0; i++) if (dir * ((dir > 0 ? bars[i].high : bars[i].low) - near) >= pct(0.0015)) away = i
      if (away < 0 || bars.slice(away + 1, -2).some(touches) || !bars.slice(-2).some(touches)) continue
      if (bars.slice(zoneIdx + 1).some((b) => dir * (b.close - far) < 0)) continue
      // The defending writers: puts (calls) at the strikes around the zone adding in the last 15 minutes.
      const map = dir > 0 ? oi.pe : oi.ce
      const k0 = Math.round(((zone.low + zone.high) / 2 - basis) / oi.step) * oi.step
      const strikes = [k0 - oi.step, k0, k0 + oi.step]
      const chg = strikes.reduce((sum, k) => sum + (oiChange(map, k, nowMs, 15) ?? 0), 0)
      const base = strikes.reduce((sum, k) => sum + (oiOf(map, k, nowMs) ?? 0), 0)
      if (!(base > 0) || chg < 0.005 * base) continue
      // Futures not building the other way.
      if (f15?.oiPct != null && dir * f15.pricePct < 0 && f15.oiPct > 0.002) continue
      const footprint = dir * last.delta > 0 && !stackAgainst(dir, 2)
      const tapeOk = aggWith(dir, 55, 'agg30')
      const c = confirm(dir, icebergs.some((i) => i.isBid === dir > 0 && Math.abs(i.price - near) <= pct(0.001)))
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = Math.max(pct(0.0008), dir * (price - far) + pct(0.0006))
      if (stopPts > pct(0.004)) continue
      const swing = dir > 0 ? Math.max(...bars.slice(zoneIdx + 1).map((b) => b.high)) : Math.min(...bars.slice(zoneIdx + 1).map((b) => b.low))
      const buildUp = f15?.oiPct != null && dir * f15.pricePct > 0 && f15.oiPct > 0
      push('imbalanceRetest', dir, stopPts, Math.max(1.5 * stopPts, Math.min(3 * stopPts, dir * (swing - price))), 45,
        63 + (absorbed(dir) ? 5 : 0) + (buildUp ? 5 : 0), {
          OI: `${dir > 0 ? 'PUT' : 'CALL'} ${strikes[0]}-${strikes[2]} around the zone ${lakh(chg)} in 15m - writers defending it`,
          Zone: `${dir > 0 ? 'buy' : 'sell'} stack ${zone.low}-${zone.high} (${fmtHm(istMinute(msOf(bars[zoneIdx].time)))}), left by 0.15%+, first retest now - swing ${swing.toFixed(1)}`,
          'Futures confirm': buildUp ? `${dir > 0 ? 'long' : 'short'} build-up in 15m` : 'no build-up against it',
          Footprint: `${absorbed(dir) ? 'absorption at the zone, ' : ''}Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
    }
  }

  // 21. ATM OI crossover + VWAP reclaim - 10:00-14:30. At the money (ATM ±1) the writers switched
  //     sides since the open - calls outweighed puts then, puts outweigh calls by 10%+ now and are still
  //     being added faster (bullish; the mirror is bearish) - and the WHOLE chain is writing the same way
  //     in the last 15 minutes, while price reclaims VWAP with the futures behind it.
  if (minute >= hm(10, 0) && minute <= hm(14, 30) && vwap != null && bars.length >= 4) {
    const atm = Math.round(spotNow / oi.step) * oi.step
    const openMs = dayOpenMs(oi, nowMs)
    const strikes = [atm - oi.step, atm, atm + oi.step]
    const total = (map, fn) => strikes.reduce((sum, k) => sum + (fn(map, k) ?? 0), 0)
    const at = {
      pe: { now: total(oi.pe, (m, k) => oiOf(m, k, nowMs)), open: total(oi.pe, (m, k) => openOi(m, k, openMs)), chg: total(oi.pe, (m, k) => oiChange(m, k, nowMs, 15)) },
      ce: { now: total(oi.ce, (m, k) => oiOf(m, k, nowMs)), open: total(oi.ce, (m, k) => openOi(m, k, openMs)), chg: total(oi.ce, (m, k) => oiChange(m, k, nowMs, 15)) },
    }
    const f15 = futuresChange(oi, nowMs, 15)
    for (const dir of [1, -1]) {
      const w = dir > 0 ? at.pe : at.ce // the writers backing the trade
      const o = dir > 0 ? at.ce : at.pe
      if (!(o.open > 0) || w.open > o.open || w.now < 1.1 * o.now || !(w.chg > 0) || !(w.chg > o.chg)) continue
      if (!optionRead || !(dir * optionRead.lean > 0)) continue
      const crossed = bars.slice(-4, -1).some((b) => dir * (b.close - vwap) < 0) && dir * (last.close - vwap) > 0
      if (!crossed || !f15 || !(dir * f15.pricePct > 0)) continue
      const footprint = (stackWith(dir, 3) || absorbed(dir)) && dir * last.delta > 0 && !stackAgainst(dir, 2)
      const tapeOk = aggWith(dir, 55, 'agg30') && aggWith(dir, 55)
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = Math.max(pct(0.001), dir * (price - vwap) + pct(0.0008))
      const ahead = roomAhead(dir)
      if (ahead && ahead.room < 1.5 * stopPts) continue
      push('atmFlip', dir, stopPts, ahead ? Math.min(0.9 * ahead.room, 2.5 * stopPts) : 2 * stopPts, 60,
        64 + (f15.oiPct > 0 ? 4 : 0) + (stackWith(dir, 3) ? 4 : 0), {
          OI: `ATM ${strikes[0]}-${strikes[2]}: ${dir > 0 ? 'puts' : 'calls'} ${(w.now / 1e5).toFixed(1)}L vs ${dir > 0 ? 'calls' : 'puts'} ${(o.now / 1e5).toFixed(1)}L now (open ${(w.open / 1e5).toFixed(1)}L vs ${(o.open / 1e5).toFixed(1)}L), 15m ${lakh(w.chg)} vs ${lakh(o.chg)} - writers flipped ${dir > 0 ? 'bullish' : 'bearish'}`,
          VWAP: `reclaimed VWAP ${vwap.toFixed(1)} with the futures ${dir > 0 ? 'up' : 'down'} ${(Math.abs(f15.pricePct) * 100).toFixed(2)}% in 15m`,
          Footprint: `${stackWith(dir, 3) ? 'stacked imbalance' : 'absorption'}, Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
    }
  }

  // ---- 22-23: range-bound (mean reversion) -----------------------------------------------------------
  // A balanced day: the option writers fence both sides (the PUT support and the CALL resistance both
  // added since the open), the futures have gone nowhere since the open (under 0.4%), price keeps
  // crossing VWAP (3+ times in 90 minutes) and the chain leans neither way. Extremes fade to the middle.
  const fOpen = futuresSince(oi, nowMs, dayOpenMs(oi, nowMs))
  const fenced = (map, strike) => strike != null && (sinceOpen(map, strike) ?? 0) > 0.01 * (oiOf(map, strike, nowMs) ?? Infinity)

  // 22. VWAP ±2σ fade - 10:30-14:30 on a balanced day: a tag of the 2-standard-deviation band, rejected
  //     (exhaustion / absorption, delta turning) - back to VWAP.
  if (minute >= hm(10, 30) && minute <= hm(14, 30) && bands?.sd > pct(0.0008) && support != null && resistance != null && resistance > support
    && fenced(oi.pe, support) && fenced(oi.ce, resistance) && fOpen && Math.abs(fOpen.pricePct) < 0.004
    && (!optionRead || Math.abs(optionRead.combined) < 0.3)) {
    const crosses = vwapCrosses(minuteBars, nowMs, 90)
    for (const dir of crosses >= 3 ? [1, -1] : []) {
      // dir = the fade: LONG off the lower band, SHORT off the upper.
      const bandPx = bands.vwap - dir * 2 * bands.sd
      if (!last3.some((b) => (dir > 0 ? b.low <= bandPx : b.high >= bandPx)) || dir * (last.close - bandPx) <= 0) continue
      // Not into a wall giving way.
      const wall = dir > 0 ? support : resistance
      if (shrank(dir > 0 ? oi.pe : oi.ce, wall, 15)) continue
      const footprint = (exhausted(dir) || absorbed(dir)) && dir * last.delta > 0 && !stackAgainst(dir, 2)
      const tapeOk = aggWith(dir, 52, 'agg30') && !sweepWith(-dir)
      const c = confirm(dir, liq.some((sg) => sg.kind === 'Exhaustion into wall' && sg.bullish === dir > 0))
      if (!footprint || !tapeOk || !c.ok) continue
      const extreme = dir > 0 ? Math.min(...last3.map((b) => b.low)) : Math.max(...last3.map((b) => b.high))
      const stopPts = dir * (price - extreme) + pct(0.0006)
      const toVwap = dir * (bands.vwap - price)
      if (toVwap < 1.2 * stopPts) continue
      const atWall = Math.abs(wall + basis - extreme) <= pct(0.0015)
      push('vwapFade', dir, stopPts, toVwap, 45, 60 + (exhausted(dir) ? 4 : 0) + (absorbed(dir) ? 4 : 0) + (atWall ? 6 : 0), {
        OI: `balanced: PUT ${support} ${lakh(sinceOpen(oi.pe, support))} and CALL ${resistance} ${lakh(sinceOpen(oi.ce, resistance))} since open, chain lean ${optionRead ? optionRead.combined.toFixed(2) : '-'}${atWall ? ` - the ${dir > 0 ? 'PUT' : 'CALL'} wall is at the band` : ''}`,
        Range: `futures ${(fOpen.pricePct * 100).toFixed(2)}% since open, ${crosses} VWAP crosses in 90m; ${dir > 0 ? 'lower' : 'upper'} 2σ band ${bandPx.toFixed(1)} tagged, VWAP ${bands.vwap.toFixed(1)} (target)`,
        Footprint: `${exhausted(dir) ? 'exhaustion' : 'absorption'} at the band, Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 23. Failed IB poke fade - 10:30-14:15 on a straddle-written day: the ATM call AND put both written
  //     since the open (3%+) and still being added - the writers expect a range. A poke beyond the
  //     initial balance (at most 0.15%) that is not accepted - back inside within minutes - fades back to
  //     the middle of the IB.
  if (minute >= hm(10, 30) && minute <= hm(14, 15) && fOpen && Math.abs(fOpen.pricePct) < 0.005) {
    const ibBars = minuteBars.filter((b) => msOf(b.time) >= sessionOpen && msOf(b.time) < sessionOpen + 60 * MIN)
    const atm = Math.round(spotNow / oi.step) * oi.step
    const openMs = dayOpenMs(oi, nowMs)
    const written = (map) => {
      const added = sinceOpen(map, atm)
      const open = openOi(map, atm, openMs)
      return added != null && open > 0 && added >= 0.03 * open && (oiChange(map, atm, nowMs, 30) ?? -1) >= 0
    }
    if (ibBars.length >= 45 && bars.length >= 6 && written(oi.ce) && written(oi.pe)) {
      const ibHigh = Math.max(...ibBars.map((b) => b.high))
      const ibLow = Math.min(...ibBars.map((b) => b.low))
      const mid = (ibHigh + ibLow) / 2
      const last4 = bars.slice(-4)
      for (const dir of [1, -1]) {
        // dir = the fade: SHORT after a poke above the IB high, LONG after one below the IB low.
        const edge = dir > 0 ? ibLow : ibHigh
        const extreme = dir > 0 ? Math.min(...last4.map((b) => b.low)) : Math.max(...last4.map((b) => b.high))
        const poke = dir * (edge - extreme)
        if (!(poke > 0) || poke > pct(0.0015) || dir * (last.close - edge) <= 0) continue
        if (bars.slice(-6).filter((b) => dir * (b.close - edge) < 0).length >= 3) continue
        const footprint = (absorbed(dir) || exhausted(dir)) && dir * last.delta > 0
        const tapeOk = aggWith(dir, 55, 'agg30')
        const c = confirm(dir)
        if (!footprint || !tapeOk || !c.ok) continue
        const stopPts = dir * (price - extreme) + pct(0.0005)
        const toMid = dir * (mid - price)
        if (toMid < 1.2 * stopPts) continue
        push('ibFade', dir, stopPts, toMid, 60, 62 + (absorbed(dir) ? 4 : 0) + (exhausted(dir) ? 4 : 0), {
          OI: `ATM ${atm} straddle written: CE ${lakh(sinceOpen(oi.ce, atm))}, PE ${lakh(sinceOpen(oi.pe, atm))} since open, both still adding in 30m`,
          Range: `poked the IB ${dir > 0 ? 'low' : 'high'} ${edge} by ${poke.toFixed(1)} and back inside (IB ${ibLow}-${ibHigh}); target the IB middle ${mid.toFixed(1)}`,
          Footprint: `${absorbed(dir) ? 'absorption' : 'exhaustion'} on the poke, Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
      }
    }
  }

  // 24. Trapped-OI squeeze - a short squeeze (LONG) or a long squeeze (SHORT) - 09:45-14:30. The futures
  //     OI is read minute by minute over the last 75 minutes for two phases:
  //     FUEL    - positions built AGAINST the coming move up to an OI peak (a short build-up - price
  //               down, OI up - before a short squeeze; a long build-up before a long squeeze);
  //     TRIGGER - the OI now coming off that peak (most of it in the last 10 minutes) while price moves
  //               the other way, back past where they were trapped: they are covering. Part of the
  //               fuel must be burnt (it has started) and most of it still left (it has room to run).
  //     The option writers on the trapped side cover at the money too (calls in a short squeeze) while
  //     the other side's writers stay, and the order flow must show the FORCED buying (selling): delta
  //     with it two bars running, a stack or a new ΣΔ extreme, fast aggressive tape (a sweep or the
  //     tape speeding up) and nothing absorbing or exhausting it. Not when already stretched from VWAP.
  if (minute >= hm(9, 45) && minute <= hm(14, 30) && bars.length >= 10) {
    const pts = (oi.futures ?? []).filter((p) => p.t >= nowMs - 75 * MIN && p.t <= nowMs && p.oi > 0)
    const nowPt = valueAt(oi.futures, nowMs)
    const fuelPts = pts.filter((p) => p.t <= nowMs - 5 * MIN)
    const f10 = futuresChange(oi, nowMs, 10)
    if (fuelPts.length >= 30 && nowPt?.oi > 0 && f10?.oiPct != null) {
      const start = pts[0]
      const peak = fuelPts.reduce((a, p) => (p.oi > a.oi ? p : a), fuelPts[0])
      const fuel = peak.oi - start.oi
      const covered = peak.oi - nowPt.oi
      const atm = Math.round(spotNow / oi.step) * oi.step
      const sumChg = (map, ks) => ks.reduce((sum, k) => sum + (oiChange(map, k, nowMs, 10) ?? 0), 0)
      const sumOi = (map, ks) => ks.reduce((sum, k) => sum + (oiOf(map, k, nowMs) ?? 0), 0)
      for (const dir of [1, -1]) {
        // The fuel: 0.4%+ OI built while price went against dir by 0.1%+.
        if (!(fuel >= 0.004 * start.oi) || !(dir * (peak.close - start.close) <= -pct(0.001))) continue
        // The trigger: 0.15%+ off the peak, 0.12%+ of it in the last 10 minutes, price 0.1%+ with dir.
        if (!(covered >= 0.0015 * peak.oi) || !(f10.oiPct <= -0.0012) || !(dir * f10.pricePct >= 0.001)) continue
        const burnt = covered / fuel
        if (burnt < 0.15 || burnt > 0.75) continue
        // The trapped side under water: price back past where the OI peaked.
        if (!(dir * (price - peak.close) > 0)) continue
        if (bands?.sd > 0 && dir * (price - bands.vwap) > Math.max(2 * bands.sd, pct(0.004))) continue
        // Option writers on the trapped side covering at the money (ATM and the next strike the move
        // runs into); the other side's (ATM and the one behind) not leaving.
        const trappedMap = dir > 0 ? oi.ce : oi.pe
        const otherMap = dir > 0 ? oi.pe : oi.ce
        const trappedStrikes = [atm, atm + dir * oi.step]
        const otherStrikes = [atm, atm - dir * oi.step]
        const writersCover = sumChg(trappedMap, trappedStrikes)
        const trappedBase = sumOi(trappedMap, trappedStrikes)
        if (!(trappedBase > 0) || writersCover > -0.005 * trappedBase) continue
        const otherChg = sumChg(otherMap, otherStrikes)
        const otherBase = sumOi(otherMap, otherStrikes)
        if (otherChg < -0.005 * otherBase) continue
        // The forced buying (selling) in the order flow.
        const footprint = dir * last.delta > 0 && prev && dir * prev.delta > 0 && (stackWith(dir, 3) || cvdNewExtreme(dir, 15)) && !absorbed(-dir) && !exhausted(-dir)
        const tapeOk = aggWith(dir, 62, 'agg30') && (sweepWith(dir) || tape.speedRatio >= 1.3 || tape.proxy)
          && (tape.proxy || (dir > 0 ? tape.bigSell <= tape.bigBuy : tape.bigBuy <= tape.bigSell))
        const c = confirm(dir, sweepWith(dir))
        if (!footprint || !tapeOk || !c.ok) continue
        // Stop beyond the last 10 minutes' swing; target back toward where the fuel began (2-3.5R) -
        // not into a growing wall close ahead.
        const swing = dir > 0 ? Math.min(...bars.slice(-10).map((b) => b.low)) : Math.max(...bars.slice(-10).map((b) => b.high))
        const stopPts = Math.max(pct(0.0012), dir * (price - swing) + pct(0.0005))
        if (stopPts > pct(0.004)) continue
        const ahead = roomAhead(dir)
        if (ahead && ahead.room < 1.5 * stopPts && grew(dir > 0 ? oi.ce : oi.pe, ahead.wall, 15)) continue
        const toOrigin = dir * (start.close - price)
        const peakAt = fmtHm(istMinute(peak.t - (oi.lag ?? 0)))
        push('oiSqueeze', dir, stopPts, Math.max(2 * stopPts, Math.min(3.5 * stopPts, toOrigin)), 40,
          64 + (sweepWith(dir) ? 6 : 0) + (stackWith(dir, 3) ? 4 : 0) + (otherChg > 0.003 * otherBase ? 4 : 0) + (fuel >= 0.008 * start.oi ? 4 : 0) + (burnt <= 0.5 ? 2 : 0), {
            OI: `futures OI +${((fuel / start.oi) * 100).toFixed(2)}% built while price went ${dir > 0 ? 'down' : 'up'} ${(Math.abs(peak.close - start.close) / start.close * 100).toFixed(2)}% (${dir > 0 ? 'shorts' : 'longs'} in) to a peak at ${peakAt}, now ${((covered / peak.oi) * 100).toFixed(2)}% off it - ${Math.round(burnt * 100)}% of the build-up covered so far`,
            'Option writers': `${dir > 0 ? 'CALL' : 'PUT'} ${trappedStrikes.join(' / ')} ${lakh(writersCover)} in 10m (covering), ${dir > 0 ? 'PUT' : 'CALL'} ${otherStrikes.join(' / ')} ${lakh(otherChg)}`,
            Squeeze: `futures ${(f10.pricePct * 100).toFixed(2)}% with OI ${(f10.oiPct * 100).toFixed(2)}% in 10m - ${dir > 0 ? 'short covering' : 'long unwinding'}, price ${dir > 0 ? 'above' : 'below'} the ${peak.close.toFixed(1)} where they were trapped`,
            Footprint: `${stackWith(dir, 3) ? 'stacked imbalance' : 'ΣΔ new extreme'}, Δ ${prev.delta > 0 ? '+' : ''}${prev.delta} / ${last.delta > 0 ? '+' : ''}${last.delta}, nothing absorbing it`,
            Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}${tape.proxy ? '' : ` · speed ${tape.speedRatio.toFixed(1)}x`}`, DOM: c.dom, Heatmap: c.heat,
          })
      }
    }
  }

  // 25. Sudden OI wall + DOM imbalance - 09:45-14:30. Writers suddenly put a wall right at the price -
  //     a PUT strike at / just under it (support: LONG) or a CALL strike at / just over it (resistance:
  //     SHORT) adds 3%+ of its OI in the last 5 minutes, at 3x+ its pace of the 30 minutes before (sudden,
  //     not a steady build), the biggest add on that side near the money, and it is now a real wall (60%+
  //     of the biggest OI of its kind within 8 strikes). Not a straddle: the other side is not written as
  //     hard at the money. The BOOK must lean the same way - bids 60%+ of the top 20 levels for a long
  //     (asks 60%+ for a short) - and the flow must not fight it (delta or the 30s tape with it, nothing
  //     absorbing / exhausting / stacking against). Needs the book: not on an estimated day.
  //     Stop just beyond the wall; target toward the opposite wall (1.5-3R).
  if (!estimated && share != null && minute >= hm(9, 45) && minute <= hm(14, 30)) {
    const atm = Math.round(spotNow / oi.step) * oi.step
    const sudden = suddenOiWalls(oi, nowMs)
    for (const dir of [1, -1]) {
      const map = dir > 0 ? oi.pe : oi.ce
      const otherMap = dir > 0 ? oi.ce : oi.pe
      // The biggest sudden add on the wall's side at / just behind the price (up to 3 strikes away).
      const best = sudden.find((w) => w.side === (dir > 0 ? 'PE' : 'CE')
        && (dir > 0 ? w.strike <= spotNow + 0.5 * oi.step && w.strike >= spotNow - 3 * oi.step : w.strike >= spotNow - 0.5 * oi.step && w.strike <= spotNow + 3 * oi.step))
      if (!best) continue
      const wallOi = best.oi
      const biggest = Math.max(...[...map.keys()].filter((k) => Math.abs(k - spotNow) <= 8 * oi.step).map((k) => oiOf(map, k, nowMs) ?? 0))
      if (!(wallOi >= 0.6 * biggest)) continue
      // Price at the wall, not through it: within 0.25% of it, on the right side (0.05% slack).
      const gap = dir * (spotNow - best.strike)
      if (gap > spotNow * 0.0025 || gap < -spotNow * 0.0005) continue
      // Not a straddle being written: the other side at the money adds under half as much.
      const otherAdd = [atm, atm + dir * oi.step].reduce((sum, k) => sum + Math.max(0, oiChange(otherMap, k, nowMs, 5) ?? 0), 0)
      if (otherAdd >= 0.5 * best.add) continue
      // The book leans the same way.
      const lean = dir > 0 ? share : 1 - share
      if (lean < 0.6) continue
      const flowWith = dir * last.delta > 0 || aggWith(dir, 55, 'agg30')
      const against = absorbed(-dir) || exhausted(-dir) || stackAgainst(dir, 2) || sweepWith(-dir)
      const c = confirm(dir)
      if (!flowWith || against || !c.ok) continue
      const wallF = best.strike + basis
      const stopPts = Math.max(pct(0.001), dir * (price - wallF) + pct(0.0008))
      if (stopPts > pct(0.004)) continue
      const ahead = roomAhead(dir)
      if (ahead && ahead.room < 1.5 * stopPts) continue
      const targetPts = ahead ? Math.max(1.5 * stopPts, Math.min(3 * stopPts, ahead.room - pct(0.0003))) : 2 * stopPts
      push('suddenWall', dir, stopPts, targetPts, 30,
        62 + (lean >= 0.65 ? 4 : 0) + ((best.paceX ?? Infinity) >= 5 ? 4 : 0) + (dir * last.delta > 0 && aggWith(dir, 55, 'agg30') ? 4 : 0) + (stackWith(dir, 3) ? 3 : 0), {
          OI: `${suddenWallText(best)}, a ${dir > 0 ? 'support' : 'resistance'} wall ${Math.abs(spotNow - best.strike).toFixed(0)} pts ${dir > 0 ? 'under' : 'over'} the index; ${dir > 0 ? 'calls' : 'puts'} at the money ${lakh(otherAdd)}`,
          DOM: `${dir > 0 ? 'bids' : 'asks'} ${Math.round(lean * 100)}% of the top 20 levels - the book leans ${dir > 0 ? 'up' : 'down'}`,
          Footprint: `Δ ${last.delta > 0 ? '+' : ''}${last.delta}${stackWith(dir, 3) ? ' · stacked imbalance with it' : ''}, nothing absorbing or stacking against it`,
          Tape: tapeText, Heatmap: c.heat,
        })
    }
  }

  // 26. OI + liquidity heatmap confluence - 09:45-14:30, exact days with a heatmap. The heatmap's read of
  //     the wall price is at (orderFlowMath.liquidityMap: walls that STAY in the book, last 10 min) and
  //     the option writers at the same price (strike + basis within 0.25%) tell the same story:
  //     HOLD  - ABSORPTION or EXHAUSTION at the wall, an option wall of that side there (a PUT wall at a
  //             bid wall, a CALL wall at an offer wall: 50%+ of the biggest of its kind within 8
  //             strikes, or a sudden OI wall) whose writers are still ADDING (15 min), and the futures
  //             not building against it (no short build-up into a support, no long build-up into a
  //             resistance) -> the bounce, stop beyond the wall;
  //     BREAK - the wall BREAKING (eaten) or PULLED, the option writers at that strike COVERING (15 min)
  //             and the futures moving with the break -> the continuation, stop back beyond the wall.
  //     Both: delta with the trade on the last bar, the 30s tape 55%+ with it, nothing stacked or
  //     sweeping against it, the book not against it. Target the next wall (heatmap or OI) 1.5R+ away,
  //     at most 3R (2R when there is none).
  if (!estimated && input.heatmap?.length && minute >= hm(9, 45) && minute <= hm(14, 30)) {
    const read = liquidityMap({ columns: input.heatmap, minuteBars, rowSize: input.rowSize ?? 1, lotSize: lot, price, nowMs })?.now
    const w = read?.level
    if (w && ['absorption', 'exhaustion', 'break', 'pulled'].includes(read.state)) {
      const hold = read.state === 'absorption' || read.state === 'exhaustion'
      const atSupport = w.kind === 'support'
      const dir = hold ? (atSupport ? 1 : -1) : (atSupport ? -1 : 1)
      const side = atSupport ? 'PE' : 'CE'
      const map = atSupport ? oi.pe : oi.ce
      const tol = pct(0.0025)
      const biggest = Math.max(0, ...[...map.keys()].filter((k) => Math.abs(k - spotNow) <= 8 * oi.step).map((k) => oiOf(map, k, nowMs) ?? 0))
      const sudden = suddenOiWalls(oi, nowMs).find((x) => x.side === side && Math.abs(x.strike + basis - w.price) <= tol)
      const strike = [...map.keys()].filter((k) => Math.abs(k + basis - w.price) <= tol)
        .sort((a, b) => (oiOf(map, b, nowMs) ?? 0) - (oiOf(map, a, nowMs) ?? 0))[0] ?? sudden?.strike
      const strikeOi = strike != null ? oiOf(map, strike, nowMs) : null
      const chg = strike != null ? oiChange(map, strike, nowMs, 15) : null
      const isWall = strikeOi > 0 && (strikeOi >= 0.5 * biggest || !!sudden)
      const writersOk = chg != null && strikeOi > 0 && (hold ? chg >= 0.005 * strikeOi || !!sudden : chg <= -0.005 * strikeOi)
      const f = futuresRead
      const futuresOk = hold
        ? !(f?.oiPct != null && dir * f.pricePct < 0 && f.oiPct > 0.002)
        : f != null && dir * f.pricePct > 0
      const flowOk = dir * last.delta > 0 && aggWith(dir, 55, 'agg30') && !stackAgainst(dir, 2) && !sweepWith(-dir)
      const c = confirm(dir)
      if (isWall && writersOk && futuresOk && flowOk && c.ok) {
        const edge = dir > 0 ? w.low : w.high // the wall's far side from the trade
        const stopPts = Math.max(pct(0.001), dir * (price - edge) + pct(0.0006))
        if (stopPts <= pct(0.004)) {
          // The next wall in the trade's direction, 1.5R+ away: an OI wall (in futures terms) or one more
          // heatmap level beyond this one.
          const levels = [resistance != null ? resistance + basis : null, support != null ? support + basis : null]
            .filter((x) => x != null && dir * (x - price) >= 1.5 * stopPts)
          const targetAt = levels.sort((a, b) => dir * (a - b))[0]
          const targetPts = targetAt != null ? Math.min(3 * stopPts, dir * (targetAt - price)) : 2 * stopPts
          const fWith = f?.oiPct != null && dir * f.pricePct > 0
          push('heatmapOi', dir, stopPts, targetPts, 45,
            62 + (read.state === 'absorption' ? 6 : read.state === 'break' ? 4 : 0) + (sudden ? 5 : 0) + (w.strength >= 5 ? 3 : 0) + (fWith ? 4 : 0) + (hold && w.trend === 'building' ? 3 : 0), {
              'Liquidity map': `${read.state.toUpperCase()} - ${read.text}`,
              OI: `${side === 'PE' ? 'PUT' : 'CALL'} ${strike} (${((strikeOi ?? 0) / 1e5).toFixed(1)}L${sudden ? ', a sudden wall' : ''}) at the ${atSupport ? 'bid' : 'offer'} wall ${w.price} - writers ${hold ? 'adding' : 'covering'} ${lakh(chg ?? 0)} in 15m`,
              'Futures OI': futuresText,
              Footprint: `Δ ${last.delta > 0 ? '+' : ''}${last.delta}, nothing stacked against it`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
              Plan: `${hold ? 'hold: bounce off' : 'break: continuation through'} the wall${targetAt != null ? `, target the wall at ${targetAt.toFixed(0)}` : ''}`,
            })
        }
      }
    }
  }

  // 27. VWAP pullback - trend continuation - 10:00-14:30, exact days with a heatmap. The classic trend-day
  //     VWAP trade: price has held on one side of a sloping VWAP (80%+ of the last 45 minutes' closes
  //     above a VWAP that rose 0.05%+ in 30 minutes, for a long) and made the day's high in the last hour;
  //     the first pullback TAGS VWAP (a low within 0.03% of it in the last 3 bars) without closing
  //     through it (no close 0.05%+ below in the last 5 bars) and the last bar turns back up off it.
  //     Confirmed by the OI - the option writers back it (the chain's put writing leads) OR the futures
  //     are in a long build-up since the open - and by the heatmap: a bid wall that stays in the book
  //     within 0.1% of VWAP, or an absorption read there. Order flow: delta with it, the 30s tape 55%+,
  //     nothing stacked against it. Stop under the pullback low; target the day's high (2-3R).
  //     The mirror for a short.
  if (!estimated && input.heatmap?.length && vwap != null && minute >= hm(10, 0) && minute <= hm(14, 30) && bars.length >= 45) {
    const vwapThen = vwapOf(minuteBars, nowMs - 30 * MIN)
    const session = minuteBars.filter((b) => msOf(b.time) >= sessionOpen && msOf(b.time) + MIN <= nowMs)
    const map = liquidityMap({ columns: input.heatmap, minuteBars, rowSize: input.rowSize ?? 1, lotSize: lot, price, nowMs })
    for (const dir of [1, -1]) {
      if (vwapThen == null || !(dir * (vwap - vwapThen) >= pct(0.0005))) continue
      const last45 = bars.slice(-45)
      const held = last45.filter((b) => dir * (b.close - vwapOf(minuteBars, msOf(b.time))) > 0).length
      if (held < 0.8 * last45.length) continue
      // The day's extreme on the trade's side made in the last hour (a trend, not an old high).
      const dayExtreme = dir > 0 ? Math.max(...session.map((b) => b.high)) : Math.min(...session.map((b) => b.low))
      const lastHour = session.filter((b) => msOf(b.time) >= nowMs - 60 * MIN)
      if (!lastHour.some((b) => (dir > 0 ? b.high >= dayExtreme : b.low <= dayExtreme))) continue
      // The pullback: tagged VWAP in the last 3 bars, no close through it in the last 5, turning now.
      const tagged = last3.some((b) => (dir > 0 ? b.low <= vwap + pct(0.0003) : b.high >= vwap - pct(0.0003)))
      const brokeThrough = bars.slice(-5).some((b) => dir * (b.close - vwap) < -pct(0.0005))
      if (!tagged || brokeThrough || !(dir * (last.close - vwap) > 0)) continue
      // OI: the writers back the trend, or the futures are building positions with it since the open.
      const stance = optionOiStance(optionRead, dir)
      const fOpen = futuresSince(oi, nowMs, dayOpenMs(oi, nowMs))
      const futuresBuild = fOpen?.oiPct != null && dir * fOpen.pricePct > 0 && fOpen.oiPct > 0
      if (stance !== 'agrees' && !futuresBuild) continue
      // Heatmap: a wall of the trade's side resting at VWAP, or an absorption read there.
      const walls = dir > 0 ? map?.support ?? [] : map?.resistance ?? []
      const wallAtVwap = walls.find((w) => Math.abs(w.price - vwap) <= pct(0.001))
      const absorbedAtVwap = map?.now?.state === 'absorption' && map.now.bullish === dir > 0 && map.now.level && Math.abs(map.now.level.price - vwap) <= pct(0.001)
      if (!wallAtVwap && !absorbedAtVwap) continue
      const flowOk = dir * last.delta > 0 && aggWith(dir, 55, 'agg30') && !stackAgainst(dir, 2) && !sweepWith(-dir)
      const c = confirm(dir)
      if (!flowOk || !c.ok) continue
      const pullbackExtreme = dir > 0 ? Math.min(...last3.map((b) => b.low)) : Math.max(...last3.map((b) => b.high))
      const stopPts = Math.max(pct(0.001), dir * (price - pullbackExtreme) + pct(0.0006))
      if (stopPts > pct(0.004)) continue
      const toExtreme = dir * (dayExtreme - price)
      const targetPts = Math.max(2 * stopPts, Math.min(3 * stopPts, toExtreme))
      push('vwapPullback', dir, stopPts, targetPts, 45,
        62 + (stance === 'agrees' ? 4 : 0) + (futuresBuild ? 4 : 0) + (absorbedAtVwap ? 5 : 0) + (wallAtVwap?.trend === 'building' ? 3 : 0) + (stackWith(dir, 3) ? 3 : 0), {
          VWAP: `${held}/${last45.length} closes ${dir > 0 ? 'above' : 'below'} VWAP ${vwap.toFixed(1)} (${dir > 0 ? 'up' : 'down'} ${(Math.abs(vwap - vwapThen) / vwapThen * 100).toFixed(2)}% in 30m); pullback tagged it, no close through - turning`,
          OI: `${stance === 'agrees' ? 'option writers back it' : 'writers neutral'}${futuresBuild ? ` · futures ${dir > 0 ? 'long' : 'short'} build-up since open (price ${(fOpen.pricePct * 100).toFixed(2)}%, OI +${(fOpen.oiPct * 100).toFixed(2)}%)` : ''}`,
          'Liquidity map': wallAtVwap ? `${dir > 0 ? 'bid' : 'offer'} wall ${wallAtVwap.price} (${wallAtVwap.lots} lots, ${wallAtVwap.trend}) at VWAP` : `absorption at VWAP - ${map.now.text}`,
          Footprint: `Δ ${last.delta > 0 ? '+' : ''}${last.delta}, nothing stacked against it`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
          Plan: `target the day's ${dir > 0 ? 'high' : 'low'} ${dayExtreme.toFixed(1)}`,
        }, { rTarget: true })
    }
  }

  // 29. VWAP + OI confluence - 10:00-14:30, every day (exact or estimated). The well-known intraday
  //     combination: trade WITH VWAP only when both OI reads agree. For a long (the mirror for a short):
  //       VWAP     - price has held above a rising VWAP (75%+ of the last 30 closes above it, VWAP up
  //                  0.03%+ in 30 minutes) and the first pullback tags it (a low within 0.05% of it in the
  //                  last 3 bars), no close 0.05%+ through it in the last 5, the last bar turning up;
  //       Options  - the option writers back it (put writing leads the chain - optionOiStance 'agrees');
  //       Futures  - a long build-up since the open (price up, OI up), the OI not falling in the last 15m.
  //     Order flow: delta with it, nothing stacked or swept against it. Stop beyond the pullback; target
  //     2R, out to the day's high if that is further (max 3R). #27 is the same trade with a heatmap wall.
  //     Every threshold here is a filter the trader can tune (STRATEGY_FILTERS.vwapOi).
  if (vwap != null && minute >= hm(10, 0) && minute <= hm(14, 30) && bars.length >= 30) {
    const f = strategyFilters('vwapOi', input.filters?.vwapOi)
    const vwapThen = vwapOf(minuteBars, nowMs - 30 * MIN)
    const session = minuteBars.filter((b) => msOf(b.time) >= sessionOpen && msOf(b.time) + MIN <= nowMs)
    const fOpen = futuresSince(oi, nowMs, dayOpenMs(oi, nowMs))
    for (const dir of [1, -1]) {
      if (vwapThen == null || !(dir * (vwap - vwapThen) >= pct(f.slopePct / 100)) || !session.length) continue
      const last30 = bars.slice(-30)
      const held = last30.filter((b) => dir * (b.close - vwapOf(minuteBars, msOf(b.time))) > 0).length
      if (held < (f.heldPct / 100) * last30.length) continue
      const tagged = last3.some((b) => (dir > 0 ? b.low <= vwap + pct(f.tagPct / 100) : b.high >= vwap - pct(f.tagPct / 100)))
      const brokeThrough = bars.slice(-5).some((b) => dir * (b.close - vwap) < -pct(0.0005))
      const turning = dir * (last.close - vwap) > 0 && dir * (last.close - last.open) > 0
      if (!tagged || brokeThrough || !turning) continue
      // Both OI reads: the option writers AND the futures positions.
      const stance = optionOiStance(optionRead, dir)
      const futuresBuild = fOpen?.oiPct != null && dir * fOpen.pricePct > 0 && fOpen.oiPct > 0
      const futuresHolding = futuresRead?.oiPct == null || futuresRead.oiPct >= 0
      if ((f.needWriters && stance !== 'agrees') || (f.needFuturesBuild && !futuresBuild) || (f.needFuturesHolding && !futuresHolding)) continue
      const flowOk = (!f.needDelta || dir * last.delta > 0) && !stackAgainst(dir, 2) && !sweepWith(-dir)
      const c = confirm(dir)
      if (!flowOk || !c.ok) continue
      const pullbackExtreme = dir > 0 ? Math.min(...last3.map((b) => b.low)) : Math.max(...last3.map((b) => b.high))
      const stopPts = Math.max(pct(0.001), dir * (price - pullbackExtreme) + pct(0.0005))
      if (stopPts > pct(0.004)) continue
      const dayExtreme = dir > 0 ? Math.max(...session.map((b) => b.high)) : Math.min(...session.map((b) => b.low))
      const targetPts = Math.max(f.targetR * stopPts, Math.min(Math.max(f.targetR, f.maxR) * stopPts, dir * (dayExtreme - price)))
      const pcrWith = optionRead && (dir > 0 ? optionRead.pcr >= 1 : optionRead.pcr <= 1)
      push('vwapOi', dir, stopPts, targetPts, f.timeStopMin,
        62 + (futuresRead?.oiPct > 0 ? 4 : 0) + (pcrWith ? 3 : 0) + (stackWith(dir, 3) ? 3 : 0), {
          VWAP: `${held}/${last30.length} closes ${dir > 0 ? 'above' : 'below'} VWAP ${vwap.toFixed(1)} (${dir > 0 ? 'up' : 'down'} ${(Math.abs(vwap - vwapThen) / vwapThen * 100).toFixed(2)}% in 30m); pullback tagged it, no close through - turning`,
          OI: `option writers ${stance === 'agrees' ? 'back it' : `${stance} (filter off)`} · ${futuresBuild ? `futures ${dir > 0 ? 'long' : 'short'} build-up since open (price ${(fOpen.pricePct * 100).toFixed(2)}%, OI +${(fOpen.oiPct * 100).toFixed(2)}%)` : 'no futures build-up (filter off)'}${optionRead ? ` · PCR ${optionRead.pcr.toFixed(2)}` : ''}`,
          Footprint: `Δ ${last.delta > 0 ? '+' : ''}${last.delta}, nothing stacked or swept against it`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
          Plan: `stop beyond the pullback ${pullbackExtreme.toFixed(1)}, target ${(targetPts / stopPts).toFixed(1)}R (day's ${dir > 0 ? 'high' : 'low'} ${dayExtreme.toFixed(1)})`,
        }, { rTarget: true })
    }
  }

  // 30. Failed IB breakout - 10:20-14:15. Price broke beyond the initial balance (the first hour's
  //     range) in the last 15 minutes but was not accepted out there: it left a TAIL (the extreme bar
  //     closed back half its range or more) or the breakout side was trapped (a sweep, big prints beyond
  //     the edge), and it is back inside the IB - value - now. The trapped breakout traders' exits drive
  //     it back across the range: target the other IB edge. For a LONG after a failed break DOWN (the
  //     mirror for a SHORT after a failed break UP):
  //       Break    - a low under the IB low in the last 15 minutes, at most 0.4% under it, at most 5
  //                  closes under it (more is an accepted breakout), the last bar out there within 3 bars;
  //       Back in  - the last close back inside by 0.02%+, entry still within 0.2% of the edge;
  //       OI       - the put writers defend the IB low (the strike just under it added OI in 15 min);
  //       Flow     - delta with the trade, the book / heatmap not against it.
  //     Stop beyond the excursion's extreme; target the other IB edge when it is 1.5R+ away.
  //     Every threshold is a filter the trader can tune (STRATEGY_FILTERS.ibFailed).
  if (minute >= hm(10, 20) && minute <= hm(14, 15) && bars.length >= 20) {
    const f = strategyFilters('ibFailed', input.filters?.ibFailed)
    const ibBars = minuteBars.filter((b) => msOf(b.time) >= sessionOpen && msOf(b.time) < sessionOpen + 60 * MIN)
    if (ibBars.length >= 45) {
      const ibHigh = Math.max(...ibBars.map((b) => b.high))
      const ibLow = Math.min(...ibBars.map((b) => b.low))
      const ibEndMs = sessionOpen + 60 * MIN
      const windowBars = bars.filter((b) => msOf(b.time) >= Math.max(ibEndMs, nowMs - f.lookbackMin * MIN))
      const sweepsIn = recent(input.sweeps ?? [], nowMs, f.lookbackMin * MIN, (w) => msOf(w.endedAt))
      const vp = input.profile?.vp
      for (const dir of [1, -1]) {
        // dir = the trade: LONG after a failed break DOWN through the IB low, SHORT after one UP.
        const edge = dir > 0 ? ibLow : ibHigh
        const other = dir > 0 ? ibHigh : ibLow
        const outside = (b) => (dir > 0 ? b.low < edge : b.high > edge)
        const out = windowBars.filter(outside)
        if (!out.length || !bars.slice(-3).some(outside)) continue
        const extremeBar = out.reduce((a, b) => (dir > 0 ? (b.low < a.low ? b : a) : (b.high > a.high ? b : a)))
        const extreme = dir > 0 ? extremeBar.low : extremeBar.high
        if (dir * (edge - extreme) > pct(f.maxExcursionPct / 100)) continue
        const closesBeyond = windowBars.filter((b) => dir * (b.close - edge) < 0).length
        if (closesBeyond > f.maxClosesBeyond) continue
        if (dir * (last.close - edge) < pct(0.0002) || dir * (price - edge) > pct(0.002)) continue
        // The trapped breakout side: a tail on the extreme bar, a sweep their way, or big prints beyond.
        const barRange = extremeBar.high - extremeBar.low
        const tail = barRange > 0 && dir * (extremeBar.close - extreme) >= (f.tailPct / 100) * barRange
        const sweep = sweepsIn.some((w) => w.buy === dir < 0)
        const blocks = bigPrints(-dir, f.lookbackMin * MIN, (px) => dir * (edge - px) >= 0)
        const trapped = tail || sweep || blocks.count >= 2
        if (f.needTrapped && !trapped) continue
        // The writers defend the edge: PUT OI added just under a failed low (CALL just over a failed high).
        const map = dir > 0 ? oi.pe : oi.ce
        const strike = dir > 0 ? Math.floor((edge - basis) / oi.step) * oi.step : Math.ceil((edge - basis) / oi.step) * oi.step
        const writersDefend = grew(map, strike, 15)
        if (f.needWriters && !writersDefend) continue
        if (f.needDelta && !(dir * last.delta > 0)) continue
        const c = confirm(dir)
        if (!c.ok) continue
        const stopPts = Math.max(pct(0.001), dir * (price - extreme) + pct(0.0005))
        if (stopPts > pct(0.005)) continue
        const targetPrice = edge + f.targetFrac * (other - edge)
        const toTarget = dir * (targetPrice - price)
        if (toTarget < f.minRR * stopPts) continue
        const backInVa = vp?.val != null && vp?.vah != null && last.close >= vp.val && last.close <= vp.vah
        push('ibFailed', dir, stopPts, toTarget, f.timeStopMin,
          62 + (tail ? 3 : 0) + (sweep ? 4 : 0) + (writersDefend ? 4 : 0) + (backInVa ? 3 : 0), {
            OI: writersDefend ? `${dir > 0 ? 'put' : 'call'} writers defend the IB ${dir > 0 ? 'low' : 'high'}: ${strike} ${dir > 0 ? 'PE' : 'CE'} OI added in 15 min` : `writers at ${strike} not adding (filter off)`,
            Profile: `broke the IB ${dir > 0 ? 'low' : 'high'} ${edge} by ${(dir * (edge - extreme)).toFixed(1)} (${closesBeyond} close${closesBeyond === 1 ? '' : 's'} out there) and is back inside the IB ${ibLow}-${ibHigh}${backInVa ? ' and the previous value area' : ''}`,
            Trapped: trapped ? [tail && `tail - the extreme bar closed back ${Math.round((dir * (extremeBar.close - extreme) / barRange) * 100)}% of its range`, sweep && 'a sweep into the break', blocks.count >= 2 && `${blocks.count} big prints beyond the edge`].filter(Boolean).join(' · ') : 'no tail / sweep (filter off)',
            Footprint: `Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
            Plan: `target ${f.targetFrac === 1 ? 'the other IB edge' : f.targetFrac === 0.5 ? 'the IB middle' : `${f.targetFrac}x back across the IB`} ${targetPrice.toFixed(1)}`,
          })
      }
    }
  }

  // 28. OI structure - purely the option OI, read minute by minute - 09:45-14:30. For a LONG (the mirror
  //     for a SHORT):
  //       Walls    - the biggest PUT OI within 6 strikes below the index (support) is at least 1.15x the
  //                  biggest CALL OI within 6 strikes above it (resistance): the floor is heavier than
  //                  the ceiling;
  //       Middle   - at the money (ATM ±1) puts outweigh calls - (PE - CE) / (PE + CE) of +0.15 or more -
  //                  and by more than the rest of the near chain (ATM ±2..6) does: the money itself leans
  //                  long, not just the far strikes;
  //       Writing  - near the money (ATM ±3) the net writing (puts added - calls added, so call covering
  //                  counts too) is with the trade in at least 3 of the last 5 one-minute changes,
  //                  including the last one, against it in none of them by more than a sliver, adds up
  //                  to 0.2%+ of the near OI over 5 minutes, and is with it over 15 minutes as well.
  //     The index must still be above its support strike, with room to the resistance wall. Stop under
  //     the support strike (in futures terms; 0.15-0.5%), target the resistance wall (1.5-3R). No
  //     footprint / tape / book needed - it is the writers' positioning - but every trade still gets the
  //     options-OI stance (push).
  if (minute >= hm(9, 45) && minute <= hm(14, 30)) {
    const step = oi.step
    const atm = Math.round(spotNow / step) * step
    const near6 = rows.filter((r) => Math.abs(r.strike - spotNow) <= 6 * step + step * 0.5)
    const putWall = near6.filter((r) => r.strike <= spotNow).reduce((a, r) => (r.peOi > (a?.peOi ?? 0) ? r : a), null)
    const callWall = near6.filter((r) => r.strike >= spotNow).reduce((a, r) => (r.ceOi > (a?.ceOi ?? 0) ? r : a), null)
    const both = (k, t = nowMs) => { const pe = oiOf(oi.pe, k, t); const ce = oiOf(oi.ce, k, t); return pe == null || ce == null ? null : { pe, ce } }
    const leanOf = (strikes) => {
      let pe = 0, ce = 0
      for (const k of strikes) { const v = both(k); if (v) { pe += v.pe; ce += v.ce } }
      return pe + ce > 0 ? (pe - ce) / (pe + ce) : null
    }
    const middle = leanOf([atm - step, atm, atm + step])
    const others = leanOf([2, 3, 4, 5, 6].flatMap((i) => [atm - i * step, atm + i * step]))
    const nearK = [-3, -2, -1, 0, 1, 2, 3].map((i) => atm + i * step)
    // Net writing (puts added - calls added) near the money between two moments.
    const netWriting = (from, to) => {
      let net = 0, seen = 0
      for (const k of nearK) {
        const a = both(k, from); const b = both(k, to)
        if (!a || !b) continue
        net += (b.pe - a.pe) - (b.ce - a.ce)
        seen++
      }
      return seen ? net : null
    }
    const nearTotal = nearK.reduce((sum, k) => { const v = both(k); return sum + (v ? v.pe + v.ce : 0) }, 0)
    const perMinute = [0, 1, 2, 3, 4].map((i) => netWriting(nowMs - (i + 1) * MIN, nowMs - i * MIN))
    const net15 = netWriting(nowMs - 15 * MIN, nowMs)
    if (putWall && callWall && middle != null && others != null && nearTotal > 0 && perMinute.every((m) => m != null) && net15 != null) {
      const fOpen = futuresSince(oi, nowMs, dayOpenMs(oi, nowMs))
      for (const dir of [1, -1]) {
        const ownWall = dir > 0 ? putWall : callWall
        const otherWall = dir > 0 ? callWall : putWall
        const ownOi = dir > 0 ? putWall.peOi : callWall.ceOi
        const otherOi = dir > 0 ? callWall.ceOi : putWall.peOi
        if (!(ownOi >= 1.15 * otherOi)) continue
        const lean = dir * middle
        if (!(lean >= 0.15) || !(lean > dir * others)) continue
        const sliver = 0.0005 * nearTotal
        const withUs = perMinute.filter((m) => dir * m > 0).length
        const sum5 = perMinute.reduce((a, b) => a + b, 0)
        if (withUs < 3 || !(dir * perMinute[0] > 0) || perMinute.some((m) => dir * m < -sliver)) continue
        if (!(dir * sum5 >= 0.002 * nearTotal) || !(dir * net15 > 0)) continue
        // The index on its side of its own wall, with room to the other one.
        if (dir * (spotNow - ownWall.strike) < 0) continue
        const stopRaw = dir * (price - (ownWall.strike + basis)) + pct(0.0008)
        if (stopRaw > pct(0.005)) continue
        const stopPts = Math.max(pct(0.0015), stopRaw)
        const room = dir * (otherWall.strike + basis - price) - pct(0.0005)
        if (room < 1.5 * stopPts) continue
        const futuresWith = fOpen?.oiPct != null && dir * fOpen.pricePct > 0 && fOpen.oiPct > 0
        push('oiStructure', dir, stopPts, Math.min(room, 3 * stopPts), 60,
          60 + (withUs === 5 ? 5 : withUs === 4 ? 3 : 0) + (ownOi >= 1.5 * otherOi ? 4 : 0) + (lean >= 0.3 ? 4 : 0) + (futuresWith ? 4 : 0), {
            OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${ownWall.strike} ${(ownOi / 1e5).toFixed(1)}L vs ${dir > 0 ? 'CALL' : 'PUT'} wall ${otherWall.strike} ${(otherOi / 1e5).toFixed(1)}L (${(ownOi / otherOi).toFixed(2)}x)`,
            Middle: `ATM ${atm} ±1: ${dir > 0 ? 'puts' : 'calls'} lead ${(lean * 100).toFixed(0)}% (rest of the chain ${(dir * others * 100).toFixed(0)}%)`,
            Writing: `net ${dir > 0 ? 'put' : 'call'} writing near the money in ${withUs}/5 minutes (${perMinute.map((m) => lakh(dir * m)).join(' ')}), ${lakh(dir * sum5)} in 5m, ${lakh(dir * net15)} in 15m`,
            ...(futuresWith ? { 'Futures confirm': `${dir > 0 ? 'long' : 'short'} build-up since open (price ${(fOpen.pricePct * 100).toFixed(2)}%, OI +${(fOpen.oiPct * 100).toFixed(2)}%)` } : {}),
            Plan: `stop beyond ${ownWall.strike}, target the ${dir > 0 ? 'call' : 'put'} wall ${otherWall.strike}`,
          })
      }
    }
  }

  // ---- 31-33: the option chain + futures OI + VWAP (no book / heatmap / tape) ---------------------------
  // Sizes in strike steps (walls sit on strikes) or % of price, so NIFTY (step 50), BANKNIFTY and SENSEX (step 100)
  // read alike. The stop's buffer beyond a wall: 0.06% of price, capped at 0.35 of a strike (as #16).
  const kStep = oi.step
  const wallBuffer = Math.min(pct(0.0006), kStep * 0.35)

  // 31. ATM straddle decay - fade the OI wall back to the middle - 10:15-14:30. The option sellers own the day: the
  //     ATM straddle (CE + PE premium at the strike nearest the index, minute by minute, finished minutes only) is
  //     under its session average and still falling (2%+ in 15 minutes) while the CE AND the PE OI at the money
  //     (ATM ±1) both rise (0.5%+ each in 15 minutes) - premium sold on both sides, the writers expect a range.
  //     A move to the edge of that range fades:
  //       SHORT - the futures within half a strike of the biggest CALL wall above (at most a quarter strike
  //               through it), the last bar turning down off it, that wall's writers not leaving (its OI not
  //               down 0.5%+ in 15 minutes);
  //       LONG  - the mirror at the biggest PUT wall below.
  //     Stop beyond the wall / the last 3 bars' extreme (+ the buffer); target the middle between the two walls,
  //     1.2R+ away. Every threshold is a filter (STRATEGY_FILTERS.straddleFade).
  if (minute >= hm(10, 15) && minute <= hm(14, 30) && support != null && resistance != null && resistance > support && bars.length >= 3) {
    const f = strategyFilters('straddleFade', input.filters?.straddleFade)
    const atm = Math.round(spotNow / kStep) * kStep
    const atmK = [atm - kStep, atm, atm + kStep]
    // A side's OI at ATM ±1: its change in 15 minutes as a fraction of what it was.
    const rise = (map) => {
      let chg = 0, base = 0
      for (const k of atmK) {
        const c = oiChange(map, k, nowMs, 15)
        const was = oiOf(map, k, nowMs - 15 * MIN)
        if (c == null || !(was > 0)) return null
        chg += c
        base += was
      }
      return base > 0 ? chg / base : null
    }
    const ceRise = rise(oi.ce)
    const peRise = rise(oi.pe)
    const bothWritten = ceRise != null && peRise != null && ceRise >= f.oiRisePct / 100 && peRise >= f.oiRisePct / 100
    // The ATM straddle at `t`: at the strike nearest the index THEN (a straddle chart); null without both premiums.
    const straddleAt = (t) => {
      const idx = valueAt(oi.spot, t)?.close
      if (!idx) return null
      const k = Math.round(idx / kStep) * kStep
      const ce = premiumAt(oi, 'CE', k, t)
      const pe = premiumAt(oi, 'PE', k, t)
      return ce != null && pe != null ? ce + pe : null
    }
    const band = f.edgeStrikes * kStep
    for (const dir of bothWritten ? [1, -1] : []) {
      // dir = the fade: LONG off the PUT wall below, SHORT off the CALL wall above.
      const wall = dir > 0 ? support : resistance
      const wallF = wall + basis
      const inside = dir * (price - wallF) // > 0: on the range side of the wall
      if (inside > band || inside < -0.25 * kStep) continue
      if (!last3.some((b) => (dir > 0 ? b.low <= wallF + band : b.high >= wallF - band))) continue
      if (!(dir * (last.close - last.open) > 0)) continue
      const map = dir > 0 ? oi.pe : oi.ce
      const wallOi = oiOf(map, wall, nowMs)
      const wallChg = oiChange(map, wall, nowMs, 15)
      if (!(wallOi > 0) || (wallChg != null && wallChg <= -0.005 * wallOi)) continue
      // The straddle: falling, and under its session average (every finished minute since the open).
      const straddle = straddleAt(nowMs)
      const before = straddleAt(nowMs - 15 * MIN)
      if (straddle == null || before == null || straddle > before * (1 - f.fallPct / 100)) continue
      let sum = 0, n = 0
      for (let t = dayOpenMs(oi, nowMs); t <= nowMs; t += MIN) { const v = straddleAt(t); if (v != null) { sum += v; n++ } }
      if (n < 30) continue
      const avg = sum / n
      if (f.needBelowAvg && !(straddle < avg)) continue
      const extreme = dir > 0 ? Math.min(...last3.map((b) => b.low)) : Math.max(...last3.map((b) => b.high))
      const stopLevel = dir > 0 ? Math.min(extreme, wallF) - wallBuffer : Math.max(extreme, wallF) + wallBuffer
      const stopPts = Math.max(Math.min(pct(0.001), kStep * 0.6), dir * (price - stopLevel))
      if (stopPts > pct(0.004)) continue
      const mid = (support + resistance) / 2 + basis
      const toMid = dir * (mid - price)
      if (toMid < f.minRR * stopPts) continue
      push('straddleFade', dir, stopPts, toMid, f.timeStopMin, 0, {
        OI: `ATM ${atmK[0]}-${atmK[2]} written on both sides: CE ${ceRise >= 0 ? '+' : ''}${(ceRise * 100).toFixed(2)}%, PE ${peRise >= 0 ? '+' : ''}${(peRise * 100).toFixed(2)}% in 15m; ${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} ${(wallOi / 1e5).toFixed(1)}L${wallChg != null ? ` (${lakh(wallChg)} in 15m)` : ''} holding`,
        Straddle: `ATM straddle ${straddle.toFixed(1)} vs ${before.toFixed(1)} 15 min ago (${(((straddle - before) / before) * 100).toFixed(1)}%), session average ${avg.toFixed(1)} - premium decaying, a range`,
        Range: `futures ${price.toFixed(1)} at the ${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} (futures ${wallF.toFixed(1)}), last bar turning ${dir > 0 ? 'up' : 'down'}; walls ${support}-${resistance}`,
        Plan: `stop beyond ${stopLevel.toFixed(1)}, target the middle ${mid.toFixed(1)} (${(toMid / stopPts).toFixed(1)}R)`,
      })
    }
  }

  // 32. S/R OI wall shift - writers rolling with the price - 09:45-14:30. The biggest PUT wall (support: the biggest
  //     PE OI at / below the index, within 8 strikes) moved UP one strike in the last 15 minutes - the put writers
  //     rolled up behind the price - and the futures followed (up 0.05%+ in those 15 minutes): LONG. The mirror -
  //     the biggest CALL wall (resistance) moved DOWN one strike and the futures fell - is a SHORT. A real roll:
  //     the new strike added 1%+ of its OI in that time and more than the old one did, and is now the bigger of
  //     the two (1.05x+); the other wall is not moving against it (the CALL wall not coming down under a long).
  //     The futures on the trade's side of the new wall, at most a strike past it. Stop beyond the new wall
  //     (+ the buffer); target 2R, short of the next wall ahead (no trade with under 1.7R of room to it).
  //     Every threshold is a filter (STRATEGY_FILTERS.wallShift).
  if (minute >= hm(9, 45) && minute <= hm(14, 30)) {
    const f = strategyFilters('wallShift', input.filters?.wallShift)
    const thenMs = nowMs - f.withinMin * MIN
    const spotThen = valueAt(oi.spot, thenMs)?.close
    const fW = futuresChange(oi, nowMs, f.withinMin)
    const wallsThen = spotThen ? wallsAt(oi, oiRows(oi, thenMs), spotThen) : null
    for (const dir of wallsThen && fW ? [1, -1] : []) {
      const map = dir > 0 ? oi.pe : oi.ce
      const nowK = dir > 0 ? support : resistance
      const thenK = dir > 0 ? wallsThen.support : wallsThen.resistance
      if (nowK == null || thenK == null) continue
      const moved = Math.round((dir * (nowK - thenK)) / kStep)
      if (moved < 1 || moved > f.maxStrikes) continue
      const newOi = oiOf(map, nowK, nowMs)
      const oldOi = oiOf(map, thenK, nowMs) ?? 0
      const newChg = oiChange(map, nowK, nowMs, f.withinMin)
      const oldChg = oiChange(map, thenK, nowMs, f.withinMin)
      if (!(newOi > 0) || newChg == null || !(newChg > 0) || newChg < (f.newAddPct / 100) * (newOi - newChg)) continue
      if (oldChg != null && oldChg >= newChg) continue
      if (newOi < f.leadX * oldOi) continue
      // The other wall not moving against the trade.
      const otherNow = dir > 0 ? resistance : support
      const otherThen = dir > 0 ? wallsThen.resistance : wallsThen.support
      if (otherNow != null && otherThen != null && dir * (otherNow - otherThen) < 0) continue
      // The futures followed the writers.
      if (!(dir * fW.pricePct > 0) || dir * fW.pricePct < f.followPct / 100) continue
      const wallF = nowK + basis
      const past = dir * (price - wallF)
      if (!(past > 0) || past > f.maxAwayStrikes * kStep) continue
      const stopPts = Math.max(Math.min(pct(0.001), kStep * 0.6), past + wallBuffer)
      if (stopPts > pct(0.004)) continue
      const aheadK = dir > 0 ? wallAheadStrikes.resistanceAhead : wallAheadStrikes.supportAhead
      const room = aheadK != null ? dir * (aheadK + basis - price) : null
      if (room != null && room < 1.7 * stopPts) continue
      const targetPts = Math.min(f.targetR * stopPts, room != null ? 0.9 * room : Infinity)
      const futOi = fW.oiPct == null ? 'no futures OI' : `futures OI ${fW.oiPct >= 0 ? '+' : ''}${(fW.oiPct * 100).toFixed(2)}% (${Math.abs(fW.oiPct) < FUT_OI_MOVE ? 'flat' : dir > 0 ? (fW.oiPct > 0 ? 'long build-up' : 'short covering') : (fW.oiPct > 0 ? 'short build-up' : 'long unwinding')})`
      push('wallShift', dir, stopPts, targetPts, f.timeStopMin, 0, {
        OI: `${dir > 0 ? 'PUT' : 'CALL'} wall moved ${thenK} → ${nowK} in ${f.withinMin}m: ${nowK} ${lakh(newChg)} (now ${(newOi / 1e5).toFixed(1)}L), ${thenK} ${oldChg != null ? lakh(oldChg) : '-'} (now ${(oldOi / 1e5).toFixed(1)}L) - writers rolling ${dir > 0 ? 'up' : 'down'}; ${dir > 0 ? 'CALL' : 'PUT'} wall ${otherThen ?? '-'} → ${otherNow ?? '-'}`,
        'Futures confirm': `futures ${(fW.pricePct * 100).toFixed(2)}% in ${f.withinMin}m - following the writers; ${futOi}`,
        Plan: `futures ${past.toFixed(1)} past the new wall (${wallF.toFixed(1)}); stop beyond it, target ${(targetPts / stopPts).toFixed(1)}R${aheadK != null ? ` (next wall ${aheadK})` : ''}`,
      })
    }
  }

  // 33. Since-open CE / PE flip + futures build-up on the VWAP side - 10:00-14:30. Over the whole chain, the OI added
  //     since the open: puts added minus calls added was negative 15 minutes ago (call writers leading) and now
  //     leads the other way by 0.2%+ of the chain's OI - the writers changed sides - with a fresh futures long
  //     build-up in the last 15 minutes (price up 0.05%+, OI up 0.1%+), the futures above VWAP (at most 0.3% above)
  //     and the last bar's delta with it: LONG. The mirror (calls now leading after puts did, a short build-up,
  //     below VWAP) is a SHORT. Stop behind VWAP (0.1%+); target 2R, short of the next wall ahead (no trade with
  //     under 1.5R of room). Every threshold is a filter (STRATEGY_FILTERS.cumFlip).
  if (minute >= hm(10, 0) && minute <= hm(14, 30) && vwap != null && optionRead) {
    const f = strategyFilters('cumFlip', input.filters?.cumFlip)
    const thenMs = nowMs - f.withinMin * MIN
    const spotThen = valueAt(oi.spot, thenMs)?.close
    const readThen = spotThen ? optionOiRead(oi, spotThen, thenMs, 15) : null
    const total = optionRead.peNow + optionRead.ceNow
    const netNow = optionRead.peOpen - optionRead.ceOpen
    const netThen = readThen ? readThen.peOpen - readThen.ceOpen : null
    for (const dir of netThen != null && futuresRead && total > 0 ? [1, -1] : []) {
      if (!(dir * netThen < 0) || dir * netNow < (f.flipPct / 100) * total) continue
      const buildUp = futuresRead.oiPct != null && dir * futuresRead.pricePct >= FUT_PRICE_MOVE && futuresRead.oiPct >= FUT_OI_MOVE
      if (!(dir * futuresRead.pricePct > 0) || (f.needBuildUp && !buildUp)) continue
      const fromVwap = dir * (price - vwap)
      if (!(fromVwap > 0) || fromVwap > pct(f.maxFromVwapPct / 100)) continue
      if (f.needDelta && !(dir * last.delta > 0)) continue
      const stopPts = Math.max(pct(0.001), fromVwap + pct(0.0005))
      if (stopPts > pct(0.004)) continue
      const aheadK = dir > 0 ? wallAheadStrikes.resistanceAhead : wallAheadStrikes.supportAhead
      const room = aheadK != null ? dir * (aheadK + basis - price) : null
      if (room != null && room < 1.5 * stopPts) continue
      const targetPts = Math.min(f.targetR * stopPts, room != null ? 0.9 * room : Infinity)
      const ofChain = (v) => `${v >= 0 ? '+' : ''}${((v / total) * 100).toFixed(2)}%`
      push('cumFlip', dir, stopPts, targetPts, f.timeStopMin, 0, {
        OI: `since the open puts ${lakh(optionRead.peOpen)} vs calls ${lakh(optionRead.ceOpen)}: net ${ofChain(netNow)} of the chain now vs ${ofChain(netThen)} ${f.withinMin} min ago - ${dir > 0 ? 'put' : 'call'} writers took the lead`,
        'Futures confirm': `${buildUp ? `${dir > 0 ? 'long' : 'short'} build-up` : 'price with it (build-up filter off)'}: ${futuresText}`,
        VWAP: `futures ${price.toFixed(1)} ${dir > 0 ? 'above' : 'below'} VWAP ${vwap.toFixed(1)} by ${fromVwap.toFixed(1)}`,
        Footprint: `Δ ${last.delta > 0 ? '+' : ''}${last.delta}`,
        Plan: `stop behind VWAP, target ${(targetPts / stopPts).toFixed(1)}R${aheadK != null ? ` (next wall ${aheadK})` : ''}`,
      })
    }
  }

  // Retired strategies are not traded (input.includeRetired: the tests, which still exercise their rules).
  // Each strategy's trade filters (sides, entry window, stop / target / time stop / trailing) - the defaults change nothing.
  // The market at the clock on every setup (for the order-flow filters, and kept in the scanner record for the learning).
  const market = out.length ? marketAt({ nowMs, price, bars, tapePrints: input.prints, oi, heatmap: input.heatmap, lotSize: input.lotSize, largeLots: input.bigLots }) : null
  const traded = out.map((s) => applyTradeFilter({ ...s, market }, strategyFilters(s.id, input.filters?.[s.id]))).filter(Boolean)
  const final = resolveConflicts(input.includeRetired ? traded : traded.filter((s) => !STRATEGY_BY_ID[s.id]?.retired))
  if (!final.length) return final
  // The day type at the clock and what an adaptive scanner would do with each setup - TRACKING ONLY:
  // every setup still fires; this is scored beside the real results (adaptiveStats).
  const regime = regimeNow()
  return final.map((s) => {
    // The adaptive call on the combined day type, and - to measure what the OI / CVD votes add - on the
    // price read alone.
    const adaptive = { ...adaptiveDecision(s, regime), priceOnly: adaptiveDecision(s, { type: regime.priceType }).take }
    return {
      ...s, regime: { type: regime.type, label: regime.label, priceType: regime.priceType, votes: regime.votes }, adaptive,
      checks: { ...s.checks, 'Day type': `${regime.label} - ${regime.reasons}. Adaptive would ${adaptive.take ? 'TAKE' : 'SKIP'} it (${adaptive.reason}) - tracking only, it fires either way` },
    }
  })
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
  return dayOver ? { status: statusOf(r), r, mfe, exitPrice: lastClose, timeStop: true, ...state() } : { status: 'open', r, mfe, ...state() }
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
