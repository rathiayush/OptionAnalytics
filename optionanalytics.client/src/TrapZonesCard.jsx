import { useMemo } from 'react'
import { Alert, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { fromChartTime, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { barsUpTo, optionDeltaMinutes } from './deltaProfile.js'
import { optionOiMinutes } from './oiProfile.js'
import { usePastDeltaSessions } from './usePastDeltaSessions.js'
import { useFuturesFootprintDay } from './DeltaProfileCard.jsx'
import { PROFILE_ROWS } from './profileZones.js'
import { TRAP_SOURCES, ZONE_KINDS, dayRead, openingRead } from './trapZones.js'

// OI Replay's TRAPPED / SQUEEZE ZONES card (asked for - "from the start of day ... previous idea of the last session ...
// identify trapped zones, short squeeze zones ... keep updating as it goes ... a separate component"): the previous
// session(s)' OI (CE − PE), option CDV / OBV and futures delta clusters read against their close before the open, and
// against the price at the clock through the day with the day's own clusters, the open rule and the squeezes (trapZones.js).

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

/** The zones near price as a vertical ladder: each zone a band in its kind's colour, price / open / previous close lines. */
function ZoneLadder({ zones, price, open, prevClose, height = 280 }) {
  if (!Number.isFinite(price) || !zones.length) return null
  const span = price * 0.02
  const near = zones.filter((z) => z.high >= price - span && z.low <= price + span)
  const lo = Math.min(price - span * 0.5, ...near.map((z) => z.low)), hi = Math.max(price + span * 0.5, ...near.map((z) => z.high))
  const y = (v) => ((hi - v) / (hi - lo)) * (height - 20) + 10
  const width = 360
  const line = (v, color, label, dash) => (Number.isFinite(v) && v >= lo && v <= hi ? (
    <g key={label}>
      <line x1={0} x2={width - 70} y1={y(v)} y2={y(v)} stroke={color} strokeWidth={label === 'Price' ? 2 : 1} strokeDasharray={dash} />
      <text x={width - 66} y={y(v) + 4} fill={color} fontSize={11}>{label} {px(v)}</text>
    </g>
  ) : null)
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: 520, height, display: 'block' }}>
      {near.map((z, i) => {
        const k = ZONE_KINDS[z.kind]
        const top = y(z.high), h = Math.max(3, y(z.low) - y(z.high))
        return (
          <g key={`${z.low}-${z.high}-${i}`}>
            <rect x={z.from === 'today' ? 150 : 0} y={top} width={140} height={h} fill={k?.color ?? '#888'} opacity={0.25 + Math.min(0.55, z.score / 4)} stroke={k?.color} />
            {h >= 12 && <text x={(z.from === 'today' ? 150 : 0) + 4} y={top + 11} fontSize={10} fill="#fff">{k?.label?.split(' - ')[0]} · {z.sources.map((s) => TRAP_SOURCES.find((x) => x.id === s)?.short).join('+')}</text>}
          </g>
        )
      })}
      <text x={2} y={9} fontSize={9} fill="#888">Previous session(s)</text>
      <text x={152} y={9} fontSize={9} fill="#888">Today so far</text>
      {line(prevClose, '#8c8c8c', 'Prev close', '2 3')}
      {line(open, '#d9d9d9', 'Open', '5 4')}
      {line(price, '#1677ff', 'Price')}
    </svg>
  )
}

