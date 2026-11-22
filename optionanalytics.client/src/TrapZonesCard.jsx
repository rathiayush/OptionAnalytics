import { useEffect, useMemo, useRef } from 'react'
import { Alert, Checkbox, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { useChartUserControl } from './oiShared.jsx'
import { useChartHeight, useFitHeight } from './DashboardCard.jsx'
import { ZoneBoxesPrimitive } from './profilePrimitives.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, fromChartTime, istTickMarkFormatter, istTimeFormatter, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { barsUpTo, optionDeltaMinutes } from './deltaProfile.js'
import { optionOiMinutes } from './oiProfile.js'
import { usePastDeltaSessions } from './usePastDeltaSessions.js'
import { useFuturesFootprintDay } from './DeltaProfileCard.jsx'
import { PROFILE_ROWS } from './profileZones.js'
import { TRAP_SOURCES, ZONE_KINDS, dayRead, dayTimeline, openingBias, openingRead, supportResistance, tradeSetups, zoneBoxes } from './trapZones.js'

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
function ZonesSpotChart({ candles, boxes, open, prevClose, dayKey, height: givenHeight = 380 }) {
  const height = useFitHeight(givenHeight)
  const heightRef = useRef(height)
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const boxesRef = useRef(null)
  const linesRef = useRef([])
  const rangeRef = useRef(null)
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
      // The scale also holds the zones nearest price (within ~1%) so a support / resistance just off the candles shows.
      autoscaleInfoProvider: (original) => {
        const base = original()
        const r = rangeRef.current
        if (!r || !base?.priceRange) return base
        return { ...base, priceRange: { minValue: Math.min(base.priceRange.minValue, r.low), maxValue: Math.max(base.priceRange.maxValue, r.high) } }
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
    if (Number.isFinite(last)) {
      const near = boxes.filter((b) => Math.abs((b.low + b.high) / 2 - last) / last <= 0.01)
      rangeRef.current = near.length ? { low: Math.min(...near.map((b) => b.low)), high: Math.max(...near.map((b) => b.high)) } : null
    }
    if (!userControlRef.current) chartRef.current?.priceScale('right').applyOptions({ autoScale: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, candles])
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const l of linesRef.current) series.removePriceLine(l)
    linesRef.current = [
      Number.isFinite(open) ? series.createPriceLine({ price: open, color: '#d9d9d9', title: 'Open', lineWidth: 1, lineStyle: 2, axisLabelVisible: true }) : null,
      Number.isFinite(prevClose) ? series.createPriceLine({ price: prevClose, color: '#8c8c8c', title: 'Prev close', lineWidth: 1, lineStyle: 1, axisLabelVisible: true }) : null,
    ].filter(Boolean)
  }, [open, prevClose])
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
  const opening = useMemo(() => openingRead({ prevOptions: pastOpt.sessions, prevFutures: pastFut.sessions, rowSize }), [pastOpt.sessions, pastFut.sessions, rowSize])
  const day = useMemo(() => dayRead({ opening, options: todayOptions, oi: todayOi, futures: todayFut, spot: spotMs, rowSize }), [opening, todayOptions, todayOi, todayFut, spotMs, rowSize])
  // The day bias from the open - fixed once the first minute is in (before it: the pre-open read).
  const dayOpen = spotMs.length ? (spotMs[0].open > 0 ? spotMs[0].open : spotMs[0].close) : null
  const bias = useMemo(() => openingBias({ opening, prevOptions: pastOpt.sessions, open: dayOpen, rowSize }), [opening, pastOpt.sessions, dayOpen, rowSize])
  const chartCandles = useMemo(() => candlesOf((spotBars ?? []).filter((b) => clock == null || fromChartTime(b.time) * 1000 <= clock), CHART_TF.includes(chartTf) ? chartTf : 5), [spotBars, clock, chartTf])
  const chartBoxes = useMemo(() => zoneBoxes(day ? day.zones : (opening.zones ?? []).map((z) => ({ ...z, from: 'prev' })), { showPrev, showToday }), [day, opening.zones, showPrev, showToday])
  const setups = useMemo(() => tradeSetups({ day, bias, rowSize }), [day, bias, rowSize])
  const sides = useMemo(() => supportResistance(day ? day.zones : opening.zones), [day, opening.zones])
  const tableZones = useMemo(() => (day ? day.zones : (opening.zones ?? []).map((z) => ({ ...z, from: 'prev' }))), [day, opening.zones])
  // The day re-read every STEP_MIN minutes - worked out again only when a new step completes (live pushes every second
  // would otherwise redo it all), from the minutes up to each step.
  const lastStep = spotMs.length ? Math.floor((spotMs[spotMs.length - 1].time - spotMs[0].time + MIN) / (STEP_MIN * MIN)) : 0
  const timelineKey = `${underlying}|${date}|${lastStep}|${opening.zones?.length}|${opening.close}|${futDay.bars?.length ? 1 : 0}`
  const zoneEvents = useMemo(
    () => dayTimeline({ opening, options: todayOptions, oi: todayOi, futures: todayFut, spot: spotMs, rowSize, stepMin: STEP_MIN }),
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
        {loadingPast && <Tag color="processing" style={{ margin: 0 }}>loading the sessions before…</Tag>}
        {pastOpt.error && <Tag color="warning" style={{ margin: 0 }}>{pastOpt.error.date}: {pastOpt.error.message}</Tag>}
        {futDay.error && <Tooltip title={futDay.error}><Tag style={{ margin: 0 }}>no futures footprint today</Tag></Tooltip>}
        {isLive && <Tag color="green" style={{ margin: 0 }}>live</Tag>}
      </Space>

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

      <Space wrap size={[8, 4]} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>On spot</Text>
        <Segmented size="small" value={CHART_TF.includes(chartTf) ? chartTf : 5} onChange={setChartTf} options={CHART_TF.map((v) => ({ value: v, label: `${v}m` }))} />
        <Checkbox checked={showPrev} onChange={(e) => setShowPrev(e.target.checked)}>Zones from before (dashed)</Checkbox>
        <Checkbox checked={showToday} onChange={(e) => setShowToday(e.target.checked)}>Today&apos;s zones (solid)</Checkbox>
      </Space>
      {chartCandles.length ? (
        <ZonesSpotChart candles={chartCandles} boxes={chartBoxes} open={day?.open} prevClose={opening.close} dayKey={`${underlying}|${date}|${chartTf}`} />
      ) : <Text type="secondary" style={{ fontSize: 12 }}>No spot candles up to this minute yet.</Text>}

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
          read is flagged for a smaller size. Only the minutes up to the clock count. A read - it feeds no strategy or alert.
        </Text>
      </FoldText>
    </Space>
  )
}
