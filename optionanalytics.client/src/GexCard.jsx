import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, Col, Popover, Row, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { BaselineSeries, CrosshairMode, LineSeries, LineStyle } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { sanitizeLine } from './chartLine.js'
import { LinesChart } from './StraddleCard.jsx'
import { CardFitBox, useChartHeight, useFitHeight } from './DashboardCard.jsx'
import { gexAgreement, gexProfile, gexUpTo } from './gex.js'
import { FoldText } from './FoldText.jsx'

const { Text } = Typography

const SPOT_COLOR = '#d9d9d9'
const FLIP_COLOR = '#ffd54f'
const MAX_GAMMA_COLOR = '#b37feb'
const CR = 1e7
const IST_MS = 330 * 60_000

/** HH:mm in IST. */
const istHhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)

const cr = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v) / CR).toLocaleString('en-IN')} Cr` : '-')
const num = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '-')
// ₹ crore, short: thousands of crore as "k".
const crShort = (v) => {
  const c = v / CR
  return Math.abs(c) >= 1000 ? `${c < 0 ? '−' : ''}${(Math.abs(c) / 1000).toFixed(1)}k Cr` : `${c < 0 ? '−' : ''}${Math.round(Math.abs(c))} Cr`
}
const EXPIRY_SOURCES = { dhan: 'Dhan', calendar: 'weekday rule', 'calendar-holiday': 'weekday rule, moved for a holiday' }

const gexColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : AXIS_COLOR)

// The net GEX through the day around zero: green above (dealers long gamma), red below (short gamma). The DEX card draws
// its net DEX with it too (`title`, its own colours, and spot on the left scale to read the two against each other).
export function NetGexChart({ data, dayKey, height: givenHeight, title = 'Net GEX (₹ Cr)', upColor = UP_COLOR, downColor = DOWN_COLOR, spot = null }) {
  // Fitted to its dashboard card when that card was sized (useFitHeight); the height asked for anywhere else.
  const height = useFitHeight(givenHeight)
  // Read once, at creation - a later height is applied to the chart there is (useChartHeight).
  const heightRef = useRef(height)
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const spotRef = useRef(null)
  const withSpot = spot != null
  useEffect(() => {
    if (!containerRef.current) return undefined
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: heightRef.current,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      leftPriceScale: { visible: withSpot, borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: upColor, topFillColor1: `${upColor}55`, topFillColor2: `${upColor}08`,
      bottomLineColor: downColor, bottomFillColor1: `${downColor}08`, bottomFillColor2: `${downColor}55`,
      lineWidth: 2, priceLineVisible: false, title,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    if (withSpot) {
      spotRef.current = chart.addSeries(LineSeries, {
        color: SPOT_COLOR, lineWidth: 1, priceScaleId: 'left', priceLineVisible: false, lastValueVisible: true, title: 'Spot', crosshairMarkerVisible: false,
      })
    }
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      spotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // A new height is applied to the chart there is - drawn again it had no data until the next update.
  useChartHeight(chartRef, height)
  useEffect(() => {
    seriesRef.current?.setData(sanitizeLine(data.map((p) => ({ time: toChartTime(p.time), value: p.value }))))
  }, [data])
  useEffect(() => {
    spotRef.current?.setData(sanitizeLine((spot ?? []).map((p) => ({ time: toChartTime(p.time), value: p.value }))))
  }, [spot])
  useFitContentAsDataGrows(chartRef, data.length, dayKey)
  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Each strike's GEX at the clock: puts to the left of the middle, calls to the right, the net beside - the ATM, the
// walls, the max gamma strike and where the flip falls marked.
function StrikeBars({ minute }) {
  const rows = minute.strikes.filter((r) => r.call != null || r.put != null)
  const scale = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.call ?? 0), Math.abs(r.put ?? 0))))
  const bar = (v, side) => {
    const width = `${Math.min(100, (Math.abs(v ?? 0) / scale) * 100)}%`
    return (
      <div style={{ flex: 1, display: 'flex', justifyContent: side === 'put' ? 'flex-end' : 'flex-start' }}>
        {v ? <div title={cr(v)} style={{ width, height: 10, background: gexColor(v), opacity: 0.85, borderRadius: 2 }} /> : null}
      </div>
    )
  }
  // The flip sits between the two strikes around it.
  const flipBelow = minute.flip != null ? rows.findIndex((r) => r.strike < minute.flip) : -1
  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ display: 'flex', gap: 6, color: AXIS_COLOR, marginBottom: 4 }}>
        <div style={{ flex: 1, textAlign: 'right' }}>Put GEX</div>
        <div style={{ width: 120, textAlign: 'center' }}>Strike</div>
        <div style={{ flex: 1 }}>Call GEX</div>
        <div style={{ width: 92, textAlign: 'right' }}>Net</div>
      </div>
      {rows.map((r, i) => (
        <div key={r.strike}>
          {i === flipBelow && i > 0 && (
            <div style={{ borderTop: `1px dashed ${FLIP_COLOR}`, color: FLIP_COLOR, fontSize: 10, textAlign: 'center', margin: '1px 0' }}>flip {num(minute.flip)}</div>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '1px 0', background: r.strike === minute.atm ? 'rgba(255,255,255,0.06)' : undefined }}>
            {bar(r.put, 'put')}
            <div style={{ width: 120, textAlign: 'center', whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: r.strike === minute.atm ? 600 : 400 }}>{r.strike}</span>
              {r.strike === minute.callWall && <Tag color="green" style={{ margin: '0 0 0 4px', fontSize: 9, lineHeight: '14px', padding: '0 3px' }}>CW</Tag>}
              {r.strike === minute.putWall && <Tag color="red" style={{ margin: '0 0 0 4px', fontSize: 9, lineHeight: '14px', padding: '0 3px' }}>PW</Tag>}
              {r.strike === minute.maxGamma && <Tag color="purple" style={{ margin: '0 0 0 4px', fontSize: 9, lineHeight: '14px', padding: '0 3px' }}>MG</Tag>}
            </div>
            {bar(r.call, 'call')}
            <div style={{ width: 92, textAlign: 'right', color: gexColor(r.net) }}>{cr(r.net)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// The GEX profile at the clock (gexProfile): the net GEX if spot were at each price across the strikes loaded, that
// minute's OI and IVs kept - it crosses zero at the flip. Spot, the flip, the walls and the max gamma strike marked; hover
// for the net at a price.
function ProfileChart({ minute, height: givenHeight = 200 }) {
  // Drawn at the height its dashboard card's fit gives it (useFitHeight) - an SVG, so a new height is just a redraw.
  const height = useFitHeight(givenHeight)
  const ref = useRef(null)
  const id = useId()
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState(null)
  useEffect(() => {
    if (!ref.current) return undefined
    const resize = new ResizeObserver(() => setWidth(ref.current?.clientWidth ?? 0))
    resize.observe(ref.current)
    return () => resize.disconnect()
  }, [])
  const points = useMemo(() => gexProfile(minute), [minute])
  const padL = 58, padR = 10, padT = 40, padB = 20
  const ready = width > padL + padR + 40 && points.length > 1
  let chart = null
  if (ready) {
    const xMin = points[0].price, xMax = points.at(-1).price
    const values = points.map((p) => p.net)
    const top = Math.max(0, ...values), bottom = Math.min(0, ...values)
    const span = top - bottom || 1
    const x = (v) => padL + ((v - xMin) / (xMax - xMin)) * (width - padL - padR)
    const y = (v) => padT + ((top - v) / span) * (height - padT - padB)
    const zero = y(0)
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.price).toFixed(1)},${y(p.net).toFixed(1)}`).join(' ')
    const area = `${line} L${x(xMax).toFixed(1)},${zero.toFixed(1)} L${x(xMin).toFixed(1)},${zero.toFixed(1)} Z`
    // A few strikes along the bottom.
    const strikes = minute.strikes.map((r) => r.strike).filter((k) => k >= xMin && k <= xMax).sort((a, b) => a - b)
    const every = Math.max(1, Math.ceil(strikes.length / Math.max(2, Math.floor((width - padL - padR) / 70))))
    const ticks = strikes.filter((_, i) => i % every === 0)
    // The levels: one line each; labels at (nearly) the same place joined ("PW·MG"), the rest staggered over three rows.
    const marks = [
      { v: minute.spot, color: SPOT_COLOR, label: 'Spot', dash: '4 3' },
      { v: minute.flip, color: FLIP_COLOR, label: 'Flip', dash: '2 2' },
      { v: minute.callWall, color: UP_COLOR, label: 'CW' },
      { v: minute.putWall, color: DOWN_COLOR, label: 'PW' },
      { v: minute.maxGamma, color: MAX_GAMMA_COLOR, label: 'MG', dash: '1 2' },
    ].filter((m) => Number.isFinite(m.v) && m.v >= xMin && m.v <= xMax).map((m) => ({ ...m, x: x(m.v) })).sort((a, b) => a.x - b.x)
    const labels = []
    for (const m of marks) {
      const last = labels.at(-1)
      if (last && m.x - last.x < 12) last.text += `·${m.label}`
      else labels.push({ x: m.x, color: m.color, text: m.label })
    }
    labels.forEach((l, i) => { l.row = i > 0 && l.x - labels[i - 1].x < 44 ? (labels[i - 1].row + 1) % 3 : 0 })
    const hovered = hover != null ? points[hover] : null
    const onMove = (e) => {
      const box = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - box.left
      const price = xMin + ((px - padL) / (width - padL - padR)) * (xMax - xMin)
      setHover(Math.max(0, Math.min(points.length - 1, Math.round(((price - xMin) / (xMax - xMin)) * (points.length - 1)))))
    }
    chart = (
      <svg width={width} height={height} style={{ display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <clipPath id={`${id}-up`}><rect x={0} y={0} width={width} height={Math.max(0, zero)} /></clipPath>
          <clipPath id={`${id}-down`}><rect x={0} y={zero} width={width} height={Math.max(0, height - zero)} /></clipPath>
        </defs>
        <line x1={padL} x2={width - padR} y1={zero} y2={zero} stroke={AXIS_COLOR} strokeDasharray="3 3" strokeWidth={1} />
        <path d={area} fill={UP_COLOR} fillOpacity={0.22} clipPath={`url(#${id}-up)`} />
        <path d={area} fill={DOWN_COLOR} fillOpacity={0.22} clipPath={`url(#${id}-down)`} />
        <path d={line} fill="none" stroke={UP_COLOR} strokeWidth={2} clipPath={`url(#${id}-up)`} />
        <path d={line} fill="none" stroke={DOWN_COLOR} strokeWidth={2} clipPath={`url(#${id}-down)`} />
        {[top, 0, bottom].filter((v, i, all) => all.indexOf(v) === i).map((v) => (
          <text key={v} x={padL - 6} y={y(v) + 4} fill={AXIS_COLOR} fontSize={10} textAnchor="end">{crShort(v)}</text>
        ))}
        {ticks.map((k) => (
          <text key={k} x={x(k)} y={height - 5} fill={AXIS_COLOR} fontSize={10} textAnchor="middle">{k}</text>
        ))}
        {marks.map((m) => (
          <line key={m.label} x1={m.x} x2={m.x} y1={padT - 4} y2={height - padB} stroke={m.color} strokeWidth={1} strokeDasharray={m.dash} />
        ))}
        {labels.map((l) => (
          <text key={l.text} x={l.x} y={10 + l.row * 11} fill={l.color} fontSize={10} textAnchor="middle">{l.text}</text>
        ))}
        {hovered && (
          <g>
            <line x1={x(hovered.price)} x2={x(hovered.price)} y1={padT - 4} y2={height - padB} stroke={AXIS_COLOR} strokeWidth={1} />
            <circle cx={x(hovered.price)} cy={y(hovered.net)} r={3} fill={gexColor(hovered.net)} />
            <text x={Math.min(Math.max(x(hovered.price), padL + 70), width - padR - 70)} y={padT + 12} fill="#ffffff" fontSize={11} textAnchor="middle">
              {`spot ${num(hovered.price)}: ${cr(hovered.net)}`}
            </text>
          </g>
        )}
      </svg>
    )
  }
  return <div ref={ref} style={{ width: '100%', height }}>{chart}</div>
}

