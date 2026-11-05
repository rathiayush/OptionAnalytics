// The Signal backtest's DAY CHART (SignalBacktestChart.jsx): one day of a run on its own candles - the spot (or the
// futures the VWAP is read on) at the run's timeframe, with the trades TAGGED: a BUY / SELL arrow at the candle each
// trade entered on (green a bullish signal, red a bearish one), a dot where it went out (green a profit, red a loss) and
// a grey dot for each signal that was not taken. The lines are the engine's own - the VWAP, the EMAs and RSI of the spot
// candles (`emaSeries` / `rsiSeries`), the previous session's pivot points and CPR - so the chart shows what the rule read.
// Pure functions: `tests/signal-backtest-chart.test.mjs`.
import { emaSeries, istMinute, normalizeRule, premiumCandles, premiumEma, premiumRsi, rsiSeries, timeframeView } from './signalBacktest.js'

const MIN = 60_000
const SESSION_FIRST = 9 * 60 + 15

/** The start of the `tf`-minute candle (from 09:15) that minute `ms` is in - where its marker goes. */
export function candleStart(ms, tf = 1) {
  const m = istMinute(ms)
  const off = (((m - SESSION_FIRST) % tf) + tf) % tf
  return ms - off * MIN
}

/** What a rule reads that the chart can draw: the EMA periods (the crossovers' fast and slow, price vs EMA's - of spot or a
 *  premium), the RSI period and the levels it is compared with (and spot's mirror's - from the other end), whether it reads
 *  the pivots, and whether it reads an option's premium. */
export function ruleIndicators(rule) {
  const r = normalizeRule(rule, null)
  const ema = new Set()
  const rsiLevels = new Set()
  let rsi = null
  let pivots = false
  let premium = false
  for (const l of r.lines) {
    if (/Prem/.test(l.id)) premium = true
    if (l.id === 'emaCross' || /PremEmaCross$/.test(l.id)) { ema.add(l.param2); ema.add(l.param3) } else if (l.id === 'emaPrice' || /PremEma$/.test(l.id)) ema.add(l.param2)
    else if (l.id === 'rsi' || /PremRsi$/.test(l.id)) {
      rsi ??= l.param2
      rsiLevels.add(l.param)
      // Spot's RSI mirrors its level (above 60 <-> below 40); a premium's mirror is the other side's at the same level.
      if (r.mirror && l.id === 'rsi') rsiLevels.add(100 - l.param)
    } else if (l.id === 'cpr' || l.id.startsWith('pivot')) pivots = true
  }
  const nums = (set) => [...set].filter(Number.isFinite).sort((a, b) => a - b)
  return { ema: nums(ema), rsi, rsiLevels: nums(rsiLevels), pivots, premium }
}

/**
 * A prepared day as the chart draws it, on `timeframe`-minute candles from 09:15: { tf, futures, candles: [{ time, open,
 * high, low, close }], vwap, emas: [{ period, points }], rsi: { period, points } | null, pivots } - every time a candle's
 * START (ms). `source` 'futures' draws the futures (the prices the VWAP is read on, when they cover the day) with their
 * VWAP; 'spot' the index with ITS OWN VWAP (none when the index had no volume) - the EMAs, RSI and pivots are the
 * spot's (on the futures the EMAs and pivots, which sit at spot's prices, are left out; RSI has its own pane). 'option'
 * with `option` { side: 'ce' | 'pe', strike } draws that strike's premium (`premiumCandles`) with ITS OWN VWAP, EMAs and RSI.
 */
