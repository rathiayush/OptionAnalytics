// The ATM straddle (the call + the put at the strike nearest spot) read through the day from a set time - 09:21 by
// default, after the opening minutes settle. The straddle is what the option market charges for the move, so:
//
//  - a RANGE is the straddle's strike ± the move the market priced from there. The straddle itself prices the move to
//    EXPIRY (a short straddle's breakevens) - days away on most days, far wider than one session. So by default
//    (`scope: 'day'`) the range is the part of it left for TODAY: the straddle at the ATM IV over the minutes left to
//    15:30 - 0.8 x spot x IV x sqrt(minutes left / (252 x 375)) (a straddle is worth 0.8 sigma), never more than the
//    straddle. `scope: 'expiry'` (or no IV) keeps the straddle's own breakevens. The first range starts at the start time;
//  - spot closing outside the range is a BREAK. A break the market accepts - spot still outside after `acceptMinutes`
//    (0 = never) - starts a NEW RANGE around the ATM at that minute: the move is done, the question is asked again from
//    the new level (sideways there, or the trend going on). A break that comes back inside first is a FAILED break and
//    the range stays. Moves inside a range never move it, so its edges stay put to be faded;
//  - the ATM straddle each minute (re-centred on the strike nearest spot every minute, so a move does not count as
//    premium) against its VWAP since the range started. A straddle loses value every minute by time decay alone, so the
//    raw line falls all day and sits under its VWAP almost always - read like that it says "sellers" on every day. By
//    default (`decay: 'removed'`) the line read is the straddle with time decay taken out: the range start's straddle
//    moved by the ATM IV and spot since then (a straddle is worth 0.8 x spot x IV x sqrt(time left), so at the start's
//    time left it is start value x spot x IV / (start spot x start IV)) - it falls only when the options are SOLD (IV
//    falling) and rises when they are bought, and a switch of the ATM strike does not make it jump. `decay: 'raw'` (or no
//    IV at the range start) reads the plain straddle (weighted by the two legs' traded volume; the plain average
//    while no volume is known): under it = premium being sold, over it = premium being bought;
//  - the CENTRE straddle (the range's own strike all along): below its value at the range start = a seller there is
//    ahead = the market has moved less than priced;
//  - ATM IV (the two legs' average): the straddle loses value every minute by time decay alone - IV says whether it is
//    also being sold (IV falling) or bought (IV rising).
//
// SIDEWAYS needs all three over the last `holdMinutes`: spot inside the range, the ATM straddle under its VWAP (80% of
// those minutes and now), and the centre straddle below its start value. The other reads:
//      drift       - premium falling but spot drifting off the centre (the centre straddle above its start value);
//      building    - inside, the ATM straddle over its VWAP: the move is being paid for, a break may come;
//      trend       - outside, the straddle over its VWAP: the move is bigger than priced;
//      breakout    - above the range with the straddle no longer falling (an index rally often LOWERS IV);
//      fake        - outside but the straddle still falling under its VWAP: likely back (a real breakdown lifts the
//                    straddle - fear raises IV);
//      new-range   - just re-centred after an accepted break, read for `holdMinutes` before a verdict;
//      unconfirmed / none - the straddle crossing its VWAP.
//
// A minute uses only readings up to that minute (each option point holds its minute's close, as the page shows it, and
// a leg is read at its last reading within 5 minutes), and nothing after `asOfMs` - the replay clock.

const MIN = 60_000
const IST_MS = 330 * MIN
const STALE_MINUTES = 5
const HOLD_SHARE = 0.8
const IV_MOVE = 0.5

export const STRADDLE_START_DEFAULT = '09:21'

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

/** HH:mm in IST. */
export const istHhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)
const pts = (v) => (Number.isFinite(v) ? v.toFixed(0) : '-')

