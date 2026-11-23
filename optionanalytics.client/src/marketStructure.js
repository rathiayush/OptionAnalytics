// MARKET STRUCTURE of a candle series - the Spot structure page (SpotStructurePage.jsx). Pure functions, no drawing.
//
// What it reads, as the structure tools traders use draw it (LuxAlgo's "Smart Money Concepts", the ICT / SMC vocabulary,
// the classic chart patterns):
//   - SWINGS: pivot highs / lows (a high higher than the `len` bars each side) - HH / LH / HL / LL against the last of
//     their kind. A pivot is only KNOWN `len` bars after it (its right side has to print), and every read below takes it
//     from that bar on - nothing is read from bars after the one it is shown on (a cut series = the whole one up to it).
//   - STRUCTURE, twice - EXTERNAL (swing pivots, long `swingLen`) and INTERNAL (short `internalLen`): a candle CLOSING
//     past the last unbroken pivot high / low is a BREAK; with the trend = BOS (break of structure), against it = CHoCH
//     (change of character - the first sign of a turn). An internal break on the same level and bar as an external one
//     is the external one's.
//   - LIQUIDITY: a wick past the last swing high / low that closes back inside = a SWEEP (stops taken, rejected); EQUAL
//     HIGHS / LOWS (two internal pivots within a tenth of an ATR) - resting liquidity until price trades past them.
//   - ORDER BLOCKS: on each break, the candle with the lowest low (bullish break) / highest high (bearish) between the
//     broken pivot and the break - its range is the block; MITIGATED (spent) once a candle closes through it.
//   - FAIR VALUE GAPS: three candles whose first and third do not overlap (an imbalance), at least 0.15 ATR; FILLED once
//     price trades back across it.
//   - STRONG / WEAK high and low, PREMIUM / DISCOUNT: in an up trend the low the last swing break started from must hold
//     (strong / protected) and the high is the target (weak); the dealing range between the last swing high and low, its
//     top half premium (sell), bottom half discount (buy), 47.5 - 52.5% equilibrium.
//   - SUPPORT / RESISTANCE ZONES: pivots within half an ATR of each other grouped - a zone is where price turned at least
//     twice; its touches, below price = support, above = resistance.
//   - TRENDLINES: through two pivot lows rising (support) / two pivot highs falling (resistance) that no close crossed in
//     between; the one with the most touches still unbroken, else the last broken (a close past it).
//   - CHART PATTERNS on the alternating swing sequence: double top / bottom, head & shoulders and the inverse, ascending /
//     descending / symmetrical triangles, rising / falling wedges, rising / falling channels and ranges - CONFIRMED once
//     a close breaks the neckline / boundary, FAILED when price breaks the other way first.
// It describes the chart; it places nothing and feeds no strategy or alert.

export const STRUCTURE_DEFAULTS = {
  swingLen: 10,      // external structure's pivots: higher / lower than 10 bars each side
  internalLen: 3,    // internal structure's
  trendLen: 5,       // the pivots trendlines and patterns are drawn through
  atrPeriod: 14,
  eqTol: 0.1,        // equal highs / lows: within 0.1 ATR
  fvgMin: 0.15,      // a fair value gap of at least 0.15 ATR
  zoneTol: 0.5,      // S/R: pivots within 0.5 ATR are one zone
}

const num = (v) => (typeof v === 'number' ? v : Number(v))

/** Wilder's ATR - each bar's from that bar and those before it (true range averaged, the first `period` simply). */
export function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null)
  let sum = 0
  let atr = null
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
    if (atr == null) {
      sum += tr
      if (i === period - 1) atr = sum / period
      out[i] = i >= period - 1 ? atr : sum / (i + 1)
    } else {
      atr = (atr * (period - 1) + tr) / period
      out[i] = atr
    }
  }
  return out
}

/** Pivot highs / lows: the bar's high above every one of the `len` bars before it and not below any of the `len` after
 *  (the low the mirror). Each { index, price, type: 'high' | 'low', confirmedAt } - confirmedAt = index + len, the bar it
 *  is known on. Sorted by confirmedAt, highs before lows. */
