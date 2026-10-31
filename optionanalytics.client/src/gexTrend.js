// OI Replay's GEX SMART DETECTION: which row of the GEX / price truth table the last `window` minutes match - how the net
// GEX (gex.js, the sign the card shows) moved and how spot moved over them, and what that combination usually means.
//
//  - The window: from the last minute at or before `window` minutes ago to the minute read (no reading that old yet =
//    no detection - the start of the day waits for its first full window). Only minutes up to the one read are used.
//  - GEX behaviour, the net GEX then -> now:
//      'negToPos' / 'posToNeg' - it changed sign: the start clearly on one side (outside the near-zero band) and now past
//        zero on the other (a wiggle from inside the band is no change of sign);
//      'nearZero' - now within `zeroShare` (10%) of the gross GEX (every strike's call and put GEX counted positive);
//      'posGrowing' / 'negGrowing' - same sign, moved away from zero by `growShare` (10%) of its size at the start (or of
//        the band, when that is bigger); 'posShrinking' / 'negShrinking' - moved towards zero as much; else '...Steady'.
//  - Price behaviour: spot then -> now, 'rising' / 'falling' past `pricePct` (0.1%) of spot, else 'sideways'.
//  - The read: the table's row for the pair (GEX_TREND_TABLE - the trader's own table, its words kept); a pair the table
//    has no row for says so (`row` null) rather than guessing one.
// `since`: when the pair read now started - each minute is classified the same way from its own window, so a minute's
// detection never changes when later minutes come in. A read, not a signal: it feeds no strategy or alert.

const MIN = 60_000

export const GEX_TREND_DEFAULTS = { window: 15, zeroShare: 0.1, growShare: 0.1, pricePct: 0.1 }
export const GEX_TREND_WINDOWS = [5, 10, 15, 30]

export const GEX_BEHAVIOURS = {
  negToPos: 'Negative → Positive',
  posToNeg: 'Positive → Negative',
  posGrowing: 'Positive increasing',
  posShrinking: 'Positive decreasing',
  posSteady: 'Positive, steady',
  negGrowing: 'Negative increasing in magnitude',
  negShrinking: 'Negative decreasing in magnitude',
  negSteady: 'Negative, steady',
  nearZero: 'Near zero',
}

export const PRICE_BEHAVIOURS = { rising: 'Rising', falling: 'Falling', sideways: 'Sideways' }

// tone: what the row leans to - 'bull', 'bear' or 'neutral' (a colour on the card, nothing more).
export const GEX_TREND_TABLE = [
  { gex: 'negToPos', price: 'falling', read: 'Potential stabilisation, bearish pressure still active', tone: 'neutral' },
  { gex: 'negToPos', price: 'rising', read: 'Potential bullish transition', tone: 'bull' },
  { gex: 'posGrowing', price: 'falling', read: 'Potential stabilisation, but bearish acceptance possible', tone: 'neutral' },
  { gex: 'posGrowing', price: 'rising', read: 'Potentially stable bullish trend', tone: 'bull' },
  { gex: 'posToNeg', price: 'falling', read: 'Potential downside acceleration', tone: 'bear' },
  { gex: 'posToNeg', price: 'rising', read: 'Potential upside acceleration', tone: 'bull' },
  { gex: 'negGrowing', price: 'falling', read: 'Strong bearish gamma regime', tone: 'bear' },
  { gex: 'negGrowing', price: 'rising', read: 'Strong bullish gamma regime', tone: 'bull' },
  { gex: 'nearZero', price: 'sideways', read: 'Possible low-gamma / transitional environment', tone: 'neutral' },
]

/** The gross GEX of a minute: every strike's call and put GEX counted positive (the calls and puts totals without strikes). */
export function grossGex(minute) {
  if (minute?.strikes?.length) return minute.strikes.reduce((sum, r) => sum + Math.abs(r.call ?? 0) + Math.abs(r.put ?? 0), 0)
  return Math.abs(minute?.calls ?? 0) + Math.abs(minute?.puts ?? 0)
}

