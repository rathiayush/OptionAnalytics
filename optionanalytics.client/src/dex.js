// OI Replay's DEALER HEDGING (DEX) card: the dealers' delta from the day's GEX minutes (gex.js' `gexDay` - each minute's
// `options`: strike, call / put, IV from its own premium, the dealers' OI under the sign picked, time to expiry and carry),
// read for what the OI cards cannot show - the index the dealers must BUY or SELL to stay hedged when:
//
//  - SPOT MOVES 1% up / down (sticky strike: each option keeps its IV) - the dealers' delta worked out again at spot x 1.01 /
//    0.99, the whole move, not the gamma slope at spot (the two sides differ: gamma is not the same above and below);
//  - IV FALLS 1 vol point (VANNA): every option's IV down 0.01, spot and time held;
//  - TIME PASSES (CHARM): to the close (15:30 IST that day) and over the next hour, spot and IV held.
//
// Flow sign: + = the dealers BUY the index, - = they SELL (their delta rose, they sell to stay flat). In rupees of index
// (Dhan's OI is in units - no lot size); per 1% move, per vol point, to the close / per hour.
// Delta on the forward (Black-76, F = spot x carry): a call's delta to spot = carry x N(d1), a put's = carry x (N(d1) - 1).
//
//  - NET dealer delta (rupees) and the DEX FLIP - the spot where the dealers' book would turn from net long to net short
//    delta (their delta worked out again at spots across the strikes loaded, OI / IV / time kept, the crossing nearest
//    spot within +/- 3% and the strikes loaded; `flipEdge` = near their edge, rough). Under the STANDARD sign (dealers long
//    every call, short every put) both legs are long delta, so the book never crosses zero: no flip - it needs OI
//    build-up / NSE + build-up. The net counts only the strikes loaded (ATM +/- 10) - a deep in-the-money option has a
//    delta of 1 and is not there - so it is a level for the strikes read; the FLOWS are local (gamma, vanna and charm fade
//    away from the money) and do not suffer from it.
//
//  - DEX BY STRIKE and the DEX WALLS (asked for - "DEX walls ... add in same card"): each strike's dealer delta in rupees
//    (its calls' and puts' dealers' OI x delta at spot x spot, the expiries summed - `strikes`), and the strikes holding
//    the most of it (|net|): DEX RESISTANCE = the strike ABOVE spot with the most, DEX SUPPORT = the one BELOW, DEX MAX =
//    the most of any strike. As the GEX walls: a level moves to another strike only with WALL_SWITCH (10%) more, and above
//    / below keep a dead zone of a quarter strike step (a strike becomes a wall once spot is that far from it, a wall
//    breaks once spot is that far through it) - carried minute to minute by dexDay (`held`), nothing after the minute.
//
// No CE vs PE lean (the OI cards show that). Every minute from its own GEX minute - readings up to it, nothing after.
// A read - it feeds no strategy, alert or order.

const MIN = 60_000
const HOUR_MS = 3600_000
const YEAR_MS = 365 * 24 * HOUR_MS
const IST_MS = 5.5 * HOUR_MS
const FLIP_STEPS = 60
const SQRT_2PI = Math.sqrt(2 * Math.PI)

export const DEX_RANGE_PCT = 3
export const DEX_MOVE_PCT = 1      // the spot move read
export const DEX_VOL_POINT = 0.01  // the IV move read (1 vol point)
export const CRORE = 1e7
const WALL_SWITCH = 0.1   // a wall moves to a strike with this much more |dealer delta|
const WALL_ZONE = 0.25    // the dead zone around spot, in strike steps

const pdf = (x) => Math.exp(-x * x / 2) / SQRT_2PI
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const tail = pdf(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - tail : tail
}

/** The delta to spot of one option (`call`), spot `S`, the forward S x `carry`, IV `sigma`, `T` years: carry x N(d1) for a
 *  call, carry x (N(d1) - 1) for a put; at expiry (T <= 0) its intrinsic step. */