export function pivots(bars, len) {
  const out = []
  for (let i = len; i + len < bars.length; i++) {
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= len && (isHigh || isLow); k++) {
      if (!(bars[i].high > bars[i - k].high) || bars[i].high < bars[i + k].high) isHigh = false
      if (!(bars[i].low < bars[i - k].low) || bars[i].low > bars[i + k].low) isLow = false
    }
    if (isHigh) out.push({ index: i, price: bars[i].high, type: 'high', confirmedAt: i + len })
    if (isLow) out.push({ index: i, price: bars[i].low, type: 'low', confirmedAt: i + len })
  }
  return out
}

/** The pivots as an ALTERNATING sequence high, low, high... - two of a kind in a row keep the more extreme. */
export function zigzag(piv) {
  const out = []
  for (const p of [...piv].sort((a, b) => a.index - b.index || (a.type === 'high' ? -1 : 1))) {
    const last = out.at(-1)
    if (last && last.type === p.type) {
      if (p.type === 'high' ? p.price >= last.price : p.price <= last.price) out[out.length - 1] = p
    } else out.push(p)
  }
  return out
}

// One structure (internal or external): its labelled swings, its breaks, sweeps of its pivots and its trend at the end.
function structureOf(bars, piv, scope) {
  let trend = 0
  let hi = null
  let lo = null
  let prevHigh = null
  let prevLow = null
  const events = []
  const swings = []
  const sweeps = []
  let p = 0
  for (let i = 0; i < bars.length; i++) {
    while (p < piv.length && piv[p].confirmedAt <= i) {
      const v = piv[p++]
      if (v.type === 'high') {
        swings.push({ ...v, scope, label: prevHigh == null ? null : v.price > prevHigh.price ? 'HH' : 'LH' })
        prevHigh = v
        hi = { ...v, crossed: false, swept: false }
      } else {
        swings.push({ ...v, scope, label: prevLow == null ? null : v.price < prevLow.price ? 'LL' : 'HL' })
        prevLow = v
        lo = { ...v, crossed: false, swept: false }
      }
    }
    const b = bars[i]
    if (hi && !hi.crossed) {
      if (b.close > hi.price) {
        events.push({ scope, kind: trend === -1 ? 'CHoCH' : 'BOS', dir: 'bullish', level: hi.price, fromIndex: hi.index, index: i })
        trend = 1
        hi.crossed = true
      } else if (b.high > hi.price && !hi.swept) {
        sweeps.push({ scope, dir: 'bearish', level: hi.price, fromIndex: hi.index, index: i, text: 'swept the high and closed back under' })
        hi.swept = true
      }
    }
    if (lo && !lo.crossed) {
      if (b.close < lo.price) {
        events.push({ scope, kind: trend === 1 ? 'CHoCH' : 'BOS', dir: 'bearish', level: lo.price, fromIndex: lo.index, index: i })
        trend = -1
        lo.crossed = true
      } else if (b.low < lo.price && !lo.swept) {
        sweeps.push({ scope, dir: 'bullish', level: lo.price, fromIndex: lo.index, index: i, text: 'swept the low and closed back over' })
        lo.swept = true
      }
    }
  }
  return { events, swings, sweeps, trend, lastHigh: hi, lastLow: lo }
}

// The order block of a break: the candle with the lowest low (bullish) / highest high (bearish) from the broken pivot to the
// break; mitigated by the first later close through it.
function orderBlockOf(bars, e) {
  let at = e.fromIndex
  for (let k = e.fromIndex; k <= e.index; k++) {
    if (e.dir === 'bullish' ? bars[k].low < bars[at].low : bars[k].high > bars[at].high) at = k
  }
  const top = bars[at].high
  const bottom = bars[at].low
  let mitigatedAt = null
  for (let j = e.index + 1; j < bars.length; j++) {
    if (e.dir === 'bullish' ? bars[j].close < bottom : bars[j].close > top) { mitigatedAt = j; break }
  }
  return { scope: e.scope, dir: e.dir, index: at, createdAt: e.index, top, bottom, mitigatedAt, kind: e.kind }
}

