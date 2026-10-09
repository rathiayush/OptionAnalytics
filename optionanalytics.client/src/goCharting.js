// GoCharting's own order flow per 1-minute bar (sent to the server by a Lipi alert's webhook - see the
// server's GoChartingStore): its tick-by-tick buy / sell volume, delta and session cumulative delta. GoCharting
// exposes no per-price footprint cells or volume profile to scripts, so this is per bar only. React-free -
// the Order Flow page, the scanner and the server runner use it.

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

/** How many of our units one GoCharting unit is: 1 when both count the same quantity, the lot size when
 *  GoCharting counts contracts (lots) - read from the volume of the minutes both have. */
export function goChartingScale(minuteBars, gcBars, lotSize = 1) {
  const ours = new Map((minuteBars ?? []).map((b) => [Math.floor(msOf(b.time) / MIN) * MIN, b.volume ?? ((b.buy ?? 0) + (b.sell ?? 0))]))
  const ratios = (gcBars ?? []).map((g) => (g.volume > 0 && ours.get(g.time) > 0 ? ours.get(g.time) / g.volume : null)).filter((r) => r != null).sort((a, b) => a - b)
  if (!ratios.length || !(lotSize > 1)) return 1
  const median = ratios[Math.floor(ratios.length / 2)]
  return Math.abs(Math.log(median / lotSize)) < Math.abs(Math.log(median)) ? lotSize : 1
}

/**
 * GoCharting's figures for each footprint bar (`bars` - our bars of `timeframe` minutes): the 1-minute
 * GoCharting bars inside it summed (buy, sell, delta, volume), its cumulative delta at the bar's last minute.
 * Only complete bars (every minute present) are given. Returns Map<bar start ms, { buy, sell, delta, cvd, volume, minutes }>.
 */
export function goChartingByBar(bars, gcBars, timeframe = 1, scale = 1) {
  const byMinute = new Map((gcBars ?? []).map((g) => [g.time, g]))
  const out = new Map()
  for (const b of bars ?? []) {
    const start = Math.floor(msOf(b.time) / MIN) * MIN
    const minutes = []
    for (let i = 0; i < timeframe; i++) {
      const g = byMinute.get(start + i * MIN)
      if (g) minutes.push(g)
    }
    if (minutes.length !== timeframe) continue
    const sum = (k) => (minutes.every((g) => g[k] != null) ? minutes.reduce((s, g) => s + g[k], 0) * scale : null)
    const delta = minutes.every((g) => g.delta != null) ? sum('delta') : sum('buyVolume') != null && sum('sellVolume') != null ? sum('buyVolume') - sum('sellVolume') : null
    const last = minutes.at(-1)
    out.set(start, { buy: sum('buyVolume'), sell: sum('sellVolume'), delta, cvd: last.cvd != null ? last.cvd * scale : null, volume: sum('volume'), minutes: minutes.length })
  }
  return out
}

/**
 * The scanner's completed 1-minute bars with GoCharting's delta and cumulative delta in place of ours - only
 * when GoCharting has every one of the last `window` completed bars (a window that mixed the two sources
 * would compare one feed's cumulative delta with the other's). The per-price reads (stacks, absorption,
 * exhaustion) stay ours - GoCharting does not send them. No look-ahead: only bars that finished by `nowMs`
 * are touched, and a GoCharting bar is the one sent when that minute finished.
 * Returns { bars, used: boolean, reason }.
 */
export function withGoChartingDelta(bars, gcBars, nowMs, { window = 20, scale = 1 } = {}) {
  if (!bars?.length || !gcBars?.length) return { bars, used: false, reason: 'no GoCharting bars' }
  const byMinute = new Map(gcBars.filter((g) => g.time + MIN <= nowMs).map((g) => [g.time, g]))
  const recent = bars.slice(-window)
  const missing = recent.filter((b) => byMinute.get(Math.floor(msOf(b.time) / MIN) * MIN)?.delta == null)
  if (missing.length) return { bars, used: false, reason: `GoCharting is missing ${missing.length} of the last ${recent.length} bars` }
  // GoCharting's own session CVD where it sent one; else its deltas added up from the first bar it has.
  let running = null
  const out = bars.map((b) => {
    const g = byMinute.get(Math.floor(msOf(b.time) / MIN) * MIN)
    if (!g || g.delta == null) { running = null; return b }
    const delta = g.delta * scale
    running = g.cvd != null ? g.cvd * scale : (running ?? 0) + delta
    return { ...b, delta, cvd: running, deltaSource: 'gocharting' }
  })
  return { bars: out, used: true, reason: null }
}
