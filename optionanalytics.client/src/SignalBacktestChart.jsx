import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, InputNumber, Segmented, Select, Space, Spin, Tag, Typography } from 'antd'
import { CloseOutlined, LeftOutlined, LineChartOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { CandlestickSeries, CrosshairMode, LineSeries, LineStyle, createSeriesMarkers } from 'lightweight-charts'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, useMediaQuery, usePersistedState } from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { TIMEFRAMES, istMinute, optionName, simulateDay } from './signalBacktest.js'
import { engineSettings } from './signalBacktestJob.js'
import { dayChartData, dayOptions, defaultChartDay, defaultChartOption, ruleIndicators, skippedMarkers, tradeMarkers } from './signalBacktestChart.js'
import { FoldText } from './FoldText.jsx'

// The Signal backtest's DAY CHART card: a day of the report on the run's own candles with every trade TAGGED - BUY / SELL
// at its entry, a dot at its exit with its net - for the page's run (its days are already loaded) and for a background run
// opened from "Background runs", finished before this chart existed or after (its day is loaded the moment it is picked -
// the server keeps past days on disk). The lines are what the rule reads (signalBacktestChart.js).

const { Text } = Typography
const STORE = {
  show: 'optionanalytics.signalBacktest.chartShow',
  source: 'optionanalytics.signalBacktest.chartSource',
  timeframe: 'optionanalytics.signalBacktest.chartTimeframe',
  ema: 'optionanalytics.signalBacktest.chartEma',
}
const SHOW_OPTIONS = [
  { value: 'vwap', label: 'VWAP' }, { value: 'ema', label: 'EMA' }, { value: 'rsi', label: 'RSI' }, { value: 'pivots', label: 'Pivots / CPR' },
  { value: 'skipped', label: 'Signals not taken' },
]
const EMA_COLORS = ['#40a9ff', '#ff85c0', '#95de64', '#ffc069']
const PIVOT_LINES = [
  ['r3', '#ff7875'], ['r2', '#ff7875'], ['r1', '#ff7875'], ['tc', '#d3adf7'], ['p', '#e6e6e6'], ['bc', '#d3adf7'], ['s1', '#5cdbd3'], ['s2', '#5cdbd3'], ['s3', '#5cdbd3'],
]
const RSI_PANE = 120
// A note tag wraps on a phone rather than running off the card.
const NOTE_TAG = { margin: 0, whiteSpace: 'normal', height: 'auto' }
const pad = (v) => String(v).padStart(2, '0')
const clock = (ms) => { const m = istMinute(ms); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }
const rupees = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}` : '—')
const pnlColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const chartTime = (ms) => toChartTime(ms)

/** The chart itself - drawn again whenever what it shows changes (a past day: nothing updates it live). */
function DayChart({ data, markers, show, rsiLevels, height }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !data?.candles.length) return undefined
    const withRsi = show.has('rsi') && data.rsi?.points.length > 0
    const chart = createZoomableChart(el, {
      width: el.clientWidth, height: height + (withRsi ? RSI_PANE : 0),
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 11, panes: { separatorColor: BORDER_COLOR } },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      localization: { timeFormatter: istTimeFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      // A finger moving up / down scrolls the page (a phone's page is long); sideways still pans, pinch zooms.
      handleScroll: { vertTouchDrag: false },
    })
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR, priceLineVisible: false,
    })
    candles.setData(data.candles.map((c) => ({ ...c, time: chartTime(c.time) })))
    const line = (points, color, title, pane = 0, more = {}) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1.5, title, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...more }, pane)
      s.setData(points.map((p) => ({ time: chartTime(p.time), value: p.value })))
      return s
    }
    if (show.has('vwap') && data.vwap.length) line(data.vwap, '#ffd54f', 'VWAP', 0, { lineWidth: 2 })
    if (show.has('ema')) data.emas.forEach((e, k) => { if (e.points.length) line(e.points, EMA_COLORS[k % EMA_COLORS.length], `EMA ${e.period}`) })
    if (show.has('pivots') && data.pivots) {
      for (const [key, color] of PIVOT_LINES) {
        const price = data.pivots[key]
        if (Number.isFinite(price)) candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: key === 'tc' || key === 'bc' ? LineStyle.Dashed : LineStyle.Dotted, axisLabelVisible: true, title: key.toUpperCase() })
      }
    }
    if (withRsi) {
      const r = line(data.rsi.points, '#b37feb', `RSI ${data.rsi.period}`, 1, { lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } })
      for (const level of rsiLevels.length ? rsiLevels : [30, 70]) r.createPriceLine({ price: level, color: '#ffffff55', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: String(level) })
      chart.panes()[1]?.setHeight(RSI_PANE)
    }
    createSeriesMarkers(candles, markers.map((m) => ({ ...m, time: chartTime(m.time) })))
    chart.timeScale().fitContent()
    const resize = new ResizeObserver(() => { if (ref.current) chart.applyOptions({ width: ref.current.clientWidth }) })
    resize.observe(el)
    return () => { resize.disconnect(); chart.remove() }
  }, [data, markers, show, rsiLevels, height])
  return <div ref={ref} style={{ width: '100%' }} />
}

// One index's day for the chart: the page's own (already loaded), else loaded now - a background run's, only while the chart
// is shown (`key` null = not wanted). Retry asks again after a failure.
function useChartDay(key, own, load) {
  const [loaded, setLoaded] = useState({ key: null, retry: 0, status: 'idle', day: null, error: null })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!key || own) return undefined
    // Loading until its answer is in (`loaded.key` is still another day's - or this day's last failure, until Retry).
    const controller = new AbortController()
    load(controller.signal)
      .then(({ day }) => setLoaded({ key, retry, status: day?.ok ? 'done' : 'failed', day: day?.ok ? day : null, error: day?.ok ? null : day?.reason ?? 'not loaded' }))
      .catch((err) => { if (!controller.signal.aborted) setLoaded({ key, retry, status: 'failed', day: null, error: String(err?.message ?? err) }) })
    return () => controller.abort()
    // `load` is made afresh each render - the key names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, own, retry])
  if (!key) return { day: null, status: 'idle', error: null, retry: () => {} }
  const day = own ?? (loaded.key === key ? loaded.day : null)   // a retry keeps nothing to show - the last try failed
  const status = own ? 'done' : loaded.key === key && loaded.retry === retry ? loaded.status : 'loading'
  return { day, status, error: loaded.key === key ? loaded.error : null, retry: () => setRetry((n) => n + 1) }
}

/**
 * The card. `report` / `settings` - what the report cards show (the page's run, or an opened background run); `dayOf(date)`
 * - the page's own prepared day for `date` (null for a background run's), `tradeDayOf(date)` - the same for the trade-in
 * index (`settings.tradeIn` - the trades were taken in it, so the chart shows it by default), `loadDay(underlying, date, signal,
 * { sumExpiries })` - loads one (the signal index's with the run's "Σ 3 expiries")
 * (the page's loader: kept for the tab's life); `date` / `onDate` - the day picked (a click on a day or a trade row picks
 * it too); `open` / `onOpen` - shown or closed (a row click shows it again).
 */
export function BacktestDayChartCard({ report, settings, runKey, dayOf, tradeDayOf, loadDay, date, onDate, open = true, onOpen, cardRef }) {
  const narrow = useMediaQuery('(max-width: 768px)')
  const [storedShow, setStoredShow] = usePersistedState(STORE.show, null)
  const [storedSource, setSource] = usePersistedState(STORE.source, 'spot')
  // The chart's own timeframe (null = the run's) and its two EMAs (null = the rule's periods, else 9 / 21).
  const [storedTf, setChartTf] = usePersistedState(STORE.timeframe, null)
  const [storedEma, setStoredEma] = usePersistedState(STORE.ema, null)
  const used = useMemo(() => ruleIndicators(settings.rule), [settings.rule])
  // Until a tick is changed: VWAP and the signals not taken, and whatever indicators the rule reads.
  const showList = Array.isArray(storedShow) ? storedShow : ['vwap', 'skipped', ...(used.ema.length ? ['ema'] : []), ...(used.rsi ? ['rsi'] : []), ...(used.pivots ? ['pivots'] : [])]
  const showKey = showList.join('|')
  const show = useMemo(() => new Set(showKey ? showKey.split('|') : []), [showKey])
  const days = useMemo(() => (report?.dayRows ?? []).filter((r) => r.ok), [report])
  const picked = days.some((r) => r.date === date) ? date : defaultChartDay(report?.dayRows)
  const at = days.findIndex((r) => r.date === picked)

  // The days: the signal index's (the rule read it) and, trading in another, that index's (the trades were taken in it).
  const tradeIn = settings.tradeIn || ''
  const signalDay = useChartDay(picked && open ? `${runKey}|${settings.underlying}|${picked}${settings.sumExpiries ? '|Σ3' : ''}` : null, picked ? dayOf?.(picked) ?? null : null,
    (signal) => loadDay(settings.underlying, picked, signal, { sumExpiries: Boolean(settings.sumExpiries) }))
  const tradeDayL = useChartDay(picked && open && tradeIn ? `${runKey}|${tradeIn}|${picked}` : null, picked && tradeIn ? tradeDayOf?.(picked) ?? null : null,
    (signal) => loadDay(tradeIn, picked, signal))
  const day = signalDay.day
  const tradeDay = tradeIn ? tradeDayL.day : day

  const trades = useMemo(() => (report?.trades ?? []).filter((t) => t.date === picked).sort((a, b) => a.entryTime - b.entryTime), [report, picked])
  // What the candles are of: spot - the TRADED index's (the signal index's is "signal" when trading in another) - the
  // signal index's futures (when the day has them) or an option's premium (of the traded index - a strike picked, by
  // default the day's first trade's, else the ATM call at the open).
  const source = storedSource === 'futures' && day?.priceSource === 'futures' ? 'futures'
    : storedSource === 'option' ? 'option' : storedSource === 'signal' && tradeIn ? 'signal' : 'spot'
  const chartDay = source === 'spot' || source === 'option' ? tradeDay : day
  const status = [signalDay.status, tradeIn ? tradeDayL.status : 'done'].includes('failed') ? 'failed'
    : [signalDay.status, tradeIn ? tradeDayL.status : 'done'].includes('loading') ? 'loading' : 'done'
  const failure = signalDay.status === 'failed' ? `${settings.underlying}: ${signalDay.error}` : tradeDayL.status === 'failed' ? `${tradeIn}: ${tradeDayL.error}` : null
  const retryLoad = () => { if (signalDay.status === 'failed') signalDay.retry(); if (tradeDayL.status === 'failed') tradeDayL.retry() }
  const options = useMemo(() => dayOptions(tradeDay), [tradeDay])
  const [optionPick, setOptionPick] = useState({ day: null, value: null })
  const fallbackOption = defaultChartOption(tradeDay, trades)
  const optionValue = optionPick.day === picked && options.some((o) => o.value === optionPick.value)
    ? optionPick.value : fallbackOption ? `${fallbackOption.side}|${fallbackOption.strike}` : null
  const option = options.find((o) => o.value === optionValue) ?? null
  const runTf = settings.timeframe ?? 1
  const tf = TIMEFRAMES.includes(storedTf) ? storedTf : runTf
  // The two EMAs: set here, else the rule's own periods (up to four), else 9 / 21; RSI the rule's period, else 14.
  const emaList = Array.isArray(storedEma) && storedEma.length === 2 ? storedEma : used.ema.length ? used.ema.slice(0, 4) : [9, 21]
  const emaKey = emaList.join('|')
  const setEma = (k, v) => {
    const next = [emaList[0] ?? 9, emaList[1] ?? 21]
    next[k] = Math.max(2, Math.min(200, Math.round(Number(v) || next[k])))
    setStoredEma(next)
  }
  const rsiPeriod = used.rsi ?? 14
  const optionKey = source === 'option' && option ? option.value : ''
  const data = useMemo(() => {
    if (!chartDay) return null
    const [side, strike] = optionKey ? optionKey.split('|') : []
    return dayChartData(chartDay, { timeframe: tf, source: source === 'signal' ? 'spot' : source, ema: emaKey.split('|').map(Number), rsi: rsiPeriod, option: optionKey ? { side, strike: Number(strike) } : null })
  }, [chartDay, tf, source, emaKey, rsiPeriod, optionKey])
  // On an option's chart only its own trades are tagged.
  const tagged = useMemo(() => (source === 'option' && option ? trades.filter((t) => t.strike === option.strike && t.side === option.side.toUpperCase()) : trades), [source, option, trades])
  // The signals not taken: the day run again with the run's own settings (the same engine) - its trades are the report's.
  const signals = useMemo(() => (day && show.has('skipped') && (!tradeIn || tradeDay) ? simulateDay(day, engineSettings(settings), { tradeDay }).signals : []),
    [day, tradeDay, tradeIn, settings, show])
  const markers = useMemo(() => [
    ...tradeMarkers(tagged, tf, { up: UP_COLOR, down: DOWN_COLOR }),
    ...(show.has('skipped') && source !== 'option' ? skippedMarkers(signals, trades, tf) : []),
  ].sort((a, b) => a.time - b.time), [tagged, trades, signals, tf, show, source])
  const notTaken = signals.filter((s) => !s.taken)

  if (!days.length) return null
  const row = days[at]
  const traded = tradeIn || settings.underlying
  const what = source === 'futures' ? (tradeIn ? `${settings.underlying} futures` : 'Futures')
    : source === 'option' && option ? `${tradeIn ? `${tradeIn} ` : ''}${option.strike} ${option.side.toUpperCase()}`
      : source === 'signal' ? `${settings.underlying} spot` : tradeIn ? `${tradeIn} spot` : 'Spot'
  const title = (
    <Space size={6} wrap>
      <span>{what} chart - the trades tagged</span>
      <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{tradeIn ? `signals ${settings.underlying} → traded ${tradeIn}` : settings.underlying} · {tf}m candles</Text>
    </Space>
  )
  const closeButton = (
    <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => onOpen?.(false)} aria-label="Close the chart" title="Close the chart (a click on a day or trade row opens it again)">
      Close
    </Button>
  )
  if (!open) {
    return (
      <div ref={cardRef}>
        <Card size="small" title={<span>Spot chart - closed</span>} extra={<Button size="small" icon={<LineChartOutlined />} onClick={() => onOpen?.(true)}>Show chart</Button>} styles={{ body: { display: 'none' } }} />
      </div>
    )
  }
  return (
    <div ref={cardRef}>
      {/* On a phone the close sits in the controls row - the card's corner can be under the page's floating ☰. */}
      <Card size="small" title={title} extra={narrow ? null : closeButton}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space size={6} wrap>
            <Button size="small" icon={<LeftOutlined />} disabled={at <= 0} onClick={() => onDate(days[at - 1].date)} aria-label="The day before" />
            <Select
              size="small" value={picked} onChange={onDate} style={{ width: narrow ? 210 : 260 }} popupMatchSelectWidth={false}
              options={days.map((r) => ({ value: r.date, label: `${dayjs(r.date).format(narrow ? 'ddd D MMM' : 'ddd D MMM YYYY')} · ${r.trades} trade${r.trades === 1 ? '' : 's'}${r.trades ? ` · ${rupees(r.net)}` : ''}` }))}
            />
            <Button size="small" icon={<RightOutlined />} disabled={at < 0 || at >= days.length - 1} onClick={() => onDate(days[at + 1].date)} aria-label="The day after" />
            <Select
              size="small" value={TIMEFRAMES.includes(storedTf) ? storedTf : 'run'} onChange={(v) => setChartTf(v === 'run' ? null : v)} style={{ width: 120 }} popupMatchSelectWidth={false}
              options={[{ value: 'run', label: `Run's (${runTf}m)` }, ...TIMEFRAMES.map((m) => ({ value: m, label: `${m} min` }))]} aria-label="The chart's timeframe"
            />
            {narrow && closeButton}
          </Space>
          <Space size={6} wrap>
            <Segmented
              size="small" value={source} onChange={setSource}
              options={tradeIn
                ? [{ value: 'spot', label: `${tradeIn}` }, { value: 'signal', label: `${settings.underlying} (signal)` }, ...(day?.priceSource === 'futures' ? [{ value: 'futures', label: `${settings.underlying} fut` }] : []), { value: 'option', label: 'Option' }]
                : [{ value: 'spot', label: 'Spot' }, ...(day?.priceSource === 'futures' ? [{ value: 'futures', label: 'Futures' }] : []), { value: 'option', label: 'Option' }]}
            />
            {source === 'option' && (
              <Select
                size="small" value={optionValue} onChange={(v) => setOptionPick({ day: picked, value: v })} style={{ width: 130 }} popupMatchSelectWidth={false} showSearch
                options={options.map((o) => ({ value: o.value, label: `${o.strike} ${o.side.toUpperCase()}` }))} aria-label="The option shown"
              />
            )}
          </Space>
          <Space size={8} wrap>
            <Checkbox.Group value={showList} onChange={(v) => setStoredShow(v)} options={SHOW_OPTIONS} style={{ fontSize: 12 }} />
            {show.has('ema') && (
              <Space size={4}>
                {[0, 1].map((k) => (
                  <InputNumber
                    key={k} size="small" min={2} max={200} step={1} value={emaList[k] ?? (k ? 21 : 9)} onChange={(v) => v != null && setEma(k, v)} style={{ width: 92 }}
                    addonBefore={<span style={{ color: EMA_COLORS[k] }}>EMA</span>} aria-label={`EMA ${k + 1} period`}
                  />
                ))}
                {Array.isArray(storedEma) && used.ema.length > 0 && <Button size="small" type="link" onClick={() => setStoredEma(null)}>Rule&apos;s</Button>}
              </Space>
            )}
          </Space>
          {status === 'loading' && <Spin size="small"><div style={{ padding: 24, textAlign: 'center' }}><Text type="secondary">Loading {dayjs(picked).format('D MMM')}…</Text></div></Spin>}
          {status === 'failed' && (
            <Alert
              type="warning" showIcon message={`${dayjs(picked).format('D MMM')} could not be loaded - ${failure}`}
              action={<Button size="small" icon={<ReloadOutlined />} onClick={retryLoad}>Retry</Button>}
            />
          )}
          {data && data.candles.length > 0 && <DayChart data={data} markers={markers} show={show} rsiLevels={used.rsiLevels} height={narrow ? 340 : 440} />}
          {data && !data.candles.length && <Text type="secondary" style={{ fontSize: 12 }}>No bars for {what} on this day.</Text>}
          {data && (
            <Space size={10} wrap style={{ fontSize: 12 }}>
              <span><span style={{ color: UP_COLOR }}>▲</span> / <span style={{ color: DOWN_COLOR }}>▼</span> BUY / SELL at the entry (green a bullish signal, red a bearish one)</span>
              <span><span style={{ color: UP_COLOR }}>●</span> / <span style={{ color: DOWN_COLOR }}>●</span> exit, its net</span>
              {show.has('skipped') && source !== 'option' && <span><span style={{ color: '#8c8c8c' }}>●</span> a signal not taken{notTaken.length ? ` (${notTaken.length})` : ''}</span>}
              {tf !== runTf && <Tag style={NOTE_TAG}>the rule read {runTf}m candles - the indicators here are on {tf}m</Tag>}
              {tradeIn && (source === 'spot' || source === 'option') && <Tag style={NOTE_TAG}>the rule read {settings.underlying} - this is {traded}, where the trades were taken</Tag>}
              {(source === 'spot' || source === 'signal') && show.has('vwap') && !data.vwap.length && <Tag style={NOTE_TAG}>no spot VWAP this day (the index had no volume){day?.priceSource === 'futures' && (!tradeIn || source === 'signal') ? ' - Futures has the rule\'s' : ''}</Tag>}
              {source === 'option' && show.has('vwap') && !data.vwap.length && <Tag style={NOTE_TAG}>no traded volume for this option - no VWAP</Tag>}
              {show.has('pivots') && !data.pivots && (source === 'spot' || source === 'signal') && <Tag style={NOTE_TAG}>no pivots - no previous session loaded</Tag>}
            </Space>
          )}
          {trades.length > 0 && (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {trades.map((t) => (
                <Text key={`${t.strategy}|${t.entryTime}`} style={{ fontSize: 12 }}>
                  <Tag
                    color={t.dir > 0 ? 'green' : 'red'} style={{ margin: '0 6px 0 0', cursor: 'pointer' }} title="Show this option's chart"
                    onClick={() => { setSource('option'); setOptionPick({ day: picked, value: `${t.side === 'PE' ? 'pe' : 'ce'}|${t.strike}` }) }}
                  >
                    {t.action} {optionName(t)}
                  </Tag>
                  {clock(t.entryTime)} @ {t.entry.toFixed(2)} → {clock(t.exitTime)} @ {t.exit.toFixed(2)} · {t.exitReason} · <Text strong style={{ color: pnlColor(t.net), fontSize: 12 }}>{rupees(t.net)}</Text>
                  {t.strategy === 'mirror' && <Text type="secondary" style={{ fontSize: 12 }}> · mirror</Text>}
                </Text>
              ))}
            </Space>
          )}
          {row && !trades.length && data && <Text type="secondary" style={{ fontSize: 12 }}>No trade on this day.</Text>}
          <FoldText id="signalBacktest.chartNote" label="about this chart" className="oa-note">
            <Text type="secondary" style={{ fontSize: 12 }}>
              The day on the run&apos;s own {runTf}-minute candles (or the timeframe picked here - the rule still read {runTf}m). A
              trade&apos;s tag is on the candle its signal closed (it entered at that candle&apos;s last minute&apos;s option close);
              its exit dot on the candle it went out in. Spot: VWAP is the index&apos;s own (when it had volume), the EMAs and RSI of
              the spot candles run on from the previous session&apos;s, Pivots / CPR the previous session&apos;s classic floor
              pivots. Futures: the futures&apos; VWAP - the one &quot;Price vs VWAP&quot; reads when the futures cover the day.
              Option: that strike&apos;s premium with its own VWAP, EMAs and RSI (the premium conditions read the ATM strike&apos;s -
              a click on a trade&apos;s tag below shows its option). The two EMAs are set here (else the rule&apos;s periods, or 9 /
              21). Pick a day here, or click a row of the Day by day or Trades table.
            </Text>
          </FoldText>
        </Space>
      </Card>
    </div>
  )
}