/** Fair value gaps: bullish when the third candle's low is over the first's high (the middle closing over it), at least
 *  `min(i)` wide; bearish the mirror. Each { dir, index (the third candle), top, bottom, filledAt }. */
export function fairValueGaps(bars, min) {
  const out = []
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2]
    const b = bars[i]
    const m = min(i)
    let gap = null
    if (b.low > a.high && bars[i - 1].close > a.high && b.low - a.high >= m) gap = { dir: 'bullish', top: b.low, bottom: a.high }
    else if (b.high < a.low && bars[i - 1].close < a.low && a.low - b.high >= m) gap = { dir: 'bearish', top: a.low, bottom: b.high }
    if (!gap) continue
    let filledAt = null
    for (let j = i + 1; j < bars.length; j++) {
      if (gap.dir === 'bullish' ? bars[j].low <= gap.bottom : bars[j].high >= gap.top) { filledAt = j; break }
    }
    out.push({ ...gap, index: i, filledAt })
  }
  return out
}

/** Equal highs / lows: consecutive pivots of a kind within `tol(i)` of each other. Each { type: 'EQH' | 'EQL', a, b,
 *  level, createdAt (the second pivot known), takenAt (a later bar trading past the level), swept (that bar closing back
 *  inside) }. */
export function equalLevels(bars, piv, tol) {
  const out = []
  let lastHigh = null
  let lastLow = null
  for (const p of piv) {
    const prev = p.type === 'high' ? lastHigh : lastLow
    if (prev && Math.abs(p.price - prev.price) <= tol(p.confirmedAt)) {
      const level = p.type === 'high' ? Math.max(p.price, prev.price) : Math.min(p.price, prev.price)
      let takenAt = null
      let swept = false
      for (let j = p.confirmedAt + 1; j < bars.length; j++) {
        if (p.type === 'high' ? bars[j].high > level : bars[j].low < level) {
          takenAt = j
          swept = p.type === 'high' ? bars[j].close < level : bars[j].close > level
          break
        }
      }
      out.push({ type: p.type === 'high' ? 'EQH' : 'EQL', a: prev, b: p, level, createdAt: p.confirmedAt, takenAt, swept })
    }
    if (p.type === 'high') lastHigh = p
    else lastLow = p
  }
  return out
}

/** Support / resistance zones from pivot prices: sorted, grouped while within `tol` of the group's mean; a zone needs two
 *  turns. Each { low, high, mid, touches, lastIndex, role: 'support' | 'resistance' (against `price`) }. */
export function srZones(piv, tol, price, minHeight = 0) {
  const sorted = [...piv].sort((a, b) => a.price - b.price)
  const groups = []
  for (const p of sorted) {
    const g = groups.at(-1)
    if (g && Math.abs(p.price - g.sum / g.items.length) <= tol) { g.items.push(p); g.sum += p.price } else groups.push({ items: [p], sum: p.price })
  }
  return groups
    .filter((g) => g.items.length >= 2)
    .map((g) => {
      const prices = g.items.map((p) => p.price)
      const mid = g.sum / g.items.length
      let low = Math.min(...prices)
      let high = Math.max(...prices)
      if (high - low < minHeight) { low = mid - minHeight / 2; high = mid + minHeight / 2 }
      return { low, high, mid, touches: g.items.length, lastIndex: Math.max(...g.items.map((p) => p.index)), role: mid <= price ? 'support' : 'resistance' }
    })
}

// A trendline through pivots a and b: its value at bar j.
const lineAt = (a, b, j) => a.price + ((b.price - a.price) / (b.index - a.index)) * (j - a.index)

