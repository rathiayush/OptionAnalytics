import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import { CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries, LineType } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, fromChartTime, istTickMarkFormatter, istTimeFormatter, useMediaQuery, usePersistedState } from './shared.jsx'
import { useChartUserControl } from './oiShared.jsx'
import { useChartHeight, useFitHeight } from './DashboardCard.jsx'
import { FoldText } from './FoldText.jsx'
import { gexLevelsNear } from './gexTrend.js'
import { GEX_SPOT_KEYS, GEX_SPOT_LINES, GEX_SPOT_TIMEFRAMES, gexLadder, gexLevelSeries, ladderStrikeAt, spotCandles, wallRange } from './gexSpot.js'
import { GEX_LADDER_SHARE, GEX_LADDER_SHARE_NARROW, GexLadderPrimitive, crShort } from './gexLadderPrimitive.js'

const { Text } = Typography
const CR = 1e7
const IST_MS = 330 * 60_000
const istHhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)
const cr = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v) / CR).toLocaleString('en-IN')} Cr` : '-')
const num = (v) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—')
const pts = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 1 })}`
const toMs = (chartSeconds) => fromChartTime(chartSeconds) * 1000
const SIGNS = [{ value: 'standard', label: 'Standard' }, { value: 'buildup', label: 'OI build-up' }]
const NONE = []
const COLOR = Object.fromEntries(GEX_SPOT_LINES.map((l) => [l.key, l.color]))
// The strikes either side of spot the prices always hold while the ladder is shown - so its rows near the money are on
// the chart, not just the candles' range.
const LADDER_STRIKES_EACH = 3

/** The spot candles, a step line for each GEX level as it stood at each candle, the regime strip at the bottom and -
 *  `ladder` given - the GEX ladder at the clock beside the candles. `onHover(price | null)`. */