function gexBehaviour(start, now, { zeroShare, growShare }) {
  const bandStart = zeroShare * grossGex(start)
  const bandNow = zeroShare * grossGex(now)
  if (start.net < -bandStart && now.net > 0) return 'negToPos'
  if (start.net > bandStart && now.net < 0) return 'posToNeg'
  if (Math.abs(now.net) <= bandNow) return 'nearZero'
  const change = now.net - start.net
  const step = growShare * Math.max(Math.abs(start.net), bandStart)
  if (now.net > 0) return change >= step ? 'posGrowing' : change <= -step ? 'posShrinking' : 'posSteady'
  return change <= -step ? 'negGrowing' : change >= step ? 'negShrinking' : 'negSteady'
}

function priceBehaviour(start, now, { pricePct }) {
  const move = now.spot - start.spot
  const threshold = (pricePct / 100) * now.spot
  return move >= threshold ? 'rising' : move <= -threshold ? 'falling' : 'sideways'
}

/**
 * The detection at each minute of `minutes` (gex.js' `gexDay`, oldest first - cut at the replay clock by the caller), each
 * from its own window only: `[{ time, gex, price, row, from }]` - null where the window has no start yet. `from` = the
 * minute the window started at.
 */
export function gexTrendDay(minutes, options = {}) {
  const opts = { ...GEX_TREND_DEFAULTS, ...options }
  const list = (minutes ?? []).filter((m) => m && Number.isFinite(m.time) && Number.isFinite(m.net) && m.spot > 0)
  const out = []
  let s = -1   // the window's start: the last minute at or before `window` minutes before the minute read
  for (let i = 0; i < list.length; i++) {
    const now = list[i]
    while (s + 1 < i && list[s + 1].time <= now.time - opts.window * MIN) s++
    const start = s >= 0 && list[s].time <= now.time - opts.window * MIN ? list[s] : null
    if (!start) { out.push(null); continue }
    const gex = gexBehaviour(start, now, opts)
    const price = priceBehaviour(start, now, opts)
    out.push({ time: now.time, gex, price, row: GEX_TREND_TABLE.find((r) => r.gex === gex && r.price === price) ?? null, from: start.time })
  }
  return out
}

/**
 * The detection at the last of `minutes`, with what the card shows: `{ gex, price, gexLabel, priceLabel, row, read, tone,
 * from, to, since, previous, netFrom, netTo, spotFrom, spotTo }`; `{ warming: true, needFrom }` before the first full
 * window (null without minutes). `since` = the first minute of the run of the same pair up to now; `path` = the day's
 * reads from the table so far (`{ row, read, tone, since, until }` - a run's first and last minute, oldest first);
 * `previous` = the last of them before this read that is another row, null when none.
 */
export function gexTrend(minutes, options = {}) {
  const opts = { ...GEX_TREND_DEFAULTS, ...options }
  const list = (minutes ?? []).filter((m) => m && Number.isFinite(m.time) && Number.isFinite(m.net) && m.spot > 0)
  if (!list.length) return null
  const day = gexTrendDay(list, opts)
  const last = day.at(-1)
  if (!last) return { warming: true, needFrom: list[0].time + opts.window * MIN, window: opts.window }
  let first = day.length - 1
  while (first > 0 && day[first - 1] && day[first - 1].gex === last.gex && day[first - 1].price === last.price) first--
  // The trend so far: the day's reads from the table, one run of minutes each, oldest first (a minute with no row ends a
  // run and is not listed); `previous` = the last one before this read that is another row.
  const path = []
  for (let i = 0; i < day.length; i++) {
    const d = day[i]
    if (!d?.row) continue
    const run = path.at(-1)
    if (run && run.row === d.row && day[i - 1]?.row === d.row) run.until = d.time
    else path.push({ row: d.row, read: d.row.read, tone: d.row.tone, since: d.time, until: d.time })
  }
  const previous = [...path].reverse().find((run) => run.row !== last.row && run.until < day[first].time) ?? null
  const start = list.find((m) => m.time === last.from)
  const now = list.at(-1)
  return {
    gex: last.gex, price: last.price, gexLabel: GEX_BEHAVIOURS[last.gex], priceLabel: PRICE_BEHAVIOURS[last.price],
    row: last.row, read: last.row?.read ?? null, tone: last.row?.tone ?? null, window: opts.window,
    from: last.from, to: now.time, since: day[first].time, previous, path,
    netFrom: start.net, netTo: now.net, spotFrom: start.spot, spotTo: now.spot,
  }
}

