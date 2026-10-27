// The ATM straddle (the call + the put at the strike nearest spot) read through the day from a set time - 09:15 (the
// open) by default - for what the option market is pricing for the move and who is winning it:
//
//  - the priced range: the straddle at the start time around its strike. The straddle prices the move to EXPIRY (a short
//    straddle's breakevens) - days away on most days, far wider than one session - so by default (`scope: 'day'`) the
//    range is today's share of it: 0.8 x spot x ATM IV x sqrt(minutes left to 15:30 / (252 x 375)) (a straddle is worth
//    0.8 sigma), never more than the straddle; `scope: 'expiry'` (or no IV) keeps strike ± straddle. Spot beyond it =
//    the move is bigger than the market priced;
//  - the ATM straddle each minute, re-centred on the strike nearest spot every minute (so a move does not turn it into
//    a one-sided position), with its VWAP from the start time (weighted by the two legs' traded volume; the plain
//    average while no volume is known);
//  - after a move, re-centred and read again: the straddle taken at the start is shifted to the new ATM once spot has
//    moved `recentreStrikes` strikes from its strike (0 = never) - the range priced from there, and what that straddle
//    is worth now against what it was taken for;
//  - ATM IV (the two legs' average): the straddle loses value every minute by time decay alone - IV says whether it is
//    also being sold (IV falling) or bought (IV rising);
//  - the read at the clock, over the last `holdMinutes`:
//      sideways   - the straddle under its VWAP (80% of those minutes and now) and spot inside the priced range:
//                   option sellers in control;
//      building   - the straddle over its VWAP while spot is still inside: premium is being bought, a break may come;
//      trend      - spot beyond the range and the straddle over its VWAP: the move is bigger than priced;
//      breakout   - spot above the range with the straddle no longer falling: an index rally often LOWERS IV, so an
//                   upside break needs only that;
//      fake       - spot beyond the range but the straddle still falling under its VWAP: sellers are not worried, it
//                   is likely to come back (a real breakdown lifts the straddle - fear raises IV);
//      unconfirmed / none - the straddle crossing its VWAP.
//
// A minute uses only readings up to that minute (each option point holds its minute's close, as the page shows it, and
// a leg is read at its last reading within 5 minutes), and nothing after `asOfMs` - the replay clock.

const MIN = 60_000
const IST_MS = 330 * MIN
const STALE_MINUTES = 5
const HOLD_SHARE = 0.8
const IV_MOVE = 0.5

export const STRADDLE_START_DEFAULT = '09:15'

const minuteOf = (t) => Math.floor(new Date(t).getTime() / MIN) * MIN

/** `HH:mm` (IST) on the IST day of `dayMs`, as epoch ms; null for a time it cannot read. */
export function istClockOn(dayMs, hhmm) {
  const [h, m] = String(hhmm ?? '').split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  const ist = new Date(dayMs + IST_MS)
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST_MS
}

// Each strike's readings, one per minute (a later point of the same minute is the newer reading - live), in time order.
function legs(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !(p.price > 0)) continue
    const t = minuteOf(p.time)
    if (!Number.isFinite(t)) continue
    let minutes = byStrike.get(p.strike)
    if (!minutes) byStrike.set(p.strike, minutes = new Map())
    const prev = minutes.get(t)
    minutes.set(t, {
      t, price: p.price,
      volume: Math.max(p.volume ?? 0, prev?.volume ?? 0),
      iv: p.impliedVolatility > 0 ? p.impliedVolatility : prev?.iv ?? null,
    })
  }
  const out = new Map()
  for (const [strike, minutes] of byStrike) out.set(strike, [...minutes.values()].sort((a, b) => a.t - b.t))
  return out
}

// A leg's last reading at or before minute `t`, if it is at most STALE_MINUTES old.
function readingAt(rows, t) {
  if (!rows?.length) return null
  let lo = 0, hi = rows.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].t <= t) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (found < 0) return null
  return t - rows[found].t <= STALE_MINUTES * MIN ? rows[found] : null
}

function straddleAt(ce, pe, strike, t) {
  const c = readingAt(ce.get(strike), t)
  const p = readingAt(pe.get(strike), t)
  if (!c || !p) return null
  const ivs = [c.iv, p.iv].filter((v) => v > 0)
  return {
    strike, value: c.price + p.price, ce: c.price, pe: p.price,
    // Only a reading OF this minute traded in it.
    volume: (c.t === t ? c.volume : 0) + (p.t === t ? p.volume : 0),
    iv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
  }
}

