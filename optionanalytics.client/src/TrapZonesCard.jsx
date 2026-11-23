import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Checkbox, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { useChartUserControl } from './oiShared.jsx'
import { useChartHeight, useFitHeight } from './DashboardCard.jsx'
import { ZoneBoxesPrimitive } from './profilePrimitives.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, fromChartTime, istTickMarkFormatter, istTimeFormatter, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { inMarketSession } from './marketSession.js'
import { barsUpTo, optionDeltaMinutes } from './deltaProfile.js'
import { optionOiMinutes } from './oiProfile.js'
import { usePastDeltaSessions } from './usePastDeltaSessions.js'
import { useFuturesFootprintDay } from './DeltaProfileCard.jsx'
import { PROFILE_ROWS } from './profileZones.js'
import { TRAP_SOURCES, ZONE_KINDS, ZONE_MODES, bestZones, cdvLevels, dayRead, dayTimeline, ladderLayout, oiLevels, openingBias, profileLevels, totalOutliers, openingRead, supportResistance, spotFeedRead, tradeSetups, zoneBoxes, zoneScaleRange } from './trapZones.js'

// OI Replay's TRAPPED / SQUEEZE ZONES card (asked for - "from the start of day ... previous idea of the last session ...
// identify trapped zones, short squeeze zones ... keep updating as it goes ... a separate component"): the previous
// session(s)' OI (CE − PE), net CE − PE (= option CDV), OBV and futures delta added into one profile, its clusters read
// against their close before the open, and against the price at the clock through the day with the day's own clusters, the open rule and the squeezes (trapZones.js).

const { Text } = Typography
const MIN = 60_000
const DAY_CHOICES = [1, 2, 3].map((v) => ({ value: v, label: `${v} day${v > 1 ? 's' : ''} before` }))
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
const px = (v) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—')
const pct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
const NONE = []

function KindTag({ kind }) {
  const k = ZONE_KINDS[kind]
  if (!k) return null
  return <Tooltip title={k.text}><Tag color={k.color} style={{ margin: 0, color: '#000' }}>{k.label}</Tag></Tooltip>
}

const sourceTags = (sources) => sources.map((s) => <Tag key={s} style={{ margin: 0, marginRight: 2 }}>{TRAP_SOURCES.find((x) => x.id === s)?.short ?? s}</Tag>)
const shortOf = (ids) => (ids ?? []).map((x) => TRAP_SOURCES.find((y) => y.id === x)?.short ?? x).join('+')
const FUTURES_OUT = { none: 'not present - left out', noBasis: 'no same-day close to put them on spot - left out' }

/** Which profiles a read is built from: each one read green, not read grey; the futures say why they were left out. */
function ProfilesRead({ label, read }) {
  if (!read) return null
  return (
    <Space wrap size={[4, 2]} align="center">
      <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
      {TRAP_SOURCES.map((s) => {
        const on = read.used?.includes(s.id)
        const why = on ? 'read' : s.id === 'fut' ? FUTURES_OUT[read.futures] ?? 'no data - left out' : 'no data - left out'
        return (
          <Tooltip key={s.id} title={`${s.name}: ${why}`}>
            <Tag color={on ? 'green' : undefined} style={{ margin: 0, opacity: on ? 1 : 0.55, textDecoration: on ? undefined : 'line-through' }}>{s.short}</Tag>
          </Tooltip>
        )
      })}
    </Space>
  )
}

// THE ZONES ON SPOT (asked for - "these levels, can we not draw them on spot as well - so easy to identify"): the spot
// candles of the card's own timeframe with every zone a band across the plot in its role's colour (floor green, trapped
// shorts teal, ceiling red, trapped longs orange), labelled with its role and the profiles behind it - the previous
// sessions' dashed, the day's own solid - and the open / previous close as price lines. Up to the clock only.
const CHART_TF = [1, 3, 5, 15]
function candlesOf(bars, minutes) {
  if (!(minutes > 1)) return bars
  const size = minutes * 60
  const out = []
  for (const b of bars) {
    const t = Math.floor(b.time / size) * size
    const last = out.at(-1)
    if (last?.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close })
  }
  return out
}
function ZonesSpotChart({ candles, boxes, lines, dayKey, height: givenHeight = 380 }) {
  const height = useFitHeight(givenHeight)
  const heightRef = useRef(height)
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const boxesRef = useRef(null)
  const linesRef = useRef([])
  const zonesRef = useRef({ boxes: [], last: null })
  useEffect(() => {
    if (!containerRef.current) return undefined
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: heightRef.current,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      // The scale is the candles' own range, widened only as far as `zoneScaleRange` allows to show the zones just off them -
      // a band far from price used to stretch it until the candles were a few pixels and the live price looked frozen.
      autoscaleInfoProvider: (original) => {
        const base = original()
        if (!base?.priceRange) return base
        const { boxes: zones, last } = zonesRef.current
        const r = zoneScaleRange(base.priceRange.minValue, base.priceRange.maxValue, zones, last)
        return r ? { ...base, priceRange: { minValue: r.min, maxValue: r.max } } : base
      },
    })
    seriesRef.current = series
    const prim = new ZoneBoxesPrimitive()
    boxesRef.current = prim
    series.attachPrimitive(prim)
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => { resize.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; boxesRef.current = null; linesRef.current = [] }
  }, [])
  useChartHeight(chartRef, height)
  const userControlRef = useChartUserControl(chartRef, dayKey)
  useEffect(() => {
    seriesRef.current?.setData(candles)
    if (chartRef.current && candles.length && !userControlRef.current) chartRef.current.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, dayKey])
  useEffect(() => {
    boxesRef.current?.setZones(boxes)
    const last = candles.at(-1)?.close
    zonesRef.current = { boxes, last: Number.isFinite(last) ? last : null }
    if (!userControlRef.current) chartRef.current?.priceScale('right').applyOptions({ autoScale: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, candles])
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const l of linesRef.current) series.removePriceLine(l)
    linesRef.current = (lines ?? []).filter((l) => Number.isFinite(l.price))
      .map((l) => series.createPriceLine({ price: l.price, color: l.color, title: l.title, lineWidth: l.width ?? 1, lineStyle: l.style ?? 0, axisLabelVisible: true }))
  }, [lines])
  return <div ref={containerRef} style={{ width: '100%', height }} />
}

function ZoneTable({ zones }) {
  return (
    <Table
      size="small" pagination={false} rowKey={(z, i) => `${z.from}-${z.low}-${z.high}-${i}`} dataSource={zones.slice(0, 12)} scroll={{ x: 640 }}
      columns={[
        { title: 'Zone', key: 'z', width: 130, render: (_, z) => `${px(z.low)} – ${px(z.high)}` },
        { title: 'What it is now', key: 'k', render: (_, z) => <KindTag kind={z.kind} /> },
        { title: 'From', key: 'f', width: 80, render: (_, z) => (z.from === 'today' ? 'today' : 'before') },
        { title: 'Profiles behind it', key: 's', render: (_, z) => sourceTags(z.sources) },
        { title: 'Against', key: 'a', render: (_, z) => (z.against?.length ? sourceTags(z.against) : '—') },
        { title: 'Strength', dataIndex: 'score', key: 'sc', width: 80, align: 'right' },
        { title: 'From price', key: 'd', width: 90, align: 'right', render: (_, z) => (z.distance === 0 ? 'at price' : pct(z.distance)) },
      ]}
    />
  )
}