export function optionDelta(call, S, K, sigma, T, carry = 1) {
  const F = S * carry
  if (!(F > 0 && K > 0)) return 0
  let n
  if (!(T > 0) || !(sigma > 0)) n = F > K ? 1 : F < K ? 0 : 0.5
  else {
    const v = sigma * Math.sqrt(T)
    n = cdf((Math.log(F / K) + v * v / 2) / v)
  }
  return carry * (call ? n : n - 1)
}

/** The dealers' delta (index units) of `options` (gexDay's) if spot were `S`, each IV moved by `volShift` and `dt` years
 *  passed. An option with no `call` flag counts as none. */
export function dealerDelta(options, S, { years = 0, carry = 1, volShift = 0, dt = 0 } = {}) {
  let d = 0
  for (const o of options ?? []) {
    if (typeof o.call !== 'boolean' || !Number.isFinite(o.dealerOi)) continue
    const T = (o.years ?? years) - dt
    d += o.dealerOi * optionDelta(o.call, S, o.strike, Math.max(0.005, o.sigma + volShift), T, o.carry ?? carry)
  }
  return d
}

// 15:30 IST of the day of `t`.
const closeOf = (t) => Date.parse(`${new Date(t + IST_MS).toISOString().slice(0, 10)}T15:30:00+05:30`)

// The crossing of zero of the dealers' delta nearest spot across [lo, hi]; null when there is none there.
function flipOf(options, spot, opts, lo, hi) {
  if (!(hi > lo)) return null
  const step = (hi - lo) / FLIP_STEPS
  let best = null
  let prevS = lo, prevV = dealerDelta(options, lo, opts)
  for (let i = 1; i <= FLIP_STEPS; i++) {
    const s = lo + i * step
    const v = dealerDelta(options, s, opts)
    if ((prevV < 0 && v >= 0) || (prevV > 0 && v <= 0)) {
      const at = prevS + (s - prevS) * (prevV / (prevV - v))
      if (best == null || Math.abs(at - spot) < Math.abs(best - spot)) best = at
    }
    prevS = s; prevV = v
  }
  return best
}

/** Each strike's dealer delta in rupees at spot `S` (the expiries summed): `[{ strike, call, put, net }]`, strikes rising. */
export function dexStrikes(options, S, opts = {}) {
  const by = new Map()
  for (const o of options ?? []) {
    if (typeof o.call !== 'boolean' || !Number.isFinite(o.dealerOi)) continue
    const d = o.dealerOi * optionDelta(o.call, S, o.strike, Math.max(0.005, o.sigma), o.years ?? opts.years ?? 0, o.carry ?? opts.carry ?? 1) * S
    const row = by.get(o.strike) ?? { strike: o.strike, call: 0, put: 0, net: 0 }
    if (o.call) row.call += d; else row.put += d
    row.net += d
    by.set(o.strike, row)
  }
  return [...by.values()].sort((a, b) => a.strike - b.strike)
}

// The strike of `rows` with the most |net|, the one held last minute kept unless the leader has WALL_SWITCH more.
function holdWall(rows, held) {
  let best = null
  for (const r of rows) if (best == null || Math.abs(r.net) > Math.abs(best.net)) best = r
  if (!best || !(Math.abs(best.net) > 0)) return null
  const keep = held == null ? null : rows.find((r) => r.strike === held)
  if (keep && keep !== best && Math.abs(best.net) < Math.abs(keep.net) * (1 + WALL_SWITCH)) return keep.strike
  return best.strike
}

/** The DEX walls of `strikes` at spot `S` given last minute's (`held` - { resistance, support, max }): a strike above spot
 *  counts once it is a quarter strike step over it, a held one until spot is that far through it. */
export function dexWalls(strikes, S, held = {}) {
  const ks = strikes.map((r) => r.strike)
  const gaps = ks.slice(1).map((k, i) => k - ks[i]).filter((g) => g > 0)
  const zone = WALL_ZONE * (gaps.length ? Math.min(...gaps) : 0)
  const above = strikes.filter((r) => r.strike > S + zone || (r.strike === held.resistance && r.strike > S - zone))
  const below = strikes.filter((r) => r.strike < S - zone || (r.strike === held.support && r.strike < S + zone))
  return { resistance: holdWall(above, held.resistance), support: holdWall(below, held.support), max: holdWall(strikes, held.max) }
}