// The straddle's worth of move left for today: 0.8 sigma (a straddle's value) at the ATM IV (% a year, 252 trading days
// of 375 minutes) over the minutes left to the close. Null without an IV.
const ANNUAL_MINUTES = 252 * 375
function dayMove(spot, iv, msLeft) {
  if (!(iv > 0) || !(spot > 0)) return null
  const vol = iv < 3 ? iv : iv / 100   // a fraction or a percent
  return Math.sqrt(2 / Math.PI) * spot * vol * Math.sqrt(Math.max(msLeft / MIN, 1) / ANNUAL_MINUTES)
}

function smallestGap(strikes) {
  let gap = Infinity
  for (let i = 1; i < strikes.length; i++) if (strikes[i] - strikes[i - 1] > 0) gap = Math.min(gap, strikes[i] - strikes[i - 1])
  return Number.isFinite(gap) ? gap : null
}

/**
 * The day's ATM straddle read, as of `asOfMs` (null = every minute given). `cePoints` / `pePoints`: the OI Replay run's
 * option points (strike, time, price, volume, impliedVolatility); `spotBars`: `[{ time (ms), close }]` one per minute.
 * Returns `{ startMs, series, anchors, day, now, position, breaks, control, belowShare, change, ivChange, held, verdict }` -
 * `series` one point per minute from the start time (`{ time, spot, strike, value, vwap, iv, anchorStrike, held, lower,
 * upper }`), `anchors` the start and every re-centre; null fields until there is a straddle to read.
 */
export function straddleRead(cePoints, pePoints, spotBars, {
  start = STRADDLE_START_DEFAULT, asOfMs = null, step = null, recentreStrikes = 1, holdMinutes = 15, scope = 'day',
} = {}) {
  const spots = (spotBars ?? []).filter((b) => b && b.close > 0)
    .map((b) => ({ t: minuteOf(b.time), spot: b.close })).filter((b) => Number.isFinite(b.t)).sort((a, b) => a.t - b.t)
  const empty = { startMs: null, series: [], anchors: [], day: null, now: null, position: null, breaks: { up: null, down: null }, control: null, belowShare: null, change: null, ivChange: null, held: null, verdict: null }
  if (!spots.length) return empty
  const startMs = istClockOn(spots[0].t, start)
  if (startMs == null) return empty
  const clock = asOfMs == null ? Infinity : minuteOf(asOfMs)
  const ce = legs(cePoints)
  const pe = legs(pePoints)
  const strikes = [...ce.keys()].filter((k) => pe.has(k)).sort((a, b) => a - b)
  const gap = step > 0 ? step : smallestGap(strikes)
  const closeMs = istClockOn(spots[0].t, '15:30')
  const byDistance = (spot) => strikes.slice().sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)

  const series = []
  const anchors = []
  let anchor = null
  let priceVolume = 0, volume = 0, sum = 0, count = 0
  for (const { t, spot } of spots) {
    if (t < startMs || t > clock) continue
    let atm = null
    for (const strike of byDistance(spot)) if ((atm = straddleAt(ce, pe, strike, t))) break
    if (!atm) continue
    count++; sum += atm.value; priceVolume += atm.value * atm.volume; volume += atm.volume
    const vwap = volume > 0 ? priceVolume / volume : sum / count
    // The straddle taken at the start, shifted to the new ATM once spot has moved `recentreStrikes` strikes from it.
    const moved = anchor && recentreStrikes > 0 && gap > 0 && Math.abs(atm.strike - anchor.strike) >= recentreStrikes * gap - 1e-9
    if (!anchor || moved) {
      const today = scope === 'day' ? dayMove(spot, atm.iv, closeMs - t) : null
      const width = today != null ? Math.min(today, atm.value) : atm.value
      anchor = { time: t, strike: atm.strike, value: atm.value, width, today, spot, iv: atm.iv, lower: atm.strike - width, upper: atm.strike + width }
      anchors.push(anchor)
    }
    const held = straddleAt(ce, pe, anchor.strike, t)
    series.push({
      time: t, spot, strike: atm.strike, value: atm.value, vwap, iv: atm.iv,
      anchorStrike: anchor.strike, held: held?.value ?? null, lower: anchor.lower, upper: anchor.upper,
    })
  }
  if (!series.length) return { ...empty, startMs }

  const first = anchors[0]
  const day = { ...first, pct: (first.width / first.spot) * 100 }
  const now = series.at(-1)
  const position = now.spot > day.upper ? 'above' : now.spot < day.lower ? 'below' : 'inside'
  const breaks = {
    up: series.find((p) => p.spot > day.upper)?.time ?? null,
    down: series.find((p) => p.spot < day.lower)?.time ?? null,
  }
  // The last `holdMinutes` minutes: how much of it the straddle spent under its VWAP, and how it and IV moved over it.
  const from = now.time - (holdMinutes - 1) * MIN
  const window = series.filter((p) => p.time >= from)
  const belowShare = window.filter((p) => p.value < p.vwap).length / window.length
  const enough = now.time - first.time >= (holdMinutes - 1) * MIN
  const control = !enough ? 'early'
    : belowShare >= HOLD_SHARE && now.value < now.vwap ? 'sellers'
      : 1 - belowShare >= HOLD_SHARE && now.value > now.vwap ? 'buyers' : 'mixed'
  const ago = [...series].reverse().find((p) => p.time <= now.time - holdMinutes * MIN) ?? series[0]
  const change = now.value - ago.value
  const ivChange = now.iv != null && ago.iv != null ? now.iv - ago.iv : null
  const current = anchors.at(-1)
  const held = anchors.length > 1 && now.held != null ? { ...current, now: now.held, sellerPnl: current.value - now.held } : null
  const verdict = readVerdict({ position, control, change, ivChange, holdMinutes, start })
  return { startMs, series, anchors, day, now, position, breaks, control, belowShare, change, ivChange, held, verdict }
}

