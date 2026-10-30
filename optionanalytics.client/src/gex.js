// OI Replay's GEX (gamma exposure): how much the option dealers must buy or sell of the index to stay hedged when spot
// moves, worked out minute by minute from the OI Replay run's option points (each strike's CE / PE open interest, IV
// and premium) and spot.
//
//  - Gamma (Black-Scholes with carry): G = phi(d1) / (S x sigma x sqrt(T)), d1 = (ln(F / K) + sigma^2 T / 2) / (sigma sqrt(T)),
//    sigma = the strike's IV worked out from its own premium (see below), F = the FORWARD - what the options price the index at expiry: spot plus the carry (interest less dividends) to it.
//    It is read from the options themselves each minute, by put-call parity (call - put = forward - strike) at the three
//    strikes nearest spot (the middle one of the three), as professional systems do - no rate to guess; spot when it
//    cannot be read or is more than 2% off. Without it gamma centres on spot, not the forward: a monthly option two
//    weeks out (BANKNIFTY) had its gamma ~1.5 strikes too low and the net GEX far off.
//  - Each strike's IV is worked out from its own premium (Black-76 on the forward, the out-of-the-money leg: the call at or
//    above the forward, the put below - one IV a strike, as professional systems do), not taken from Dhan's IV field: the
//    premium fixes sigma x sqrt(T), and gamma depends on nothing else, so it follows the prices traded whatever day count or
//    rate Dhan's IV was worked out with - and even a time to expiry a day off changes no gamma. Dhan's IV is the fallback
//    where a premium gives none; an IV outside 0.5 - 2x the ATM one (a stale print) is replaced by the ATM IV.
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
// DEX (delta exposure), worked out in the same minute from the same forward, time to expiry and strike IVs:
//  - Delta (Black-76 on the forward, as the gamma): a call N(d1), a put N(d1) - 1.
//  - DEX of a strike's call or put = delta x the dealers' OI x S: the rupees of index the dealers' options are long (+) or
//    short (-) - what their futures hedge holds the other way. Summed: the net DEX; calls and puts apart.
//  - Its sign is the one the DEX tools publish (FlashAlpha, Options Analysis Suite): the dealers SHORT every contract -
//    customers hold the calls and the puts - so DEX = -sum(delta x OI x S): calls count negative, puts positive.
//    (GEX's standard - dealers long the calls - would make every strike's DEX positive and say nothing.) Negative = the
//    open options lean CALL-heavy (customers net long delta; the dealers' hedge is long futures), positive = PUT-heavy.
//    'buildup': short at the first reading, then each minute's OI change signed by the premium, as GEX's build-up.
//  - DECAY TO THE CLOSE (charm): how the dealers' options delta changes from now to 15:30 today with time alone - spot, OI
//    and IVs kept; the hedge they trade is the opposite (options delta up = they sell futures). On expiry day every
//    out-of-the-money delta runs to 0 by the close, so it is the day's biggest.
//  - DELTA ADDED: the delta of the OI added or cut over the last DEX_WINDOW minutes, at this minute's deltas - the
//    positioning that came in, with how far spot went over the same minutes (`dexDivergence` reads the two together).
//  Delta does NOT fade away from the money like gamma - a deep in-the-money option carries a delta near 1 - so with only
//  ATM +/- 10 strikes the net DEX is more partial than the GEX: read its CHANGE (through the day, added, decay) more than
//  its level.
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
export const DEX_WINDOW = 15  // minutes the "delta added" is read over
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

/** Black-Scholes gamma per point of spot `S`, the strike's d1 taken from the forward `F` (spot plus the carry to expiry;
 * spot itself when not given); 0 when it cannot be worked out. */
export function bsGamma(S, K, sigma, T, F = S) {
  if (!(S > 0 && K > 0 && sigma > 0 && T > 0 && F > 0)) return 0
  const v = sigma * Math.sqrt(T)
  const d1 = (Math.log(F / K) + v * v / 2) / v
  return pdf(d1) / (S * v)
}

/** A call's Black-76 delta, N(d1), on the forward `F` (a put's is this less 1); at expiry (`T` 0) the intrinsic one - 1 in
 * the money, 0 out of it, 0.5 at it. */
export function bsDelta(F, K, sigma, T) {
  if (!(F > 0 && K > 0)) return 0
  if (!(T > 0 && sigma > 0)) return F > K ? 1 : F < K ? 0 : 0.5
  const v = sigma * Math.sqrt(T)
  return cdf((Math.log(F / K) + v * v / 2) / v)
}

