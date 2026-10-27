// OI Replay's GEX (gamma exposure): how much the option dealers must buy or sell of the index to stay hedged when spot
// moves, worked out minute by minute from the OI Replay run's option points (each strike's CE / PE open interest, IV
// and premium) and spot.
//
//  - Gamma (Black-Scholes, no carry): G = phi(d1) / (S x sigma x sqrt(T)), d1 = (ln(S / K) + sigma^2 T / 2) / (sigma sqrt(T)),
//    sigma = that option's own IV (Dhan sends it per minute, in %; the ATM IV where a strike has none or one far off it).
//  - T, the time to expiry: from the minute to 15:30 IST on the options' expiry day (`expiry` - the server's
//    OptionExpiryResolver: Dhan's listed expiry from today on, the weekday rule checked for holidays before that), in
//    years of 365 days. Without an expiry date (or past it) T is IMPLIED: the T at which the ATM straddle priced at the ATM
//    IV equals the straddle traded (a minute where it cannot be implied keeps the last). The implied T is worked out every
//    minute anyway (`impliedYears` on each minute) - far off the expiry's, the IVs and the expiry do not agree.
//  - GEX of a strike's call or put = G x the dealers' OI x S^2 x 1%: the rupees of index the dealers trade for a 1% move.
//    Dhan's OI is in units (shares), so no lot size. Positive = dealers LONG gamma: they sell rallies and buy dips -
//    moves are damped (range, pin). Negative = dealers SHORT gamma: they buy rallies and sell dips - moves run (trend).
//  - Who the dealers are is not in the data, so the sign is an assumption (`sign`):
//      'standard' - dealers long the calls, short the puts (calls +, puts -), as GEX is usually shown;
//      'buildup'  - the OI at the first reading signed as standard, then every minute's OI change signed by the premium
//                   (the OI build-up read): OI added while the premium fell = written by customers, the dealers bought
//                   it (+); added while it rose = bought by customers, the dealers sold it (-); OI taken off while the
//                   premium rose = writers buying back (the dealers' long goes, -); off while it fell = holders selling
//                   (the dealers' short goes, +) - i.e. each minute adds -|change in OI| x sign(change in premium).
//                   The premium also moves with spot, so this is a rough read of who traded.
//  - Levels, as the GEX tools publish them (SpotGamma, MenthorQ, the Indian GEX pages):
//      NET GEX - all strikes added up;
//      GAMMA FLIP (zero gamma) - the spot at which the net GEX would cross zero: the net worked out again at spots across
//        the strikes the page has, the OI and IVs kept (the GEX PROFILE - `gexProfile`), the crossing nearest spot within
//        `rangePct` % of it and never past the strikes loaded (beyond them the profile would only be the strikes missing);
//        null when it does not cross there. `flipEdge`: it sits within a strike step / a 1-sigma move of the edge of the
//        strikes loaded, where strikes not loaded weigh in - a rough level;
//      CALL WALL - the strike ABOVE spot with the most call gamma x OI: resistance, the top of the range;
//      PUT WALL - the strike BELOW spot with the most put gamma x OI: support, the bottom of the range;
//      MAX GAMMA (absolute gamma strike) - the most call + put gamma x OI of any strike: the magnet / pin, above all on
//        expiry day, when gamma piles up at the money.
//    A level moves to another strike only when that one has WALL_SWITCH (10%) more gamma x OI than the strike holding it
//    - two strikes about level no longer swap it every minute - or at once when the strike holding it no longer can (no
//    reading; spot through a wall: it rolls on to the next strike). "Above" / "below" spot keep a dead zone of WALL_ZONE (a
//    quarter of a strike step) around spot: a strike becomes a wall only once spot is that far away from it, and a wall is
//    through only once spot is that far past it - spot wiggling across a big strike does not swap the walls every minute
//    (a strike at the money is the magnet, not a wall).
//
// Only the strikes the run has (ATM +/- 10 - Dhan's rolling option data) count, so the totals are partial; gamma fades
// fast away from the money, so they hold most of it. A minute uses only readings up to that minute (each option point
// holds its minute's close, a leg is read at its last reading within 5 minutes) - nothing after it.