function readVerdict({ position, control, change, ivChange, holdMinutes, start }) {
  const range = `the ${start} priced range`
  const side = position === 'above' ? 'up' : position === 'below' ? 'down' : null
  let verdict
  if (control === 'early') {
    verdict = { kind: 'early', side, title: 'Reading', detail: `Needs ${holdMinutes} minutes of the straddle from ${start}.` }
  } else if (position === 'inside') {
    verdict = control === 'sellers'
      ? { kind: 'sideways', side, title: 'Sideways', detail: `The straddle has stayed under its VWAP for the last ${holdMinutes} min and spot is inside ${range} - option sellers are in control: fade the edges, keep targets inside the range.` }
      : control === 'buyers'
        ? { kind: 'building', side, title: 'Premium being bought', detail: `The straddle is over its VWAP while spot is still inside ${range} - the move is being paid for; a break may be coming.` }
        : { kind: 'none', side, title: 'No clear read', detail: `The straddle is crossing its VWAP and spot is inside ${range}.` }
  } else if (control === 'buyers') {
    verdict = { kind: 'trend', side, title: side === 'up' ? 'Trend up' : 'Trend down', detail: `Spot is beyond ${range} and the straddle is over its VWAP - the move is bigger than priced: trade with it.` }
  } else if (control === 'sellers') {
    verdict = side === 'up' && change >= 0
      ? { kind: 'breakout', side, title: 'Breakout up', detail: `Spot is above ${range} and the straddle has stopped falling (an index rally often lowers IV) - likely real.` }
      : { kind: 'fake', side, title: side === 'up' ? 'Breakout not confirmed' : 'Breakdown not confirmed', detail: `Spot is ${side === 'up' ? 'above' : 'below'} ${range} but the straddle is still falling under its VWAP - sellers are not worried; likely back into the range.` }
  } else {
    verdict = { kind: 'unconfirmed', side, title: side === 'up' ? 'Breakout - wait' : 'Breakdown - wait', detail: `Spot is ${side === 'up' ? 'above' : 'below'} ${range}, the straddle crossing its VWAP - it holding over the VWAP confirms the move, under it says fake.` }
  }
  // IV takes time decay out of the read.
  if (ivChange != null && control === 'sellers' && ivChange >= IV_MOVE) verdict.note = `ATM IV is up ${ivChange.toFixed(1)} in ${holdMinutes} min - the straddle's fall is time decay, not selling.`
  if (ivChange != null && control === 'buyers' && ivChange <= -IV_MOVE) verdict.note = `ATM IV is down ${(-ivChange).toFixed(1)} in ${holdMinutes} min - the straddle's rise is the spot's move, not premium buying.`
  return verdict
}
