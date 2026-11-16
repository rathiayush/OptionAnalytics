// SCORED absorption and exhaustion on the footprint (asked for - "is there any better way to identify exhaustion /
// absorption on the footprint ... please work on this area"; "yes, you fix absorption exhaustion"). The footprint's first
// rules (orderFlowMath.analyzeBars) read ONE bar: heavy aggression in its end rows with a close off the extreme
// (absorption), a nearly empty end row (exhaustion). They stay as they are for the bias - which
// are measured on them. What the FOOTPRINT shows is this read instead, each mark with a 0 - 100 score of how many
// independent things agree:
//
//   ABSORPTION - an EFFORT that FAILED at a price. At a bar's low (bullish; the high is the mirror):
//     effort     - the aggressive SELLING in the bar's bottom zone (its lowest third, at least two rows), with what was
//                  sold at those same prices in the bars before it for as long as price kept trading there (absorption is
//                  a fight at a price - it lasts as long as the market stays at it, not a set number of bars), against
//                  today's usual bar's selling - the bar's own at least half a usual bar's, and the selling there 1.5x
//                  the buying;
//     result     - how far the bar closed back off its low (it must close above the zone);
//     efficiency - the delta that did not move price: sellers ahead on the bar yet it closed up, or it moved far less a
//                  lot of delta than bars usually do;
//     context    - the low breaks the market's STRUCTURE (a new session low, under the last swing low, a new low of the
//                  move) or retests it, and / or sits at a level given (VWAP, a wall, yesterday's value area ...);
//     book       - with the order book: what traded into the bids there against what they SHOWED, and whether they
//                  are still there (traded more than was ever shown, bids still standing = refilled: the real thing);
//                  an ICEBERG the engine caught on the bid in the zone during the bar (detected by its end) = 1.
//   EXHAUSTION - PARTICIPATION FADING at a new extreme. At a new high of the STRUCTURE (bearish; the low is the mirror):
//     volume     - less volume than the push before it (the last bar that made a new high of the structure);
//     delta      - less buying delta than that push (or none at all), and a lower cumulative delta at a higher high;
//     thin top   - little traded in the top two rows (two, not one: Dhan's one-second packets put a whole second's
//                  volume on one price, so a single thin row is often an artefact); a FINISHED AUCTION at the top - nothing
//                  at all bought there (0 offers lifted) - = 1, the classic exhaustion print;
//     value      - the bar's busiest price (POC) did not follow price up;
//     rejection  - how far it closed back off the high (it must close off it).
//
// NOTHING IS A FIXED NUMBER OF BARS (asked for - "like how a human reads it ... not 5 - 10 candles, adaptive and
// dynamic"; "I am only loading the current day - 10 bars come after 50 min"): the yardstick (the usual bar's volume,
// selling, buying, range and move per delta) is the median of TODAY's bars before this one together with YESTERDAY's
// bars within 30 minutes of its time of day (`prior` - so it reads from the first bars of the day, the open against
// yesterday's open, and today's own bars count for more as they come); the "new high / low" is against the
// market's SWINGS (`swingTracker` - a swing is confirmed once price comes back from it by 1.5x today's usual bar range,
// at least two rows, so the swings grow with a fast market and shrink with a quiet one), the session's high / low and the
// current move's extreme; the fight at a price runs back over every bar that kept trading there.
//
// CONFIRMATION (as the professional order-flow reads go - a read is a candidate until the market agrees): each mark is
// `status` 'pending' when printed, 'confirmed' once a later bar of the day CLOSES past the signal bar's other end (price
// left the level - the aggressors are trapped), 'failed' once a later bar TRADES past the level the read said would hold
// (the zone's far edge for absorption, the extreme for exhaustion; checked first - a sweep of the level that closes back
// is a failure); `statusAt` = that bar. The score and parts never change; the status is the one known at the clock.
//
// A part that cannot be read (no book, no push before) is left out and the rest re-weighted. Every bar is read from
// itself and the bars BEFORE it - nothing after (`tests/flow-reads.test.mjs`). A read on the chart: it feeds no strategy,
// alert or order.

