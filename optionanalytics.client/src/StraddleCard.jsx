import { useEffect, useMemo, useRef, useState } from 'react'
import { Col, Row, Segmented, Select, Space, Tag, TimePicker, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { CrosshairMode, LineSeries, LineStyle, LineType, createSeriesMarkers } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { STRADDLE_START_DEFAULT, straddleRead } from './straddle.js'
import { sanitizeLine } from './chartLine.js'

const { Text } = Typography

const STRADDLE_COLOR = '#f5a623'
const VWAP_COLOR = '#4c9ffe'
const FIXED_COLOR = '#b37feb'
const FIXED_VWAP_COLOR = '#9aa4b2'
const SPOT_COLOR = '#d9d9d9'

const VERDICT_COLORS = {
  sideways: 'geekblue', building: 'purple', none: 'default', early: 'default', unconfirmed: 'gold', fake: 'orange',
}
const verdictColor = (v) => (v.kind === 'trend' || v.kind === 'breakout' ? (v.side === 'down' ? 'red' : 'green') : VERDICT_COLORS[v.kind] ?? 'default')

// HH:mm in IST, whatever the browser's own zone.
const hhmm = (ms) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16)
const num = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '-')
const signed = (v, digits = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}` : '-')

// A few lines on one time axis. `lines`: [{ id, title, color, width, style, steps, scale, data: [{ time (ms), value }] }] -
// the set of ids is fixed for a chart's life (a new set rebuilds it); `scale: 'left'` puts a line on its own left price
// scale (one far from the others would flatten them); `markers` go on the first line.
export function LinesChart({ lines, markers = [], dayKey, height }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(new Map())
  const markersRef = useRef(null)
  const ids = lines.map((l) => l.id).join('|')

  useEffect(() => {
    if (!containerRef.current) return undefined
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      leftPriceScale: { visible: lines.some((l) => l.scale === 'left'), borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    const series = new Map()
    lines.forEach((l) => {
      series.set(l.id, chart.addSeries(LineSeries, {
        color: l.color, lineWidth: l.width ?? 2, lineStyle: l.style ?? LineStyle.Solid, lineType: l.steps ? LineType.WithSteps : LineType.Simple,
        title: l.title ?? '', priceLineVisible: false, lastValueVisible: l.lastValue ?? true, priceScaleId: l.scale === 'left' ? 'left' : 'right',
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      }))
    })
    seriesRef.current = series
    markersRef.current = lines.length ? createSeriesMarkers(series.get(lines[0].id), []) : null
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = new Map()
      markersRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, ids])

  useEffect(() => {
    for (const l of lines) seriesRef.current.get(l.id)?.setData(sanitizeLine(l.data.map((p) => ({ time: toChartTime(p.time), value: p.value }))))
    markersRef.current?.setMarkers(markers.map((m) => ({ ...m, time: toChartTime(m.time) })))
  }, [lines, markers])
  useFitContentAsDataGrows(chartRef, lines[0]?.data.length ?? 0, dayKey)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

/**
 * The straddle from a set time - straddle.js, the two charts the option tools draw: the Auto ATM straddle (the strike
 * nearest the futures price, switching when it changes) and a fixed straddle (the start's ATM, or a strike picked here,
 * never shifted), each against the VWAP of its combined premium; the range the options priced at the start, ATM IV and
 * the read (sideways / trend / breakout / fake) - as of the replay clock (`asOfMs`; null - live - every minute given;
 * 0 - the replay not started), so it runs with OI Replay, replayed or live.
 */
export function StraddleCard({ cePoints, pePoints, spotBars, asOfMs, dayKey, expiry = null, height = 260 }) {
  const [start, setStart] = usePersistedState('optionanalytics.oiReplay.straddleStart', STRADDLE_START_DEFAULT)
  const [holdMinutes, setHoldMinutes] = usePersistedState('optionanalytics.oiReplay.straddleHold', 15)
  const [scope, setScope] = usePersistedState('optionanalytics.oiReplay.straddleScope', 'day')
  // The fixed strike picked for this day ('atm' = the ATM at the start time) - a new day starts at the ATM again.
  const [pick, setPick] = useState({ dayKey, strike: 'atm' })
  const fixedStrike = pick.dayKey === dayKey && pick.strike !== 'atm' ? pick.strike : null

  const read = useMemo(
    () => straddleRead(cePoints, pePoints, spotBars, { start, asOfMs, fixedStrike, holdMinutes, scope, expiry }),
    [cePoints, pePoints, spotBars, start, asOfMs, fixedStrike, holdMinutes, scope, expiry],
  )
  const charts = useMemo(() => {
    const s = read.series
    const line = (pick) => s.filter((p) => Number.isFinite(pick(p))).map((p) => ({ time: p.time, value: pick(p) }))
    const fixed = read.fixed
    const straddle = [
      { id: 'straddle', title: 'Auto ATM', color: STRADDLE_COLOR, data: line((p) => p.value) },
      { id: 'vwap', title: 'VWAP', color: VWAP_COLOR, width: 1, style: LineStyle.Dashed, data: line((p) => p.vwap) },
      { id: 'fixed', title: fixed ? `Fixed ${fixed.strike}` : 'Fixed', color: FIXED_COLOR, width: 2, scale: 'left', data: line((p) => p.fixed) },
      { id: 'fixedVwap', title: 'Its VWAP', color: FIXED_VWAP_COLOR, width: 1, style: LineStyle.Dashed, scale: 'left', data: line((p) => p.fixedVwap) },
    ]
    const day = read.day
    const spot = [
      { id: 'spot', title: 'Spot', color: SPOT_COLOR, data: line((p) => p.spot) },
      { id: 'upper', title: day ? `${hhmm(day.time)} +${num(day.width, 0)}` : '', color: UP_COLOR, width: 1, style: LineStyle.Dashed, data: day ? s.map((p) => ({ time: p.time, value: day.upper })) : [] },
      { id: 'lower', title: day ? `${hhmm(day.time)} −${num(day.width, 0)}` : '', color: DOWN_COLOR, width: 1, style: LineStyle.Dashed, data: day ? s.map((p) => ({ time: p.time, value: day.lower })) : [] },
    ]
    return { straddle, spot }
  }, [read])

  const fixedOptions = [
    { value: 'atm', label: `ATM at ${start}${read.day && !read.fixed?.asked ? ` (${read.day.strike})` : ''}` },
    ...read.fixedChoices.map((k) => ({ value: k, label: String(k) })),
  ]
  const controls = (
    <Space wrap size={[16, 6]} style={{ marginBottom: 8 }}>
      <Tooltip title="The time the straddle is first read - its value then, around its strike, is the range the options priced for the day, and the fixed straddle is taken then. 09:15 (the open) by default; a few minutes later (e.g. 09:21) skips the opening minutes' wide prices.">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>From</Text>
          <TimePicker
            size="small" format="HH:mm" allowClear={false} needConfirm={false} showNow={false} style={{ width: 82 }}
            value={dayjs(`2000-01-01T${start}`)}
            onChange={(v) => v && setStart(v.format('HH:mm'))}
            disabledTime={() => ({
              disabledHours: () => Array.from({ length: 24 }, (_, h) => h).filter((h) => h < 9 || h > 15),
              disabledMinutes: (h) => Array.from({ length: 60 }, (_, m) => m).filter((m) => (h === 9 && m < 15) || (h === 15 && m > 29)),
            })}
          />
        </Space>
      </Tooltip>
      <Tooltip title="Today: the part of the straddle's move left for this session - straddle x √(trading minutes left today / trading minutes left to the expiry), worked out from the option prices and the expiry date alone, so a past day and today live read the same. The straddle itself prices the move to expiry, often days away. To expiry: the straddle's own breakevens (strike ± straddle).">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Range</Text>
          <Segmented size="small" value={scope} onChange={setScope} options={[{ value: 'day', label: 'Today' }, { value: 'expiry', label: 'To expiry' }]} />
        </Space>
      </Tooltip>
      <Tooltip title="The fixed straddle - the one a seller holds: the ATM strike at the start time, or any strike you pick, kept all day and never shifted (moving to another strike is the trader's adjustment - pick it here). Its value against what it was sold for is the seller's P&L; against its own VWAP, whether its sellers are winning.">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Fixed</Text>
          <Select
            size="small" value={fixedStrike ?? 'atm'} onChange={(v) => setPick({ dayKey, strike: v })} style={{ width: 132 }}
            popupMatchSelectWidth={false} showSearch options={fixedOptions}
          />
        </Space>
      </Tooltip>
      <Tooltip title="How long the Auto ATM straddle must stay under / over its VWAP for the read (80% of these minutes and now).">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Read over</Text>
          <Segmented size="small" value={holdMinutes} onChange={setHoldMinutes} options={[10, 15, 30].map((v) => ({ value: v, label: `${v}m` }))} />
        </Space>
      </Tooltip>
    </Space>
  )

  if (!read.series.length) {
    const waiting = read.startMs != null && asOfMs != null && asOfMs < read.startMs
    return (
      <>
        {controls}
        <Text type="secondary" style={{ display: 'block' }}>
          {waiting ? `The straddle is read from ${start}${asOfMs > 0 ? ` - the replay is at ${hhmm(asOfMs)}` : ''}.`
            : 'No straddle yet - it needs the call and the put of the ATM strike from the start time.'}
        </Text>
      </>
    )
  }

  const { day, now, verdict, fixed } = read
  const under = now.value < now.vwap
  const breaks = [read.breaks.up && `broke up ${hhmm(read.breaks.up)}`, read.breaks.down && `broke down ${hhmm(read.breaks.down)}`].filter(Boolean)
  return (
    <>
      {controls}
      <div style={{ borderLeft: '3px solid #4c9ffe', padding: '4px 10px', marginBottom: 8 }}>
        <Tag color={verdictColor(verdict)} style={{ marginRight: 8 }}>{verdict.title}{verdict.side && verdict.kind !== 'early' ? (verdict.side === 'up' ? ' ↑' : ' ↓') : ''}</Tag>
        <Text style={{ fontSize: 12 }}>{verdict.detail}</Text>
        {verdict.note && <Text type="warning" style={{ fontSize: 12, display: 'block' }}>{verdict.note}</Text>}
      </div>
      <Space direction="vertical" size={2} style={{ marginBottom: 8 }}>
        <Text style={{ fontSize: 12 }}>
          <Text strong style={{ fontSize: 12 }}>{hhmm(day.time)}</Text> ATM {day.strike} straddle <Text strong style={{ fontSize: 12 }}>{num(day.value)}</Text> (to expiry)
          {day.today != null && scope === 'day' ? <> → today ± <Text strong style={{ fontSize: 12 }}>{num(day.width, 0)}</Text>{day.basis === 'expiry'
            ? ` (${num(day.sessions, 1)} sessions to the ${dayjs(expiry).format('D MMM')} expiry)`
            : ` (feed IV ${num(day.iv)} - no expiry date)`}</> : ''}
          {' '}→ priced range <Text style={{ fontSize: 12, color: DOWN_COLOR }}>{num(day.lower, 0)}</Text> – <Text style={{ fontSize: 12, color: UP_COLOR }}>{num(day.upper, 0)}</Text> ({num(day.pct, 2)}% of spot)
          {breaks.length ? ` · ${breaks.join(' · ')}` : ' · spot inside it so far'}
        </Text>
        <Text style={{ fontSize: 12 }}>
          <Text strong style={{ fontSize: 12 }}>{hhmm(now.time)}</Text> Auto ATM {now.strike} straddle <Text strong style={{ fontSize: 12, color: STRADDLE_COLOR }}>{num(now.value)}</Text>
          {' '}· VWAP <Text style={{ fontSize: 12, color: VWAP_COLOR }}>{num(now.vwap)}</Text> ({under ? 'under' : 'over'} it; under {Math.round(read.belowShare * 100)}% of the last {holdMinutes} min)
          {' '}· {signed(read.change)} in {holdMinutes} min
          {now.iv != null && <> · {read.ivFrom === 'straddle' ? 'IV (from the straddle)' : 'ATM IV (feed)'} {num(now.iv)}{read.ivChange != null ? ` (${signed(read.ivChange)})` : ''}</>}
          {' '}· futures ≈ {num(now.forward, 0)}
        </Text>
        <Text style={{ fontSize: 12 }}>
          <Text strong style={{ fontSize: 12, color: FIXED_COLOR }}>Fixed {fixed.strike}</Text> straddle: sold at {hhmm(fixed.time)} for {num(fixed.entry)}
          {fixed.now != null ? <> → now <Text strong style={{ fontSize: 12, color: FIXED_COLOR }}>{num(fixed.now)}</Text> ({signed(fixed.sellerPnl)} for a seller) · its VWAP {num(fixed.vwap)} ({fixed.now < fixed.vwap ? 'under it - its sellers winning' : 'over it - its sellers losing'})</> : ' → not quoted now'}
        </Text>
      </Space>
      <Row gutter={[16, 12]}>
        <Col xs={24} lg={12}>
          <Text strong style={{ fontSize: 12 }}>Straddles &amp; their VWAPs</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · Auto ATM (right scale): the strike nearest the futures price, switching when it changes · Fixed {fixed.strike} (left scale): one strike all day, never shifted</Text>
          <LinesChart lines={charts.straddle} dayKey={`straddle-${dayKey}-${start}-${fixed.strike}`} height={height} />
        </Col>
        <Col xs={24} lg={12}>
          <Text strong style={{ fontSize: 12 }}>Spot vs the priced range</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · from {hhmm(day.time)}: ATM {day.strike} ± {num(day.width, 0)}</Text>
          <LinesChart lines={charts.spot} dayKey={`straddle-spot-${dayKey}-${start}-${scope}`} height={height} />
        </Col>
      </Row>
    </>
  )
}
