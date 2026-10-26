// The ATM straddle (the call + the put at the strike nearest spot) from a set time - 09:21 by default, after the
// opening minutes settle - drawn as ONE LINE PER STRIKE, never stitched into one line.
//
// One line that jumps to the new ATM strike every time spot moves reads as falling all day: the strike nearest spot is
// always the cheapest straddle on the chain, so each jump throws away the move (the old strike's straddle growing as
// spot leaves it) and keeps only the decay. So here the straddle of the ATM strike at the start time is a line; when
// spot moves and another strike becomes the ATM, that strike's straddle starts a NEW line from that minute, and the old
// line keeps going - it rising while spot runs away from it is the move, it falling while spot sits at it is premium
// being sold (and time decay, which a seller there earns too). A strike that becomes the ATM again goes on in its own
// line. A new strike takes over only once spot is `switchBuffer` of a strike step past the midpoint between the two
// strikes, so spot hovering at the midpoint does not flip the ATM every minute.
//
// A minute uses only readings up to that minute (each option point holds its minute's close, as the page shows it, and
// a leg is read at its last reading within 5 minutes), and nothing after `asOfMs` - the replay clock.

const MIN = 60_000
const IST_MS = 330 * MIN
const STALE_MINUTES = 5

export const STRADDLE_START_DEFAULT = '09:21'
export const STRADDLE_MAX_LINES = 6

const minuteOf = (t) => Math.floor(new Date(t).getTime() / MIN) * MIN

/** `HH:mm` (IST) on the IST day of `dayMs`, as epoch ms; null for a time it cannot read. */
export function istClockOn(dayMs, hhmm) {
  const [h, m] = String(hhmm ?? '').split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  const ist = new Date(dayMs + IST_MS)
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST_MS
}

/** HH:mm in IST. */
export const istHhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)

// Each strike's readings, one per minute (a later point of the same minute is the newer reading - live), in time order.
function legs(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !(p.price > 0)) continue
    const t = minuteOf(p.time)
    if (!Number.isFinite(t)) continue
    let minutes = byStrike.get(p.strike)
    if (!minutes) byStrike.set(p.strike, minutes = new Map())
    minutes.set(t, { t, price: p.price })
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
  return c && p ? c.price + p.price : null
}

/**
 * The day's ATM straddle, one line per strike, as of `asOfMs` (null = every minute given). `cePoints` / `pePoints`: the
 * OI Replay run's option points (strike, time, price); `spotBars`: `[{ time (ms), close }]` one per minute.
 * Returns `{ startMs, lines, hidden, shifts, now }`:
 *  - `lines`: the strikes that were the ATM, in the order they first were - at most `maxLines` (the ones ATM most
 *    recently; the ATM now always among them), `hidden` the rest. Each `{ strike, order, from, until, atmNow, start,
 *    value, change, high, low, data: [{ time, value }] }` - from the minute it first became the ATM to the clock;
 *    `order` its place among every line (for a colour that stays the strike's);
 *  - `shifts`: each change of the ATM `{ time, from, to, spot }`;
 *  - `now`: `{ time, spot, strike, value }` the last minute read - null until there is a straddle.
 */
export function straddleLines(cePoints, pePoints, spotBars, {
  start = STRADDLE_START_DEFAULT, asOfMs = null, maxLines = STRADDLE_MAX_LINES, switchBuffer = 0.1,
} = {}) {
  const spots = (spotBars ?? []).filter((b) => b && b.close > 0)
    .map((b) => ({ t: minuteOf(b.time), spot: b.close })).filter((b) => Number.isFinite(b.t)).sort((a, b) => a.t - b.t)
  const empty = { startMs: null, lines: [], hidden: 0, shifts: [], now: null }
  if (!spots.length) return empty
  const startMs = istClockOn(spots[0].t, start)
  if (startMs == null) return empty
  const clock = asOfMs == null ? Infinity : minuteOf(asOfMs)
  const ce = legs(cePoints)
  const pe = legs(pePoints)
  const strikes = [...ce.keys()].filter((k) => pe.has(k)).sort((a, b) => a - b)
  const steps = strikes.slice(1).map((k, i) => k - strikes[i]).filter((d) => d > 0)
  const step = steps.length ? Math.min(...steps) : 0
  const byDistance = (spot) => strikes.slice().sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)

  const lines = new Map()   // strike -> line
  const shifts = []
  let atm = null
  let now = null
  for (const { t, spot } of spots) {
    if (t < startMs || t > clock) continue
    // The nearest strike with both legs read this minute...
    let nearest = null, nearestValue = null
    for (const strike of byDistance(spot)) {
      const value = straddleAt(ce, pe, strike, t)
      if (value != null) { nearest = strike; nearestValue = value; break }
    }
    if (nearest == null) continue
    // ...takes over from the ATM only once spot is clearly past the midpoint between them.
    const atmValue = atm != null ? straddleAt(ce, pe, atm, t) : null
    const keep = atmValue != null && nearest !== atm
      && Math.abs(spot - atm) - Math.abs(spot - nearest) < 2 * switchBuffer * step
    const strike = keep ? atm : nearest
    if (strike !== atm) {
      if (atm != null) shifts.push({ time: t, from: atm, to: strike, spot })
      atm = strike
      if (!lines.has(strike)) lines.set(strike, { strike, order: lines.size, from: t, data: [] })
    }
    lines.get(strike).until = t
    for (const line of lines.values()) {
      const value = line.strike === strike ? (keep ? atmValue : nearestValue) : straddleAt(ce, pe, line.strike, t)
      if (value != null) line.data.push({ time: t, value })
    }
    now = { time: t, spot, strike, value: keep ? atmValue : nearestValue }
  }
  if (!now) return { ...empty, startMs }

  const all = [...lines.values()].map((line) => {
    const values = line.data.map((p) => p.value)
    const first = line.data[0]?.value ?? null
    const last = line.data.at(-1)?.value ?? null
    return {
      ...line, atmNow: line.strike === now.strike, start: first, value: last,
      change: first != null && last != null ? last - first : null,
      high: values.length ? Math.max(...values) : null, low: values.length ? Math.min(...values) : null,
    }
  })
  const keepCount = Math.max(1, maxLines ?? all.length)
  const shown = new Set([...all].sort((a, b) => (b.atmNow - a.atmNow) || (b.until - a.until)).slice(0, keepCount).map((l) => l.strike))
  return {
    startMs,
    lines: all.filter((l) => shown.has(l.strike)).sort((a, b) => a.from - b.from),
    hidden: all.length - shown.size,
    shifts,
    now,
  }
}
