// GoCharting's chart SDK (their footprint / cluster chart) fed with OUR data: the Order Flow page's GoCharting
// view. GoCharting hosts the SDK per license key (https://gocharting.com/sdk/library/{key}/index.umd.js); it
// calls a datafeed we give it - getBars for the history (OHLCV only), subscribeTicks for live trades, which it
// builds its footprint cells from (each trade's price, quantity and BUY / SELL side). With a custom datafeed
// the SDK has no way to take the per-price volumes of past bars, so its footprint shows on the bars formed
// while the chart is open; earlier bars are plain candles.

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

/** The symbol key the SDK uses, EXCHANGE:SEGMENT:SYMBOL - the index future. */
export const goChartingSymbol = (underlying) => `${underlying === 'SENSEX' ? 'BSE' : 'NSE'}:FUTURE:${underlying}-I`

const RESOLUTIONS = ['1m', '2m', '3m', '5m', '10m', '15m', '30m']

/** The minutes of an SDK resolution ('5m', { scale: 'minutes', units: 5 }, { type: '5m' } ...); 1 when unknown. */
export function resolutionMinutes(resolution) {
  if (resolution == null) return 1
  if (typeof resolution === 'object') {
    if (resolution.scale === 'minutes') return Math.max(1, Number(resolution.units) || 1)
    if (resolution.scale === 'hours') return 60 * Math.max(1, Number(resolution.units) || 1)
    return resolutionMinutes(resolution.type ?? resolution.baseType)
  }
  const m = String(resolution).match(/^(\d+)\s*(m|min|h)?$/i)
  if (!m) return 1
  return Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 60 : 1)
}

/**
 * Our 1-minute bars as the SDK's history (UDF shape, unix SECONDS): only minutes that have finished by
 * `nowMs` (the running minute is built by the SDK from the live trades - giving it here as well would count
 * its volume twice), aggregated to `minutes`, within [fromMs, toMs] when given.
 */
export function udfFromBars(minuteBars, { nowMs = Infinity, minutes = 1, fromMs = null, toMs = null } = {}) {
  const done = (minuteBars ?? []).filter((b) => msOf(b.time) + MIN <= nowMs)
  const buckets = []
  for (const b of done) {
    const t = msOf(b.time)
    const start = t - (t % (minutes * MIN))
    const last = buckets.at(-1)
    const volume = b.volume ?? ((b.buy ?? 0) + (b.sell ?? 0))
    if (last && last.t === start) {
      last.h = Math.max(last.h, b.high)
      last.l = Math.min(last.l, b.low)
      last.c = b.close
      last.v += volume
    } else {
      buckets.push({ t: start, o: b.open, h: b.high, l: b.low, c: b.close, v: volume })
    }
  }
  const inRange = buckets.filter((b) => (fromMs == null || b.t >= fromMs) && (toMs == null || b.t <= toMs))
  const rows = inRange.length ? inRange : buckets
  if (!rows.length) return { s: 'no_data', nextTime: null }
  return {
    s: 'ok', t: rows.map((b) => Math.floor(b.t / 1000)), o: rows.map((b) => b.o), h: rows.map((b) => b.h),
    l: rows.map((b) => b.l), c: rows.map((b) => b.c), v: rows.map((b) => b.v),
  }
}

/** One of our tape prints as the SDK's trade tick. */
export function tradeTick(print, underlying) {
  const key = goChartingSymbol(underlying)
  const [exchange, segment, symbol] = key.split(':')
  const quantity = Number(print.quantity) || 0
  return {
    type: 'trade', productId: key, symbol, exchange, segment,
    timeStamp: new Date(msOf(print.time)), tradeID: String(print.seq ?? `${msOf(print.time)}-${print.price}-${quantity}`),
    price: print.price, quantity, amount: print.price * quantity, side: print.buy ? 'BUY' : 'SELL',
  }
}