const MIN = 60_000
const STALE_MINUTES = 5
const SQRT_2PI = Math.sqrt(2 * Math.PI)
const FLIP_STEPS = 60       // the flip is looked for on this grid across its range, then interpolated
const WALL_SWITCH = 0.1    // a level moves to a strike with this much more gamma x OI than the one holding it
const WALL_ZONE = 0.25     // the dead zone around spot for the walls, in strike steps
const IV_BAND = [0.5, 2]   // an option's own IV is used within this share of the ATM IV, else the ATM IV

export const GEX_RANGE_PCT = 3
const YEAR_MS = 365 * 24 * 3600_000

const minuteOf = (t) => Math.floor(new Date(t).getTime() / MIN) * MIN
const pdf = (x) => Math.exp(-x * x / 2) / SQRT_2PI
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const tail = pdf(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - tail : tail
}
/** Dhan's IV is a percent (12.5); a fraction (0.125) is taken as it is. */
export const ivFraction = (iv) => (iv > 3 ? iv / 100 : iv)

/** Black-Scholes gamma (no carry) per point of spot; 0 when it cannot be worked out. */
export function bsGamma(S, K, sigma, T) {
  if (!(S > 0 && K > 0 && sigma > 0 && T > 0)) return 0
  const v = sigma * Math.sqrt(T)
  const d1 = (Math.log(S / K) + v * v / 2) / v
  return pdf(d1) / (S * v)
}

/** Black-Scholes call + put at one strike (no carry). */
export function bsStraddle(S, K, sigma, T) {
  if (!(T > 0 && sigma > 0)) return Math.abs(S - K)
  const v = sigma * Math.sqrt(T)
  const d1 = (Math.log(S / K) + v * v / 2) / v
  const call = S * cdf(d1) - K * cdf(d1 - v)
  return 2 * call - (S - K)
}

/** The time to expiry (years) at which the straddle priced at `sigma` is `straddle`; null when none fits. */
export function impliedYears(straddle, S, K, sigma) {
  if (!(straddle > 0 && S > 0 && K > 0 && sigma > 0)) return null
  let lo = 1e-8, hi = 2
  if (straddle <= bsStraddle(S, K, sigma, lo) || straddle >= bsStraddle(S, K, sigma, hi)) return null
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (bsStraddle(S, K, sigma, mid) < straddle) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/** The net GEX (rupees per 1% move) if spot were `S`: `options` [{ strike, sigma, dealerOi }], `years` the time to expiry. */
export function netGexAt(options, S, years) {
  let net = 0
  for (const o of options) net += bsGamma(S, o.strike, o.sigma, years) * o.dealerOi * S * S * 0.01
  return net
}

// Each strike's readings of one side, one per minute (a later point of the same minute is the newer reading - live), in
// time order, each with the build-up change in the dealers' OI so far (`dealer` - see the top).
function sideRows(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !(p.price > 0) || !(p.openInterest >= 0)) continue
    const t = minuteOf(p.time)
    if (!Number.isFinite(t)) continue
    let minutes = byStrike.get(p.strike)
    if (!minutes) byStrike.set(p.strike, minutes = new Map())
    const prev = minutes.get(t)
    minutes.set(t, { t, price: p.price, oi: p.openInterest, iv: p.impliedVolatility > 0 ? p.impliedVolatility : prev?.iv ?? null })
  }
  const out = new Map()
  for (const [strike, minutes] of byStrike) {
    const rows = [...minutes.values()].sort((a, b) => a.t - b.t)
    let change = 0
    rows.forEach((r, i) => {
      if (i > 0) change += -Math.abs(r.oi - rows[i - 1].oi) * Math.sign(r.price - rows[i - 1].price)
      r.firstOi = rows[0].oi
      r.change = change
    })
    out.set(strike, rows)
  }
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

// The dealers' OI of one reading (+ = dealers long), call side `+1` / put side `-1` as standard.
const dealerOi = (row, standard, sign) => (sign === 'buildup' ? standard * row.firstOi + row.change : standard * row.oi)

// The strike holding a level this minute: the one with the most weight (gamma x OI) among the candidates - unless the
// one holding it last minute is still a candidate and the leader is not WALL_SWITCH ahead of it.
function holdLevel(weights, held) {
  let best = null
  for (const [strike, weight] of weights) if (best == null || weight > weights.get(best)) best = strike
  if (best == null) return null
  if (held != null && held !== best && weights.has(held) && weights.get(best) < weights.get(held) * (1 + WALL_SWITCH)) return held
  return best
}