function ZoneTable({ zones }) {
  return (
    <Table
      size="small" pagination={false} rowKey={(z, i) => `${z.from}-${z.low}-${z.high}-${i}`} dataSource={zones.slice(0, 12)} scroll={{ x: 560 }}
      columns={[
        { title: 'Zone', key: 'z', width: 130, render: (_, z) => `${px(z.low)} – ${px(z.high)}` },
        { title: 'What it is now', key: 'k', render: (_, z) => <KindTag kind={z.kind} /> },
        { title: 'From', key: 'f', width: 80, render: (_, z) => (z.from === 'today' ? 'today' : 'before') },
        { title: 'Profiles', key: 's', render: (_, z) => sourceTags(z.sources) },
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
}

/**
 * `cePoints` / `pePoints` (the page's option points), `spotBars` (chart time, seconds), `asOfMs` (the replay clock; live
 * the latest), `underlying`, `date`, `expiryFlag`, `isLive`.
 */
export function TrapZonesCard({ cePoints, pePoints, spotBars, asOfMs, underlying, date, expiryFlag, isLive = false }) {
  const [days, setDays] = usePersistedState('optionanalytics.oiReplay.trapZonesDays', 1)
  const dayCount = [1, 2, 3].includes(days) ? days : 1
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

  const events = useMemo(() => {
    if (!day) return []
    const list = [
      ...day.openRule.events.map((e) => ({ t: e.t, type: e.state ?? 'off' })),
      ...day.crossings.map((e) => ({ t: e.t, type: e.type, zone: e.zone })),
    ]
    return list.sort((a, b) => b.t - a.t).slice(0, 10)
  }, [day])

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

      {day ? (
        <Alert
          type={verdictType} showIcon
          message={<span><b>{day.verdict}</b> · price {px(day.price)} vs open {px(day.open)} ({pct((day.price - day.open) / day.open * 100)}){!isLive && asOfMs ? ` · at ${hhmm(asOfMs)}` : ''}</span>}
          description={day.reasons.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{day.reasons.map((r) => <li key={r} style={{ fontSize: 12 }}>{r}</li>)}</ul> : <Text style={{ fontSize: 12 }}>Nothing decisive yet.</Text>}
        />
      ) : (
        <Alert type="info" showIcon message="Before the open" description="The day's first minute is not in yet - the read below is from the sessions before." />
      )}

      <Text style={{ fontSize: 12 }}>
        <b>Before the open</b> ({pastOpt.sessions.map((s) => s.date).join(', ') || 'no session loaded'}): close {px(opening.close)} - positioning {openingLean}
        {opening.zones?.length ? ` · nearest: ${opening.zones.slice(0, 2).map((z) => `${ZONE_KINDS[z.kind]?.label.split(' - ')[0]} ${px(z.low)}–${px(z.high)}`).join(', ')}` : ''}
        {opening.basis == null && pastFut.sessions.length ? ' · futures left out (no same-day close for the basis)' : ''}
      </Text>

      {day && day.openRule.gross > 0 && (
        <Text style={{ fontSize: 12 }}>
          <b>Open rule</b>: OI CE − PE added below the open {Math.round(day.openRule.below).toLocaleString('en-IN')} · above {Math.round(day.openRule.above).toLocaleString('en-IN')}
          {' '}→ <Text strong style={{ fontSize: 12, color: day.openRule.state === 'bull' ? '#52c41a' : day.openRule.state === 'bear' ? '#ff4d4f' : undefined }}>
            {day.openRule.state === 'bull' ? `trend-day-up setup since ${hhmm(day.openRule.since)}` : day.openRule.state === 'bear' ? `trend-day-down setup since ${hhmm(day.openRule.since)}` : 'not on'}
          </Text>
        </Text>
      )}

      <ZoneLadder zones={day ? day.zones : (opening.zones ?? [])} price={day?.price ?? opening.close} open={day?.open} prevClose={opening.close} />
      <ZoneTable zones={day ? day.zones : (opening.zones ?? []).map((z) => ({ ...z, from: 'prev' }))} />

      {events.length > 0 && (
        <Space direction="vertical" size={2}>
          <Text type="secondary" style={{ fontSize: 12 }}>Through the day (newest first)</Text>
          {events.map((e, i) => (
            <Text key={`${e.t}-${e.type}-${i}`} style={{ fontSize: 12 }}>
              {hhmm(e.t)} · {EVENT_TEXT[e.type]}{e.zone ? ` ${px(e.zone.low)}–${px(e.zone.high)}` : ''}
            </Text>
          ))}
        </Space>
      )}

      <FoldText id="oiReplay.trapZones" label="how to read this" className="oa-note">
        <Text type="secondary" style={{ fontSize: 12 }}>
          Four position profiles - OI (CE − PE), option CDV, option OBV and the futures delta - each show CLUSTERS: price bands
          where one side stacked up. Those positions were opened at those prices, so where price is now says who is in profit
          and who is trapped. A bullish cluster below price is a FLOOR (buyers / put writers defend it); above price those
          buyers are TRAPPED - their exits are supply (long liquidation). A bearish cluster above price is a CEILING; below price
          its sellers / call writers are TRAPPED - their covering is fuel (SHORT SQUEEZE). Clusters of different profiles that
          overlap are one zone, stronger the more profiles agree. BEFORE THE OPEN the previous session(s)&apos; zones are read
          against their close; THROUGH THE DAY against the price at the replay clock, with the day&apos;s own clusters (today&apos;s
          column). A previous ceiling closed above = its sellers trapped = squeeze; a previous floor closed below = long
          liquidation. THE OPEN RULE (yours): the OI added below the day&apos;s open net CE − PE negative (puts written under the
          open) with price above the open = the writers defend a floor under a rising market - a trend-day-up setup; calls
          written above the open with price below it = trend-day-down; it counts once it holds 3 minutes. The verdict adds the
          open rule (±2), today&apos;s four flows (±1 each) and a squeeze still standing (±1). Futures zones are moved to spot by
          the basis. Only the minutes up to the clock count. A read - it feeds no strategy or alert.
        </Text>
      </FoldText>
    </Space>
  )
}