/** Trendlines: SUPPORT through two pivot lows rising, RESISTANCE through two pivot highs falling, no close past the line
 *  (by more than `tol`) between them, known once the second pivot is; broken by the first later close past it. Of the last
 *  `lookback` pivots of each kind, the unbroken line with the most touches (pivots within `tol` of it, then the latest)
 *  is the one shown, else the line broken last. Each { kind, a, b, touches, knownAt, brokenAt, endIndex }. */
export function trendlines(bars, piv, tol, lookback = 10) {
  const n = bars.length
  const best = (kind) => {
    const points = piv.filter((p) => p.type === (kind === 'support' ? 'low' : 'high')).slice(-lookback)
    let active = null
    let broken = null
    for (let x = 0; x < points.length; x++) {
      for (let y = x + 1; y < points.length; y++) {
        const a = points[x]
        const b = points[y]
        if (b.index - a.index < 3) continue
        if (kind === 'support' ? !(b.price > a.price) : !(b.price < a.price)) continue
        let clean = true
        for (let j = a.index + 1; j < b.index && clean; j++) {
          const v = lineAt(a, b, j)
          if (kind === 'support' ? bars[j].close < v - tol : bars[j].close > v + tol) clean = false
        }
        if (!clean) continue
        let brokenAt = null
        for (let j = b.index + 1; j < n; j++) {
          const v = lineAt(a, b, j)
          if (kind === 'support' ? bars[j].close < v - tol : bars[j].close > v + tol) { brokenAt = j; break }
        }
        if (brokenAt != null && brokenAt <= b.confirmedAt) continue // broken before it could be drawn
        const touches = points.filter((p) => p.index >= a.index && (brokenAt == null || p.index < brokenAt) && Math.abs(p.price - lineAt(a, b, p.index)) <= tol).length
        const line = { kind, a, b, touches, knownAt: b.confirmedAt, brokenAt, endIndex: brokenAt ?? n - 1 }
        if (brokenAt == null) {
          if (!active || touches > active.touches || (touches === active.touches && b.index > active.b.index)) active = line
        } else if (!broken || brokenAt > broken.brokenAt || (brokenAt === broken.brokenAt && (touches > broken.touches || (touches === broken.touches && b.index > broken.b.index)))) broken = line
      }
    }
    return active ?? broken
  }
  return [best('support'), best('resistance')].filter(Boolean)
}

// The first close past a level / line after bar `from`: 'up' / 'down' / null, with the bar.
function breakOut(bars, from, upper, lower, tol) {
  for (let j = from + 1; j < bars.length; j++) {
    if (bars[j].close > upper(j) + tol) return { dir: 'up', index: j }
    if (bars[j].close < lower(j) - tol) return { dir: 'down', index: j }
  }
  return null
}

const PATTERN_SIDE = {
  'Double top': 'bearish', 'Double bottom': 'bullish', 'Head & shoulders': 'bearish', 'Inverse head & shoulders': 'bullish',
  'Ascending triangle': 'bullish', 'Descending triangle': 'bearish', 'Symmetrical triangle': 'neutral',
  'Rising wedge': 'bearish', 'Falling wedge': 'bullish', 'Rising channel': 'bullish', 'Falling channel': 'bearish', Range: 'neutral',
}

/** Chart patterns on the alternating swing sequence `zz` (zigzag of pivots). `atrAt(i)` sizes "equal" and "flat".
 *  Each { name, side, points, lines: [{ a, b }], neckline, knownAt, status: 'forming' | 'confirmed' | 'failed', at,
 *  target }. The newest few, an older pattern overlapping a newer one dropped. */
