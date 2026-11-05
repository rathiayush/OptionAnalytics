import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Segmented, Select, Space, Spin, Tag, Typography } from 'antd'
import { LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { CandlestickSeries, CrosshairMode, LineSeries, LineStyle, createSeriesMarkers } from 'lightweight-charts'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, useMediaQuery, usePersistedState } from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { istMinute, simulateDay } from './signalBacktest.js'
import { engineSettings } from './signalBacktestJob.js'
import { dayChartData, defaultChartDay, ruleIndicators, skippedMarkers, tradeMarkers } from './signalBacktestChart.js'
import { FoldText } from './FoldText.jsx'

// The Signal backtest's DAY CHART card: a day of the report on the run's own candles with every trade TAGGED - BUY / SELL
// at its entry, a dot at its exit with its net - for the page's run (its days are already loaded) and for a background run
// opened from "Background runs", finished before this chart existed or after (its day is loaded the moment it is picked -
// the server keeps past days on disk). The lines are what the rule reads (signalBacktestChart.js).

const { Text } = Typography
const STORE = {
  show: 'optionanalytics.signalBacktest.chartShow',
  source: 'optionanalytics.signalBacktest.chartSource',
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

/**
 * The card. `report` / `settings` - what the report cards show (the page's run, or an opened background run); `dayOf(date)`
 * - the page's own prepared day for `date` (null for a background run's), `loadDay(underlying, date, signal)` - loads one
 * (the page's loader: kept for the tab's life); `date` / `onDate` - the day picked (a click on a day or a trade row picks
 * it too).
 */
export function BacktestDayChartCard({ report, settings, runKey, dayOf, loadDay, date, onDate, cardRef }) {
  const narrow = useMediaQuery('(max-width: 768px)')
  const [storedShow, setStoredShow] = usePersistedState(STORE.show, null)
  const [storedSource, setSource] = usePersistedState(STORE.source, 'spot')
  const used = useMemo(() => ruleIndicators(settings.rule), [settings.rule])
  // Until a tick is changed: VWAP and the signals not taken, and whatever indicators the rule reads.
  const showList = Array.isArray(storedShow) ? storedShow : ['vwap', 'skipped', ...(used.ema.length ? ['ema'] : []), ...(used.rsi ? ['rsi'] : []), ...(used.pivots ? ['pivots'] : [])]
  const showKey = showList.join('|')
  const show = useMemo(() => new Set(showKey ? showKey.split('|') : []), [showKey])
  const days = useMemo(() => (report?.dayRows ?? []).filter((r) => r.ok), [report])
  const picked = days.some((r) => r.date === date) ? date : defaultChartDay(report?.dayRows)
  const at = days.findIndex((r) => r.date === picked)

  // The day: the page's own (already loaded), else loaded now - a background run's.
  const own = picked ? dayOf?.(picked) ?? null : null
  const [loaded, setLoaded] = useState({ key: null, retry: 0, status: 'idle', day: null, error: null })
  const [retry, setRetry] = useState(0)
  const key = picked ? `${runKey}|${settings.underlying}|${picked}` : null
  useEffect(() => {
    if (!key || own) return undefined
    // Loading until its answer is in (`loaded.key` is still another day's - or this day's last failure, until Retry).
    const controller = new AbortController()
    loadDay(settings.underlying, picked, controller.signal)
      .then(({ day }) => setLoaded({ key, retry, status: day?.ok ? 'done' : 'failed', day: day?.ok ? day : null, error: day?.ok ? null : day?.reason ?? 'not loaded' }))
      .catch((err) => { if (!controller.signal.aborted) setLoaded({ key, retry, status: 'failed', day: null, error: String(err?.message ?? err) }) })
    return () => controller.abort()
  }, [key, own, retry, loadDay, picked, settings.underlying])
  const day = own ?? (loaded.key === key ? loaded.day : null)   // a retry keeps nothing to show - the last try failed
  const status = own ? 'done' : loaded.key === key && loaded.retry === retry ? loaded.status : 'loading'

  const source = storedSource === 'futures' && day?.priceSource === 'futures' ? 'futures' : 'spot'
  const tf = settings.timeframe ?? 1
  // The rule's own periods, else EMA 9 / 21 and RSI 14.
  const emaKey = (used.ema.length ? used.ema : [9, 21]).join('|')
  const rsiPeriod = used.rsi ?? 14
  const data = useMemo(() => (day ? dayChartData(day, { timeframe: tf, source, ema: emaKey.split('|').map(Number), rsi: rsiPeriod }) : null), [day, tf, source, emaKey, rsiPeriod])
  const trades = useMemo(() => (report?.trades ?? []).filter((t) => t.date === picked).sort((a, b) => a.entryTime - b.entryTime), [report, picked])
  // The signals not taken: the day run again with the run's own settings (the same engine) - its trades are the report's.
  const signals = useMemo(() => (day && show.has('skipped') ? simulateDay(day, engineSettings(settings)).signals : []), [day, settings, show])
  const markers = useMemo(() => [...tradeMarkers(trades, tf, { up: UP_COLOR, down: DOWN_COLOR }), ...(show.has('skipped') ? skippedMarkers(signals, trades, tf) : [])].sort((a, b) => a.time - b.time), [trades, signals, tf, show])
  const notTaken = signals.filter((s) => !s.taken)

  if (!days.length) return null
  const row = days[at]
  const title = (
    <Space size={6} wrap>
      <span>{source === 'futures' ? 'Futures' : 'Spot'} chart - the trades tagged</span>
      <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{settings.underlying} · {tf}m candles</Text>
    </Space>
  )
  return (
    <div ref={cardRef}>
      <Card size="small" title={title}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space size={6} wrap>
            <Button size="small" icon={<LeftOutlined />} disabled={at <= 0} onClick={() => onDate(days[at - 1].date)} aria-label="The day before" />
            <Select
              size="small" value={picked} onChange={onDate} style={{ width: narrow ? 210 : 260 }} popupMatchSelectWidth={false}
              options={days.map((r) => ({ value: r.date, label: `${dayjs(r.date).format(narrow ? 'ddd D MMM' : 'ddd D MMM YYYY')} · ${r.trades} trade${r.trades === 1 ? '' : 's'}${r.trades ? ` · ${rupees(r.net)}` : ''}` }))}
            />
            <Button size="small" icon={<RightOutlined />} disabled={at < 0 || at >= days.length - 1} onClick={() => onDate(days[at + 1].date)} aria-label="The day after" />
            {day?.priceSource === 'futures' && (
              <Segmented size="small" value={source} onChange={setSource} options={[{ value: 'spot', label: 'Spot' }, { value: 'futures', label: 'Futures' }]} />
            )}
          </Space>
          <Checkbox.Group value={showList} onChange={(v) => setStoredShow(v)} options={SHOW_OPTIONS} style={{ fontSize: 12 }} />
          {status === 'loading' && <Spin size="small"><div style={{ padding: 24, textAlign: 'center' }}><Text type="secondary">Loading {dayjs(picked).format('D MMM')}…</Text></div></Spin>}
          {status === 'failed' && (
            <Alert
              type="warning" showIcon message={`${dayjs(picked).format('D MMM')} could not be loaded: ${loaded.error}`}
              action={<Button size="small" icon={<ReloadOutlined />} onClick={() => setRetry((n) => n + 1)}>Retry</Button>}
            />
          )}
          {data && <DayChart data={data} markers={markers} show={show} rsiLevels={used.rsiLevels} height={narrow ? 340 : 440} />}
          {data && (
            <Space size={10} wrap style={{ fontSize: 12 }}>
              <span><span style={{ color: UP_COLOR }}>▲</span> / <span style={{ color: DOWN_COLOR }}>▼</span> BUY / SELL at the entry (green a bullish signal, red a bearish one)</span>
              <span><span style={{ color: UP_COLOR }}>●</span> / <span style={{ color: DOWN_COLOR }}>●</span> exit, its net</span>
              {show.has('skipped') && <span><span style={{ color: '#8c8c8c' }}>●</span> a signal not taken{notTaken.length ? ` (${notTaken.length})` : ''}</span>}
              {source === 'spot' && show.has('vwap') && !data.vwap.length && <Tag style={NOTE_TAG}>no spot VWAP this day (the index had no volume){day.priceSource === 'futures' ? ' - Futures has the rule\'s' : ''}</Tag>}
              {show.has('pivots') && !data.pivots && source === 'spot' && <Tag style={NOTE_TAG}>no pivots - no previous session loaded</Tag>}
            </Space>
          )}
          {trades.length > 0 && (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {trades.map((t) => (
                <Text key={`${t.strategy}|${t.entryTime}`} style={{ fontSize: 12 }}>
                  <Tag color={t.dir > 0 ? 'green' : 'red'} style={{ margin: '0 6px 0 0' }}>{t.action} {t.strike} {t.side}</Tag>
                  {clock(t.entryTime)} @ {t.entry.toFixed(2)} → {clock(t.exitTime)} @ {t.exit.toFixed(2)} · {t.exitReason} · <Text strong style={{ color: pnlColor(t.net), fontSize: 12 }}>{rupees(t.net)}</Text>
                  {t.strategy === 'mirror' && <Text type="secondary" style={{ fontSize: 12 }}> · mirror</Text>}
                </Text>
              ))}
            </Space>
          )}
          {row && !trades.length && data && <Text type="secondary" style={{ fontSize: 12 }}>No trade on this day.</Text>}
          <FoldText id="signalBacktest.chartNote" label="about this chart" className="oa-note">
            <Text type="secondary" style={{ fontSize: 12 }}>
              The day on the run&apos;s own {tf}-minute candles. A trade&apos;s tag is on the candle its signal closed (it entered at
              that candle&apos;s last minute&apos;s option close); its exit dot on the candle it went out in. VWAP on Spot is the
              index&apos;s own (when it had volume); on Futures the futures&apos; - the one &quot;Price vs VWAP&quot; reads when the
              futures cover the day. The EMAs and RSI are of the spot candles, run on from the previous session&apos;s (as the rule
              reads them): the rule&apos;s own periods, else EMA 9 / 21 and RSI 14. Pivots / CPR are the previous session&apos;s
              classic floor pivots. Pick a day here, or click a row of the Day by day or Trades table.
            </Text>
          </FoldText>
        </Space>
      </Card>
    </div>
  )
}
