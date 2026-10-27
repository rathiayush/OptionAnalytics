// The ATM straddle (the call + the put at the strike nearest spot) read through the day from a set time - 09:15 (the
// open) by default - for what the option market is pricing for the move and who is winning it:
//
//  - the priced range: the straddle at the start time around its strike. The straddle prices the move to EXPIRY (a short
//    straddle's breakevens) - days away on most days, far wider than one session - so by default (`scope: 'day'`) the
//    range is today's share of it: straddle x sqrt(trading minutes left today / trading minutes left to 15:30 on the
//    expiry day) - a straddle grows with the square root of the time it covers (on expiry day: the straddle).
//    `scope: 'expiry'` keeps strike ± straddle. Spot beyond it = the move is bigger than the market priced;
//  - TIME DECAY: every straddle loses value each minute by time alone, so the Auto ATM line falls on a quiet day and sits
//    under its VWAP. The DECAY-ONLY line shows that fall: the start's straddle as it would be with only time passing
//    (and the futures level moving - IV unchanged): start straddle x (futures / start futures) x sqrt(trading minutes left
//    to expiry / those at the start). The Auto ATM over it = premium bought beyond the decay (IV up), under it = sold
//    faster than the decay (IV down); the gap is exactly the IV change since the start. Needs the expiry date;
//  - everything is read from the option PRICES and the expiry date alone - no futures data, and not the IV a data feed
//    sends (Dhan's past-day IV and the live chain's are different sources and can be missing): the ATM by the synthetic
//    futures, the IV from the ATM straddle itself (straddle = 0.8 x futures x IV x sqrt(time left)) - so a past day
//    replayed and today live are worked out the same way. Without an expiry date the range falls back to the feed's IV
//    (0.8 x spot x IV x sqrt(minutes left today / (252 x 375))), then to the straddle;
//  - the two straddle charts the option tools draw (Sensibull: "Auto ATM" and a fixed strike), each with the VWAP of its
//    combined premium from the start time (weighted by the two legs' traded volume; the plain average while no volume
//    is known):
//      AUTO ATM - the straddle of the ATM strike, switching to the new ATM from the minute it changes. The ATM is the
//                 strike nearest the expiry's FUTURES price - for a weekly, which has no futures, the synthetic one from
//                 the chain itself (put-call parity: strike + call - put, the median over the 3 strikes nearest spot), as
//                 Sensibull does; nearest spot when that cannot be told. Not moved by spot's moves, so it reads premium:
//                 under its VWAP = being sold (melting), over it = being bought (expanding);
//      FIXED    - one strike all day, never shifted: the ATM at the start time, or the strike asked for (`fixedStrike`).
//                 The straddle a seller holds - its value against what it was sold for is the seller's P&L, and against
//                 its own VWAP whether its sellers are winning. Shifting it is the trader's adjustment, not the chart's;
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
const SESSION_MINUTES = 375
const DAY_MS = 86_400_000
const STRADDLE_SIGMA = Math.sqrt(2 / Math.PI)   // an at-the-money straddle is worth 0.8 sigma

// Trading minutes from minute `t` to 15:30 IST on `expiry` (YYYY-MM-DD): what is left of today's session (`closeMs` -
// today's 15:30) plus a session for every weekday after today up to the expiry day (holidays in between are not known
// here); null without a date or past it.
function minutesToExpiry(t, expiry, closeMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expiry ?? ''))
  if (!m) return null
  const expiryDay = Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS
  const today = Math.floor((t + IST_MS) / DAY_MS)
  if (expiryDay < today) return null
  let minutes = Math.max((closeMs - t) / MIN, 1)
  for (let d = today + 1; d <= expiryDay; d++) {
    const weekday = new Date(d * DAY_MS).getUTCDay()
    if (weekday !== 0 && weekday !== 6) minutes += SESSION_MINUTES
  }
  return minutes
}

function dayMove(spot, iv, msLeft) {
  if (!(iv > 0) || !(spot > 0)) return null
  const vol = iv < 3 ? iv : iv / 100   // a fraction or a percent
  return Math.sqrt(2 / Math.PI) * spot * vol * Math.sqrt(Math.max(msLeft / MIN, 1) / ANNUAL_MINUTES)
}