export function chartPatterns(bars, zz, atrAt, max = 8) {
  const found = []
  const add = (p) => found.push({ ...p, side: p.side ?? PATTERN_SIDE[p.name] })
  for (let k = 2; k < zz.length; k++) {
    const last = zz[k]
    const atr = atrAt(last.confirmedAt) || atrAt(last.index) || 1
    const tol = 0.1 * atr
    // Double top / bottom: two extremes within 0.6 ATR, the swing between them at least 1.5 ATR away.
    {
      const [x, m, y] = zz.slice(k - 2, k + 1)
      if (x.type === y.type && y.index - x.index >= 4 && Math.abs(x.price - y.price) <= 0.6 * atr) {
        const top = x.type === 'high'
        const depth = top ? Math.min(x.price, y.price) - m.price : m.price - Math.max(x.price, y.price)
        if (depth >= 1.5 * atr) {
          const extreme = top ? Math.max(x.price, y.price) : Math.min(x.price, y.price)
          const out = breakOut(bars, y.index, () => (top ? extreme : m.price), () => (top ? m.price : extreme), tol)
          const confirmed = out && (top ? out.dir === 'down' : out.dir === 'up')
          add({
            name: top ? 'Double top' : 'Double bottom', points: [x, m, y], lines: [{ a: x, b: y }],
            neckline: { a: { index: m.index, price: m.price }, b: { index: bars.length - 1, price: m.price } }, knownAt: y.confirmedAt,
            status: out ? (confirmed ? 'confirmed' : 'failed') : 'forming', at: out?.index ?? null,
            target: top ? m.price - depth : m.price + depth,
          })
        }
      }
    }
    // Head & shoulders: shoulder, neck, head, neck, shoulder - the head 0.6 ATR past both shoulders, the shoulders within
    // 40% of the head's height of each other; the neckline through the two necks.
    if (k >= 4) {
      const [s1, n1, h, n2, s2] = zz.slice(k - 4, k + 1)
      const top = h.type === 'high'
      if (s1.type === h.type && s2.type === h.type) {
        const neck = (j) => lineAt(n1, n2, j)
        const height = top ? h.price - (n1.price + n2.price) / 2 : (n1.price + n2.price) / 2 - h.price
        const headOut = top ? h.price - Math.max(s1.price, s2.price) : Math.min(s1.price, s2.price) - h.price
        const shouldersOut = top ? Math.min(s1.price - neck(s1.index), s2.price - neck(s2.index)) : Math.min(neck(s1.index) - s1.price, neck(s2.index) - s2.price)
        if (headOut >= 0.6 * atr && height >= 2 * atr && Math.abs(s1.price - s2.price) <= 0.4 * height && shouldersOut >= 0.5 * atr) {
          const out = breakOut(bars, s2.index, (j) => (top ? h.price : neck(j)), (j) => (top ? neck(j) : h.price), tol)
          const confirmed = out && (top ? out.dir === 'down' : out.dir === 'up')
          add({
            name: top ? 'Head & shoulders' : 'Inverse head & shoulders', points: [s1, n1, h, n2, s2], lines: [],
            neckline: { a: n1, b: { index: bars.length - 1, price: neck(bars.length - 1) } }, knownAt: s2.confirmedAt,
            status: out ? (confirmed ? 'confirmed' : 'failed') : 'forming', at: out?.index ?? null,
            target: out ? (top ? neck(out.index) - height : neck(out.index) + height) : null,
          })
        }
      }
    }
    // Triangles, wedges, channels, ranges: the last two highs and the last two lows (four or five swings).
    if (k >= 3) {
      const pts = zz.slice(Math.max(0, k - 4), k + 1)
      const highs = pts.filter((p) => p.type === 'high').slice(-2)
      const lows = pts.filter((p) => p.type === 'low').slice(-2)
      if (highs.length === 2 && lows.length === 2) {
        const [h1, h2] = highs
        const [l1, l2] = lows
        const start = Math.min(h1.index, l1.index)
        const end = Math.max(h2.index, l2.index)
        const upper = (j) => lineAt(h1, h2, j)
        const lower = (j) => lineAt(l1, l2, j)
        const w0 = upper(start) - lower(start)
        const w1 = upper(end) - lower(end)
        const flat = 0.5 * atr
        const du = upper(end) - upper(start)
        const dl = lower(end) - lower(start)
        const upFlat = Math.abs(du) <= flat
        const lowFlat = Math.abs(dl) <= flat
        let name = null
        if (w0 > 1.5 * atr && w1 > 0) {
          const converging = w1 < 0.8 * w0
          const parallel = Math.abs(w1 - w0) <= 0.25 * w0
          if (upFlat && lowFlat) name = 'Range'
          else if (upFlat && dl > flat && converging) name = 'Ascending triangle'
          else if (lowFlat && du < -flat && converging) name = 'Descending triangle'
          else if (du < -flat && dl > flat) name = 'Symmetrical triangle'
          else if (du > flat && dl > flat && converging) name = 'Rising wedge'
          else if (du < -flat && dl < -flat && converging) name = 'Falling wedge'
          else if (du > flat && dl > flat && parallel) name = 'Rising channel'
          else if (du < -flat && dl < -flat && parallel) name = 'Falling channel'
        }
        if (name) {
          const out = breakOut(bars, end, upper, lower, tol)
          const side = PATTERN_SIDE[name]
          const status = !out ? 'forming' : side === 'neutral' ? 'confirmed' : (out.dir === 'up') === (side === 'bullish') ? 'confirmed' : 'failed'
          add({
            name, side: side === 'neutral' && out ? (out.dir === 'up' ? 'bullish' : 'bearish') : side,
            points: pts, lines: [{ a: h1, b: h2 }, { a: l1, b: l2 }], neckline: null, knownAt: last.confirmedAt,
            status, at: out?.index ?? null, breakout: out?.dir ?? null,
            target: out ? (out.dir === 'up' ? upper(out.index) + w0 : lower(out.index) - w0) : null,
          })
        }
      }
    }
  }
  // Newest first; an older pattern sharing swings with a newer one is the same picture - dropped.
  const kept = []
  for (const p of found.sort((a, b) => b.knownAt - a.knownAt)) {
    const lo = Math.min(...p.points.map((q) => q.index))
    if (kept.some((q) => Math.max(...p.points.map((x) => x.index)) > Math.min(...q.points.map((x) => x.index)) && lo < Math.max(...q.points.map((x) => x.index)))) continue
    kept.push(p)
    if (kept.length >= max) break
  }
  return kept
}