// ---- price at the GEX levels ------------------------------------------------------------------------------------------
// Spot NEAR a level (within `nearPct` % of spot - 0.15%: ~37 points on NIFTY) and what that level usually does in the
// gamma regime now (the net GEX of the Sign shown), as the GEX tools read it: the PUT WALL (support - dealers long gamma
// buy the dip there; short gamma, a break can run), the CALL WALL (resistance - long gamma, dealers sell the rally there;
// short gamma, a break can squeeze), MAX GAMMA (the magnet - long gamma pins price there; short gamma, its pull is weak).
// With the net GEX near zero (within 10% of the gross) the read is the same with "weak" - little gamma either way.

export const GEX_LEVEL_DEFAULTS = { nearPct: 0.15 }

export const GEX_LEVELS = {
  putWall: 'Put wall (support)',
  callWall: 'Call wall (resistance)',
  maxGamma: 'Max gamma (magnet)',
}

export const GEX_LEVEL_TABLE = [
  { level: 'putWall', regime: 'positive', read: 'Support likely to hold - dealers buy the dip (bounce)', tone: 'bull' },
  { level: 'putWall', regime: 'negative', read: 'Support at risk - a break can accelerate lower', tone: 'bear' },
  { level: 'callWall', regime: 'positive', read: 'Resistance likely to hold - dealers sell the rally (rejection)', tone: 'bear' },
  { level: 'callWall', regime: 'negative', read: 'Resistance at risk - a break can accelerate higher (squeeze)', tone: 'bull' },
  { level: 'maxGamma', regime: 'positive', read: 'Pin - price tends to stick around the magnet (chop)', tone: 'neutral' },
  { level: 'maxGamma', regime: 'negative', read: 'Weak magnet - moves can run through it', tone: 'neutral' },
]

/**
 * The GEX levels spot is near at a minute (`gexDay`'s): `[{ level, label, price, distance, regime, weak, row, read, tone }]`
 * - `distance` = level - spot (points), `regime` 'positive' / 'negative' (the net GEX's sign), `weak` = the net GEX near
 * zero; nearest first. Empty when spot is near none.
 */
export function gexLevelsNear(minute, options = {}) {
  const { nearPct, zeroShare } = { ...GEX_LEVEL_DEFAULTS, zeroShare: GEX_TREND_DEFAULTS.zeroShare, ...options }
  if (!minute || !(minute.spot > 0) || !Number.isFinite(minute.net)) return []
  const regime = minute.net >= 0 ? 'positive' : 'negative'
  const weak = Math.abs(minute.net) <= zeroShare * grossGex(minute)
  const reach = (nearPct / 100) * minute.spot
  return Object.keys(GEX_LEVELS)
    .filter((level) => Number.isFinite(minute[level]) && Math.abs(minute[level] - minute.spot) <= reach)
    .map((level) => {
      const row = GEX_LEVEL_TABLE.find((r) => r.level === level && r.regime === regime)
      return { level, label: GEX_LEVELS[level], price: minute[level], distance: minute[level] - minute.spot, regime, weak, row, read: row.read, tone: row.tone }
    })
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
}