const HOW_TO_READ = (
  <div style={{ maxWidth: 440, fontSize: 12 }}>
    <p style={{ margin: '0 0 6px' }}><b>GEX</b> = how much index the option dealers must trade to stay hedged for a 1% move: gamma × the dealers&apos; OI × spot² × 1%, in ₹ crore. Gamma is Black-Scholes on the forward (spot plus the carry to expiry, read from the call and put premiums by put-call parity), with each strike&apos;s IV worked out from its own premium - so it follows the prices traded, not how Dhan works out its IV. The time to expiry runs to 15:30 on the expiry day (NIFTY Tuesday, SENSEX Thursday, BANKNIFTY the month&apos;s last Tuesday - Dhan&apos;s own date from today on, holidays checked before that).</p>
    <p style={{ margin: '0 0 6px' }}><b>Net GEX positive</b>: dealers are long gamma - they sell rallies and buy dips, so moves are damped: range, pin. <b>Negative</b>: they are short gamma - they buy rallies and sell dips, so moves run: trend, fast days.</p>
    <p style={{ margin: '0 0 6px' }}><b>Gamma flip</b> (zero gamma): the spot at which the net GEX would cross zero. Above it the market tends to be calmer; below it moves speed up. &quot;Rough&quot; = it sits near the edge of the strikes loaded, where strikes not loaded weigh in.</p>
    <p style={{ margin: '0 0 6px' }}><b>Call wall (CW)</b>: the strike above spot with the most call gamma × OI - resistance, the top of the range. <b>Put wall (PW)</b>: the strike below spot with the most put gamma × OI - support, the bottom. <b>Max gamma (MG)</b> (absolute gamma strike): the most call + put gamma × OI of any strike - the magnet / pin, above all on expiry day. A level moves to another strike only when that one is 10% bigger, so two strikes about level do not swap it every minute. A wall breaks only once spot is a quarter of a strike step through it - then it rolls on to the next strike - and a strike becomes a wall only once spot is that far from it: a strike at the money is the magnet, not a wall.</p>
    <p style={{ margin: '0 0 6px' }}><b>GEX profile</b>: the net GEX if spot were at each price, this minute&apos;s OI and IVs kept. It crosses zero at the flip; deep in green = strong pinning there, deep in red = moves speed up there; a steep curve = the regime changes fast as spot moves.</p>
    <p style={{ margin: '0 0 6px' }}><b>Sign.</b> Who the dealers are is not in the data. Standard: dealers long the calls, short the puts. OI build-up: the OI at the first reading as standard, then each minute&apos;s OI change signed by the premium - added while it fell = written by customers (dealers long), added while it rose = bought (dealers short). The premium also moves with spot, so it is a rough read.</p>
    <p style={{ margin: 0 }}>Only the strikes the page has (ATM ± 10) count: the totals are partial, though gamma is mostly near the money.</p>
  </div>
)