// The ATM straddle at minute `t`: the strike nearest the synthetic futures price of the expiry (strike + call - put - put-call
// parity - the median over the 3 strikes nearest spot with both legs), as the option tools pick it; `forward` is that price.
function atmAt(ce, pe, strikes, spot, t) {
  const byDistance = (x) => strikes.slice().sort((a, b) => Math.abs(a - x) - Math.abs(b - x) || a - b)
  const quotes = []
  for (const strike of byDistance(spot)) {
    const q = straddleAt(ce, pe, strike, t)
    if (q && quotes.push(q) >= 3) break
  }
  if (!quotes.length) return null
  const forwards = quotes.map((q) => q.strike + q.ce - q.pe).sort((a, b) => a - b)
  const mid = forwards.length >> 1
  const forward = forwards.length % 2 ? forwards[mid] : (forwards[mid - 1] + forwards[mid]) / 2
  for (const strike of byDistance(forward)) {
    const q = straddleAt(ce, pe, strike, t)
    if (q) return { ...q, forward }
  }
  return null
}

/**
 * The day's straddle read, as of `asOfMs` (null = every minute given). `cePoints` / `pePoints`: the OI Replay run's option
 * points (strike, time, price, volume, impliedVolatility); `spotBars`: `[{ time (ms), close }]` one per minute.
 * `expiry` (YYYY-MM-DD) is the options' expiry date - the range and the IV come from the straddle with it (see the top).
 * Returns `{ startMs, series, day, now, fixed, fixedChoices, position, breaks, control, belowShare, change, ivChange,
 * ivFrom, verdict }` - `series` one point per minute from the start time (`{ time, spot, forward, strike, value, vwap, iv, fixed,
 * fixedVwap }`: the Auto ATM straddle and the fixed one), `day` the start's ATM straddle and the range it priced, `fixed`
 * the fixed straddle (`{ strike, time, entry, now, vwap, sellerPnl }`), `fixedChoices` the strikes it can be (both legs
 * quoted at the start); null fields until there is a straddle to read.
 */