/**
 * The day's ATM straddle read, as of `asOfMs` (null = every minute given). `cePoints` / `pePoints`: the OI Replay run's
 * option points (strike, time, price, volume, impliedVolatility); `spotBars`: `[{ time (ms), close }]` one per minute.
 * `decay`: 'removed' (default) reads the straddle with time decay taken out, 'raw' the plain straddle (see the top).
 * Returns `{ startMs, series, ranges, day, dayBreaks, range, now, position, control, belowShare, change, ivChange, centre,
 * checks, outsideFor, failed, verdict }` - `series` one point per minute from the start time (`{ time, spot, strike,
 * value (the plain straddle), read (the line read: decay taken out, or the plain straddle), decayRemoved, vwap (of read), iv, rangeIndex, centre, lower, upper }`), `ranges` the start's range and every accepted move's; the read
 * fields are null until there is a straddle to read.
 */
export function straddleRead(cePoints, pePoints, spotBars, {
  start = STRADDLE_START_DEFAULT, asOfMs = null, acceptMinutes = 10, holdMinutes = 15, scope = 'day', decay = 'removed',
} = {}) {
  const spots = (spotBars ?? []).filter((b) => b && b.close > 0)
    .map((b) => ({ t: minuteOf(b.time), spot: b.close })).filter((b) => Number.isFinite(b.t)).sort((a, b) => a.t - b.t)
  const empty = {
    startMs: null, series: [], ranges: [], day: null, dayBreaks: { up: null, down: null }, range: null, now: null, position: null,
    control: null, belowShare: null, change: null, ivChange: null, centre: null, checks: null, outsideFor: null, failed: null, verdict: null,
  }
  if (!spots.length) return empty
  const startMs = istClockOn(spots[0].t, start)
  if (startMs == null) return empty
  const clock = asOfMs == null ? Infinity : minuteOf(asOfMs)
  const ce = legs(cePoints)
  const pe = legs(pePoints)
  const strikes = [...ce.keys()].filter((k) => pe.has(k)).sort((a, b) => a - b)
  const byDistance = (spot) => strikes.slice().sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)
  const closeMs = istClockOn(spots[0].t, '15:30')

  const series = []
  const ranges = []
  let range = null
  let outside = null   // the break in progress: { side, from, to, accepted }
  let priceVolume = 0, volume = 0, sum = 0, count = 0
  let lastIv = null   // the ATM IV last read in this range - a minute without one keeps it
  for (const { t, spot } of spots) {
    if (t < startMs || t > clock) continue
    let atm = null
    for (const strike of byDistance(spot)) if ((atm = straddleAt(ce, pe, strike, t))) break
    if (!atm) continue
    let reason = 'start'
    if (range) {
      const side = spot > range.upper ? 'up' : spot < range.lower ? 'down' : null
      if (side !== (outside?.side ?? null)) {
        if (outside) outside.to = t   // back inside (a failed break), or straight through to the other side
        outside = side ? { side, from: t, to: null, accepted: null } : null
        if (outside) range.breaks.push(outside)
      }
      // Still outside after acceptMinutes: the market accepted the move - a new range around the ATM from here.
      if (outside && acceptMinutes > 0 && t - outside.from >= (acceptMinutes - 1) * MIN) {
        outside.accepted = t
        reason = outside.side
        range = null
        outside = null
      }
    }
    if (!range) {
      const today = scope === 'day' ? dayMove(spot, atm.iv, closeMs - t) : null
      const width = today != null ? Math.min(today, atm.value) : atm.value
      range = { time: t, strike: atm.strike, value: atm.value, width, today, spot, iv: atm.iv, lower: atm.strike - width, upper: atm.strike + width, reason, breaks: [] }
      ranges.push(range)
      range.decayRemoved = decay === 'removed' && range.iv > 0
      priceVolume = 0; volume = 0; sum = 0; count = 0
      lastIv = null
    }
    if (atm.iv > 0) lastIv = atm.iv
    // The line read against its VWAP: the straddle with time decay taken out (see the top), else the plain straddle.
    const read = range.decayRemoved ? range.value * (spot * lastIv) / (range.spot * range.iv) : atm.value
    count++; sum += read; priceVolume += read * atm.volume; volume += atm.volume
    const centre = straddleAt(ce, pe, range.strike, t)
    series.push({
      time: t, spot, strike: atm.strike, value: atm.value, read, decayRemoved: range.decayRemoved,
      vwap: volume > 0 ? priceVolume / volume : sum / count, iv: atm.iv,
      rangeIndex: ranges.length - 1, centre: centre?.value ?? null, lower: range.lower, upper: range.upper,
    })
  }
  if (!series.length) return { ...empty, startMs }

  const first = ranges[0]
  const day = { ...first, pct: (first.width / first.spot) * 100 }
  const dayBreaks = { up: series.find((p) => p.spot > day.upper)?.time ?? null, down: series.find((p) => p.spot < day.lower)?.time ?? null }
  const current = ranges.at(-1)
  const now = series.at(-1)
  const position = now.spot > current.upper ? 'above' : now.spot < current.lower ? 'below' : 'inside'
  // The last `holdMinutes` of this range: how much of it the straddle spent under its VWAP, and how it and IV moved.
  const own = series.filter((p) => p.time >= current.time)
  const window = own.filter((p) => p.time > now.time - holdMinutes * MIN)
  const belowShare = window.filter((p) => p.read < p.vwap).length / window.length
  const enough = now.time - current.time >= (holdMinutes - 1) * MIN
  const control = !enough ? 'early'
    : belowShare >= HOLD_SHARE && now.read < now.vwap ? 'sellers'
      : 1 - belowShare >= HOLD_SHARE && now.read > now.vwap ? 'buyers' : 'mixed'
  const ago = [...own].reverse().find((p) => p.time <= now.time - holdMinutes * MIN) ?? own[0]
  const change = now.read - ago.read
  const ivChange = now.iv != null && ago.iv != null ? now.iv - ago.iv : null
  const centre = { strike: current.strike, time: current.time, value: current.value, now: now.centre, sellerPnl: now.centre != null ? current.value - now.centre : null }
  const checks = {
    inside: position === 'inside',
    premiumFalling: enough ? control === 'sellers' : null,
    centreBelowStart: centre.sellerPnl == null ? null : centre.sellerPnl > 0,
    ivSteady: ivChange == null ? null : ivChange < IV_MOVE,
  }
  const lastBreak = current.breaks.at(-1) ?? null
  const outsideFor = lastBreak && lastBreak.to == null ? (now.time - lastBreak.from) / MIN + 1 : null
  const failed = lastBreak && lastBreak.to != null ? lastBreak : null
  const verdict = readVerdict({ range: current, now, position, control, change, ivChange, checks, holdMinutes, acceptMinutes, outsideFor, failed })
  return { startMs, series, ranges, day, dayBreaks, range: current, now, position, control, belowShare, change, ivChange, centre, checks, outsideFor, failed, verdict }
}