const round2 = (v) => Math.round(v * 100) / 100
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0)
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : 0 }
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

export const FLOW_READ_DEFAULTS = {
  minScore: 50,      // a mark is drawn from this score
  swingRanges: 1.5,  // a swing is confirmed once price comes back from it by this many of today's usual bar ranges
  nearRows: 2,       // rows within which a given level counts as "at" the extreme
}
const IST_MS = 5.5 * 3600_000
const dayOf = (t) => Math.floor((msOf(t) + IST_MS) / 86_400_000)
const clockOf = (t) => (msOf(t) + IST_MS) % 86_400_000
export const PRIOR_CLOCK_MS = 30 * 60_000

/**
 * The market's swings as the bars go by - a zigzag whose turn is `reversal(i)` points (today's usual range, so it adapts):
 * a high is a SWING HIGH once price has come back down from it by that much, a low the mirror. `levels()` is what is known
 * BEFORE the next bar (call `add` after reading a bar): { swingHigh, swingLow (the last confirmed, { price, i }), moveHigh,
 * moveLow (the current move's extreme so far - since the last opposite swing), sessionHigh, sessionLow }.
 */
export function swingTracker() {
  let dir = 0, legHigh = null, legLow = null, swingHigh = null, swingLow = null, sessionHigh = null, sessionLow = null
  return {
    levels: () => ({ swingHigh, swingLow, moveHigh: legHigh, moveLow: legLow, sessionHigh, sessionLow }),
    add(bar, i, reversal) {
      sessionHigh = sessionHigh == null || bar.high > sessionHigh.price ? { price: bar.high, i } : sessionHigh
      sessionLow = sessionLow == null || bar.low < sessionLow.price ? { price: bar.low, i } : sessionLow
      if (legHigh == null) { legHigh = { price: bar.high, i }; legLow = { price: bar.low, i }; return }
      if (bar.high > legHigh.price) legHigh = { price: bar.high, i }
      if (bar.low < legLow.price) legLow = { price: bar.low, i }
      // Up (or not yet known) and price came back down far enough from the move's high: that high is a swing.
      if (dir >= 0 && legHigh.i < i && legHigh.price - bar.low >= reversal) {
        swingHigh = legHigh; dir = -1; legLow = { price: bar.low, i }; legHigh = { price: bar.high, i }
      } else if (dir <= 0 && legLow.i < i && bar.high - legLow.price >= reversal) {
        swingLow = legLow; dir = 1; legHigh = { price: bar.high, i }; legLow = { price: bar.low, i }
      }
    },
  }
}

// The price a new high / low is new against, and its name: the current move's extreme or the last swing, whichever is
// further out (before the first swing the move is the whole session so far).
function structureRef(lv, high) {
  if (high) {
    const ref = [lv.swingHigh, lv.moveHigh].filter(Boolean).reduce((a, b) => (a && a.price >= b.price ? a : b), null)
    if (!ref) return null
    const name = ref.price >= lv.sessionHigh.price ? 'session high' : ref === lv.swingHigh ? 'swing high' : 'high of the move'
    return { price: ref.price, name }
  }
  const ref = [lv.swingLow, lv.moveLow].filter(Boolean).reduce((a, b) => (a && a.price <= b.price ? a : b), null)
  if (!ref) return null
  const name = ref.price <= lv.sessionLow.price ? 'session low' : ref === lv.swingLow ? 'swing low' : 'low of the move'
  return { price: ref.price, name }
}
export const FLOW_READ_SCORES = [40, 50, 60, 70]
const ABSORPTION_WEIGHTS = { effort: 30, result: 20, efficiency: 20, context: 15, book: 15 }
const EXHAUSTION_WEIGHTS = { volume: 20, delta: 25, thin: 15, value: 15, rejection: 25 }
export const FLOW_READ_PARTS = {
  effort: 'heavy aggression at the price', result: 'closed back off it', efficiency: 'delta did not move price', context: 'at a new extreme / a level',
  book: 'resting orders held or refilled', volume: 'less volume than the last push', delta: 'less delta than the last push', thin: 'little traded at the extreme',
  value: 'the busiest price did not follow', rejection: 'closed back off it',
}