function GexSpotChart({ candles, series, shown, regimeOn, ladder, share, dayKey, onHover, height: givenHeight = 420 }) {
  const height = useFitHeight(givenHeight)
  const heightRef = useRef(height)
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const candleRef = useRef(null)
  const linesRef = useRef({})
  const regimeRef = useRef(null)
  const ladderRef = useRef(null)
  const rangeRef = useRef(null)
  const hoverRef = useRef(onHover)
  useEffect(() => { hoverRef.current = onHover })
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
      autoscaleInfoProvider: (original) => {
        const base = original()
        const r = rangeRef.current
        if (!r) return base
        return { ...(base ?? {}), priceRange: { minValue: Math.min(base?.priceRange?.minValue ?? r.low, r.low), maxValue: Math.max(base?.priceRange?.maxValue ?? r.high, r.high) } }
      },
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
    const primitive = new GexLadderPrimitive()
    ladderRef.current = primitive
    candleRef.current.attachPrimitive(primitive)
    chart.subscribeCrosshairMove((param) => {
      const p = param?.point ? candleRef.current?.coordinateToPrice(param.point.y) : null
      hoverRef.current?.(Number.isFinite(p) ? p : null)
    })
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      linesRef.current = {}
      regimeRef.current = null
      ladderRef.current = null
    }
  }, [])
  useChartHeight(chartRef, height)
  // Dragged or zoomed: the view is the viewer's until a double-click (or a new day / timeframe) hands it back.
  const userControlRef = useChartUserControl(chartRef, dayKey)
  const panel = ladder ? share : 0
  useEffect(() => {
    candleRef.current?.setData(candles)
    for (const key of GEX_SPOT_KEYS) linesRef.current[key]?.setData(shown.includes(key) ? series.lines[key] : NONE)
    regimeRef.current?.setData(regimeOn
      ? series.regime.map((p) => ({ time: p.time, value: 1, color: p.net >= 0 ? `${UP_COLOR}aa` : `${DOWN_COLOR}aa` }))
      : NONE)
    const chart = chartRef.current
    if (!chart || !candles.length || userControlRef.current) return
    // The whole day, with the ladder's share of the plot left empty on the right - the candles stand beside it.
    const n = candles.length
    chart.timeScale().applyOptions({ rightOffset: panel > 0 ? Math.max(Math.round((n * panel) / (1 - panel)) + 2, 20 - n) : 6 })
    chart.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, series, shown, regimeOn, panel])
  // The captions on the price axis (Spot, CW, PW, Max γ, Flip) are drawn inside the plot - over the ladder's call bars;
  // with the ladder on only the coloured values stay (the headline numbers name them).
  const captions = !ladder
  useEffect(() => {
    candleRef.current?.applyOptions({ title: captions ? 'Spot' : '' })
    for (const l of GEX_SPOT_LINES) linesRef.current[l.key]?.applyOptions({ title: captions ? l.short : '' })
  }, [captions])
  useEffect(() => {
    ladderRef.current?.setLadder(ladder, share)
    const range = ladder?.step > 0 ? { low: ladder.spot - LADDER_STRIKES_EACH * ladder.step, high: ladder.spot + LADDER_STRIKES_EACH * ladder.step } : null
    const old = rangeRef.current
    rangeRef.current = range
    if ((old?.low !== range?.low || old?.high !== range?.high) && !userControlRef.current) chartRef.current?.priceScale('right').applyOptions({ autoScale: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ladder, share])
  return <div ref={containerRef} style={{ width: '100%', height }} />
}

/** A headline number - the order-book card's look: the title, the value big in its colour, a line under it. */
function Headline({ title, value, color, sub }) {
  return (
    <div style={{ minWidth: 110 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>{title}</Text>
      <div style={{ color, fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
      {sub && <Text type="secondary" style={{ fontSize: 11 }}>{sub}</Text>}
    </div>
  )
}

const away = (level, spot) => (Number.isFinite(level) && spot > 0 ? `${pts(level - spot)} pts ${level >= spot ? 'above' : 'below'}` : null)

/**
 * OI Replay's "GEX levels on spot" card (asked for - "on OI Replay show the GEX levels with the spot chart", then "like
 * these" - the order-book ladder picture): the spot candles of its own timeframe with the call wall, put wall, max gamma
 * and gamma flip of the day's GEX (`days` - the page's useGexDays, both signs; the Sign picked here) drawn THROUGH the
 * day as each stood at that candle, the net GEX's regime as a strip under the candles, and the GEX LADDER at the clock
 * beside them - every strike's put and call GEX (gexLadder / GexLadderPrimitive) - under a row of headline numbers (spot,
 * the walls, the flip, max gamma, the net). Up to the replay clock (`asOfMs`; live null), so nothing after it is drawn.
 * `spotBars`: the page's 1-minute spot bars shown (chart time). It feeds no strategy or alert.
 */
export function GexSpotCard({ days, spotBars, asOfMs, dayKey, isLive }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.oiReplay.gexSpotTf', 5)
  const [sign, setSign] = usePersistedState('optionanalytics.oiReplay.gexSpotSign', 'standard')
  const [savedShown, setShown] = usePersistedState('optionanalytics.oiReplay.gexSpotLines', GEX_SPOT_KEYS)
  const [regimeOn, setRegimeOn] = usePersistedState('optionanalytics.oiReplay.gexSpotRegime', true)
  const [ladderOn, setLadderOn] = usePersistedState('optionanalytics.oiReplay.gexSpotLadder', true)
  const [hover, setHover] = useState(null)
  const narrow = useMediaQuery('(max-width: 768px)')
  const tf = GEX_SPOT_TIMEFRAMES.includes(timeframe) ? timeframe : 5
  const shown = Array.isArray(savedShown) ? savedShown.filter((k) => GEX_SPOT_KEYS.includes(k)) : GEX_SPOT_KEYS
  const minutes = days?.[sign === 'buildup' ? 'buildup' : 'standard'] ?? NONE
  const candles = useMemo(() => spotCandles(spotBars, tf), [spotBars, tf])
  const series = useMemo(() => gexLevelSeries(minutes, candles, tf, { asOfMs, toMs }), [minutes, candles, tf, asOfMs])
  const now = series.at.at(-1) ?? null
  const near = useMemo(() => gexLevelsNear(now), [now])
  const ladder = useMemo(() => (ladderOn ? gexLadder(now) : null), [ladderOn, now])
  const range = wallRange(now)
  const hoverRow = ladderStrikeAt(ladder, hover)

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
        <Tooltip title="Every strike's GEX at the clock beside the candles: puts left, calls right, green = dealers long gamma there, red = short; the walls, max gamma and spot marked, the flip across.">
          <Checkbox checked={ladderOn} onChange={(e) => setLadderOn(e.target.checked)}>GEX ladder</Checkbox>
        </Tooltip>
      </Space>
      {now ? (
        <>
          <Space size={[22, 8]} wrap style={{ marginBottom: 4 }}>
            <Headline title={`Spot · ${istHhmm(now.time)}${isLive ? ' live' : ''}`} value={num(now.spot)}
              sub={range === 'inside' ? 'between the walls' : range === 'above' ? 'ABOVE the call wall' : range === 'below' ? 'BELOW the put wall' : null} />
            <Headline title="Call wall (resistance)" value={num(now.callWall)} color={COLOR.callWall} sub={away(now.callWall, now.spot) ?? 'none above spot'} />
            <Headline title="Put wall (support)" value={num(now.putWall)} color={COLOR.putWall} sub={away(now.putWall, now.spot) ?? 'none below spot'} />
            <Headline title="Gamma flip" value={num(now.flip)} color={COLOR.flip}
              sub={Number.isFinite(now.flip) ? `${away(now.flip, now.spot)} · spot ${now.spot >= now.flip ? 'above' : 'below'}` : 'none within ±3%'} />
            <Headline title="Max gamma (magnet)" value={num(now.maxGamma)} color={COLOR.maxGamma} sub={away(now.maxGamma, now.spot)} />
            <Headline title="Net GEX" value={cr(now.net)} color={now.net >= 0 ? UP_COLOR : DOWN_COLOR}
              sub={now.net >= 0 ? 'dealers long gamma - moves damped' : 'dealers short gamma - moves can run'} />
          </Space>
          {near.map((n) => (
            <div key={n.level} style={{ fontSize: 12, color: n.tone === 'bull' ? UP_COLOR : n.tone === 'bear' ? DOWN_COLOR : undefined }}>
              At the {n.label.toLowerCase()}: {n.read}{n.weak ? ' (weak - net GEX near zero)' : ''}
            </div>
          ))}
        </>
      ) : (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>No GEX yet{asOfMs != null ? ' at this minute' : ''} - it needs the ATM straddle's premiums.</Text>
      )}
      {ladder && (
        <div style={{ fontSize: 11, margin: '4px 0', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>Ladder at {istHhmm(ladder.time)}: puts left · calls right (₹ Cr per 1% move)</span>
          <span><span style={{ color: UP_COLOR }}>■</span> dealers long gamma</span>
          <span><span style={{ color: DOWN_COLOR }}>■</span> dealers short gamma</span>
          <span><Tag color="green" style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 3px' }}>CW</Tag> <Tag color="red" style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 3px' }}>PW</Tag> <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 3px' }}>MG</Tag> outlined</span>
          <span style={{ color: COLOR.flip }}>- - flip</span>
        </div>
      )}
      <GexSpotChart
        candles={candles} series={series} shown={shown} regimeOn={regimeOn} ladder={ladder}
        share={narrow ? GEX_LADDER_SHARE_NARROW : GEX_LADDER_SHARE} dayKey={`${dayKey}-${tf}-${ladderOn ? 'l' : ''}`} onHover={setHover}
      />
      {ladder && (
        <div style={{ fontSize: 11, minHeight: 18, marginTop: 2 }}>
          {hoverRow ? (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {hoverRow.strike.toLocaleString('en-IN')}: <span style={{ color: hoverRow.call >= 0 ? UP_COLOR : DOWN_COLOR }}>calls {hoverRow.call < 0 ? '−' : ''}₹{crShort(hoverRow.call)} Cr</span>
              {' · '}<span style={{ color: hoverRow.put >= 0 ? UP_COLOR : DOWN_COLOR }}>puts {hoverRow.put < 0 ? '−' : ''}₹{crShort(hoverRow.put)} Cr</span>
              {' · '}net {cr(hoverRow.net)}{Number.isFinite(hoverRow.ceOi) ? ` · CE OI ${Math.round(hoverRow.ceOi).toLocaleString('en-IN')}` : ''}{Number.isFinite(hoverRow.peOi) ? ` · PE OI ${Math.round(hoverRow.peOi).toLocaleString('en-IN')}` : ''}
            </Text>
          ) : <Text type="secondary" style={{ fontSize: 11 }}>Hover a strike for its numbers.</Text>}
        </div>
      )}
      <FoldText id="gexSpot.note" label="how to read it" className="oa-note" style={{ marginTop: 4 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          Each line is a GEX level as it stood at that candle (read at the candle's last minute, nothing after it): the CALL WALL
          (most call gamma above spot - resistance), the PUT WALL (most put gamma below - support), MAX GAMMA (the magnet) and
          the GAMMA FLIP (where the net GEX would cross zero). Above the flip dealers are long gamma - they sell rallies and buy
          dips, so moves are damped and the walls tend to hold; below it they are short gamma and chase the move, so a wall
          can break and run. The strip under the candles is the net GEX's sign. The ladder on the right is every strike's GEX
          at the clock - the bigger the bar, the more hedging there; the walls are its biggest call / put rows either side of
          spot. Levels, regime and ladder are the GEX card's own (same Sign, Σ 3 expiries when ticked) - a read, not a signal.
        </Text>
      </FoldText>
    </div>
  )
}