function readVerdict({ range, now, position, control, change, ivChange, checks, holdMinutes, acceptMinutes, outsideFor, failed }) {
  const edges = `${pts(range.lower)} – ${pts(range.upper)}`
  const name = range.reason === 'start' ? `the ${istHhmm(range.time)} range (${edges})` : `the new range from ${istHhmm(range.time)} (${edges})`
  const side = position === 'above' ? 'up' : position === 'below' ? 'down' : null
  let verdict
  if (control === 'early' && position === 'inside') {
    verdict = range.reason === 'start'
      ? { kind: 'early', side: null, title: 'Reading', detail: `Needs ${holdMinutes} minutes of the straddle from ${istHhmm(range.time)}.` }
      : { kind: 'new-range', side: range.reason, title: 'New range', detail: `Spot held ${range.reason === 'up' ? 'above' : 'below'} the last range for ${acceptMinutes} min - the move was accepted, so the range is re-centred on ${range.strike} at ${istHhmm(range.time)}: ${edges}. Reading it for ${holdMinutes} min: the straddle falling under its VWAP here = sideways at the new level; spot leaving it = the trend goes on.` }
  } else if (position === 'inside') {
    if (checks.premiumFalling && checks.centreBelowStart) {
      verdict = { kind: 'sideways', side: null, title: 'Sideways', detail: `Spot inside ${name}, the ATM straddle under its VWAP for the last ${holdMinutes} min and the ${range.strike} straddle below its ${istHhmm(range.time)} value - option sellers are in control: fade the edges, keep targets inside the range.` }
    } else if (checks.premiumFalling) {
      const drift = now.spot >= range.strike ? 'up' : 'down'
      verdict = { kind: 'drift', side: drift, title: 'Range, drifting', detail: `Premium is still falling, but spot has drifted ${now.spot >= range.strike ? '+' : '−'}${pts(Math.abs(now.spot - range.strike))} from ${range.strike} and the ${range.strike} straddle is above its ${istHhmm(range.time)} value - sellers at the centre are losing. Still a range; watch the ${drift === 'up' ? 'upper' : 'lower'} edge (${pts(drift === 'up' ? range.upper : range.lower)}).` }
    } else if (control === 'buyers') {
      verdict = { kind: 'building', side: null, title: 'Premium being bought', detail: `Spot inside ${name} but the ATM straddle is over its VWAP - the move is being paid for; a break may come.` }
    } else {
      verdict = { kind: 'none', side: null, title: 'No clear read', detail: `Spot inside ${name}, the straddle crossing its VWAP.` }
    }
  } else {
    const where = `${outsideFor} min ${side === 'up' ? 'above' : 'below'} ${name}${acceptMinutes > 0 ? ` (a new range if it holds ${acceptMinutes} min)` : ''}`
    if (control === 'buyers') {
      verdict = { kind: 'trend', side, title: side === 'up' ? 'Trend up' : 'Trend down', detail: `Spot ${where}, the ATM straddle over its VWAP - the move is bigger than priced: trade with it.` }
    } else if (control === 'sellers' && side === 'up' && change >= 0) {
      verdict = { kind: 'breakout', side, title: 'Breakout up', detail: `Spot ${where}; the straddle has stopped falling (an index rally often lowers IV) - likely real.` }
    } else if (control === 'sellers') {
      verdict = { kind: 'fake', side, title: side === 'up' ? 'Breakout not confirmed' : 'Breakdown not confirmed', detail: `Spot ${where}, but the straddle is still falling under its VWAP - sellers are not worried; likely back into the range.` }
    } else {
      verdict = { kind: 'unconfirmed', side, title: side === 'up' ? 'Breakout - wait' : 'Breakdown - wait', detail: `Spot ${where}, the straddle crossing its VWAP - it holding over the VWAP confirms the move, under it says fake.` }
    }
  }
  const notes = []
  if (position === 'inside' && failed) notes.push(`Back inside after a failed break ${failed.side} (${istHhmm(failed.from)} – ${istHhmm(failed.to)}): the move was not accepted.`)
  // IV takes time decay out of the read.
  // (Only for the plain straddle: with time decay taken out the line already moves with IV.)
  if (!now.decayRemoved && ivChange != null && control === 'sellers' && ivChange >= IV_MOVE) notes.push(`ATM IV is up ${ivChange.toFixed(1)} in ${holdMinutes} min - the straddle's fall is time decay, not selling; a break may be coming.`)
  if (!now.decayRemoved && ivChange != null && control === 'buyers' && ivChange <= -IV_MOVE) notes.push(`ATM IV is down ${(-ivChange).toFixed(1)} in ${holdMinutes} min - the straddle's rise is the spot's move, not premium buying.`)
  return { ...verdict, notes }
}