// The score of the parts read (null = not read): their weights' share, 0 - 100.
function scoreOf(parts, weights) {
  let got = 0, of = 0
  for (const [key, w] of Object.entries(weights)) if (parts[key] != null) { got += w * parts[key]; of += w }
  return of > 0 ? Math.round((got / of) * 100) : 0
}

// Resting size shown at the zone's rows through the bar (the most, and at its end), from the book columns - null without any.
function bookAt(columns, fromMs, toMs, lo, hi, side, step) {
  if (!columns?.length) return null
  let a = 0, b = columns.length
  while (a < b) { const m = (a + b) >> 1; if (columns[m].t < fromMs) a = m + 1; else b = m }
  let most = 0, last = null
  for (let i = a; i < columns.length && columns[i].t < toMs; i++) {
    let q = 0
    for (const [p, qty] of columns[i][side] ?? []) if (p >= lo - step / 2 && p <= hi + step / 2) q += qty
    most = Math.max(most, q)
    last = q
  }
  return last == null ? null : { most, last }
}

const hhmm = (t) => new Date(msOf(t) + IST_MS).toISOString().slice(11, 16)
// A later bar's verdict on a waiting mark (true = settled): FAILED when it trades past the level the read said would hold
// (checked first - a bar that sweeps the level and closes back is a failure, the read was wrong about the level), else
// CONFIRMED when it closes past the signal bar's other end. The mark itself (score, parts) never changes - only its status,
// from the bar that decided it, so a read at any clock shows the status known then.
function settle(w, bar) {
  const failed = w.bull ? bar.low < w.fail - 1e-9 : bar.high > w.fail + 1e-9
  const confirmed = !failed && (w.bull ? bar.close > w.confirm + 1e-9 : bar.close < w.confirm - 1e-9)
  if (!failed && !confirmed) return false
  w.mark.status = failed ? 'failed' : 'confirmed'
  w.mark.statusAt = bar.time
  w.mark.text += failed ? ` · FAILED ${hhmm(bar.time)} (${w.failText})` : ` · CONFIRMED ${hhmm(bar.time)} (closed past ${w.confirm})`
  return true
}

// The iceberg on the absorbing side (`bull` - a bid) inside [lo, hi] that was resting during [fromMs, toMs) and was already
// detected by the bar's end - nothing the engine only found out later.
function icebergAt(icebergs, fromMs, toMs, lo, hi, bull, step) {
  for (const b of icebergs ?? []) {
    if (!b || !!b.isBid !== bull || !(b.price >= lo - step / 2 && b.price <= hi + step / 2)) continue
    const started = msOf(b.startedAt), detected = msOf(b.detectedAt ?? b.startedAt), ended = b.endedAt ? msOf(b.endedAt) : Infinity
    if (started < toMs && ended >= fromMs && detected < toMs) return b
  }
  return null
}

// "a new session low", "under the swing low 24,980", "a new low of the move" (the mirror at a high).
const breakText = (ref, low) => (ref.name.startsWith('session') ? `a new ${ref.name}` : `${low ? 'under' : 'over'} the ${ref.name} ${ref.price}`)

/**
 * The scored reads of `bars` (analyzeBars' - time, open / high / low / close, buy, sell, delta, volume, cvd, poc, levels
 * [{ price, buy, sell }]; oldest first): an array beside them, each { absorption: [], exhaustion: [] } of { side ('buy' =
 * bullish - selling absorbed / exhausted at the low; 'sell' = bearish), price (the extreme's row), low, high (the zone),
 * volume (the aggression there), score, parts { name: 0 - 1 | null }, text }. `rowSize`: the footprint's rows;
 * `timeframe`: the bars' minutes (for the book); `columns`: the book's columns ({ t, bids, asks } as [price, quantity] -
 * optional); `levels`: prices that matter ([{ price, label }], or (barIndex) => those known AT that bar - a level
 * that moves, like VWAP, must be the bar's own; optional); `prior`: the previous session's bars of the same timeframe
 * (optional - without them the first bars of the day wait for three of today's). An estimated day's rows are a spread, not
 * trades: none are read (the candle rules stay).
 */