/** One GEX minute (gexDay's) read as the dealers' hedging: `{ time, spot, net (rupees of dealer delta), up / down (flow for
 *  spot +/- 1%), vanna (flow for IV -1 vol point), charmClose (flow from now to 15:30, minutesToClose), charmHour (flow over
 *  the next hour), flip, flipEdge }` - flows in rupees, + = dealers buy. Null without options read. `flips: false` leaves
 *  the flip out. */
export function dexAt(minute, { flips = true, rangePct = DEX_RANGE_PCT, held = {} } = {}) {
  const options = (minute?.options ?? []).filter((o) => typeof o.call === 'boolean')
  if (!options.length || !(minute.spot > 0)) return null
  const S = minute.spot
  const opts = { years: minute.years, carry: minute.carry ?? 1 }
  const base = dealerDelta(options, S, opts)
  const flow = (d) => -(d - base) * S
  const nearest = Math.min(...options.map((o) => o.years ?? minute.years).filter((y) => y > 0))
  const toClose = Math.max(0, closeOf(minute.time) - minute.time)
  const dtClose = Math.min(toClose / YEAR_MS, Number.isFinite(nearest) ? nearest : 0)
  const dtHour = Math.min(HOUR_MS / YEAR_MS, Number.isFinite(nearest) ? nearest : 0)
  const [low, high] = minute.band ?? [Math.min(...options.map((o) => o.strike)), Math.max(...options.map((o) => o.strike))]
  const flip = flips ? flipOf(options, S, opts, Math.max(S * (1 - rangePct / 100), low), Math.min(S * (1 + rangePct / 100), high)) : null
  const steps = [...new Set(options.map((o) => o.strike))].sort((a, b) => a - b)
  const gaps = steps.slice(1).map((k, i) => k - steps[i]).filter((g) => g > 0)
  const edge = Math.max(gaps.length ? Math.min(...gaps) : 0, (minute.atmIv ?? 0) * Math.sqrt(minute.years ?? 0) * S)
  const strikes = dexStrikes(options, S, opts)
  return {
    strikes, walls: dexWalls(strikes, S, held),
    time: minute.time, spot: S,
    net: base * S,
    up: flow(dealerDelta(options, S * (1 + DEX_MOVE_PCT / 100), opts)),
    down: flow(dealerDelta(options, S * (1 - DEX_MOVE_PCT / 100), opts)),
    vanna: flow(dealerDelta(options, S, { ...opts, volShift: -DEX_VOL_POINT })),
    charmClose: dtClose > 0 ? flow(dealerDelta(options, S, { ...opts, dt: dtClose })) : 0,
    minutesToClose: Math.round(toClose / MIN),
    charmHour: dtHour > 0 ? flow(dealerDelta(options, S, { ...opts, dt: dtHour })) : 0,
    flip, flipEdge: flip != null && (flip - low < edge || high - flip < edge),
    ...(minute.expiries ? { expiries: minute.expiries } : {}),
  }
}

/** The day's dealer hedging, a minute per GEX minute (`gexMinutes` - gexDay's, already cut or whole). */
export function dexDay(gexMinutes, { flips = true } = {}) {
  const out = []
  let held = {}
  for (const m of gexMinutes ?? []) {
    const d = dexAt(m, { flips, held })
    if (d) { out.push(d); held = d.walls }
  }
  return out
}

/** The minutes up to the replay clock (null = all - live). */
export function dexUpTo(minutes, asOfMs) {
  if (asOfMs == null) return minutes ?? []
  return (minutes ?? []).filter((m) => m.time <= asOfMs)
}

/** The dealers' delta (rupees) if spot were at each of `steps` + 1 prices across the strikes loaded - `[{ price, net }]`;
 *  it crosses zero at the flip. */
