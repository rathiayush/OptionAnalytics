import { useEffect, useMemo, useRef } from 'react'
import { Checkbox, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import { CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries, LineType } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, fromChartTime, istTickMarkFormatter, istTimeFormatter, usePersistedState } from './shared.jsx'
import { useChartUserControl } from './oiShared.jsx'
import { useChartHeight, useFitHeight } from './DashboardCard.jsx'
import { FoldText } from './FoldText.jsx'
import { gexLevelsNear } from './gexTrend.js'
import { GEX_SPOT_KEYS, GEX_SPOT_LINES, GEX_SPOT_TIMEFRAMES, gexLevelSeries, levelsAround, spotCandles, wallRange } from './gexSpot.js'

const { Text } = Typography
const CR = 1e7
const IST_MS = 330 * 60_000
const istHhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)
const cr = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v) / CR).toLocaleString('en-IN')} Cr` : '-')
const pts = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 1 })}`
const toMs = (chartSeconds) => fromChartTime(chartSeconds) * 1000
const SIGNS = [{ value: 'standard', label: 'Standard' }, { value: 'buildup', label: 'OI build-up' }]
const NONE = []

/** The spot candles, a step line for each GEX level as it stood at each candle, and the regime strip at the bottom. */
function GexSpotChart({ candles, series, shown, regimeOn, dayKey, height: givenHeight = 420 }) {
  const height = useFitHeight(givenHeight)
  const heightRef = useRef(height)
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const candleRef = useRef(null)
  const linesRef = useRef({})
  const regimeRef = useRef(null)
  useEffect(() => {
    if (!containerRef.current) return undefined
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: heightRef.current,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR, scaleMargins: { top: 0.06, bottom: 0.1 } },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR, title: 'Spot',
    })
    // Each level a step line - it moves to another strike only when gex.js moves it (WALL_SWITCH / WALL_ZONE) - with
    // its value on the price axis, so the levels now are read off the axis.
    for (const l of GEX_SPOT_LINES) {
      linesRef.current[l.key] = chart.addSeries(LineSeries, {
        color: l.color, lineWidth: l.width, lineStyle: l.style, lineType: LineType.WithSteps, title: l.short,
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
      })
    }
    // The regime: a thin strip under the candles, green while dealers are long gamma, red while short.
    regimeRef.current = chart.addSeries(HistogramSeries, {
      priceScaleId: 'gexRegime', priceLineVisible: false, lastValueVisible: false, base: 0,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    chart.priceScale('gexRegime').applyOptions({ scaleMargins: { top: 0.955, bottom: 0 }, visible: false })
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      linesRef.current = {}
      regimeRef.current = null
    }
  }, [])
  useChartHeight(chartRef, height)
  // Dragged or zoomed: the view is the viewer's until a double-click (or a new day / timeframe) hands it back.
  const userControlRef = useChartUserControl(chartRef, dayKey)
  useEffect(() => {
    candleRef.current?.setData(candles)
    for (const key of GEX_SPOT_KEYS) linesRef.current[key]?.setData(shown.includes(key) ? series.lines[key] : NONE)
    regimeRef.current?.setData(regimeOn
      ? series.regime.map((p) => ({ time: p.time, value: 1, color: p.net >= 0 ? `${UP_COLOR}aa` : `${DOWN_COLOR}aa` }))
      : NONE)
    if (!userControlRef.current && candles.length) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, series, shown, regimeOn])
  return <div ref={containerRef} style={{ width: '100%', height }} />
}

/**
 * OI Replay's "GEX levels on spot" card (asked for - "on OI Replay show the GEX levels with the spot chart"): the spot
 * candles of its own timeframe with the call wall, put wall, max gamma and gamma flip of the day's GEX (`days` - the
 * page's useGexDays, both signs; the Sign picked here) drawn THROUGH the day as each stood at that candle, and the net
 * GEX's regime as a strip under the candles. Up to the replay clock (`asOfMs`; live null), so nothing after it is drawn.
 * `spotBars`: the page's 1-minute spot bars shown (chart time). It feeds no strategy or alert.
 */