export function scoredFlowReads(bars, { rowSize, timeframe = 1, columns = null, levels = [], prior = null, icebergs = null, ...options } = {}) {
  const o = { ...FLOW_READ_DEFAULTS, ...options }
  // Yesterday's bars of the same timeframe by their clock: a bar's yardstick takes those within PRIOR_CLOCK_MS of its own
  // time of day (the open's heavy bars against yesterday's open, the lunch lull against yesterday's lunch).
  const priorByClock = (prior ?? []).filter((b) => b && b.volume > 0 && b.high > b.low).map((b) => ({ b, clock: clockOf(b.time) }))
  const priorNear = (t) => { const c = clockOf(t); return priorByClock.filter((x) => Math.abs(x.clock - c) <= PRIOR_CLOCK_MS).map((x) => x.b) }
  const step = rowSize > 0 ? rowSize : 0.05
  const list = bars ?? []
  const out = list.map(() => ({ absorption: [], exhaustion: [] }))
  const spanMs = Math.max(1, timeframe) * 60_000
  // Today's session so far: where it began, its swings, the last bar that made a new high / low of the structure.
  let day = null, sessionFrom = 0, swings = null, lastPush = { high: null, low: null }
  // The marks still waiting for the market's verdict (CONFIRMATION - what a trader waits for before acting on a read).
  let pending = []
  for (let i = 0; i < list.length; i++) {
    const bar = list[i]
    if (dayOf(bar.time) !== day) { day = dayOf(bar.time); sessionFrom = i; swings = swingTracker(); lastPush = { high: null, low: null }; pending = [] }
    pending = pending.filter((w) => !settle(w, bar))
    const rows = [...(bar.levels ?? [])].sort((a, b) => a.price - b.price)
    const range = bar.high - bar.low
    // The yardstick: every bar of today's session before this one, with yesterday's bars at this time of day - so it
    // reads from the open, and today's own bars weigh more as the day goes on.
    const before = [...priorNear(bar.time), ...list.slice(sessionFrom, i)]
    const usualRange = median(before.map((b) => b.high - b.low))
    const lv = swings.levels()
    const refHigh = structureRef(lv, true), refLow = structureRef(lv, false)
    const newHigh = refHigh != null && bar.high > refHigh.price
    const newLow = refLow != null && bar.low < refLow.price
    // Back at the structure's extreme without passing it: within a quarter of the swing size (at least a row).
    const tol = Math.max(step, (o.swingRanges * usualRange) / 4)
    if (rows.length >= 3 && bar.volume > 0 && range > 0 && before.length >= 3) {
      const typical = { sell: median(before.map((b) => b.sell ?? 0)), buy: median(before.map((b) => b.buy ?? 0)) }
      // Points a bar usually moves a lot of delta.
      const perDelta = median(before.map((b) => (Math.abs(b.delta) > 0 ? Math.abs(b.close - b.open) / Math.abs(b.delta) : 0)))
      const zoneRows = Math.max(2, Math.ceil(rows.length / 3))
      const known = (typeof levels === 'function' ? levels(i) : levels) ?? []
      const near = (price) => known.find((l) => Number.isFinite(l?.price) && Math.abs(l.price - price) <= o.nearRows * step + 1e-9)

      for (const bull of [true, false]) {
        const zone = bull ? rows.slice(0, zoneRows) : rows.slice(-zoneRows)
        const lo = zone[0].price, hi = zone.at(-1).price
        const hit = bull ? 'sell' : 'buy'           // the aggression that was absorbed
        const other = bull ? 'buy' : 'sell'
        let effort = 0, against = 0
        for (const l of zone) { effort += l[hit]; against += l[other] }
        const own = effort
        // The same prices in the bars before, back to the first bar that did not trade there: the fight at this price so
        // far - as long as it has lasted today, not a set number of bars.
        let fightBars = 0
        for (let j = i - 1; j >= sessionFrom; j--) {
          const b = list[j]
          if (!(b.low <= hi + 1e-9 && b.high >= lo - 1e-9)) break
          for (const l of b.levels ?? []) if (l.price >= lo - 1e-9 && l.price <= hi + 1e-9) { effort += l[hit]; against += l[other] }
          fightBars++
        }
        const typ = typical[hit]
        // This bar's own aggression there must be real (half a usual bar's whole selling, in the zone alone) and one-sided:
        // ordinary two-way trading at the bottom of a quiet bar, added up over three bars, is not an effort.
        if (!(typ > 0) || own < 0.5 * typ || effort < 1.5 * against) continue
        const closedOff = bull ? (bar.close - bar.low) / range : (bar.high - bar.close) / range
        const clear = bull ? bar.close > hi + step - 1e-9 : bar.close < lo + 1e-9   // closed beyond the zone
        if (!clear || closedOff < 0.3) continue
        const parts = { effort: clamp01(effort / (1.5 * typ)), result: clamp01(closedOff), efficiency: null, context: null, book: null }
        // The delta that did not move price: the aggressor ahead on the bar, yet it closed the other way - or moved little.
        const pushed = bull ? -bar.delta : bar.delta      // + = the absorbed side was ahead on the bar
        const went = bull ? bar.open - bar.close : bar.close - bar.open   // + = price went the aggressor's way
        if (pushed > 0) parts.efficiency = went <= 0 ? 1 : perDelta > 0 ? clamp01(1 - (went / pushed) / perDelta) : 0
        else parts.efficiency = 0
        const level = near(bull ? bar.low : bar.high)
        const fresh = bull ? newLow : newHigh
        const ref = bull ? refLow : refHigh
        const prev = i > sessionFrom ? list[i - 1] : null
        const pastPrev = prev && (bull ? bar.low < prev.low : bar.high > prev.high)
        // Back at the structure's extreme without passing it: a retest of the same price - the fight going on.
        const retest = !fresh && ref != null && (bull ? bar.low <= ref.price + tol + 1e-9 : bar.high >= ref.price - tol - 1e-9)
        parts.context = Math.min(1, (fresh ? 0.7 : retest ? 0.5 : pastPrev ? 0.35 : 0) + (level ? 0.5 : 0))
        const start = msOf(bar.time)
        const shown = bookAt(columns, start, start + spanMs, lo, hi, bull ? 'bids' : 'asks', step)
        if (shown && shown.most > 0) parts.book = 0.5 * clamp01(own / shown.most) + 0.5 * clamp01(shown.last / shown.most)
        // An ICEBERG the engine caught on the absorbing side in the zone during the bar (known by the bar's end): hidden size
        // refilling as it was hit - the strongest evidence of absorption there is.
        const berg = icebergAt(icebergs, start, start + spanMs, lo, hi, bull, step)
        if (berg) parts.book = 1
        const score = scoreOf(parts, ABSORPTION_WEIGHTS)
        if (parts.effort < 0.5 || score < o.minScore) continue
        const where = lo === hi ? `${lo}` : `${lo}–${round2(hi + step)}`
        const why = [
          `${Math.round((effort / typ) * 10) / 10}x a usual bar's ${bull ? 'selling' : 'buying'} at ${where}${fightBars ? ` over the last ${fightBars + 1} bars` : ''}`,
          `closed ${Math.round(closedOff * 100)}% off the ${bull ? 'low' : 'high'}`,
          parts.efficiency >= 0.7 ? `${bull ? 'sellers' : 'buyers'} ahead but price did not follow` : null,
          fresh ? `${breakText(ref, bull)}` : retest ? `a retest of the ${ref.name} ${ref.price}` : null,
          level ? `at ${level.label ?? level.price}` : null,
          berg ? `an iceberg ${bull ? 'bid' : 'offer'} at ${berg.price} (${berg.refills} refills)` : parts.book != null && parts.book >= 0.7 ? `the ${bull ? 'bids' : 'offers'} there held / refilled` : null,
        ].filter(Boolean).join(' · ')
        const mark = {
          side: bull ? 'buy' : 'sell', price: bull ? rows[0].price : rows.at(-1).price, low: lo, high: hi, volume: effort, score, parts,
          text: `${bull ? 'Selling absorbed' : 'Buying absorbed'} (score ${score}): ${why}`, status: 'pending', statusAt: null,
        }
        out[i].absorption.push(mark)
        // Wrong once price trades through the zone (the absorbing side gave way); right once a bar closes past the bar's
        // other end (price left the level and the aggressors are trapped).
        pending.push({ mark, bull, fail: bull ? lo : hi, confirm: bull ? bar.high : bar.low, failText: `traded through ${bull ? lo : hi}` })
      }

      for (const bear of [true, false]) {
        if (bear ? !newHigh : !newLow) continue
        const closedOff = bear ? (bar.high - bar.close) / range : (bar.close - bar.low) / range
        if (closedOff < 0.25) continue
        const push = bear ? lastPush.high : lastPush.low
        const typVolume = median(before.map((b) => b.volume))
        const typDelta = median(before.map((b) => Math.abs(b.delta)))
        const way = bear ? bar.delta : -bar.delta          // + = the delta that made the push
        const pushWay = push ? (bear ? push.delta : -push.delta) : null
        const parts = { volume: null, delta: null, thin: null, value: null, rejection: clamp01(closedOff / 0.6) }
        const againstVolume = push ? push.volume : typVolume
        parts.volume = againstVolume > 0 ? clamp01(1 - bar.volume / againstVolume) : null
        const againstDelta = push && pushWay > 0 ? pushWay : typDelta
        let delta = way <= 0 ? 1 : againstDelta > 0 ? clamp01(1 - way / againstDelta) : null
        // A higher high on a lower cumulative delta (the mirror at a low): the divergence itself.
        if (delta != null && push && Number.isFinite(bar.cvd) && Number.isFinite(push.cvd) && (bear ? bar.cvd < push.cvd : bar.cvd > push.cvd)) delta = Math.min(1, delta + 0.3)
        parts.delta = delta
        const end = bear ? rows.slice(-2) : rows.slice(0, 2)
        const endVolume = end.reduce((s, l) => s + l.buy + l.sell, 0)
        parts.thin = clamp01(1 - (endVolume / bar.volume) / (2 / rows.length))
        // A FINISHED AUCTION at the extreme - nothing at all bought at the top (0 offers lifted; sold at the bottom the
        // mirror): the buyers ran out there - the classic exhaustion print.
        const extremeRow = bear ? rows.at(-1) : rows[0]
        const finished = extremeRow && (bear ? extremeRow.buy === 0 : extremeRow.sell === 0) && extremeRow.buy + extremeRow.sell > 0
        if (finished) parts.thin = 1
        if (Number.isFinite(bar.poc)) {
          const lowerHalf = bear ? bar.poc < bar.low + range / 2 : bar.poc > bar.low + range / 2
          const stalled = push && Number.isFinite(push.poc) ? (bear ? bar.poc <= push.poc : bar.poc >= push.poc) : false
          parts.value = stalled ? 1 : lowerHalf ? 0.6 : 0
        }
        const score = scoreOf(parts, EXHAUSTION_WEIGHTS)
        if (score < o.minScore) continue
        const why = [
          breakText(bear ? refHigh : refLow, !bear),
          parts.volume >= 0.3 ? `${Math.round(parts.volume * 100)}% less volume than ${push ? 'the last push' : 'usual'}` : null,
          way <= 0 ? `no ${bear ? 'buying' : 'selling'} delta behind it` : parts.delta >= 0.3 ? `less ${bear ? 'buying' : 'selling'} delta than ${push ? 'the last push' : 'usual'}` : null,
          finished ? `a finished auction - nothing ${bear ? 'bought at the top' : 'sold at the bottom'}` : parts.thin >= 0.5 ? `little traded at the ${bear ? 'top' : 'bottom'}` : null,
          parts.value >= 0.6 ? 'the busiest price did not follow' : null,
          `closed ${Math.round(closedOff * 100)}% off it`,
        ].filter(Boolean).join(' · ')
        const mark = {
          side: bear ? 'sell' : 'buy', price: bear ? rows.at(-1).price : rows[0].price, score, parts,
          text: `${bear ? 'Buying exhausted' : 'Selling exhausted'} (score ${score}): ${why}`, status: 'pending', statusAt: null,
        }
        out[i].exhaustion.push(mark)
        // Wrong once a later bar makes a higher high (the push went on); right once a bar closes under the bar's low.
        pending.push({ mark, bull: !bear, fail: bear ? bar.high : bar.low, confirm: bear ? bar.low : bar.high, failText: `a new ${bear ? 'high' : 'low'} past ${bear ? bar.high : bar.low}` })
      }
    }
    // This bar is the push the next new extreme is compared with; then the swings take it in.
    if (newHigh) lastPush = { ...lastPush, high: bar }
    if (newLow) lastPush = { ...lastPush, low: bar }
    swings.add(bar, i, Math.max(2 * step, o.swingRanges * median([...before, bar].map((b) => b.high - b.low))))
  }
  return out
}