export function dexProfile(minute, steps = 80) {
  const options = (minute?.options ?? []).filter((o) => typeof o.call === 'boolean')
  const [lo, hi] = minute?.band ?? []
  if (!(hi > lo) || !options.length) return []
  const opts = { years: minute.years, carry: minute.carry ?? 1 }
  const out = []
  for (let i = 0; i <= steps; i++) {
    const price = lo + ((hi - lo) * i) / steps
    out.push({ price, net: dealerDelta(options, price, opts) * price })
  }
  return out
}

// A flow smaller than this share of the larger 1% move's counts as small.
const SMALL_SHARE = 0.1

/** What the flows say (`dex` - a dexAt minute): one line each - the moves (dealers lean against them or chase them, and
 *  which side is heavier), charm (into the close) and vanna (an IV fall). `[{ key, tone ('bull' | 'bear' | 'calm'), text }]`. */
export function dexRead(dex) {
  if (!dex) return []
  const cr = (v) => `₹${(Math.abs(v) / CRORE).toFixed(Math.abs(v) < 10 * CRORE ? 1 : 0)} Cr`
  const scale = Math.max(Math.abs(dex.up), Math.abs(dex.down))
  const small = (v) => Math.abs(v) < SMALL_SHARE * scale || Math.abs(v) < 0.05 * CRORE
  const out = []
  if (scale >= 0.05 * CRORE) {
    const damp = dex.up < 0 && dex.down > 0
    const chase = dex.up > 0 && dex.down < 0
    const heavier = Math.abs(dex.up) > 1.25 * Math.abs(dex.down) ? 'up' : Math.abs(dex.down) > 1.25 * Math.abs(dex.up) ? 'down' : null
    const text = damp
      ? `Dealers lean AGAINST moves: a 1% rally has them selling ${cr(dex.up)}, a 1% fall buying ${cr(dex.down)} - moves are damped.`
      : chase
        ? `Dealers CHASE moves: a 1% rally has them buying ${cr(dex.up)}, a 1% fall selling ${cr(dex.down)} - moves can run.`
        : `Mixed: a 1% rally has them ${dex.up >= 0 ? 'buying' : 'selling'} ${cr(dex.up)}, a 1% fall ${dex.down >= 0 ? 'buying' : 'selling'} ${cr(dex.down)} - spot sits where the hedging turns.`
    out.push({ key: 'move', tone: damp ? 'calm' : chase ? (heavier === 'down' ? 'bear' : heavier === 'up' ? 'bull' : 'calm') : 'calm', text: heavier ? `${text} The ${heavier === 'up' ? 'rally' : 'fall'} side is heavier.` : text })
  }
  if (dex.minutesToClose > 0) {
    out.push(small(dex.charmClose)
      ? { key: 'charm', tone: 'calm', text: `Time alone (charm) moves little to the close: ${dex.charmClose >= 0 ? 'buying' : 'selling'} ${cr(dex.charmClose)}.` }
      : { key: 'charm', tone: dex.charmClose > 0 ? 'bull' : 'bear', text: `Time alone (charm): dealers ${dex.charmClose > 0 ? 'BUY' : 'SELL'} ${cr(dex.charmClose)} by the close at this spot - a ${dex.charmClose > 0 ? 'tailwind up' : 'drag down'} into 15:30.` })
  }
  out.push(small(dex.vanna)
    ? { key: 'vanna', tone: 'calm', text: `An IV fall (vanna) changes little: ${dex.vanna >= 0 ? 'buying' : 'selling'} ${cr(dex.vanna)} a vol point.` }
    : { key: 'vanna', tone: dex.vanna > 0 ? 'bull' : 'bear', text: `Each vol point IV falls (vanna), dealers ${dex.vanna > 0 ? 'BUY' : 'SELL'} ${cr(dex.vanna)} - ${dex.vanna > 0 ? 'IV sold into a rally adds fuel' : 'IV sold adds pressure down'}; an IV rise does the opposite.` })
  return out
}
