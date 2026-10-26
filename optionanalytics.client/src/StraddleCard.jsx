import { useEffect, useMemo, useRef } from 'react'
import { Button, Col, Popover, Row, Segmented, Select, Space, Tag, TimePicker, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { CrosshairMode, LineSeries, LineStyle, LineType, createSeriesMarkers } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { STRADDLE_START_DEFAULT, istHhmm, straddleRead } from './straddle.js'
import { sanitizeLine } from './chartLine.js'

const { Text } = Typography

const STRADDLE_COLOR = '#f5a623'
const VWAP_COLOR = '#4c9ffe'
const CENTRE_COLOR = '#9aa4b2'
const SPOT_COLOR = '#d9d9d9'
const NEW_RANGE_COLOR = '#ffd54f'
const DAY_RANGE_COLOR = '#8c8c8c'

const VERDICT_COLORS = {
  sideways: 'geekblue', drift: 'cyan', building: 'purple', none: 'default', early: 'default', 'new-range': 'gold', unconfirmed: 'gold', fake: 'orange',
}
const verdictColor = (v) => (v.kind === 'trend' || v.kind === 'breakout' ? (v.side === 'down' ? 'red' : 'green') : VERDICT_COLORS[v.kind] ?? 'default')

const hhmm = istHhmm
const num = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '-')
const signed = (v, digits = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}` : '-')

// A few lines on one time axis. `lines`: [{ id, title, color, width, style, steps, data: [{ time (ms), value }] }] -
// the set of ids is fixed for a chart's life (a new set rebuilds it); `markers` go on the first line.
function LinesChart({ lines, markers = [], dayKey, height }) {
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
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    const series = new Map()
    lines.forEach((l) => {
      series.set(l.id, chart.addSeries(LineSeries, {
        color: l.color, lineWidth: l.width ?? 2, lineStyle: l.style ?? LineStyle.Solid, lineType: l.steps ? LineType.WithSteps : LineType.Simple,
        title: l.title ?? '', priceLineVisible: false, lastValueVisible: l.lastValue ?? true,
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

// How to read the card - the method in straddle.js, in the order a trader reads it.
const HOW_TO_READ = (
  <div style={{ maxWidth: 420, fontSize: 12 }}>
    <p style={{ margin: '0 0 6px' }}><b>1. The range.</b> At the start time the ATM straddle is what the market charges for the move to expiry. Today&apos;s share of it (the straddle at the ATM IV over the hours left) around the strike is the range priced for this session; &quot;To expiry&quot; shows the straddle&apos;s full breakevens. It stays put while spot moves inside it - its edges are the levels to fade.</p>
    <p style={{ margin: '0 0 6px' }}><b>2. Sideways = all three checks.</b> Spot inside the range; the ATM straddle under its VWAP (premium being sold); the centre straddle (the range&apos;s own strike) below what it was at the start (a seller there is ahead - spot moved less than priced).</p>
    <p style={{ margin: '0 0 6px' }}><b>3. A break.</b> Spot outside the range. The straddle over its VWAP = buyers paying for the move: trend. Still falling under its VWAP = sellers not worried: likely fake. Upside only needs the straddle to stop falling (an index rally lowers IV).</p>
    <p style={{ margin: '0 0 6px' }}><b>4. Re-centre.</b> Only when the market accepts the move - spot still outside after the minutes set. Then a new range starts around the ATM there and the questions start again: sideways at the new level, or the trend going on. A break that comes back first is a failed break - the range stays.</p>
    <p style={{ margin: 0 }}><b>5. IV.</b> The straddle falls every minute by time decay alone. Falling with IV rising: quiet now, but options are being bought - a break may come.</p>
  </div>
)

const CHECK = { true: '✓', false: '✗', null: '…' }
const checkColor = (ok) => (ok === true ? UP_COLOR : ok === false ? DOWN_COLOR : AXIS_COLOR)

/**
 * The ATM straddle (call + put at the strike nearest spot) from a set time - straddle.js: the range the options priced,
 * re-centred only when a break is accepted, the sideways check, the straddle against its VWAP, the centre straddle, ATM
 * IV and the read - as of the replay clock (`asOfMs`; null - live - every minute given; 0 - the replay not started), so
 * it runs with OI Replay, replayed or live.
 */
export function StraddleCard({ cePoints, pePoints, spotBars, asOfMs, dayKey, height = 260 }) {
  const [start, setStart] = usePersistedState('optionanalytics.oiReplay.straddleStart', STRADDLE_START_DEFAULT)
  const [acceptMinutes, setAcceptMinutes] = usePersistedState('optionanalytics.oiReplay.straddleAccept', 10)
  const [holdMinutes, setHoldMinutes] = usePersistedState('optionanalytics.oiReplay.straddleHold', 15)
  const [scope, setScope] = usePersistedState('optionanalytics.oiReplay.straddleScope', 'day')

  const read = useMemo(
    () => straddleRead(cePoints, pePoints, spotBars, { start, asOfMs, acceptMinutes, holdMinutes, scope }),
    [cePoints, pePoints, spotBars, start, asOfMs, acceptMinutes, holdMinutes, scope],
  )
  const charts = useMemo(() => {
    const s = read.series
    const line = (pick) => s.filter((p) => Number.isFinite(pick(p))).map((p) => ({ time: p.time, value: pick(p) }))
    const straddle = [
      { id: 'straddle', title: 'ATM', color: STRADDLE_COLOR, data: line((p) => p.value) },
      { id: 'vwap', title: 'VWAP', color: VWAP_COLOR, width: 1, style: LineStyle.Dashed, data: line((p) => p.vwap) },
      { id: 'centre', title: 'Centre', color: CENTRE_COLOR, width: 1, style: LineStyle.Dotted, data: line((p) => p.centre) },
    ]
    const day = read.day
    const moved = read.ranges.length > 1
    const spot = [
      { id: 'spot', title: 'Spot', color: SPOT_COLOR, data: line((p) => p.spot) },
      { id: 'upper', title: 'Range', color: UP_COLOR, width: 1, steps: true, data: line((p) => p.upper) },
      { id: 'lower', title: 'Range', color: DOWN_COLOR, width: 1, steps: true, data: line((p) => p.lower) },
      ...(moved && day ? [
        { id: 'dayUpper', title: hhmm(day.time), color: DAY_RANGE_COLOR, width: 1, style: LineStyle.Dashed, lastValue: false, data: s.map((p) => ({ time: p.time, value: day.upper })) },
        { id: 'dayLower', color: DAY_RANGE_COLOR, width: 1, style: LineStyle.Dashed, lastValue: false, data: s.map((p) => ({ time: p.time, value: day.lower })) },
      ] : []),
    ]
    const markers = read.ranges.slice(1).map((r) => ({ time: r.time, position: r.reason === 'down' ? 'belowBar' : 'aboveBar', color: NEW_RANGE_COLOR, shape: 'circle', text: `new range ${r.strike}` }))
    return { straddle, spot, markers }
  }, [read])

  const controls = (
    <Space wrap size={[16, 6]} style={{ marginBottom: 8 }}>
      <Tooltip title="When the straddle is first read - its value then, around its strike, is the range the options priced. 09:15 (the open) by default; a few minutes later (e.g. 09:21) skips the opening minutes' wide prices.">
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
      <Tooltip title="Today: the part of the straddle's move left for this session (the straddle at the ATM IV over the minutes left to 15:30) - the straddle itself prices the move to expiry, often days away. To expiry: the straddle's own breakevens (strike ± straddle).">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Range</Text>
          <Segmented size="small" value={scope} onChange={setScope} options={[{ value: 'day', label: 'Today' }, { value: 'expiry', label: 'To expiry' }]} />
        </Space>
      </Tooltip>
      <Tooltip title="A break is accepted when spot is still outside the range after this long: a new range then starts around the ATM there and is read again. A break that comes back inside first is a failed break - the range stays.">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>New range after</Text>
          <Select
            size="small" value={acceptMinutes} onChange={setAcceptMinutes} style={{ width: 140 }} popupMatchSelectWidth={false}
            options={[{ value: 0, label: 'never' }, ...[5, 10, 15, 30].map((v) => ({ value: v, label: `${v} min outside` }))]}
          />
        </Space>
      </Tooltip>
      <Tooltip title="How long the straddle must stay under / over its VWAP for the read (80% of these minutes and now).">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Read over</Text>
          <Segmented size="small" value={holdMinutes} onChange={setHoldMinutes} options={[10, 15, 30].map((v) => ({ value: v, label: `${v}m` }))} />
        </Space>
      </Tooltip>
      <Popover content={HOW_TO_READ} title="How to read the straddle" trigger="click" placement="bottomLeft">
        <Button size="small" type="link" style={{ padding: 0 }}>How to read</Button>
      </Popover>
    </Space>
  )

  if (!read.series.length) {
    const waiting = read.startMs != null && asOfMs != null && asOfMs < read.startMs
    return (
      <>
        {controls}
        <Text type="secondary" style={{ display: 'block' }}>
          {waiting ? `The straddle is read from ${start}${asOfMs > 0 ? ` - the replay is at ${hhmm(asOfMs)}` : ''}.`
            : 'No straddle yet - it needs the call and the put of the strike nearest spot from the start time.'}
        </Text>
      </>
    )
  }

  const { day, range, now, verdict, centre, checks } = read
  const passed = [checks.inside, checks.premiumFalling, checks.centreBelowStart].filter((v) => v === true).length
  const under = now.value < now.vwap
  const dayBreaks = [read.dayBreaks.up && `broke up ${hhmm(read.dayBreaks.up)}`, read.dayBreaks.down && `broke down ${hhmm(read.dayBreaks.down)}`].filter(Boolean)
  const newRanges = read.ranges.slice(1)
  const checkRow = (ok, text) => (
    <div style={{ fontSize: 12 }}><span style={{ color: checkColor(ok), display: 'inline-block', width: 16, fontWeight: 600 }}>{CHECK[ok]}</span>{text}</div>
  )
  return (
    <>
      {controls}
      <div style={{ borderLeft: '3px solid #4c9ffe', padding: '4px 10px', marginBottom: 8 }}>
        <Tag color={verdictColor(verdict)} style={{ marginRight: 8 }}>{verdict.title}{verdict.side ? (verdict.side === 'up' ? ' ↑' : ' ↓') : ''}</Tag>
        <Text style={{ fontSize: 12 }}>{verdict.detail}</Text>
        {verdict.notes.map((n) => <Text key={n} type="warning" style={{ fontSize: 12, display: 'block' }}>{n}</Text>)}
      </div>
      <Row gutter={[16, 8]} style={{ marginBottom: 8 }}>
        <Col xs={24} lg={12}>
          <Text strong style={{ fontSize: 12 }}>Sideways check {passed}/3</Text>
          {checkRow(checks.inside, <>Spot {num(now.spot, 0)} inside the range <Text style={{ fontSize: 12, color: DOWN_COLOR }}>{num(range.lower, 0)}</Text> – <Text style={{ fontSize: 12, color: UP_COLOR }}>{num(range.upper, 0)}</Text> ({range.strike} ± {num(range.width, 0)} from {hhmm(range.time)}){read.outsideFor ? ` - outside ${read.outsideFor} min` : ''}</>)}
          {checkRow(checks.premiumFalling, <>ATM straddle <Text style={{ fontSize: 12, color: STRADDLE_COLOR }}>{num(now.value)}</Text> under its VWAP <Text style={{ fontSize: 12, color: VWAP_COLOR }}>{num(now.vwap)}</Text>: {Math.round(read.belowShare * 100)}% of the last {holdMinutes} min{checks.premiumFalling == null ? ` (needs ${holdMinutes} min of this range)` : `, ${under ? 'under' : 'over'} now`}</>)}
          {checkRow(checks.centreBelowStart, <>{centre.strike} straddle {num(centre.now)} below its {hhmm(centre.time)} value {num(centre.value)} ({signed(centre.sellerPnl)} for a seller there)</>)}
          {now.iv != null && checkRow(checks.ivSteady, <>ATM IV {num(now.iv)}{read.ivChange != null ? ` (${signed(read.ivChange)} in ${holdMinutes} min)` : ''} - not rising</>)}
        </Col>
        <Col xs={24} lg={12}>
          <Text strong style={{ fontSize: 12 }}>The day</Text>
          <div style={{ fontSize: 12 }}>
            {hhmm(day.time)} ATM {day.strike} straddle <Text strong style={{ fontSize: 12 }}>{num(day.value)}</Text> (to expiry)
            {day.today != null && scope === 'day' ? <> → today ± <Text strong style={{ fontSize: 12 }}>{num(day.width, 0)}</Text> (IV {num(day.iv)})</> : ''}
            {' '}→ range {num(day.lower, 0)} – {num(day.upper, 0)} ({num(day.pct, 2)}% of spot)
            {dayBreaks.length ? ` · ${dayBreaks.join(' · ')}` : ' · spot inside it so far'}
          </div>
          {newRanges.length > 0 && (
            <div style={{ fontSize: 12 }}>
              New range{newRanges.length > 1 ? 's' : ''} (break accepted):{' '}
              {newRanges.map((r) => `${hhmm(r.time)} ${r.reason === 'up' ? '↑' : '↓'} ${r.strike} ± ${num(r.width, 0)}`).join(' · ')}
            </div>
          )}
          {range.breaks.filter((b) => b.to != null).length > 0 && (
            <div style={{ fontSize: 12 }}>
              Failed breaks of this range: {range.breaks.filter((b) => b.to != null).map((b) => `${b.side} ${hhmm(b.from)}–${hhmm(b.to)}`).join(' · ')}
            </div>
          )}
          <div style={{ fontSize: 12 }}>
            {hhmm(now.time)} ATM {now.strike} straddle {num(now.value)} · {signed(read.change)} in {holdMinutes} min
          </div>
        </Col>
      </Row>
      <Row gutter={[16, 12]}>
        <Col xs={24} lg={12}>
          <Text strong style={{ fontSize: 12 }}>ATM straddle &amp; its VWAP</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · ATM: the nearest strike each minute; VWAP and Centre (the range&apos;s strike) start again with each new range</Text>
          <LinesChart lines={charts.straddle} markers={charts.markers} dayKey={`straddle-${dayKey}-${start}`} height={height} />
        </Col>
        <Col xs={24} lg={12}>
          <Text strong style={{ fontSize: 12 }}>Spot vs the range</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · the range moves only when a break is accepted{newRanges.length ? `; dashed: the ${hhmm(day.time)} range` : ''}</Text>
          <LinesChart lines={charts.spot} dayKey={`straddle-spot-${dayKey}-${start}-${scope}`} height={height} />
        </Col>
      </Row>
    </>
  )
}