// The crossing of zero of the net GEX nearest spot, looked for across [lo, hi]; null when there is none there.
function flipOf(options, spot, years, lo, hi) {
  if (!(hi > lo)) return null
  const step = (hi - lo) / FLIP_STEPS
  let best = null
  let prevS = lo, prevV = netGexAt(options, lo, years)
  for (let i = 1; i <= FLIP_STEPS; i++) {
    const s = lo + i * step
    const v = netGexAt(options, s, years)
    if ((prevV < 0 && v >= 0) || (prevV > 0 && v <= 0)) {
      const at = prevS + (s - prevS) * (prevV / (prevV - v))
      if (best == null || Math.abs(at - spot) < Math.abs(best - spot)) best = at
    }
    prevS = s; prevV = v
  }
  return best
}

/**
 * The day's GEX, one entry per minute of spot (every minute given - pick the replay clock's with `gexAt`).
 * `cePoints` / `pePoints`: the OI Replay run's option points (strike, time, price, openInterest, impliedVolatility);
 * `spotBars`: `[{ time (ms), close }]` one per minute; `expiry`: the options' expiry day ('YYYY-MM-DD'), null = implied.
 * Each minute: `{ time, spot, years, yearsFrom ('expiry' | 'straddle'), impliedYears, atm, atmIv, net, calls, puts, flip,
 * flipEdge, callWall, putWall, maxGamma, band: [lowest, highest strike read], options: [{ strike, sigma, dealerOi }],
 * strikes: [{ strike, call, put, net, ceOi, peOi, gamma }] }` (GEX in rupees per 1% move; `strikes` high to low; `options`
 * what the profile is worked out from). A minute with no ATM straddle and no time to expiry yet is left out. `flips: false`
 * leaves the flip out (null) - the costly part - for a caller that needs only the net and the walls.
 */