const EVENT_TEXT = {
  bull: 'Open rule ON (bullish): puts written below the open, price above it',
  bear: 'Open rule ON (bearish): calls written above the open, price below it',
  off: 'Open rule off',
  shortSqueeze: 'SHORT SQUEEZE: closed above the previous sellers\' zone',
  longLiquidation: 'LONG LIQUIDATION: closed below the previous buyers\' zone',
  failedUp: 'Back inside the sellers\' zone - the squeeze stalled',
  failedDown: 'Back inside the buyers\' zone - the liquidation stalled',
  newZone: 'New zone of the day',
  roleChange: 'Zone changed role',
  verdict: 'Bias now',
}
const STEP_MIN = 5

const biasColor = (score) => (score >= 1 ? '#52c41a' : score <= -1 ? '#ff4d4f' : '#d9d9d9')

const ladderTint = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
const sameZone = (a, b) => !!a && !!b && a.from === b.from && a.bullish === b.bullish && a.low === b.low && a.high === b.high
const LADDER_SPANS = [0.5, 1, 2]
const HEADER_PX = 18
// Text widths MEASURED (a canvas in the page's own font) - a guess per character left the label backings short of the text.
let measureCtx = null
let measureFont = null
function textWidth(text, fontPx, weight) {
  if (typeof document === 'undefined') return text.length * fontPx * 0.62
  measureCtx ??= document.createElement('canvas').getContext('2d')
  measureFont ??= getComputedStyle(document.body).fontFamily || 'sans-serif'
  measureCtx.font = `${weight} ${fontPx}px ${measureFont}`
  return measureCtx.measureText(text).width
}
/** `text` cut with an ellipsis to fit `room` px, or null when not even its first letters fit. */
function fitText(text, room, fontPx, weight) {
  if (textWidth(text, fontPx, weight) <= room) return text
  for (let n = text.length - 1; n >= 3; n--) { const t = `${text.slice(0, n).trimEnd()}…`; if (textWidth(t, fontPx, weight) <= room) return t }
  return null
}

const STRIP_NAMES = { oi: ['O', 'OI'], cdv: ['N', 'Net'], obv: ['B', 'OBV'], fut: ['F', 'Fut'] }
const STRIP_FULL = { oi: 'OI CE − PE (OI delta)', cdv: 'Net CE − PE (= option CDV)', obv: 'Option OBV', fut: 'Futures delta' }

/**
 * THE LADDER TO SCALE (ladderLayout): the previous day(s) in one lane, the current day in the other, each zone a band at
 * its real price with its range, the price / open / previous close / CDV lines across both with their labels in the right
 * gutter, and (asked for - "is anything missing ... OI net CE − PE, OBV, CDV, net CE − PE, futures delta") each lane's
 * PROFILE STRIPS - one thin column a profile (OI, Net / CDV, OBV, Futures) at the lane's left, green where that profile is
 * bullish at a price, red where bearish, stronger the deeper the colour; a profile not read (futures not present) is an
 * empty dashed column. Drawn at the box's MEASURED width (an SVG scaled by a viewBox shrank its text on a phone), text widths
 * measured, labels spaced so none touches another - one with no room is left off, the band stays (hover it).
 */