/** The symbol description the SDK needs for the index future (meta: the order-flow snapshot's meta). */
export function symbolInfoFor(underlying, meta = {}) {
  const key = goChartingSymbol(underlying)
  const [exchange, segment, symbol] = key.split(':')
  const tick = meta.tickSize > 0 ? meta.tickSize : 0.05
  const precision = Math.max(0, Math.min(4, (String(tick).split('.')[1] ?? '').length))
  return {
    exchange, segment, symbol, ticker: symbol, full_name: key,
    name: meta.contractSymbol ?? `${underlying} futures`, description: meta.contractSymbol ?? `${underlying} futures (near month)`,
    type: 'futures', asset_type: 'FUTURE', is_index: false, session: '0915-1530', timezone: 'Asia/Kolkata',
    has_intraday: true, has_daily: false, supported_resolutions: RESOLUTIONS,
    tick_size: tick, display_tick_size: tick, max_tick_precision: precision, data_status: 'streaming', delay_seconds: 0,
    tradeable: false, quote_currency: 'INR',
    exchange_info: { name: exchange.toLowerCase(), code: exchange, zone: 'Asia/Kolkata', hours: Array.from({ length: 7 }, () => ({ open: true })), valid_intervals: RESOLUTIONS },
  }
}

/**
 * The datafeed object the SDK calls. `source()` returns what the page has now: { underlying, meta, minuteBars,
 * nowMs (the replay clock; null live - now), prints }. Live trades are pushed with `push(prints)`; on subscribing, the prints of the running minute
 * are sent first so the current bar starts complete.
 */
export function createGoChartingDatafeed(source) {
  const subs = new Map()
  return {
    onReady(cb) { setTimeout(() => cb({ supported_resolutions: RESOLUTIONS }), 0) },
    resolveSymbol(_name, onResolve) {
      const { underlying, meta } = source()
      setTimeout(() => onResolve(symbolInfoFor(underlying, meta)), 0)
    },
    async getBars(_symbolInfo, resolution, periodParams) {
      const { minuteBars } = source()
      const nowMs = source().nowMs ?? Date.now()
      const toMs = (v) => (v == null ? null : v instanceof Date ? v.getTime() : Number(v) > 1e12 ? Number(v) : Number(v) * 1000)
      return udfFromBars(minuteBars, { nowMs, minutes: resolutionMinutes(resolution), fromMs: toMs(periodParams?.from), toMs: toMs(periodParams?.to) })
    },
    subscribeTicks(_symbolInfo, _resolution, onTick, uid) {
      subs.set(uid, onTick)
      const { underlying, prints, nowMs } = source()
      const minuteStart = Math.floor((nowMs ?? Date.now()) / MIN) * MIN
      for (const p of prints ?? []) if (msOf(p.time) >= minuteStart) onTick(tradeTick(p, underlying))
    },
    unsubscribeTicks(uid) { subs.delete(uid) },
    searchSymbols(_q, _ex, _type, onResult) { onResult({ searchInProgress: false, items: [] }) },
    /** New live prints -> every subscriber. */
    push(prints) {
      if (!subs.size || !prints?.length) return
      const { underlying } = source()
      for (const cb of subs.values()) for (const p of prints) cb(tradeTick(p, underlying))
    },
    subscribers: () => subs.size,
  }
}

/** Loads GoCharting's hosted SDK once per URL; resolves with window.GoChartingSDK. */
const loading = new Map()
export function loadGoChartingSdk(scriptUrl, { timeoutMs = 30_000 } = {}) {
  if (typeof window === 'undefined') return Promise.reject(new Error('no browser'))
  if (window.GoChartingSDK?.createChart) return Promise.resolve(window.GoChartingSDK)
  if (loading.has(scriptUrl)) return loading.get(scriptUrl)
  const promise = new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = scriptUrl
    el.async = true
    el.onerror = () => { loading.delete(scriptUrl); reject(new Error('GoCharting\'s chart SDK could not be loaded (network, or the license key)')) }
    document.head.appendChild(el)
    const started = Date.now()
    const wait = () => {
      if (window.GoChartingSDK?.createChart) resolve(window.GoChartingSDK)
      else if (Date.now() - started > timeoutMs) { loading.delete(scriptUrl); reject(new Error('GoCharting\'s chart SDK did not start in time')) }
      else setTimeout(wait, 100)
    }
    el.onload = wait
  })
  loading.set(scriptUrl, promise)
  return promise
}