/** Everything above for one series of candles ({ time, open, high, low, close }, oldest first). */
export function analyzeStructure(rawBars, options = {}) {
  const o = { ...STRUCTURE_DEFAULTS, ...options }
  const bars = (rawBars ?? []).map((b) => ({ ...b, open: num(b.open), high: num(b.high), low: num(b.low), close: num(b.close) }))
  const n = bars.length
  // Too few candles to read (a replay's first minutes: one forming Day / 4H candle): the same shape with nothing found and
  // every trend undecided - n is still the candles there, so a reader guarding on `n` must find bias / swing readable.
  const none = { events: [], swings: [], sweeps: [], lastHigh: null, lastLow: null, trend: 0, trendName: 'undecided' }
  const empty = {
    bars, n, atr: [], price: bars[n - 1]?.close ?? null, lastAtr: 0, options: o,
    swing: { ...none }, internal: { ...none }, events: [], swings: [], sweeps: [], orderBlocks: [], fvgs: [], equal: [], zones: [],
    trendlines: [], patterns: [], range: null, strongWeak: null,
    bias: { swing: 'undecided', internal: 'undecided', lastSwing: null, lastInternal: null },
  }
  if (n < 3) return empty
  const atr = atrSeries(bars, o.atrPeriod)
  const atrAt = (i) => atr[Math.max(0, Math.min(n - 1, i))] ?? 0
  const lastAtr = atr[n - 1] || 1
  const price = bars[n - 1].close

  const swingPiv = pivots(bars, o.swingLen).sort((a, b) => a.confirmedAt - b.confirmedAt)
  const internalPiv = pivots(bars, o.internalLen).sort((a, b) => a.confirmedAt - b.confirmedAt)
  const trendPiv = pivots(bars, o.trendLen).sort((a, b) => a.confirmedAt - b.confirmedAt)

  const swing = structureOf(bars, swingPiv, 'swing')
  const internal = structureOf(bars, internalPiv, 'internal')
  const external = new Set(swing.events.map((e) => `${e.dir}|${e.level}|${e.index}`))
  internal.events = internal.events.filter((e) => !external.has(`${e.dir}|${e.level}|${e.index}`))
  const events = [...swing.events, ...internal.events].sort((a, b) => a.index - b.index || (a.scope === 'swing' ? -1 : 1))

  const orderBlocks = events.map((e) => orderBlockOf(bars, e))
  const fvgs = fairValueGaps(bars, (i) => o.fvgMin * atrAt(i))
  const equal = equalLevels(bars, internalPiv, (i) => o.eqTol * atrAt(i))
  const zones = srZones(internalPiv, o.zoneTol * lastAtr, price, 0.2 * lastAtr)
  const lines = trendlines(bars, trendPiv, 0.2 * lastAtr)
  const patterns = chartPatterns(bars, zigzag(trendPiv), atrAt)

  // The dealing range: the last swing high and low (or the extreme printed since), its premium / discount.
  let range = null
  const sh = swing.lastHigh
  const sl = swing.lastLow
  if (sh && sl) {
    let top = sh.price
    let bottom = sl.price
    for (let j = sh.index + 1; j < n; j++) top = Math.max(top, bars[j].high)
    for (let j = sl.index + 1; j < n; j++) bottom = Math.min(bottom, bars[j].low)
    const eq = (top + bottom) / 2
    const pos = top > bottom ? (price - bottom) / (top - bottom) : 0.5
    range = { top, bottom, eq, pos, zone: pos > 0.525 ? 'premium' : pos < 0.475 ? 'discount' : 'equilibrium', from: Math.min(sh.index, sl.index) }
  }

  // Strong / weak: the last swing break - its origin must hold, the far extreme is the target.
  let strongWeak = null
  const lastSwing = swing.events.at(-1)
  if (lastSwing) {
    let originAt = lastSwing.fromIndex
    for (let k = lastSwing.fromIndex; k <= lastSwing.index; k++) {
      if (lastSwing.dir === 'bullish' ? bars[k].low < bars[originAt].low : bars[k].high > bars[originAt].high) originAt = k
    }
    let farAt = lastSwing.index
    for (let k = lastSwing.index; k < n; k++) {
      if (lastSwing.dir === 'bullish' ? bars[k].high > bars[farAt].high : bars[k].low < bars[farAt].low) farAt = k
    }
    strongWeak = lastSwing.dir === 'bullish'
      ? { strong: { type: 'low', index: originAt, price: bars[originAt].low }, weak: { type: 'high', index: farAt, price: bars[farAt].high } }
      : { strong: { type: 'high', index: originAt, price: bars[originAt].high }, weak: { type: 'low', index: farAt, price: bars[farAt].low } }
  }

  const trendName = (t) => (t === 1 ? 'bullish' : t === -1 ? 'bearish' : 'undecided')
  const lastInternal = internal.events.at(-1)
  return {
    bars, n, atr, price, lastAtr, options: o,
    swing: { ...swing, trendName: trendName(swing.trend) },
    internal: { ...internal, trendName: trendName(internal.trend) },
    events,
    swings: [...swing.swings, ...internal.swings],
    // Sweeps of the SWING pivots only - every internal pivot's wick would be noise.
    sweeps: swing.sweeps,
    orderBlocks, fvgs, equal, zones, trendlines: lines, patterns, range, strongWeak,
    bias: { swing: trendName(swing.trend), internal: trendName(internal.trend), lastSwing: lastSwing ?? null, lastInternal: lastInternal ?? null },
  }
}