export function GexSpotCard({ days, spotBars, asOfMs, dayKey, isLive }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.oiReplay.gexSpotTf', 5)
  const [sign, setSign] = usePersistedState('optionanalytics.oiReplay.gexSpotSign', 'standard')
  const [savedShown, setShown] = usePersistedState('optionanalytics.oiReplay.gexSpotLines', GEX_SPOT_KEYS)
  const [regimeOn, setRegimeOn] = usePersistedState('optionanalytics.oiReplay.gexSpotRegime', true)
  const tf = GEX_SPOT_TIMEFRAMES.includes(timeframe) ? timeframe : 5
  const shown = Array.isArray(savedShown) ? savedShown.filter((k) => GEX_SPOT_KEYS.includes(k)) : GEX_SPOT_KEYS
  const minutes = days?.[sign === 'buildup' ? 'buildup' : 'standard'] ?? NONE
  const candles = useMemo(() => spotCandles(spotBars, tf), [spotBars, tf])
  const series = useMemo(() => gexLevelSeries(minutes, candles, tf, { asOfMs, toMs }), [minutes, candles, tf, asOfMs])
  const now = series.at.at(-1) ?? null
  const near = useMemo(() => gexLevelsNear(now), [now])
  const around = useMemo(() => levelsAround(now), [now])
  const range = wallRange(now)

  if (!days) return <Text type="secondary">Working out the day's GEX…</Text>
  return (
    <div>
      <Space size={[12, 6]} wrap style={{ marginBottom: 6 }}>
        <Segmented size="small" value={tf} onChange={setTimeframe} options={GEX_SPOT_TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
        <Tooltip title="Standard: calls +, puts −. OI build-up: each OI change signed by its own IV's move (buyers vs writers) - the GEX card's Sign.">
          <Segmented size="small" value={sign} onChange={setSign} options={SIGNS} />
        </Tooltip>
        <Checkbox.Group
          value={shown} onChange={setShown}
          options={GEX_SPOT_LINES.map((l) => ({ value: l.key, label: <span style={{ color: l.color }}>{l.title}</span> }))}
        />
        <Tooltip title="A strip under the candles: green while the net GEX is positive (dealers long gamma - moves damped, levels hold), red while negative (dealers short gamma - moves can run).">
          <Checkbox checked={regimeOn} onChange={(e) => setRegimeOn(e.target.checked)}>Regime</Checkbox>
        </Tooltip>
      </Space>
      {now ? (
        <div style={{ fontSize: 12, marginBottom: 6, lineHeight: 1.7 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{istHhmm(now.time)}{isLive ? ' (live)' : ''} · net GEX </Text>
          <span style={{ color: now.net >= 0 ? UP_COLOR : DOWN_COLOR }}>{cr(now.net)}</span>
          <Tag color={now.net >= 0 ? 'green' : 'red'} style={{ marginLeft: 6 }}>{now.net >= 0 ? 'dealers long gamma - moves damped' : 'dealers short gamma - moves can run'}</Tag>
          {range && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {range === 'inside' ? 'spot between the walls' : range === 'above' ? 'spot ABOVE the call wall' : 'spot BELOW the put wall'}
            </Text>
          )}
          {/* A wrapping row - inline spans with no space between them never broke, and ran a phone's page wide. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12 }}>
            {around.map((l) => (
              <span key={l.key} style={{ whiteSpace: 'nowrap' }}>
                <span style={{ color: l.color }}>{l.title} {l.price.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</span>
                <Text type="secondary" style={{ fontSize: 11 }}> {pts(l.distance)}</Text>
              </span>
            ))}
          </div>
          {near.map((n) => (
            <div key={n.level} style={{ color: n.tone === 'bull' ? UP_COLOR : n.tone === 'bear' ? DOWN_COLOR : undefined }}>
              At the {n.label.toLowerCase()}: {n.read}{n.weak ? ' (weak - net GEX near zero)' : ''}
            </div>
          ))}
        </div>
      ) : (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>No GEX yet{asOfMs != null ? ' at this minute' : ''} - it needs the ATM straddle's premiums.</Text>
      )}
      <GexSpotChart candles={candles} series={series} shown={shown} regimeOn={regimeOn} dayKey={`${dayKey}-${tf}`} />
      <FoldText id="gexSpot.note" label="how to read it" className="oa-note" style={{ marginTop: 4 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          Each line is a GEX level as it stood at that candle (read at the candle's last minute, nothing after it): the CALL WALL
          (most call gamma above spot - resistance), the PUT WALL (most put gamma below - support), MAX GAMMA (the magnet) and
          the GAMMA FLIP (where the net GEX would cross zero). Above the flip dealers are long gamma - they sell rallies and buy
          dips, so moves are damped and the walls tend to hold; below it they are short gamma and chase the move, so a wall
          can break and run. The strip under the candles is the net GEX's sign. Levels and regime are the GEX card's own
          (same Sign, Σ 3 expiries when ticked) - a read, not a signal.
        </Text>
      </FoldText>
    </div>
  )
}