export function straddleRead(cePoints, pePoints, spotBars, {
  start = STRADDLE_START_DEFAULT, asOfMs = null, fixedStrike = null, holdMinutes = 15, scope = 'day', expiry = null,
} = {}) {
  const spots = (spotBars ?? []).filter((b) => b && b.close > 0)
    .map((b) => ({ t: minuteOf(b.time), spot: b.close })).filter((b) => Number.isFinite(b.t)).sort((a, b) => a.t - b.t)
  const empty = {
    startMs: null, series: [], day: null, now: null, fixed: null, fixedChoices: [], position: null, breaks: { up: null, down: null },
    control: null, belowShare: null, change: null, ivChange: null, verdict: null,
  }
  if (!spots.length) return empty
  const startMs = istClockOn(spots[0].t, start)
  if (startMs == null) return empty
  const clock = asOfMs == null ? Infinity : minuteOf(asOfMs)
  const ce = legs(cePoints)
  const pe = legs(pePoints)
  const strikes = [...ce.keys()].filter((k) => pe.has(k)).sort((a, b) => a - b)
  const closeMs = istClockOn(spots[0].t, '15:30')
  // The ATM IV: from the ATM straddle itself when the expiry is known (straddle = 0.8 x futures x IV x sqrt(time left), in
  // trading time) - the same on a past day and live; else the feed's.
  const ivFrom = minutesToExpiry(Math.max(startMs, spots[0].t), expiry, closeMs) != null ? 'straddle' : 'feed'
  const ivOf = (atm, t) => {
    const toExpiry = minutesToExpiry(t, expiry, closeMs)
    if (toExpiry == null) return atm.iv
    return (atm.value / (STRADDLE_SIGMA * atm.forward * Math.sqrt(toExpiry / ANNUAL_MINUTES))) * 100
  }

  const series = []
  let first = null
  let fixedAt = null
  let fixedChoices = []
  const atmVwap = { pv: 0, volume: 0, sum: 0, count: 0 }
  const fixedVwap = { pv: 0, volume: 0, sum: 0, count: 0 }
  const add = (acc, q) => { acc.count++; acc.sum += q.value; acc.pv += q.value * q.volume; acc.volume += q.volume }
  const vwapOf = (acc) => (acc.count ? (acc.volume > 0 ? acc.pv / acc.volume : acc.sum / acc.count) : null)
  for (const { t, spot } of spots) {
    if (t < startMs || t > clock) continue
    const atm = atmAt(ce, pe, strikes, spot, t)
    if (!atm) continue
    if (!first) {
      // The start: the ATM straddle prices the range; the fixed straddle is taken (the strike asked for, else this ATM).
      const toExpiry = minutesToExpiry(t, expiry, closeMs)
      const today = scope !== 'day' ? null
        : toExpiry != null ? atm.value * Math.sqrt(Math.max((closeMs - t) / MIN, 1) / toExpiry)
          : dayMove(spot, atm.iv, closeMs - t)
      const width = today != null ? Math.min(today, atm.value) : atm.value
      const basis = today == null ? null : toExpiry != null ? 'expiry' : 'iv'
      first = {
        time: t, strike: atm.strike, value: atm.value, width, today, basis, sessions: toExpiry != null ? toExpiry / SESSION_MINUTES : null,
        spot, forward: atm.forward, iv: ivOf(atm, t), lower: atm.strike - width, upper: atm.strike + width, toExpiry,
      }
      fixedChoices = strikes.filter((k) => straddleAt(ce, pe, k, t))
      const taken = (fixedStrike != null && fixedChoices.includes(fixedStrike) ? straddleAt(ce, pe, fixedStrike, t) : null) ?? atm
      fixedAt = { strike: taken.strike, time: t, entry: taken.value }
    }
    add(atmVwap, atm)
    const fixed = straddleAt(ce, pe, fixedAt.strike, t)
    if (fixed) add(fixedVwap, fixed)
    // The start's straddle with only time passing (IV unchanged; the futures level as now).
    const left = first.toExpiry != null ? minutesToExpiry(t, expiry, closeMs) : null
    const decay = left != null ? first.value * (atm.forward / first.forward) * Math.sqrt(left / first.toExpiry) : null
    series.push({
      time: t, spot, forward: atm.forward, strike: atm.strike, value: atm.value, vwap: vwapOf(atmVwap), iv: ivOf(atm, t), decay,
      fixed: fixed?.value ?? null, fixedVwap: fixed ? vwapOf(fixedVwap) : null,
    })
  }
  if (!series.length) return { ...empty, startMs }

  const day = { ...first, pct: (first.width / first.spot) * 100 }
  const now = series.at(-1)
  const lastFixed = [...series].reverse().find((p) => p.fixed != null)
  const fixed = {
    ...fixedAt, now: lastFixed?.fixed ?? null, vwap: lastFixed?.fixedVwap ?? null,
    sellerPnl: lastFixed ? fixedAt.entry - lastFixed.fixed : null, asked: fixedStrike != null && fixedStrike === fixedAt.strike,
  }
  const position = now.spot > day.upper ? 'above' : now.spot < day.lower ? 'below' : 'inside'
  const breaks = {
    up: series.find((p) => p.spot > day.upper)?.time ?? null,
    down: series.find((p) => p.spot < day.lower)?.time ?? null,
  }
  // The last `holdMinutes` minutes: how much of it the Auto ATM straddle spent under its VWAP, and how it and IV moved.
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
  const vsDecay = now.decay != null ? now.value - now.decay : null
  const verdict = readVerdict({ position, control, change, ivChange, holdMinutes, start, vsDecay })
  return { vsDecay, startMs, series, day, now, fixed, fixedChoices, position, breaks, control, belowShare, change, ivChange, ivFrom, verdict }
}

function readVerdict({ position, control, change, ivChange, holdMinutes, start, vsDecay = null }) {
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
  // Time decay taken out of the read: the decay-only line (the whole day), else IV over the window.
  if (vsDecay != null && control === 'sellers' && vsDecay >= 0) verdict.note = `The straddle is under its VWAP but not under its decay-only line (${vsDecay >= 0 ? '+' : ''}${vsDecay.toFixed(1)}) - its fall is time decay, not selling.`
  else if (ivChange != null && control === 'sellers' && ivChange >= IV_MOVE) verdict.note = `ATM IV is up ${ivChange.toFixed(1)} in ${holdMinutes} min - the straddle's fall is time decay, not selling.`
  if (ivChange != null && control === 'buyers' && ivChange <= -IV_MOVE) verdict.note = `ATM IV is down ${(-ivChange).toFixed(1)} in ${holdMinutes} min - the straddle's rise is the spot's move, not premium buying.`
  return verdict
}