/** The active things worth drawing / listing at the last bar: unmitigated order blocks (newest `maxOb` of each scope),
 *  unfilled gaps (`maxFvg`), untaken equal levels, the S/R zones nearest price (`maxZones` each side). */
export function activeLevels(a, { maxOb = 3, maxFvg = 5, maxZones = 3 } = {}) {
  if (!a?.n) return { orderBlocks: [], fvgs: [], equal: [], support: [], resistance: [] }
  const live = (x) => x.mitigatedAt == null
  const obs = ['swing', 'internal'].flatMap((scope) => a.orderBlocks.filter((b) => b.scope === scope && live(b)).slice(-maxOb))
  const fvgs = a.fvgs.filter((g) => g.filledAt == null).slice(-maxFvg)
  const equal = a.equal.filter((q) => q.takenAt == null).slice(-4)
  const support = a.zones.filter((z) => z.role === 'support').sort((x, y) => y.mid - x.mid).slice(0, maxZones)
  const resistance = a.zones.filter((z) => z.role === 'resistance').sort((x, y) => x.mid - y.mid).slice(0, maxZones)
  return { orderBlocks: obs, fvgs, equal, support, resistance }
}

/** The TOP-DOWN read of a higher and a lower timeframe's analyses: the higher one's swing trend and where price sits in its
 *  dealing range, the lower one's structure against it. Returns { verdict, side, lines: [string] }. */