export function dayChartData(day, { timeframe = 1, source = 'spot', ema = [], rsi = null, option = null } = {}) {
  if (!day?.ok) return null
  const view = timeframeView(day, timeframe)
  const tf = view.tf ?? 1
  if (source === 'option' && option && (option.side === 'ce' || option.side === 'pe')) {
    // An option's premium on its own candles, with its own VWAP, EMAs and RSI (the conditions' series).
    const { side, strike } = option
    const p = premiumCandles(view, side, strike)
    const times = Array.from(view.t, (ms) => candleStart(ms, tf))
    const line = (values) => times.map((time, k) => ({ time, value: values[k] })).filter((x) => Number.isFinite(x.value))
    return {
      tf, futures: false, option: { side, strike },
      candles: times.map((time, k) => ({ time, open: p.o[k], high: p.h[k], low: p.l[k], close: p.c[k] })).filter((c) => Number.isFinite(c.close)),
      vwap: line(p.vwap),
      emas: ema.map((period) => ({ period, points: line(premiumEma(view, side, strike, period)) })),
      rsi: rsi ? { period: rsi, points: line(premiumRsi(view, side, strike, rsi)) } : null,
      pivots: null,
    }
  }
  const futures = source === 'futures' && day.priceSource === 'futures'
  const bars = futures ? view.price : view.spot
  const times = Array.from(view.t, (ms) => candleStart(ms, tf))
  const candles = times.map((time, k) => ({ time, open: bars.o[k], high: bars.h[k], low: bars.l[k], close: bars.c[k] }))
  const line = (values) => (values ? times.map((time, k) => ({ time, value: values[k] })).filter((p) => Number.isFinite(p.value)) : [])
  const spotVwap = view.spotVwap ?? (day.priceSource === 'spot' ? view.vwap : null)
  return {
    tf, futures, candles,
    vwap: line(futures ? view.vwap : spotVwap),
    emas: futures ? [] : ema.map((period) => ({ period, points: line(emaSeries(view, period)) })),
    rsi: rsi ? { period: rsi, points: line(rsiSeries(view, rsi)) } : null,
    pivots: futures ? null : (day.pivots ?? null),
  }
}

const rupee = (v) => `${v < 0 ? '−' : '+'}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`

/** The trades as markers, time order: a BUY / SELL arrow at the entry candle (under it, pointing up, for a bullish signal;
 *  over it, down, for a bearish one), and a dot at the exit candle - green a net profit, red a loss - with the net. */
export function tradeMarkers(trades, tf = 1, { up = '#26a69a', down = '#ef5350' } = {}) {
  const out = []
  for (const t of trades ?? []) {
    const bull = t.dir > 0
    out.push({ time: candleStart(t.entryTime, tf), position: bull ? 'belowBar' : 'aboveBar', shape: bull ? 'arrowUp' : 'arrowDown', color: bull ? up : down, text: `${t.action} ${t.strike} ${t.side}` })
    out.push({ time: candleStart(t.exitTime, tf), position: bull ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.net >= 0 ? up : down, text: `Exit ${rupee(t.net)}` })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** The signals that were NOT taken (a trade still open, the cooldown, the day's limit, outside the entry window) - a small
 *  grey dot each, on the side of its direction; none on a candle a trade entered on. */
export function skippedMarkers(signals, trades, tf = 1, color = '#8c8c8c') {
  const entered = new Set((trades ?? []).map((t) => candleStart(t.entryTime, tf)))
  return (signals ?? [])
    .filter((s) => !s.taken)
    .map((s) => ({ time: candleStart(s.time, tf), position: s.dir > 0 ? 'belowBar' : 'aboveBar', shape: 'circle', color, size: 0.6, text: '' }))
    .filter((m, k, all) => !entered.has(m.time) && all.findIndex((x) => x.time === m.time && x.position === m.position) === k)
}

/** The day picked by default: the first day of the report with a trade, else its first day that ran. */
export function defaultChartDay(dayRows) {
  const ok = (dayRows ?? []).filter((r) => r.ok)
  return (ok.find((r) => r.trades > 0) ?? ok[0])?.date ?? null
}

/** The options a day's chart can show: every strike loaded, CE and PE ({ value: 'ce|25000', side, strike }), ATM first. */
export function dayOptions(day) {
  if (!day?.ok) return []
  const atm = day.atm?.[0]
  const strikes = [...new Set([...(day.ce?.keys() ?? []), ...(day.pe?.keys() ?? [])])].sort((a, b) => Math.abs(a - atm) - Math.abs(b - atm) || a - b)
  return strikes.flatMap((strike) => ['ce', 'pe'].filter((side) => (side === 'ce' ? day.ce : day.pe)?.has(strike)).map((side) => ({ value: `${side}|${strike}`, side, strike })))
}

/** The option a day's chart opens on: the first trade's (its strike and side), else the ATM call at the open. */
export function defaultChartOption(day, trades) {
  const t = (trades ?? [])[0]
  if (t) return { side: t.side === 'PE' ? 'pe' : 'ce', strike: t.strike }
  const atm = day?.atm?.[0]
  return Number.isFinite(atm) ? { side: 'ce', strike: atm } : null
}