/** Black-Scholes call + put at one strike, on the forward `F` (undiscounted - the discount over days is negligible). */
export function bsStraddle(F, K, sigma, T) {
  if (!(T > 0 && sigma > 0)) return Math.abs(F - K)
  const v = sigma * Math.sqrt(T)
  const d1 = (Math.log(F / K) + v * v / 2) / v
  const call = F * cdf(d1) - K * cdf(d1 - v)
  return 2 * call - (F - K)
}

/** The time to expiry (years) at which the straddle priced at `sigma` on the forward `F` is `straddle`; null when none fits. */
export function impliedYears(straddle, F, K, sigma) {
  if (!(straddle > 0 && F > 0 && K > 0 && sigma > 0)) return null
  let lo = 1e-8, hi = 2
  if (straddle <= bsStraddle(F, K, sigma, lo) || straddle >= bsStraddle(F, K, sigma, hi)) return null
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (bsStraddle(F, K, sigma, mid) < straddle) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/** The Black-76 (undiscounted) implied volatility of an option at strike `K` on the forward `F`, `T` years out, from its
 * `premium` (`isCall` - a call, else a put); null when the premium is outside what any volatility gives. */
export function impliedVol(premium, F, K, T, isCall) {
  if (!(premium > 0 && F > 0 && K > 0 && T > 0)) return null
  const price = (sigma) => {
    const v = sigma * Math.sqrt(T)
    const d1 = (Math.log(F / K) + v * v / 2) / v
    const call = F * cdf(d1) - K * cdf(d1 - v)
    return isCall ? call : call - (F - K)
  }
  let lo = 0.005, hi = 5
  if (premium <= price(lo) || premium >= price(hi)) return null
  for (let i = 0; i < 40; i++) {   // to a millionth of a vol point and finer
    const mid = (lo + hi) / 2
    if (price(mid) < premium) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/** The forward from put-call parity at the strikes nearest spot (call - put = forward - strike): the middle of the three
 * nearest with both legs; spot when there is none or it is more than 2% off. `pairs`: [{ strike, call, put }] (premiums). */
export function parityForward(pairs, spot) {
  const forwards = [...(pairs ?? [])].filter((p) => p.call > 0 && p.put > 0)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike).slice(0, 3)
    .map((p) => p.strike + p.call - p.put).sort((a, b) => a - b)
  if (!forwards.length) return spot
  const mid = forwards.length % 2 ? forwards[(forwards.length - 1) / 2] : (forwards[forwards.length / 2 - 1] + forwards[forwards.length / 2]) / 2
  return Math.abs(mid / spot - 1) <= 0.02 ? mid : spot
}

/** The net GEX (rupees per 1% move) if spot were `S`: `options` [{ strike, sigma, dealerOi }], `years` the time to expiry,
 * `carry` the forward / spot (kept as spot moves). */
export function netGexAt(options, S, years, carry = 1) {
  let net = 0
  for (const o of options) net += bsGamma(S, o.strike, o.sigma, years, S * carry) * o.dealerOi * S * S * 0.01
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
// The dealers' OI for DEX: short every contract (DEX's own standard - see the top), or short at the first reading and
// the build-up since.
const dexDealerOi = (row, sign) => (sign === 'buildup' ? -row.firstOi + row.change : -row.oi)
// 15:30 IST of the day `t` (epoch ms) is in.
const IST_MS = 330 * MIN
const closeOf = (t) => Date.parse(`${new Date(t + IST_MS).toISOString().slice(0, 10)}T15:30:00+05:30`)

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
function flipOf(options, spot, years, lo, hi, carry) {
  if (!(hi > lo)) return null
  const step = (hi - lo) / FLIP_STEPS
  let best = null
  let prevS = lo, prevV = netGexAt(options, lo, years, carry)
  for (let i = 1; i <= FLIP_STEPS; i++) {
    const s = lo + i * step
    const v = netGexAt(options, s, years, carry)
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
 * Each minute: `{ time, spot, forward, carry (forward / spot), years, yearsFrom ('expiry' | 'straddle'), impliedYears, atm, atmIv, net, calls, puts, flip,
 * flipEdge, callWall, putWall, maxGamma, band: [lowest, highest strike read], options: [{ strike, sigma, dealerOi }],
 * strikes: [{ strike, call, put, net, ceOi, peOi, gamma, delta, dexCall, dexPut, dexNet }], dex: { net, calls, puts,
 * decayToClose, added, addedFrom, spotFrom } }` (GEX in rupees per 1% move; DEX in rupees of index - see the top; `delta`
 * the strike's call delta; `strikes` high to low; `options` what the profile is worked out from). A minute with no ATM straddle and no time to expiry yet is left out. `flips: false`
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
  const spotAt = new Map(spots.map((b) => [b.t, b.spot]))
  const firstT = spots[0]?.t
  let implied = null
  for (const { t, spot } of spots) {
    const readings = strikes.map((strike) => ({ strike, c: readingAt(ce.get(strike), t), p: readingAt(pe.get(strike), t) }))
    // The ATM: the strike nearest spot with both legs read - its straddle and IV give the time to expiry.
    const atm = readings.filter((r) => r.c && r.p).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike)[0]
    if (!atm) continue
    // The forward, from put-call parity at the strikes nearest spot (spot itself when it cannot be read).
    const forward = parityForward(readings.filter((r) => r.c && r.p).map((r) => ({ strike: r.strike, call: r.c.price, put: r.p.price })), spot)
    const carry = forward / spot
    // Dhan's ATM IV: the time to expiry implied from it (the fallback with no expiry date, and kept as a check).
    const dhanIvs = [atm.c.iv, atm.p.iv].filter((v) => v > 0).map(ivFraction)
    const dhanAtmIv = dhanIvs.length ? dhanIvs.reduce((a, b) => a + b, 0) / dhanIvs.length : null
    if (dhanAtmIv != null) implied = impliedYears(atm.c.price + atm.p.price, forward, atm.strike, dhanAtmIv) ?? implied
    const toExpiry = Number.isFinite(expiryMs) && expiryMs > t ? (expiryMs - t) / YEAR_MS : null
    const years = toExpiry ?? implied
    if (years == null) continue
    // Each strike's IV from its own premium - the out-of-the-money leg first, then the other - Dhan's IV where neither
    // gives one; outside 0.5 - 2x the ATM IV (a stale print), the ATM IV.
    const strikeIv = new Map()
    for (const { strike, c, p } of readings) {
      const above = strike >= forward
      const otm = above ? c : p, itm = above ? p : c
      const own = (otm ? impliedVol(otm.price, forward, strike, years, above) : null) ?? (itm ? impliedVol(itm.price, forward, strike, years, !above) : null)
      const dhan = [otm?.iv, itm?.iv].find((v) => v > 0)
      const iv = own ?? (dhan > 0 ? ivFraction(dhan) : null)
      if (iv != null) strikeIv.set(strike, iv)
    }
    const atmIv = strikeIv.get(atm.strike) ?? dhanAtmIv
    if (atmIv == null) continue
    const sigmaAt = (strike) => {
      const own = strikeIv.get(strike)
      return own != null && own >= IV_BAND[0] * atmIv && own <= IV_BAND[1] * atmIv ? own : atmIv
    }
    const options = []
    const rows = []
    let calls = 0, puts = 0
    // DEX: the net, calls and puts; the time decay to 15:30 today; the delta of the OI added since `addedFrom`.
    let dexCalls = 0, dexPuts = 0, decay = 0, added = 0, addedLegs = 0
    const close = closeOf(t)
    const yearsAtClose = t < close ? Math.max(0, years - (close - t) / YEAR_MS) : null
    const addedFrom = Math.max(t - DEX_WINDOW * MIN, firstT)
    const callWeights = new Map(), putWeights = new Map(), gammaWeights = new Map()
    const zone = WALL_ZONE * strikeStep
    let lowStrike = Infinity, highStrike = -Infinity
    for (const { strike, c, p } of readings) {
      if (!c && !p) continue
      const sigma = sigmaAt(strike)
      const cGamma = c ? bsGamma(spot, strike, sigma, years, forward) : 0
      const pGamma = p ? bsGamma(spot, strike, sigma, years, forward) : 0
      const unit = spot * spot * 0.01
      const call = c ? cGamma * dealerOi(c, 1, sign) * unit : null
      const put = p ? pGamma * dealerOi(p, -1, sign) * unit : null
      if (c) options.push({ strike, sigma, dealerOi: dealerOi(c, 1, sign) })
      if (p) options.push({ strike, sigma, dealerOi: dealerOi(p, -1, sign) })
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
      // DEX - delta x the dealers' OI x S (a put's delta is the call's less 1).
      const callDelta = bsDelta(forward, strike, sigma, years)
      const dexCall = c ? callDelta * dexDealerOi(c, sign) * spot : null
      const dexPut = p ? (callDelta - 1) * dexDealerOi(p, sign) * spot : null
      dexCalls += dexCall ?? 0
      dexPuts += dexPut ?? 0
      // Time alone to 15:30: both legs' deltas change by the same amount.
      if (yearsAtClose != null) {
        const change = bsDelta(forward, strike, sigma, yearsAtClose) - callDelta
        decay += change * ((c ? dexDealerOi(c, sign) : 0) + (p ? dexDealerOi(p, sign) : 0)) * spot
      }
      // The OI added or cut since `addedFrom`, at this minute's delta (a strike not read then counts from its first reading).
      if (addedFrom < t) {
        for (const [now, leg, d] of [[c, ce.get(strike), callDelta], [p, pe.get(strike), callDelta - 1]]) {
          const then = now ? readingAt(leg, addedFrom) : null
          if (!now || !then) continue
          added += (dexDealerOi(now, sign) - dexDealerOi(then, sign)) * d * spot
          addedLegs++
        }
      }
      rows.push({
        strike, call, put, net: (call ?? 0) + (put ?? 0), ceOi: c?.oi ?? null, peOi: p?.oi ?? null, gamma: (cWeight + pWeight) * unit,
        delta: callDelta, dexCall, dexPut, dexNet: (dexCall ?? 0) + (dexPut ?? 0),
      })
    }
    held.call = holdLevel(callWeights, held.call)
    held.put = holdLevel(putWeights, held.put)
    held.max = holdLevel(gammaWeights, held.max)
    // The flip: within rangePct % of spot and the strikes loaded; near their edge (a strike step or a 1-sigma move),
    // the strikes not loaded weigh in.
    const flip = flips ? flipOf(options, spot, years, Math.max(spot * (1 - rangePct / 100), lowStrike), Math.min(spot * (1 + rangePct / 100), highStrike), carry) : null
    const edge = Math.max(strikeStep, atmIv * Math.sqrt(years) * spot)
    minutes.push({
      time: t, spot, forward, carry, years, yearsFrom: toExpiry != null ? 'expiry' : 'straddle', impliedYears: implied,
      atm: atm.strike, atmIv, net: calls + puts, calls, puts,
      flip, flipEdge: flip != null && (flip - lowStrike < edge || highStrike - flip < edge),
      callWall: held.call, putWall: held.put, maxGamma: held.max,
      band: [lowStrike, highStrike], options, strikes: rows,
      dex: {
        net: dexCalls + dexPuts, calls: dexCalls, puts: dexPuts,
        decayToClose: yearsAtClose != null ? decay : null,
        added: addedLegs ? added : null, addedFrom: addedLegs ? addedFrom : null, spotFrom: addedLegs ? spotAt.get(addedFrom) ?? null : null,
      },
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
    out.push({ price, net: netGexAt(minute.options, price, minute.years, minute.carry ?? 1) })
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

/** The two signs' DEX lean at one minute, side by side: `{ standard, buildup, agree, lean }` - each 'call-heavy' (net DEX
 * below zero: the dealers short delta) / 'put-heavy' (null without a reading); `lean` the one they agree on, else null. */
export function dexAgreement(standardMinute, buildupMinute) {
  const leanOf = (m) => (m?.dex && Number.isFinite(m.dex.net) ? (m.dex.net < 0 ? 'call-heavy' : 'put-heavy') : null)
  const standard = leanOf(standardMinute)
  const buildup = leanOf(buildupMinute)
  const agree = standard != null && standard === buildup
  return { standard, buildup, agree, lean: agree ? standard : null }
}

/** Price against the positioning that came in over the DEX window (a minute of `gexDay`): `{ spotChange, customers (the
 * delta customers added - the dealers' less: + = bullish positions), verdict }` - 'confirms' (both the same way),
 * 'diverges' (price one way, the new positions the other: the move is not backed by them), 'flat' (spot moved less than
 * `minMovePct` % or no delta came in); null without a window yet. Context, not a trigger. */
export function dexDivergence(minute, { minMovePct = 0.1 } = {}) {
  const dex = minute?.dex
  if (!dex || dex.added == null || !(dex.spotFrom > 0)) return null
  const spotChange = minute.spot - dex.spotFrom
  const customers = -dex.added
  const moved = Math.abs(spotChange) >= (minMovePct / 100) * dex.spotFrom
  const verdict = !moved || customers === 0 ? 'flat' : Math.sign(spotChange) === Math.sign(customers) ? 'confirms' : 'diverges'
  return { spotChange, customers, verdict, minutes: Math.round((minute.time - dex.addedFrom) / MIN) }
}