export function topDownRead(htf, ltf, names = { htf: 'Higher TF', ltf: 'Lower TF' }) {
  if (!htf?.n || !ltf?.n || !htf.bias || !ltf.bias) return { verdict: 'Not enough candles', side: 'neutral', lines: [] }
  const h = htf.bias.swing
  const lInt = ltf.bias.internal
  const lSw = ltf.bias.swing
  const lastL = ltf.events.at(-1)
  const zone = htf.range?.zone
  const lines = []
  lines.push(`${names.htf}: ${h === 'undecided' ? 'no swing break yet' : `${h} structure`}${htf.bias.lastSwing ? ` (last ${htf.bias.lastSwing.kind} ${htf.bias.lastSwing.dir} at ${fmt(htf.bias.lastSwing.level)})` : ''}${zone ? `, price in its ${zone} (${Math.round(htf.range.pos * 100)}% of the range ${fmt(htf.range.bottom)} - ${fmt(htf.range.top)})` : ''}.`)
  lines.push(`${names.ltf}: swing ${lSw}, internal ${lInt}${lastL ? ` - last ${lastL.scope} ${lastL.kind} ${lastL.dir} at ${fmt(lastL.level)}` : ''}.`)
  let verdict
  let side = 'neutral'
  if (h === 'bullish') {
    if (lInt === 'bullish' && lSw !== 'bearish') { verdict = 'ALIGNED BULLISH - trend and timing agree'; side = 'bullish' }
    else if (lastL?.kind === 'CHoCH' && lastL.dir === 'bearish') { verdict = 'PULLBACK in a higher-TF uptrend - wait for a bullish CHoCH on the lower TF'; side = 'neutral' }
    else { verdict = 'Higher TF bullish, lower TF against it - pullback / no entry yet'; side = 'neutral' }
    if (zone === 'discount' && lInt === 'bullish') verdict += ' · in the discount: the buy zone'
    if (zone === 'premium') verdict += ' · in the premium: late to buy here'
  } else if (h === 'bearish') {
    if (lInt === 'bearish' && lSw !== 'bullish') { verdict = 'ALIGNED BEARISH - trend and timing agree'; side = 'bearish' }
    else if (lastL?.kind === 'CHoCH' && lastL.dir === 'bullish') { verdict = 'PULLBACK in a higher-TF downtrend - wait for a bearish CHoCH on the lower TF'; side = 'neutral' }
    else { verdict = 'Higher TF bearish, lower TF against it - pullback / no entry yet'; side = 'neutral' }
    if (zone === 'premium' && lInt === 'bearish') verdict += ' · in the premium: the sell zone'
    if (zone === 'discount') verdict += ' · in the discount: late to sell here'
  } else {
    verdict = lInt === 'undecided' ? 'No structure yet' : `Higher TF undecided - lower TF ${lInt}, trade the range edges`
  }
  return { verdict, side, lines }
}

function fmt(v) {
  return v == null ? '-' : Math.round(v * 100) / 100
}