export function ZoneLadder({ zones, price, marks, best, rows, used, prevLabel = 'Previous day', spanPct = 1, onSpan, showStrips = true, onStrips, rowSize = 5, split = false }) {
  const boxRef = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const narrow = width > 0 && width < 480
  const height = narrow ? 320 : 360
  const layout = useMemo(() => ladderLayout({ zones, price, marks, span: spanPct / 100, height, rows: showStrips ? rows : null, rowSize }), [zones, price, marks, spanPct, height, rows, showStrips, rowSize])
  const fontPx = narrow ? 10 : 11
  const headerPx = showStrips ? 30 : HEADER_PX
  const axisW = 46, gutterW = narrow ? 82 : 136, gap = 4
  const laneW = Math.max(40, (width - axisW - gutterW - gap * 3) / 2)
  const laneX = { prev: axisW + gap, today: axisW + gap * 2 + laneW }
  const lanesEnd = laneX.today + laneW
  const stripW = showStrips ? (narrow ? 7 : 20) : 0
  const stripsW = showStrips ? TRAP_SOURCES.length * (stripW + 1) + 3 : 0
  // "Each profile" (the first version) lets a bullish and a bearish zone sit on the same prices: each lane is then split,
  // bullish zones in its left half and bearish in its right, so neither covers the other.
  const areaW = Math.max(20, laneW - stripsW)
  const bandW = split ? Math.max(10, areaW / 2 - 1) : areaW
  const bandX = (lane, bullish = true) => laneX[lane] + stripsW + (split && !bullish ? areaW / 2 + 1 : 0)
  const starred = (z) => sameZone(best?.support?.zone, z) || sameZone(best?.resistance?.zone, z)
  const bandViews = (layout?.bands ?? []).map((b) => {
    const z = b.zone
    const k = ZONE_KINDS[z.kind]
    const star = starred(z)
    const kind = (narrow ? k?.tiny : k?.short) ?? k?.label ?? ''
    const name = `${star ? '★ ' : ''}${kind}`
    const range = `${px(z.low)}–${px(z.high)}`
    // On a phone the label takes the lane's whole width (over the strips, on its dark backing) - beside them it had ~45 px.
    const labelX = narrow ? laneX[b.lane] + 1 : split ? laneX[b.lane] + stripsW : bandX(b.lane)
    const labelW = narrow ? laneW - 2 : split ? areaW : bandW
    const room = labelW - 12
    // As much as fits: the kind, its range and its profiles; the kind and its range; the kind alone.
    const label = width > 0 ? ([`${name} ${range} · ${shortOf(z.sources)}`, `${name} ${range}`].find((t) => textWidth(t, fontPx, 600) <= room) ?? fitText(name, room, fontPx, 600)) : null
    return {
      b, z, star, x: bandX(b.lane, z.bullish), labelX, labelW, color: k?.color ?? '#8c8c8c', label,
      title: `${k?.label ?? ''} ${range} (${z.from === 'today' ? 'current day' : 'previous'}) · ${shortOf(z.sources)}${z.against?.length ? ` · ${shortOf(z.against)} against` : ''} · strength ${z.score} · ${z.distance === 0 ? 'at price' : pct(z.distance)}`,
    }
  })
  const stripX = (lane, i) => laneX[lane] + i * (stripW + 1)
  return (
    <div style={{ border: `1px solid ${BORDER_COLOR}`, borderRadius: 6, padding: '6px 8px' }}>
      <Space wrap size={[8, 4]} align="center" style={{ marginBottom: 4 }}>
        <Text strong style={{ fontSize: 12 }}>Ladder</Text>
        <Segmented size="small" value={spanPct} onChange={onSpan} options={LADDER_SPANS.map((v) => ({ value: v, label: `±${v}%` }))} />
        <Checkbox checked={showStrips} onChange={(e) => onStrips?.(e.target.checked)}>Profile strips</Checkbox>
        <Text type="secondary" style={{ fontSize: 11 }}>dashed = previous, solid = current day, ★ best</Text>
      </Space>
      <div ref={boxRef} style={{ width: '100%' }}>
        {width > 0 && layout && (
          <svg width={width} height={height + headerPx} style={{ display: 'block', fontVariantNumeric: 'tabular-nums' }}>
            <text x={laneX.prev + 2} y={12} fontSize={11} fill="#8c8c8c">{fitText(prevLabel, laneW - 4, 11, 400) ?? ''}</text>
            <text x={laneX.today + 2} y={12} fontSize={11} fill="#8c8c8c">Current day</text>
            {showStrips && ['prev', 'today'].map((lane) => TRAP_SOURCES.map((src, i) => (
              <text key={`h-${lane}-${src.id}`} x={stripX(lane, i) + stripW / 2} y={26} fontSize={narrow ? 8 : 9} fill="#8c8c8c" textAnchor="middle">
                <title>{STRIP_FULL[src.id]}</title>
                {STRIP_NAMES[src.id][narrow ? 0 : 1]}
              </text>
            )))}
            <g transform={`translate(0, ${headerPx})`}>
              {['prev', 'today'].map((lane) => <rect key={lane} x={laneX[lane]} y={0} width={laneW} height={height} fill="rgba(255,255,255,0.025)" rx={3} />)}
              {layout.ticks.map((t) => (
                <g key={t.price}>
                  <line x1={axisW} x2={lanesEnd} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.07)" />
                  <text x={axisW - 4} y={t.y + 3.5} fontSize={10} fill="#8c8c8c" textAnchor="end">{Math.round(t.price).toLocaleString('en-IN')}</text>
                </g>
              ))}
              {showStrips && ['prev', 'today'].map((lane) => TRAP_SOURCES.map((src, i) => {
                const read = used?.[lane]?.includes(src.id)
                return (
                  <rect key={`s-${lane}-${src.id}`} x={stripX(lane, i)} y={0} width={stripW} height={height} rx={1}
                    fill={read ? 'rgba(255,255,255,0.03)' : 'none'} stroke={read ? 'none' : 'rgba(255,255,255,0.18)'} strokeDasharray={read ? undefined : '2 3'}>
                    <title>{`${STRIP_FULL[src.id]}: ${read ? 'green = bullish, red = bearish at that price' : 'not present - left out'}`}</title>
                  </rect>
                )
              }))}
              {showStrips && layout.strips.map((st) => {
                const i = TRAP_SOURCES.findIndex((src) => src.id === st.id)
                if (i < 0) return null
                return <rect key={`r-${st.lane}-${st.id}-${st.price}`} x={stripX(st.lane, i)} y={st.top} width={stripW} height={st.height}
                  fill={st.value > 0 ? `rgba(82,196,26,${0.15 + 0.75 * Math.min(1, st.value)})` : `rgba(255,77,79,${0.15 + 0.75 * Math.min(1, -st.value)})`} />
              })}
              {bandViews.map((v) => (
                <g key={`${v.b.lane}-${v.z.low}-${v.z.high}`}>
                  <title>{v.title}</title>
                  <rect x={v.x} y={v.b.top} width={bandW} height={v.b.height} fill={ladderTint(v.color, v.star ? 0.38 : Math.min(0.3, 0.1 + v.z.score * 0.07))}
                    stroke={v.color} strokeWidth={v.star ? 2 : 1} strokeDasharray={v.z.from === 'today' ? undefined : '4 3'} rx={2} />
                </g>
              ))}
              {layout.lines.map((l) => (
                <g key={`${l.label}-${l.price}`}>
                  <line x1={axisW} x2={lanesEnd} y1={l.y} y2={l.y} stroke={l.color} strokeWidth={l.now ? 2 : 1} strokeDasharray={l.dashed ? '4 3' : undefined} />
                  <polyline points={`${lanesEnd},${l.y} ${lanesEnd + 6},${l.labelY}`} fill="none" stroke={l.color} strokeWidth={1} />
                  <text x={lanesEnd + 8} y={l.labelY + fontPx * 0.36} fontSize={fontPx} fontWeight={l.now ? 700 : 500} fill={l.color}>
                    {/* On a phone a line's name alone (its price is on the axis) - the price's own line keeps its price. */}
                    {fitText(narrow && !l.now ? l.label : `${l.label} ${px(l.price)}`, gutterW - 10, fontPx, l.now ? 700 : 500) ?? ''}
                  </text>
                </g>
              ))}
              {/* The zones' labels LAST - over the price lines, which used to run through them. */}
              {bandViews.filter((v) => v.b.labelY != null && v.label).map((v) => (
                <g key={`label-${v.b.lane}-${v.z.low}-${v.z.high}`}>
                  <title>{v.title}</title>
                  <rect x={v.labelX + 2} y={v.b.labelY - fontPx * 0.68} width={Math.min(v.labelW - 4, textWidth(v.label, fontPx, 600) + 6)} height={fontPx * 1.36} fill="rgba(13,17,26,0.82)" rx={2} />
                  <text x={v.labelX + 5} y={v.b.labelY + fontPx * 0.36} fontSize={fontPx} fontWeight={600} fill={v.color}>{v.label}</text>
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
      {showStrips && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          Strips: {TRAP_SOURCES.map((src) => `${STRIP_NAMES[src.id][narrow ? 0 : 1]} = ${STRIP_FULL[src.id]}`).join(' · ')} - green bullish, red bearish at that price; a dashed empty strip = not present.
        </Text>
      )}
    </div>
  )
}

/** LEVELS BY PROFILE (profileLevels): each profile's own strongest bullish / bearish cluster, the previous day(s) and the
 *  current day, with its range, its busiest row and what it is against price now. */
export function ProfileLevels({ prev, today, prevLabel, totals }) {
  const ids = TRAP_SOURCES.map((x) => x.id).filter((id) => prev?.some((p) => p.id === id) || today?.some((p) => p.id === id))
  if (!ids.length && !totals?.prev && !totals?.today) return null
  // THE HIGHEST TOTAL (OI − NET): its row, how many times the usual row's size, OUTLIER when past the rule, its role now.
  const totalCell = (t, bullish) => {
    if (!t) return <Text type="secondary" style={{ fontSize: 12 }}>{bullish ? '▲' : '▼'} none</Text>
    const k = ZONE_KINDS[t.kind]
    return (
      <span style={{ fontSize: 12, display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 4, rowGap: 2 }}>
        <Text style={{ fontSize: 12, color: bullish ? '#52c41a' : '#ff4d4f', whiteSpace: 'nowrap' }}>{bullish ? '▲' : '▼'} {px(t.low)}–{px(t.high)}</Text>
        {t.times != null && <Text type="secondary" style={{ fontSize: 11 }}> {t.times}× the usual row</Text>}{' '}
        {t.outlier ? <Tag color="gold" style={{ margin: 0, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>OUTLIER</Tag> : <Text type="secondary" style={{ fontSize: 11 }}>(not an outlier)</Text>}{' '}
        {k && <Tooltip title={k.text}><Tag color={k.color} style={{ margin: 0, color: '#000', fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>{k.short}</Tag></Tooltip>}
      </span>
    )
  }
  const totalSide = (t, label) => (
    <div>
      <Space wrap size={[8, 2]} align="center">
        <Text type="secondary" style={{ fontSize: 11, minWidth: 80, display: 'inline-block' }}>{label}</Text>
        {t ? <>{totalCell(t.bull, true)}{totalCell(t.bear, false)}</> : <Text type="secondary" style={{ fontSize: 12 }}>needs both the OI and the flow</Text>}
        {t?.outliers?.length > 2 && <Text type="secondary" style={{ fontSize: 11 }}>{t.outliers.length} outlier bands: {t.outliers.map((o) => `${o.total > 0 ? '▲' : '▼'} ${px(o.low)}–${px(o.high)}`).join(', ')}</Text>}
      </Space>
    </div>
  )
  const cell = (lv, bullish) => {
    if (!lv) return <Text type="secondary" style={{ fontSize: 12 }}>{bullish ? '▲' : '▼'} none</Text>
    const k = ZONE_KINDS[lv.kind]
    return (
      <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        <Text style={{ fontSize: 12, color: bullish ? '#52c41a' : '#ff4d4f' }}>{bullish ? '▲' : '▼'} {px(lv.low)}–{px(lv.high)}</Text>
        <Text type="secondary" style={{ fontSize: 11 }}> ({px(lv.level)})</Text>{' '}
        {k && <Tooltip title={k.text}><Tag color={k.color} style={{ margin: 0, color: '#000', fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>{k.short}</Tag></Tooltip>}
      </span>
    )
  }
  const side = (list, id, label) => {
    const p = list?.find((x) => x.id === id)
    return (
      <div>
        <Space wrap size={[8, 2]} align="center">
          <Text type="secondary" style={{ fontSize: 11, minWidth: 80, display: 'inline-block' }}>{label}</Text>
          {p ? <>{cell(p.bull, true)}{cell(p.bear, false)}</> : <Text type="secondary" style={{ fontSize: 12 }}>not present - left out</Text>}
        </Space>
      </div>
    )
  }
  return (
    <div style={{ border: `1px solid ${BORDER_COLOR}`, borderRadius: 6, padding: '6px 10px' }}>
      <Text strong style={{ fontSize: 12 }}>Levels by profile</Text>
      <Text type="secondary" style={{ fontSize: 11 }}> - each profile on its own: its strongest bullish (▲) and bearish (▼) cluster, (its busiest row), what it is against price now</Text>
      {ids.map((id) => (
        <div key={id} style={{ borderTop: `1px solid ${BORDER_COLOR}`, marginTop: 4, paddingTop: 4 }}>
          <div><Text strong style={{ fontSize: 12 }}>{STRIP_FULL[id]}</Text></div>
          {side(prev, id, prevLabel)}
          {side(today, id, 'Current day')}
        </div>
      ))}
      {totals && (
        <div style={{ borderTop: `1px solid ${BORDER_COLOR}`, marginTop: 4, paddingTop: 4 }}>
          <div>
            <Tooltip title="The option delta profile card's third column: at each price the OI's CE − PE less the net CE − PE flow, the flow scaled to the OI's size so both count equally - bullish when puts are written and / or calls bought there. The highest row of each side; OUTLIER = far past the usual row's size (median + 3 robust deviations).">
              <Text strong style={{ fontSize: 12, borderBottom: '1px dotted #8c8c8c' }}>Total (OI − Net) - the highest, and its outliers</Text>
            </Tooltip>
          </div>
          {totalSide(totals.prev, prevLabel)}
          {totalSide(totals.today, 'Current day')}
        </div>
      )}
    </div>
  )
}

/** One side's zones (support / resistance), nearest first. */
function SideList({ title, zones, color }) {
  return (
    <Space direction="vertical" size={2} style={{ minWidth: 240, flex: 1 }}>
      <Text strong style={{ fontSize: 12, color }}>{title}</Text>
      {zones.length ? zones.slice(0, 4).map((z, i) => (
        <Space key={`${z.from}-${z.low}-${z.high}-${i}`} size={4} wrap>
          <Text style={{ fontSize: 12, minWidth: 110, display: 'inline-block' }}>{px(z.low)} – {px(z.high)}</Text>
          <KindTag kind={z.kind} />
          <Text type="secondary" style={{ fontSize: 11 }}>{z.distance === 0 ? 'at price' : pct(z.distance)} · {z.from === 'today' ? 'today' : 'before'} · {shortOf(z.sources)}{z.against?.length ? ` (${shortOf(z.against)} against)` : ''}</Text>
        </Space>
      )) : <Text type="secondary" style={{ fontSize: 12 }}>none near</Text>}
    </Space>
  )
}

/** The best zone of each side (bestZones), the better one first, with why - starred on the chart. */
function BestZones({ best }) {
  const list = [best?.best, best?.best === best?.support ? best?.resistance : best?.support].filter(Boolean)
  if (!list.length) return null
  return (
    <div style={{ border: '1px solid #faad14', borderRadius: 6, padding: '6px 10px' }}>
      {list.map((b, i) => {
        const z = b.zone
        const support = best.support === b
        return (
          <div key={support ? 's' : 'r'} style={{ fontSize: 12, marginTop: i ? 2 : 0 }}>
            <Text strong style={{ fontSize: i ? 12 : 13, color: '#faad14' }}>★ {i ? 'Other side' : 'Best zone now'}:</Text>{' '}
            <Text strong style={{ fontSize: 12, color: support ? '#52c41a' : '#ff4d4f' }}>{support ? 'support' : 'resistance'} {px(z.low)} – {px(z.high)}</Text>{' '}
            <KindTag kind={z.kind} />{' '}
            <Text type="secondary" style={{ fontSize: 11 }}>
              {z.distance === 0 ? 'at price' : pct(z.distance)} · {z.from === 'today' ? 'today' : 'before'} · {shortOf(z.sources)} · quality {b.quality}
              {b.reasons.length ? ` - ${b.reasons.join(', ')}` : ''}
            </Text>
          </div>
        )
      })}
    </div>
  )
}

const lots = (v) => `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-IN')} lots`
/** The biggest CDV support / resistance - the sessions before and the day so far (cdvLevels). */
function CdvLevelsLine({ prev, today }) {
  const part = (lv, side) => (lv?.[side] ? `${side === 'support' ? 'S' : 'R'} ${px(lv[side].low)}–${px(lv[side].high)} (peak ${px(lv[side].level)}, ${lots(lv[side].sum)})` : `${side === 'support' ? 'S' : 'R'} none`)
  return (
    <Text style={{ fontSize: 12 }}>
      <b>Biggest CDV (net CE − PE) support / resistance</b> - before (fixed from the start): {prev?.support || prev?.resistance ? `${part(prev, 'support')} · ${part(prev, 'resistance')}` : 'none loaded'}
      {' '}| today, developing: {today ? `${part(today, 'support')} · ${part(today, 'resistance')}` : 'not yet'}
    </Text>
  )
}

const oiAmount = (v) => `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-IN')} OI`
/** The biggest OI (CE − PE) support / resistance - the sessions before and the day so far (oiLevels): puts written = support,
 *  calls written = resistance. */
function OiLevelsLine({ prev, today }) {
  const part = (lv, side) => (lv?.[side] ? `${side === 'support' ? 'S' : 'R'} ${px(lv[side].low)}–${px(lv[side].high)} (peak ${px(lv[side].level)}, ${oiAmount(lv[side].sum)})` : `${side === 'support' ? 'S' : 'R'} none`)
  return (
    <Text style={{ fontSize: 12 }}>
      <b>Biggest OI (CE − PE) support / resistance</b> <Text type="secondary" style={{ fontSize: 11 }}>(puts written = support, calls written = resistance)</Text> - before (fixed from the start): {prev?.support || prev?.resistance ? `${part(prev, 'support')} · ${part(prev, 'resistance')}` : 'none loaded'}
      {' '}| today, developing: {today ? `${part(today, 'support')} · ${part(today, 'resistance')}` : 'not yet'}
    </Text>
  )
}

/** The trade setups (tradeSetups) - ideas, each with its trigger, stop, targets and reward / risk. */
function SetupList({ setups }) {
  if (!setups.length) return <Text type="secondary" style={{ fontSize: 12 }}>No setup near price yet.</Text>
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {setups.map((x) => (
        <div key={x.id} style={{ border: `1px solid ${x.side === 'long' ? '#237804' : '#a8071a'}`, borderRadius: 6, padding: '6px 10px' }}>
          <Space wrap size={[6, 2]} align="center">
            <Tag color={x.side === 'long' ? 'green' : 'red'} style={{ margin: 0 }}>{x.side === 'long' ? 'LONG' : 'SHORT'}</Tag>
            <Tag color={x.status === 'ready' ? 'gold' : 'default'} style={{ margin: 0 }}>{x.status === 'ready' ? 'READY - price at the trigger' : 'WATCH'}</Tag>
            <Text strong style={{ fontSize: 12 }}>{x.name}</Text>
            {x.aligned === true && <Tag color="blue" style={{ margin: 0 }}>with the day&apos;s read</Tag>}
            {x.aligned === false && <Tag style={{ margin: 0 }}>against the read - smaller size</Tag>}
          </Space>
          <div style={{ fontSize: 12, marginTop: 2 }}>
            {x.entryText}. <Text type="secondary" style={{ fontSize: 12 }}>{x.option}</Text>
          </div>
          <div style={{ fontSize: 12 }}>
            Entry ~{px(x.entry)} · Stop {px(x.stop)} ({px(Math.abs(x.entry - x.stop))} pts)
            {x.targets.length ? ` · Target ${x.targets.map(px).join(' / ')}` : ' · no zone the other way - trail it'}
            {x.rr != null && <> · <Text strong style={{ fontSize: 12, color: x.rr >= 1.5 ? '#52c41a' : x.rr < 1 ? '#ff4d4f' : undefined }}>R:R {x.rr}</Text></>}
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>{x.why}</Text>
        </div>
      ))}
    </Space>
  )
}

const eventText = (e) => {
  if (e.type === 'verdict') return `Bias now ${e.to} (was ${e.from})`
  if (e.type === 'newZone') return `New ${ZONE_KINDS[e.zone.kind]?.label.split(' - ')[0].toLowerCase() ?? 'zone'} of the day ${px(e.zone.low)}–${px(e.zone.high)} (${shortOf(e.zone.sources)})`
  if (e.type === 'roleChange') return `${px(e.zone.low)}–${px(e.zone.high)}: ${ZONE_KINDS[e.fromKind]?.label.split(' - ')[0]} → ${ZONE_KINDS[e.zone.kind]?.label}`
  return `${EVENT_TEXT[e.type]}${e.zone ? ` ${px(e.zone.low)}–${px(e.zone.high)}` : ''}`
}

/**
 * `cePoints` / `pePoints` (the page's option points), `spotBars` (chart time, seconds), `asOfMs` (the replay clock; live
 * the latest), `underlying`, `date`, `expiryFlag`, `isLive`.
 */
export function TrapZonesCard({ cePoints, pePoints, spotBars, asOfMs, underlying, date, expiryFlag, isLive = false }) {
  const [days, setDays] = usePersistedState('optionanalytics.oiReplay.trapZonesDays', 1)
  const dayCount = [1, 2, 3].includes(days) ? days : 1
  const [chartTf, setChartTf] = usePersistedState('optionanalytics.oiReplay.trapZonesTf', 5)
  const [showPrev, setShowPrev] = usePersistedState('optionanalytics.oiReplay.trapZonesPrev', true)
  const [showToday, setShowToday] = usePersistedState('optionanalytics.oiReplay.trapZonesToday', true)
  const [showCdv, setShowCdv] = usePersistedState('optionanalytics.oiReplay.trapZonesCdv', true)
  const [showOi, setShowOi] = usePersistedState('optionanalytics.oiReplay.trapZonesOi', true)
  const [showLadder, setShowLadder] = usePersistedState('optionanalytics.oiReplay.trapZonesLadder', true)
  const [ladderSpan, setLadderSpan] = usePersistedState('optionanalytics.oiReplay.trapZonesLadderSpan', 1)
  const [showStrips, setShowStrips] = usePersistedState('optionanalytics.oiReplay.trapZonesStrips', true)
  const [showTotals, setShowTotals] = usePersistedState('optionanalytics.oiReplay.trapZonesTotals', true)
  const [showOpenClose, setShowOpenClose] = usePersistedState('optionanalytics.oiReplay.trapZonesOpenClose', true)
  const [modeSaved, setMode] = usePersistedState('optionanalytics.oiReplay.trapZonesMode', 'composite')
  const mode = ZONE_MODES.includes(modeSaved) ? modeSaved : 'composite'
  const rowSize = PROFILE_ROWS[underlying] ?? 5
  const flag = expiryFlag || (underlying === 'BANKNIFTY' ? 'MONTH' : 'WEEK')
  const pastOpt = usePastDeltaSessions('options', underlying, date, dayCount, flag)
  const pastFut = usePastDeltaSessions('futures', underlying, date, dayCount)
  const futDay = useFuturesFootprintDay(underlying, date, isLive, rowSize)
  const clock = asOfMs == null ? null : Math.floor(asOfMs / MIN) * MIN
  const spotMs = useMemo(() => (spotBars ?? []).map((b) => ({ time: fromChartTime(b.time) * 1000, open: b.open, high: b.high, low: b.low, close: b.close }))
    .filter((b) => clock == null || b.time <= clock), [spotBars, clock])
  const todayOptions = useMemo(() => optionDeltaMinutes(cePoints, pePoints, spotMs, { asOfMs }), [cePoints, pePoints, spotMs, asOfMs])
  const todayOi = useMemo(() => optionOiMinutes(cePoints, pePoints, spotMs, { asOfMs }), [cePoints, pePoints, spotMs, asOfMs])
  const todayFut = useMemo(() => barsUpTo(futDay.bars ?? NONE, asOfMs), [futDay.bars, asOfMs])
  const opening = useMemo(() => openingRead({ prevOptions: pastOpt.sessions, prevFutures: pastFut.sessions, rowSize, mode }), [pastOpt.sessions, pastFut.sessions, rowSize, mode])
  const day = useMemo(() => dayRead({ opening, options: todayOptions, oi: todayOi, futures: todayFut, spot: spotMs, rowSize, mode }), [opening, todayOptions, todayOi, todayFut, spotMs, rowSize, mode])
  // The day bias from the open - fixed once the first minute is in (before it: the pre-open read).
  const dayOpen = spotMs.length ? (spotMs[0].open > 0 ? spotMs[0].open : spotMs[0].close) : null
  const bias = useMemo(() => openingBias({ opening, prevOptions: pastOpt.sessions, open: dayOpen, rowSize }), [opening, pastOpt.sessions, dayOpen, rowSize])
  const chartCandles = useMemo(() => candlesOf((spotBars ?? []).filter((b) => clock == null || fromChartTime(b.time) * 1000 <= clock), CHART_TF.includes(chartTf) ? chartTf : 5), [spotBars, clock, chartTf])
  // The live price over the chart and, when the spot feed has stopped (the last minute is over 2 min behind the clock), a warning.
  const spotRead = useMemo(() => spotFeedRead(spotMs, asOfMs, { live: isLive, inSession: asOfMs != null && inMarketSession(asOfMs) }), [spotMs, asOfMs, isLive])
  const sides = useMemo(() => supportResistance(day ? day.zones : opening.zones), [day, opening.zones])
  const tableZones = useMemo(() => (day ? day.zones : (opening.zones ?? []).map((z) => ({ ...z, from: 'prev' }))), [day, opening.zones])
  // The biggest CDV support / resistance: the sessions before (fixed from the start of the day) and the day so far
  // (developing - the minutes up to the clock).
  const cdvPrev = useMemo(() => cdvLevels(pastOpt.sessions.map((x) => x.items ?? []), rowSize), [pastOpt.sessions, rowSize])
  const cdvToday = useMemo(() => (todayOptions.length ? cdvLevels([todayOptions], rowSize) : null), [todayOptions, rowSize])
  // The biggest OI (CE − PE) support / resistance the same way: the sessions before (fixed) and the day so far (developing).
  const oiPrev = useMemo(() => oiLevels(pastOpt.sessions.map((x) => x.oi ?? []), rowSize), [pastOpt.sessions, rowSize])
  const oiToday = useMemo(() => (todayOi.length ? oiLevels([todayOi], rowSize) : null), [todayOi, rowSize])
  const best = useMemo(() => bestZones({ zones: tableZones, cdv: { prev: cdvPrev, today: cdvToday } }), [tableZones, cdvPrev, cdvToday])
  const chartBoxes = useMemo(() => zoneBoxes(tableZones, { showPrev, showToday, best }), [tableZones, showPrev, showToday, best])
  const chartLines = useMemo(() => [
    ...(showOpenClose ? [
      { price: day?.open, color: '#d9d9d9', title: 'Open', style: 2 },
      { price: opening.close, color: '#8c8c8c', title: 'Prev close', style: 1 },
    ] : []),
    ...(showCdv ? [
      { price: cdvPrev.support?.level, color: '#73d13d', title: 'Prev CDV S', style: 2, width: 2 },
      { price: cdvPrev.resistance?.level, color: '#ff7875', title: 'Prev CDV R', style: 2, width: 2 },
      { price: cdvToday?.support?.level, color: '#52c41a', title: 'CDV S', width: 2 },
      { price: cdvToday?.resistance?.level, color: '#ff4d4f', title: 'CDV R', width: 2 },
    ] : []),
    ...(showOi ? [
      { price: oiPrev.support?.level, color: '#91d5ff', title: 'Prev OI S', style: 2, width: 2 },
      { price: oiPrev.resistance?.level, color: '#ffc069', title: 'Prev OI R', style: 2, width: 2 },
      { price: oiToday?.support?.level, color: '#40a9ff', title: 'OI S', width: 2 },
      { price: oiToday?.resistance?.level, color: '#fa8c16', title: 'OI R', width: 2 },
    ] : []),
  ], [day?.open, opening.close, showOpenClose, showCdv, cdvPrev, cdvToday, showOi, oiPrev, oiToday])
  const setups = useMemo(() => tradeSetups({ day, bias, rowSize, best }), [day, bias, rowSize, best])
  const prevLabel = dayCount === 1 ? 'Previous day' : `Previous ${dayCount} days`
  const ladderRows = useMemo(() => ({ prev: opening.rows ?? [], today: day?.rows ?? [] }), [opening.rows, day?.rows])
  const ladderUsed = useMemo(() => ({ prev: opening.used ?? [], today: day?.used ?? [] }), [opening.used, day?.used])
  const nowPrice = day?.price ?? opening.close
  const levelsPrev = useMemo(() => profileLevels(opening.rows, opening.used, rowSize, nowPrice), [opening.rows, opening.used, rowSize, nowPrice])
  const levelsToday = useMemo(() => (day ? profileLevels(day.rows, day.used, rowSize, nowPrice) : null), [day, rowSize, nowPrice])
  const totalsRead = useMemo(() => ({
    prev: totalOutliers(opening.rows, opening.used, rowSize, nowPrice),
    today: day ? totalOutliers(day.rows, day.used, rowSize, nowPrice) : null,
  }), [opening.rows, opening.used, day, rowSize, nowPrice])
  // The highest Total (OI − Net) rows that are OUTLIERS, as lines on the chart and the ladder - the previous day(s) dashed,
  // the current day solid (none when the highest is not an outlier - a line for an ordinary row says nothing).
  const allLines = useMemo(() => {
    if (!showTotals) return chartLines
    const out = []
    const add = (t, prefix, style) => {
      if (t?.bull?.outlier) out.push({ price: t.bull.level, color: '#36cfc9', title: `${prefix}Total ▲`, style, width: 2 })
      if (t?.bear?.outlier) out.push({ price: t.bear.level, color: '#f759ab', title: `${prefix}Total ▼`, style, width: 2 })
    }
    add(totalsRead.prev, 'Prev ', 2)
    add(totalsRead.today, '', 0)
    return [...chartLines, ...out]
  }, [chartLines, showTotals, totalsRead])
  const ladderMarks = useMemo(() => allLines.filter((l) => l.title).map((l) => ({ price: l.price, label: l.title, color: l.color, dashed: l.style === 2 })), [allLines])
  // The day re-read every STEP_MIN minutes - worked out again only when a new step completes (live pushes every second
  // would otherwise redo it all), from the minutes up to each step.
  const lastStep = spotMs.length ? Math.floor((spotMs[spotMs.length - 1].time - spotMs[0].time + MIN) / (STEP_MIN * MIN)) : 0
  const timelineKey = `${underlying}|${date}|${lastStep}|${opening.zones?.length}|${opening.close}|${futDay.bars?.length ? 1 : 0}|${mode}`
  const zoneEvents = useMemo(
    () => dayTimeline({ opening, options: todayOptions, oi: todayOi, futures: todayFut, spot: spotMs, rowSize, stepMin: STEP_MIN, mode }),
    [timelineKey], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const events = useMemo(() => {
    if (!day) return []
    const list = [
      ...day.openRule.events.map((e) => ({ t: e.t, type: e.state ?? 'off' })),
      ...day.crossings.map((e) => ({ t: e.t, type: e.type, zone: e.zone })),
      ...zoneEvents,
    ]
    return list.sort((a, b) => b.t - a.t).slice(0, 14)
  }, [day, zoneEvents])

  const verdictType = !day ? 'info' : day.score >= 2 ? 'success' : day.score <= -2 ? 'error' : 'info'
  const loadingPast = pastOpt.loading || pastFut.loading
  const openingLean = opening.lean > 0.25 ? 'leans UP' : opening.lean < -0.25 ? 'leans DOWN' : 'balanced'

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={[8, 6]} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>Positions from</Text>
        <Segmented size="small" value={dayCount} onChange={setDays} options={DAY_CHOICES} />
        <Text type="secondary" style={{ fontSize: 12 }}>Zones</Text>
        <Segmented
          size="small" value={mode} onChange={setMode}
          options={[{ value: 'composite', label: 'Combined (recommended)' }, { value: 'union', label: 'Each profile (first version)' }]}
        />
        {loadingPast && <Tag color="processing" style={{ margin: 0 }}>loading the sessions before…</Tag>}
        {pastOpt.error && <Tag color="warning" style={{ margin: 0 }}>{pastOpt.error.date}: {pastOpt.error.message}</Tag>}
        {futDay.error && <Tooltip title={futDay.error}><Tag style={{ margin: 0 }}>no futures footprint today</Tag></Tooltip>}
        {isLive && <Tag color="green" style={{ margin: 0 }}>live</Tag>}
      </Space>

      <Text type="secondary" style={{ fontSize: 11 }}>
        {mode === 'union'
          ? 'Each profile (first version): every profile\'s own clusters, joined where they overlap - nothing cancels, so a bullish and a bearish zone can sit on the same prices (the ladder splits each column: bullish left, bearish right). The bias, best zone and setups below read these zones.'
          : 'Combined: the profiles added into one - where they agree a zone is strong, where they disagree they cancel; tight zones that never overlap. Each profile on its own: the strips in the ladder and "Levels by profile".'}
      </Text>

      <div style={{ border: `1px solid ${biasColor(bias.score)}`, borderRadius: 6, padding: '6px 10px' }}>
        <Text style={{ fontSize: 13 }}>
          <b>Day bias {bias.open ? `from the open (${px(bias.open)})` : '(pre-open)'}:</b>{' '}
          <Text strong style={{ fontSize: 13, color: biasColor(bias.score) }}>{bias.bias}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · score {bias.score > 0 ? '+' : ''}{bias.score} · fixed for the day</Text>
        </Text>
        {bias.reasons.length > 0 && <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{bias.reasons.map((r) => <li key={r} style={{ fontSize: 12 }}>{r}</li>)}</ul>}
      </div>

      {day ? (
        <Alert
          type={verdictType} showIcon
          message={<span><b>{day.verdict}</b> · price {px(day.price)} vs open {px(day.open)} ({pct((day.price - day.open) / day.open * 100)}){!isLive && asOfMs ? ` · at ${hhmm(asOfMs)}` : ''}</span>}
          description={day.reasons.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{day.reasons.map((r) => <li key={r} style={{ fontSize: 12 }}>{r}</li>)}</ul> : <Text style={{ fontSize: 12 }}>Nothing decisive yet.</Text>}
        />
      ) : (
        <Alert type="info" showIcon message="Before the open" description="The day's first minute is not in yet - the read below is from the sessions before." />
      )}

      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Text strong style={{ fontSize: 13 }}>Trade setups <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>(ideas from the zones at this minute - not orders; levels are spot)</Text></Text>
        <SetupList setups={setups} />
      </Space>

      <Text style={{ fontSize: 12 }}>
        <b>Before the open</b> ({pastOpt.sessions.map((s) => s.date).join(', ') || 'no session loaded'}): close {px(opening.close)} - positioning {openingLean}
        {opening.zones?.length ? ` · nearest: ${opening.zones.slice(0, 2).map((z) => `${ZONE_KINDS[z.kind]?.label.split(' - ')[0]} ${px(z.low)}–${px(z.high)}`).join(', ')}` : ''}
      </Text>
      <Space wrap size={[12, 2]}>
        <ProfilesRead label="Profiles read - before:" read={opening} />
        {day && <ProfilesRead label="today:" read={day} />}
      </Space>

      {day && day.openRule.gross > 0 && (
        <Text style={{ fontSize: 12 }}>
          <b>Open rule</b>: OI CE − PE added below the open {Math.round(day.openRule.below).toLocaleString('en-IN')} · above {Math.round(day.openRule.above).toLocaleString('en-IN')}
          {' '}→ <Text strong style={{ fontSize: 12, color: day.openRule.state === 'bull' ? '#52c41a' : day.openRule.state === 'bear' ? '#ff4d4f' : undefined }}>
            {day.openRule.state === 'bull' ? `trend-day-up setup since ${hhmm(day.openRule.since)}` : day.openRule.state === 'bear' ? `trend-day-down setup since ${hhmm(day.openRule.since)}` : 'not on'}
          </Text>
        </Text>
      )}

      <Space wrap align="start" size={[16, 8]} style={{ width: '100%' }}>
        <SideList title="Support below (floors / trapped shorts)" zones={sides.support} color="#52c41a" />
        <SideList title="Resistance above (ceilings / trapped longs)" zones={sides.resistance} color="#ff4d4f" />
      </Space>

      <BestZones best={best} />
      {showCdv && <CdvLevelsLine prev={cdvPrev} today={cdvToday} />}
      {showOi && <OiLevelsLine prev={oiPrev} today={oiToday} />}

      <Space wrap size={[8, 4]} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>On spot</Text>
        <Segmented size="small" value={CHART_TF.includes(chartTf) ? chartTf : 5} onChange={setChartTf} options={CHART_TF.map((v) => ({ value: v, label: `${v}m` }))} />
        <Checkbox checked={showPrev} onChange={(e) => setShowPrev(e.target.checked)}>Zones from before (dashed)</Checkbox>
        <Checkbox checked={showToday} onChange={(e) => setShowToday(e.target.checked)}>Today&apos;s zones (solid)</Checkbox>
        <Checkbox checked={showCdv} onChange={(e) => setShowCdv(e.target.checked)}>CDV S / R lines</Checkbox>
        <Checkbox checked={showOi} onChange={(e) => setShowOi(e.target.checked)}>OI S / R lines</Checkbox>
        <Checkbox checked={showOpenClose} onChange={(e) => setShowOpenClose(e.target.checked)}>Open / prev close</Checkbox>
        <Checkbox checked={showLadder} onChange={(e) => setShowLadder(e.target.checked)}>Ladder</Checkbox>
        <Checkbox checked={showTotals} onChange={(e) => setShowTotals(e.target.checked)}>Total (OI − Net) outliers</Checkbox>
      </Space>
      {spotRead && (
        <Space wrap size={[8, 2]} align="center">
          <Text style={{ fontSize: 13 }}>
            Spot <b>{px(spotRead.price)}</b>
            {opening.close > 0 && <Text type="secondary" style={{ fontSize: 12 }}> ({pct((spotRead.price - opening.close) / opening.close * 100)} vs previous close)</Text>}
            <Text type="secondary" style={{ fontSize: 12 }}> · {isLive ? 'last minute' : 'at'} {hhmm(spotRead.minute)}</Text>
          </Text>
          {spotRead.stale && (
            <Tooltip title="The page's live spot feed has not delivered a new minute for over 2 minutes while the market is open - the price here is the last one received. Check the Live badge / connection at the top of the page, or reload.">
              <Tag color="warning" style={{ margin: 0 }}>Spot feed behind: stopped at {hhmm(spotRead.minute)}, now {hhmm(asOfMs)}</Tag>
            </Tooltip>
          )}
        </Space>
      )}
      {chartCandles.length ? (
        <ZonesSpotChart candles={chartCandles} boxes={chartBoxes} lines={allLines} dayKey={`${underlying}|${date}|${chartTf}`} />
      ) : <Text type="secondary" style={{ fontSize: 12 }}>No spot candles up to this minute yet.</Text>}

      {showLadder && (
        <ZoneLadder
          zones={tableZones} price={day?.price ?? opening.close} marks={ladderMarks} best={best}
          rows={ladderRows} used={ladderUsed} rowSize={rowSize} showStrips={showStrips} onStrips={setShowStrips} split={mode === 'union'}
          prevLabel={prevLabel} spanPct={LADDER_SPANS.includes(ladderSpan) ? ladderSpan : 1} onSpan={setLadderSpan}
        />
      )}
      <ProfileLevels prev={levelsPrev} today={levelsToday} prevLabel={prevLabel} totals={showTotals ? totalsRead : null} />

      <FoldText id="oiReplay.trapZones.table" label="all zones" summary={<Text type="secondary" style={{ fontSize: 12 }}>All zones ({tableZones.length}) - open for the table</Text>}>
        <ZoneTable zones={tableZones} />
      </FoldText>

      {events.length > 0 && (
        <Space direction="vertical" size={2}>
          <Text type="secondary" style={{ fontSize: 12 }}>Through the day (newest first)</Text>
          {events.map((e, i) => (
            <Text key={`${e.t}-${e.type}-${i}`} style={{ fontSize: 12 }}>
              {hhmm(e.t)} · {eventText(e)}
            </Text>
          ))}
        </Space>
      )}

      <FoldText id="oiReplay.trapZones" label="how to read this" className="oa-note">
        <Text type="secondary" style={{ fontSize: 12 }}>
          The position profiles - OI (CE − PE), the net CE − PE flow (which IS the option CDV: the option delta profile&apos;s Net
          side and the CDV / OBV profile&apos;s CDV column are the same numbers, so it is counted once, &quot;Net/CDV&quot;), the option
          OBV and the futures delta (left out when there is no futures data, or no same-day close to move it onto spot) - are
          added into ONE profile, each scaled by its own largest row and read bullish-positive (OI negated: puts written =
          bullish). Where they agree a row is strong, where they disagree they cancel, so a bullish and a bearish zone never sit
          on the same prices; each zone is the tight core of a run of one sign (the rows around its peak holding 70% of it),
          named with the profiles behind it and any pushing against it; strength 1 = one profile at its largest, up to the
          number agreeing. The tags under &quot;Before the open&quot; show which profiles each read used. Those positions were
          opened at those prices, so where price is now says who is in profit
          and who is trapped. A bullish cluster below price is a FLOOR (buyers / put writers defend it); above price those
          buyers are TRAPPED - their exits are supply (long liquidation). A bearish cluster above price is a CEILING; below price
          its sellers / call writers are TRAPPED - their covering is fuel (SHORT SQUEEZE). BEFORE THE OPEN the previous session(s)&apos; zones are read
          against their close; THROUGH THE DAY against the price at the replay clock, with the day&apos;s own clusters (today&apos;s
          column). A previous ceiling closed above = its sellers trapped = squeeze; a previous floor closed below = long
          liquidation. THE OPEN RULE (yours): the OI added below the day&apos;s open net CE − PE negative (puts written under the
          open) with price above the open = the writers defend a floor under a rising market - a trend-day-up setup; calls
          written above the open with price below it = trend-day-down; it counts once it holds 3 minutes. The verdict adds the
          open rule (±2), today&apos;s flows (±1 each - the futures only when present) and a squeeze still standing (±1). Futures zones are moved to spot by
          the basis. DAY BIAS: fixed once the day's first minute is in, from what was known then - the previous zones' lean at the close
          and at the open, a gap through a zone (its side trapped from the open), the last session's OI and CDV. Through the day
          the profiles are re-read every 5 minutes: a new zone of the day, a previous zone changing role and the bias changing are
          listed under &quot;Through the day&quot;. TRADE SETUPS - ideas only, nothing is placed: floor bounce (the nearest support,
          stop under it), ceiling rejection (the nearest resistance, stop over it), squeeze / liquidation continuation (the retest
          of a zone price broke through and holds beyond), the open-rule trend day (dips toward the open) and a failed squeeze /
          breakdown (back inside within 15 minutes - the breakout traders trapped); targets = the next zones the other way, R:R =
          the first target against the stop; READY = price at the trigger now, WATCH = wait for it; one against the day&apos;s
          read is flagged for a smaller size. BEST ZONE (★ on the chart, outlined thicker): each zone rated by its strength,
          the profiles agreeing (+50% each beyond one) and against (−25% each), the sessions before and today both building it
          (×1.5), a biggest CDV level of its side inside it (×1.3 each) and its nearness to price; the best support and the best
          resistance are starred - the bounce / rejection setups trade those. BIGGEST CDV SUPPORT / RESISTANCE: the net CE − PE
          flow&apos;s strongest buying cluster (support) and selling cluster (resistance) - of the sessions before, fixed from the
          start of the day (dashed &quot;Prev CDV S / R&quot; lines at each cluster&apos;s busiest row), and of the day so far,
          developing (solid &quot;CDV S / R&quot;). TOTAL (OI − NET): the option delta card&apos;s third column - at each price the OI&apos;s
          CE − PE less the net flow, both scaled to count equally; its highest bullish (▲) and bearish (▼) row, how many times
          the usual row&apos;s size, and OUTLIER when far past it (median + 3 robust deviations) - an outlier drawn as a line
          (&quot;Total ▲ / ▼&quot;, dashed for the days before). LEVELS BY PROFILE: the zones add the profiles together, so where two disagree they cancel - the
          profile strips in the ladder (O / OI = OI CE − PE, the OI delta; N / Net = net CE − PE, which IS the option CDV; B /
          OBV; F / Fut = futures delta) and the &quot;Levels by profile&quot; list show each one ON ITS OWN: green where it is
          bullish at a price, red where bearish; its strongest bullish / bearish cluster with its range, busiest row and role
          against price now. THE LADDER (under the chart), to scale: the previous day(s) in the left lane and
          the current day in the right, each zone a band at its real price (dashed previous, solid current), the price, the open,
          the previous close and the CDV lines across both, ±0.5 / 1 / 2% of price; ★ = the best zone of its side; hover a band
          for its details. Only the minutes up to the clock count. A read - it feeds no strategy or alert.
        </Text>
      </FoldText>
    </Space>
  )
}
