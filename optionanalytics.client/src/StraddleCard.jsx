import { useEffect, useMemo, useRef } from 'react'
import { Button, Popover, Select, Space, Table, Tag, TimePicker, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { CrosshairMode, LineSeries, createSeriesMarkers } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { STRADDLE_MAX_LINES, STRADDLE_START_DEFAULT, istHhmm, straddleLines } from './straddle.js'
import { sanitizeLine } from './chartLine.js'

const { Text } = Typography

// One colour per strike, in the order the strikes became the ATM - a strike keeps its colour all day.
const LINE_COLORS = ['#f5a623', '#4c9ffe', '#b37feb', '#36cfc9', '#ff7875', '#95de64', '#ffd666', '#ff9c6e', '#5cdbd3', '#adc6ff']
const colorOf = (order) => LINE_COLORS[order % LINE_COLORS.length]
const SHIFT_COLOR = '#ffd54f'

const hhmm = istHhmm
const num = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '-')
const signed = (v, digits = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}` : '-')
const changeColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)

// A few lines on one time axis. `lines`: [{ id, title, color, width, data: [{ time (ms), value }] }] - a new set of ids
// rebuilds the chart (and fits it again); each marker goes on its `line` (an id).
function LinesChart({ lines, markers = [], dayKey, height }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(new Map())
  const markersRef = useRef(new Map())
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
        color: l.color, lineWidth: l.width ?? 2, title: l.title ?? '', priceLineVisible: false, lastValueVisible: true,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      }))
    })
    seriesRef.current = series
    markersRef.current = new Map([...series].map(([id, s]) => [id, createSeriesMarkers(s, [])]))
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = new Map()
      markersRef.current = new Map()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, ids])

  useEffect(() => {
    for (const l of lines) {
      const series = seriesRef.current.get(l.id)
      series?.setData(sanitizeLine(l.data.map((p) => ({ time: toChartTime(p.time), value: p.value }))))
      series?.applyOptions({ color: l.color, lineWidth: l.width ?? 2, title: l.title ?? '' })
    }
    for (const [id, m] of markersRef.current) m.setMarkers(markers.filter((x) => x.line === id).map(({ line: _line, ...x }) => ({ ...x, time: toChartTime(x.time) })))
  }, [lines, markers])
  useFitContentAsDataGrows(chartRef, lines[0]?.data.length ?? 0, `${dayKey}|${ids}`)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

const HOW_TO_READ = (
  <div style={{ maxWidth: 420, fontSize: 12 }}>
    <p style={{ margin: '0 0 6px' }}><b>One line per strike.</b> At the start time the ATM strike&apos;s straddle (call + put) is the first line. When spot moves and another strike becomes the ATM, that strike&apos;s straddle starts a new line from that minute - the old one keeps going. The ATM now is the thick line.</p>
    <p style={{ margin: '0 0 6px' }}><b>Why not one line.</b> The strike nearest spot is always the cheapest straddle, so one line jumping to it each time drops the move and only ever falls.</p>
    <p style={{ margin: '0 0 6px' }}><b>Reading it.</b> An old strike&apos;s line rising = spot running away from it - the move is bigger than that straddle priced. The ATM line falling while spot sits there = premium being sold (and time decay, which a seller there earns). The ATM line rising with spot at the strike = options being bought.</p>
    <p style={{ margin: 0 }}><b>Switching.</b> A new strike takes over once spot is a tenth of a strike step past the midpoint, so spot sitting at the midpoint does not flip it every minute. A strike that becomes the ATM again goes on in its own line.</p>
  </div>
)

/**
 * The ATM straddle from a set time, one line per strike that was the ATM (straddle.js) - as of the replay clock
 * (`asOfMs`; null - live - every minute given; 0 - the replay not started), so it runs with OI Replay, replayed or live.
 */
export function StraddleCard({ cePoints, pePoints, spotBars, asOfMs, dayKey, height = 300 }) {
  const [start, setStart] = usePersistedState('optionanalytics.oiReplay.straddleStart', STRADDLE_START_DEFAULT)
  const [maxLines, setMaxLines] = usePersistedState('optionanalytics.oiReplay.straddleLines', STRADDLE_MAX_LINES)

  const read = useMemo(
    () => straddleLines(cePoints, pePoints, spotBars, { start, asOfMs, maxLines: maxLines || null }),
    [cePoints, pePoints, spotBars, start, asOfMs, maxLines],
  )
  const chart = useMemo(() => ({
    lines: read.lines.map((l) => ({
      id: String(l.strike), title: l.atmNow ? `${l.strike} ATM` : String(l.strike), color: colorOf(l.order), width: l.atmNow ? 3 : 1, data: l.data,
    })),
    // Each change of the ATM marked where the strike taken over starts (or goes on) its line.
    markers: read.shifts.map((s) => ({ line: String(s.to), time: s.time, position: s.to < s.from ? 'belowBar' : 'aboveBar', color: SHIFT_COLOR, shape: 'circle', text: `ATM ${s.to}` })),
  }), [read])

  const controls = (
    <Space wrap size={[16, 6]} style={{ marginBottom: 8 }}>
      <Tooltip title="When the straddle is first read - the ATM strike then is the first line. 09:21: after the opening minutes settle.">
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
      <Tooltip title="How many strikes' lines to draw - the ones that were the ATM most recently (the ATM now always).">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Lines</Text>
          <Select
            size="small" value={maxLines} onChange={setMaxLines} style={{ width: 90 }}
            options={[...[3, 6, 10].map((v) => ({ value: v, label: `last ${v}` })), { value: 0, label: 'all' }]}
          />
        </Space>
      </Tooltip>
      <Popover content={HOW_TO_READ} title="How to read the straddle" trigger="click" placement="bottomLeft">
        <Button size="small" type="link" style={{ padding: 0 }}>How to read</Button>
      </Popover>
    </Space>
  )

  if (!read.now) {
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

  const { now, shifts, hidden } = read
  const first = read.lines.find((l) => l.order === 0)
  const current = read.lines.find((l) => l.atmNow)
  const rows = [...read.lines].reverse()
  return (
    <>
      {controls}
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        {first && <>{hhmm(first.from)} ATM {first.strike} straddle {num(first.start)} → now {num(first.value)} (<Text style={{ fontSize: 12, color: changeColor(first.change) }}>{signed(first.change)}</Text>)</>}
        {current && current !== first && <> · ATM now {current.strike} (since {hhmm(current.from)}) {num(current.start)} → {num(current.value)} (<Text style={{ fontSize: 12, color: changeColor(current.change) }}>{signed(current.change)}</Text>)</>}
        {' '}· spot {num(now.spot, 1)} at {hhmm(now.time)} · {shifts.length} ATM change{shifts.length === 1 ? '' : 's'}
        {hidden > 0 && <Text type="secondary" style={{ fontSize: 12 }}> · {hidden} older strike{hidden === 1 ? '' : 's'} not drawn</Text>}
      </div>
      <LinesChart lines={chart.lines} markers={chart.markers} dayKey={`straddle-${dayKey}-${start}`} height={height} />
      <Table
        size="small" pagination={false} style={{ marginTop: 8 }} rowKey="strike" dataSource={rows}
        columns={[
          { title: 'Strike', key: 'k', render: (_, l) => <Space size={6}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: colorOf(l.order) }} />{l.strike}{l.atmNow && <Tag color="gold" style={{ margin: 0 }}>ATM now</Tag>}</Space> },
          { title: 'ATM', key: 'atm', render: (_, l) => `${hhmm(l.from)} – ${l.atmNow ? 'now' : hhmm(l.until)}` },
          { title: 'At start', key: 's', align: 'right', render: (_, l) => num(l.start) },
          { title: 'Now', key: 'v', align: 'right', render: (_, l) => num(l.value) },
          { title: 'Change', key: 'c', align: 'right', render: (_, l) => <span style={{ color: changeColor(l.change) }}>{signed(l.change)}</span> },
          { title: 'High / Low', key: 'hl', align: 'right', render: (_, l) => `${num(l.high)} / ${num(l.low)}` },
        ]}
      />
    </>
  )
}