/**
 * GEX (gamma exposure) from the day's option OI, IV and premium (gex.js - `days`, useGexDays), up to the replay clock
 * (`asOfMs`; null - live - every minute given; 0 - the replay not started), so it runs with OI Replay, replayed or live.
 */
export function GexCard({ days, asOfMs, dayKey, expiry = null, expirySource = null, height = 260 }) {
  const [sign, setSign] = usePersistedState('optionanalytics.oiReplay.gexSign', 'standard')
  // Both signs, always: the card shows the one chosen; the line under the read says whether the other agrees.
  const minutes = useMemo(() => gexUpTo((sign === 'buildup' ? days?.buildup : days?.standard) ?? [], asOfMs), [days, sign, asOfMs])
  const now = minutes.at(-1)
  const both = useMemo(() => {
    const standardNow = gexUpTo(days?.standard ?? [], asOfMs).at(-1)
    const buildupNow = gexUpTo(days?.buildup ?? [], asOfMs).at(-1)
    return { standardNow, buildupNow, ...gexAgreement(standardNow, buildupNow) }
  }, [days, asOfMs])

  const charts = useMemo(() => {
    const line = (pick) => minutes.filter((m) => Number.isFinite(pick(m))).map((m) => ({ time: m.time, value: pick(m) }))
    return {
      net: line((m) => m.net / CR),
      levels: [
        { id: 'spot', title: 'Spot', color: SPOT_COLOR, data: line((m) => m.spot) },
        { id: 'flip', title: 'Flip', color: FLIP_COLOR, width: 1, style: LineStyle.Dashed, data: line((m) => m.flip) },
        { id: 'callWall', title: 'Call wall', color: UP_COLOR, width: 1, steps: true, data: line((m) => m.callWall) },
        { id: 'putWall', title: 'Put wall', color: DOWN_COLOR, width: 1, steps: true, data: line((m) => m.putWall) },
        { id: 'maxGamma', title: 'Max gamma', color: MAX_GAMMA_COLOR, width: 1, style: LineStyle.Dotted, steps: true, data: line((m) => m.maxGamma) },
      ],
    }
  }, [minutes])

  const controls = (
    <Space wrap size={[16, 6]} style={{ marginBottom: 8 }}>
      <Tooltip title="Who holds the other side of the OI is not in the data. Standard: dealers long the calls and short the puts (calls +, puts −). OI build-up: the first reading's OI as standard, then each minute's OI change signed by the premium - added while it fell = written (dealers long), added while it rose = bought (dealers short).">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Sign</Text>
          <Segmented size="small" value={sign} onChange={setSign} options={[{ value: 'standard', label: 'Standard' }, { value: 'buildup', label: 'OI build-up' }]} />
        </Space>
      </Tooltip>
      <Popover content={HOW_TO_READ} title="How to read GEX" trigger="click" placement="bottomLeft">
        <Button size="small" type="link" style={{ padding: 0 }}>How to read</Button>
      </Popover>
    </Space>
  )

  if (!now) {
    return (
      <>
        {controls}
        <Text type="secondary" style={{ display: 'block' }}>
          {asOfMs === 0 ? 'Start the replay to read GEX.' : 'No GEX yet - it needs the ATM call and put with their IV and OI.'}
        </Text>
      </>
    )
  }

  const positive = now.net >= 0
  const aboveFlip = now.flip != null ? now.spot > now.flip : null
  // How far a level is from spot, signed.
  const away = (level) => (Number.isFinite(level) ? ` (${level - now.spot >= 0 ? '+' : '−'}${Math.abs(level - now.spot).toFixed(0)})` : '')
  return (
    <>
      {controls}
      {/* The read, the two signs' verdict and the notes each fold to one line (FoldText - remembered, "Fold all" on the page). */}
      <FoldText id="gex.read" label="the read" style={{ marginBottom: 4 }}>
        <div style={{ borderLeft: `3px solid ${gexColor(now.net)}`, padding: '4px 10px', fontSize: 12 }}>
          <Tag color={positive ? 'green' : 'red'} style={{ marginRight: 8 }}>{positive ? 'Positive gamma' : 'Negative gamma'}</Tag>
          {positive
            ? 'Dealers long gamma: they sell rallies and buy dips - moves are damped (range, pin).'
            : 'Dealers short gamma: they buy rallies and sell dips - moves run (trend, fast moves).'}
          {aboveFlip != null && <> Spot {num(now.spot, 1)} is {aboveFlip ? 'above' : 'below'} the flip {num(now.flip)} ({aboveFlip ? 'the calmer side' : 'moves speed up below it'}).</>}
          {aboveFlip == null && <> No flip within ±3% of spot and the strikes loaded - the net stays {positive ? 'positive' : 'negative'} there.</>}
          {(now.callWall != null || now.putWall != null) && (
            <> Range: {now.putWall != null ? <>put wall {now.putWall}{away(now.putWall)} below</> : 'no put wall below'} · {now.callWall != null ? <>call wall {now.callWall}{away(now.callWall)} above</> : 'no call wall above'}{now.maxGamma != null ? <>; magnet {now.maxGamma}{away(now.maxGamma)}</> : ''}.</>
          )}
        </div>
      </FoldText>
      <FoldText id="gex.agreement" label="the two signs' verdict" style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Standard </Text>
          <span style={{ color: gexColor(both.standardNow?.net) }}>{cr(both.standardNow?.net)} ({both.standard ?? '-'})</span>
          <Text type="secondary" style={{ fontSize: 12 }}> · OI build-up </Text>
          <span style={{ color: gexColor(both.buildupNow?.net) }}>{cr(both.buildupNow?.net)} ({both.buildup ?? '-'})</span>
          {' → '}
          {both.agree
            ? <><Tag color={both.regime === 'positive' ? 'green' : 'red'} style={{ margin: '0 6px 0 0' }}>agree</Tag>{both.regime === 'positive' ? 'range / pin day - fade the walls, aim at the max gamma strike.' : 'trend / fast day - trade with the break, do not fade it.'}</>
            : <><Tag color="gold" style={{ margin: '0 6px 0 0' }}>disagree</Tag>regime unclear - do not lean on the flip; trade the walls and spot structure.</>}
        </div>
      </FoldText>
      <Row gutter={[16, 4]} style={{ marginBottom: 8, fontSize: 12 }}>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Net GEX </Text><Text strong style={{ fontSize: 12, color: gexColor(now.net) }}>{cr(now.net)}</Text><Text type="secondary" style={{ fontSize: 12 }}> per 1% move</Text></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Calls </Text><span style={{ color: gexColor(now.calls) }}>{cr(now.calls)}</span><Text type="secondary" style={{ fontSize: 12 }}> · Puts </Text><span style={{ color: gexColor(now.puts) }}>{cr(now.puts)}</span></Col>
        <Col>
          <Text type="secondary" style={{ fontSize: 12 }}>Flip </Text><span style={{ color: FLIP_COLOR }}>{num(now.flip)}{away(now.flip)}</span>
          {now.flipEdge && <Tooltip title="Near the edge of the strikes loaded (ATM ± 10): strikes not loaded weigh in there, so the flip is only rough."><Text type="secondary" style={{ fontSize: 11 }}> rough</Text></Tooltip>}
        </Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Call wall </Text><span style={{ color: UP_COLOR }}>{now.callWall ?? '-'}{away(now.callWall)}</span></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Put wall </Text><span style={{ color: DOWN_COLOR }}>{now.putWall ?? '-'}{away(now.putWall)}</span></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Max gamma </Text><span style={{ color: MAX_GAMMA_COLOR }}>{now.maxGamma ?? '-'}{away(now.maxGamma)}</span></Col>
        <Col flex="1 1 320px" style={{ minWidth: 0 }}>
          <FoldText id="gex.basis" label="how it is worked out" className="oa-note">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {istHhmm(now.time)} · ATM {now.atm} · ATM IV {num(now.atmIv * 100, 1)} (from the premiums) · forward {num(now.forward, 1)} ({now.forward >= now.spot ? '+' : '−'}{num(Math.abs(now.forward - now.spot), 1)} carry) ·{' '}
              {now.yearsFrom === 'expiry'
                ? <>expiry {dayjs(expiry).format('ddd D MMM')} ({EXPIRY_SOURCES[expirySource] ?? 'weekday rule'}) - {num(now.years * 365, 2)} days left</>
                : <>≈ {num(now.years * 365, 1)} days to expiry (implied from the ATM straddle{expiry ? ' - past the expiry date' : ' - no expiry date'})</>}
            </Text>
          </FoldText>
        </Col>
      </Row>
      <Row gutter={[16, 12]}>
        <Col xs={24} lg={10}>
          <FoldText id="gex.strikeNote" label="the table's note">
            <Text strong style={{ fontSize: 12 }}>GEX by strike</Text>
            <Text className="oa-note" type="secondary" style={{ fontSize: 11 }}> · at {istHhmm(now.time)}; green = dealers long gamma, red = short</Text>
          </FoldText>
          {/* In a card the trader sized, the table takes its share of the card and scrolls inside it (CardFitBox). */}
          <CardFitBox min={100}>
            <StrikeBars minute={now} />
          </CardFitBox>
          <div style={{ marginTop: 10 }}>
            <FoldText id="gex.profileNote" label="the profile's note">
              <Text strong style={{ fontSize: 12 }}>GEX profile</Text>
              <Text className="oa-note" type="secondary" style={{ fontSize: 11 }}> · the net GEX if spot were here (this minute&apos;s OI and IVs); it crosses zero at the flip</Text>
            </FoldText>
            <ProfileChart minute={now} />
          </div>
        </Col>
        <Col xs={24} lg={14}>
          <Text strong style={{ fontSize: 12 }}>Spot, flip and walls</Text>
          <LinesChart lines={charts.levels} dayKey={`gex-levels-${dayKey}-${sign}`} height={height} />
          <Text strong style={{ fontSize: 12 }}>Net GEX through the day</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · ₹ crore per 1% move</Text>
          <NetGexChart data={charts.net} dayKey={`gex-net-${dayKey}-${sign}`} height={Math.round(height * 0.7)} />
        </Col>
      </Row>
    </>
  )
}