export function gexDay(cePoints, pePoints, spotBars, { sign = 'standard', rangePct = GEX_RANGE_PCT, expiry = null, flips = true } = {}) {
  const spots = (spotBars ?? []).filter((b) => b && b.close > 0)
    .map((b) => ({ t: minuteOf(b.time), spot: b.close })).filter((b) => Number.isFinite(b.t)).sort((a, b) => a.t - b.t)
  const ce = sideRows(cePoints)
  const pe = sideRows(pePoints)
  const strikes = [...new Set([...ce.keys(), ...pe.keys()])].sort((a, b) => b - a)
  const steps = strikes.slice(1).map((k, i) => strikes[i] - k).filter((d) => d > 0)
  const strikeStep = steps.length ? Math.min(...steps) : 0
  const held = { call: null, put: null, max: null }   // the strikes holding the levels, minute to minute
  const expiryMs = expiry ? Date.parse(`${String(expiry).slice(0, 10)}T15:30:00+05:30`) : null
  const minutes = []
  let implied = null
  for (const { t, spot } of spots) {
    const readings = strikes.map((strike) => ({ strike, c: readingAt(ce.get(strike), t), p: readingAt(pe.get(strike), t) }))
    // The ATM: the strike nearest spot with both legs read - its straddle and IV give the time to expiry.
    const atm = readings.filter((r) => r.c && r.p).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike)[0]
    if (!atm) continue
    const ivs = [atm.c.iv, atm.p.iv].filter((v) => v > 0).map(ivFraction)
    const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null
    if (atmIv == null) continue
    implied = impliedYears(atm.c.price + atm.p.price, spot, atm.strike, atmIv) ?? implied
    const toExpiry = Number.isFinite(expiryMs) && expiryMs > t ? (expiryMs - t) / YEAR_MS : null
    const years = toExpiry ?? implied
    if (years == null) continue
    const sigmaOf = (row) => {
      const own = row.iv > 0 ? ivFraction(row.iv) : null
      return own != null && own >= IV_BAND[0] * atmIv && own <= IV_BAND[1] * atmIv ? own : atmIv
    }
    const options = []
    const rows = []
    let calls = 0, puts = 0
    const callWeights = new Map(), putWeights = new Map(), gammaWeights = new Map()
    const zone = WALL_ZONE * strikeStep
    let lowStrike = Infinity, highStrike = -Infinity
    for (const { strike, c, p } of readings) {
      if (!c && !p) continue
      const cGamma = c ? bsGamma(spot, strike, sigmaOf(c), years) : 0
      const pGamma = p ? bsGamma(spot, strike, sigmaOf(p), years) : 0
      const unit = spot * spot * 0.01
      const call = c ? cGamma * dealerOi(c, 1, sign) * unit : null
      const put = p ? pGamma * dealerOi(p, -1, sign) * unit : null
      if (c) options.push({ strike, sigma: sigmaOf(c), dealerOi: dealerOi(c, 1, sign) })
      if (p) options.push({ strike, sigma: sigmaOf(p), dealerOi: dealerOi(p, -1, sign) })
      calls += call ?? 0
      puts += put ?? 0
      // The levels' weights: gamma x OI, whoever holds it - the call wall from the strikes clear above spot (or the one
      // holding it, until spot is clear past it), the put wall below the same way, the max gamma any.
      const cWeight = c ? cGamma * c.oi : 0
      const pWeight = p ? pGamma * p.oi : 0
      if (c && (strike >= spot + zone || (strike === held.call && strike >= spot - zone))) callWeights.set(strike, cWeight)
      if (p && (strike <= spot - zone || (strike === held.put && strike <= spot + zone))) putWeights.set(strike, pWeight)
      gammaWeights.set(strike, cWeight + pWeight)
      lowStrike = Math.min(lowStrike, strike)
      highStrike = Math.max(highStrike, strike)
      rows.push({ strike, call, put, net: (call ?? 0) + (put ?? 0), ceOi: c?.oi ?? null, peOi: p?.oi ?? null, gamma: (cWeight + pWeight) * unit })
    }
    held.call = holdLevel(callWeights, held.call)
    held.put = holdLevel(putWeights, held.put)
    held.max = holdLevel(gammaWeights, held.max)
    // The flip: within rangePct % of spot and the strikes loaded; near their edge (a strike step or a 1-sigma move),
    // the strikes not loaded weigh in.
    const flip = flips ? flipOf(options, spot, years, Math.max(spot * (1 - rangePct / 100), lowStrike), Math.min(spot * (1 + rangePct / 100), highStrike)) : null
    const edge = Math.max(strikeStep, atmIv * Math.sqrt(years) * spot)
    minutes.push({
      time: t, spot, years, yearsFrom: toExpiry != null ? 'expiry' : 'straddle', impliedYears: implied,
      atm: atm.strike, atmIv, net: calls + puts, calls, puts,
      flip, flipEdge: flip != null && (flip - lowStrike < edge || highStrike - flip < edge),
      callWall: held.call, putWall: held.put, maxGamma: held.max,
      band: [lowStrike, highStrike], options, strikes: rows,
    })
  }
  return minutes
}

/** The GEX profile of a minute (`gexDay`'s): the net GEX if spot were at each of `steps` + 1 prices across the strikes
 * loaded, the OI and IVs of that minute kept - `[{ price, net }]`; it crosses zero at the flip. */
export function gexProfile(minute, steps = 80) {
  const [lo, hi] = minute?.band ?? []
  if (!(hi > lo) || !minute.options?.length) return []
  const out = []
  for (let i = 0; i <= steps; i++) {
    const price = lo + ((hi - lo) * i) / steps
    out.push({ price, net: netGexAt(minute.options, price, minute.years) })
  }
  return out
}

/** The minutes of `day` up to the replay clock `asOfMs` (null = all - live; 0 = none). */
export function gexUpTo(day, asOfMs) {
  if (asOfMs == null) return day
  const clock = minuteOf(asOfMs)
  let n = 0
  while (n < day.length && day[n].time <= clock) n++
  return day.slice(0, n)
}

/** The two signs' regimes at one minute, side by side: `{ standard, buildup, agree, regime }` - each 'positive' /
 * 'negative' (null without a reading); `regime` the one they agree on, else null. */
export function gexAgreement(standardMinute, buildupMinute) {
  const regimeOf = (m) => (m && Number.isFinite(m.net) ? (m.net >= 0 ? 'positive' : 'negative') : null)
  const standard = regimeOf(standardMinute)
  const buildup = regimeOf(buildupMinute)
  const agree = standard != null && standard === buildup
  return { standard, buildup, agree, regime: agree ? standard : null }
}