/** `bars` with their absorption / exhaustion replaced by the scored reads (`reads` - scoredFlowReads of the same bars). */
export function withScoredReads(bars, reads) {
  return (bars ?? []).map((bar, i) => ({ ...bar, absorption: reads?.[i]?.absorption ?? [], exhaustion: reads?.[i]?.exhaustion ?? [] }))
}

const READ_KINDS = ['absorption', 'exhaustion']
const readKey = (time, kind, side) => `${msOf(time)}|${kind}|${side}`

/**
 * A SHOWN READ NEVER VANISHES (asked for - "it gives signals, absorption / exhaustion, and then it just disappears if price
 * went in the opposite direction"): the reads are worked out again from the bars on every update, so a bar still forming -
 * or inputs that arrive or change later (the book, yesterday's bars) - could make a mark disappear after it was on screen.
 * `memory` (a Map the page keeps for a LIVE day - never a replay, which is worked out again at the clock) holds every read
 * that was ever produced for a bar (bar time, kind, side); a read that is no longer produced stays in `reads` as it was,
 * FAILED (faded, ✗) and said so in its text - the market took the read back, the trader still sees what was shown. Returns
 * `reads` with those added (new arrays; `reads` itself is not changed). Calling it again gives the same result.
 */
export function keepShownReads(memory, bars, reads) {
  const list = reads ?? []
  const index = new Map()
  ;(bars ?? []).forEach((bar, i) => index.set(msOf(bar.time), i))
  list.forEach((r, i) => {
    const bar = bars?.[i]
    if (!bar || !r) return
    for (const kind of READ_KINDS) for (const mark of r[kind] ?? []) memory.set(readKey(bar.time, kind, mark.side), mark)
  })
  const out = list.map((r) => ({ absorption: [...(r?.absorption ?? [])], exhaustion: [...(r?.exhaustion ?? [])] }))
  for (const [key, mark] of memory) {
    const [t, kind, side] = key.split('|')
    const i = index.get(Number(t))
    if (i == null || out[i][kind].some((m) => m.side === side)) continue
    const lastBar = bars[bars.length - 1]
    out[i][kind].push({
      ...mark,
      status: mark.status === 'pending' || mark.status == null ? 'failed' : mark.status,
      statusAt: mark.statusAt ?? lastBar?.time ?? null,
      kept: true,
      text: `${mark.text} · NO LONGER READ - it was shown, then the bar's read changed`,
    })
  }
  return out
}
