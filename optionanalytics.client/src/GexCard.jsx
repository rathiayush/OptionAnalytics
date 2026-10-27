import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Col, Popover, Row, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import dayjs from 'dayjs'
import { BaselineSeries, CrosshairMode, LineStyle } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { sanitizeLine } from './chartLine.js'
import { LinesChart } from './StraddleCard.jsx'
import { gexAgreement, gexDay, gexUpTo } from './gex.js'

const { Text } = Typography

const SPOT_COLOR = '#d9d9d9'
const FLIP_COLOR = '#ffd54f'
const MAX_GAMMA_COLOR = '#b37feb'
const CR = 1e7
const IST_MS = 330 * 60_000

/** HH:mm in IST. */
const istHhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)

const LIVE_EVERY_MS = 5000

// `value`, passed on at most every `ms` while `throttle` is on (live: the option points change with every tick, and a
// day's GEX takes a moment to work out) - at once otherwise.
function useThrottled(value, ms, throttle) {
  const [shown, setShown] = useState(value)
  const lastRef = useRef(0)
  useEffect(() => {
    const wait = throttle ? Math.max(0, lastRef.current + ms - Date.now()) : 0
    const id = setTimeout(() => { lastRef.current = Date.now(); setShown(value) }, wait)
    return () => clearTimeout(id)
  }, [value, ms, throttle])
  return shown
}

const cr = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v) / CR).toLocaleString('en-IN')} Cr` : '-')
const num = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '-')
const EXPIRY_SOURCES = { dhan: 'Dhan', calendar: 'weekday rule', 'calendar-holiday': 'weekday rule, moved for a holiday' }
// The straddle's own time to expiry is far off the expiry date's: more than half a day and a third apart.
const disagrees = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > Math.max(0.5, 0.33 * Math.max(a, b))

const gexColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : AXIS_COLOR)

// The net GEX through the day around zero: green above (dealers long gamma), red below (short gamma).
function NetGexChart({ data, dayKey, height }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
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
    seriesRef.current = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: UP_COLOR, topFillColor1: `${UP_COLOR}55`, topFillColor2: `${UP_COLOR}08`,
      bottomLineColor: DOWN_COLOR, bottomFillColor1: `${DOWN_COLOR}08`, bottomFillColor2: `${DOWN_COLOR}55`,
      lineWidth: 2, priceLineVisible: false, title: 'Net GEX (₹ Cr)',
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [height])
  useEffect(() => {
    seriesRef.current?.setData(sanitizeLine(data.map((p) => ({ time: toChartTime(p.time), value: p.value }))))
  }, [data])
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

const HOW_TO_READ = (
  <div style={{ maxWidth: 440, fontSize: 12 }}>
    <p style={{ margin: '0 0 6px' }}><b>GEX</b> = how much index the option dealers must trade to stay hedged for a 1% move: gamma (Black-Scholes, each option&apos;s IV) × the dealers&apos; OI × spot² × 1%, in ₹ crore. The time to expiry runs to 15:30 on the expiry day (NIFTY Tuesday, SENSEX Thursday, BANKNIFTY the month&apos;s last Tuesday - Dhan&apos;s own date from today on, holidays checked before that).</p>
    <p style={{ margin: '0 0 6px' }}><b>Net GEX positive</b>: dealers are long gamma - they sell rallies and buy dips, so moves are damped: range, pin. <b>Negative</b>: they are short gamma - they buy rallies and sell dips, so moves run: trend, fast days.</p>
    <p style={{ margin: '0 0 6px' }}><b>Gamma flip</b>: the spot at which the net GEX would cross zero. Above it the market tends to be calmer; below it moves speed up. <b>Call wall (CW)</b> / <b>Put wall (PW)</b>: the most call / put gamma × OI - resistance / support. <b>Max gamma (MG)</b>: the most of both - the magnet, above all on expiry day.</p>
    <p style={{ margin: '0 0 6px' }}><b>Sign.</b> Who the dealers are is not in the data. Standard: dealers long the calls, short the puts. OI build-up: the OI at the first reading as standard, then each minute&apos;s OI change signed by the premium - added while it fell = written by customers (dealers long), added while it rose = bought (dealers short). The premium also moves with spot, so it is a rough read.</p>
    <p style={{ margin: 0 }}>Only the strikes the page has (ATM ± 10) count: the totals are partial, though gamma is mostly near the money.</p>
  </div>
)

/**
 * GEX (gamma exposure) from the day's option OI, IV and premium (gex.js), up to the replay clock (`asOfMs`; null - live -
 * every minute given; 0 - the replay not started), so it runs with OI Replay, replayed or live.
 */
export function GexCard({ cePoints, pePoints, spotBars, asOfMs, dayKey, expiry = null, expirySource = null, height = 260 }) {
  const [sign, setSign] = usePersistedState('optionanalytics.oiReplay.gexSign', 'standard')
  // Every minute of the day once (each uses only what was known at it), then cut at the clock - live, again at most every
  // few seconds.
  const inputs = useMemo(() => ({ cePoints, pePoints, spotBars }), [cePoints, pePoints, spotBars])
  const shown = useThrottled(inputs, LIVE_EVERY_MS, asOfMs == null)
  // Both signs, always: the card shows the one chosen, the line under the read says whether the other agrees.
  const standardDay = useMemo(() => gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'standard', expiry }), [shown, expiry])
  const buildupDay = useMemo(() => gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'buildup', expiry }), [shown, expiry])
  const minutes = useMemo(() => gexUpTo(sign === 'buildup' ? buildupDay : standardDay, asOfMs), [sign, standardDay, buildupDay, asOfMs])
  const now = minutes.at(-1)
  const both = useMemo(() => {
    const standardNow = gexUpTo(standardDay, asOfMs).at(-1)
    const buildupNow = gexUpTo(buildupDay, asOfMs).at(-1)
    return { standardNow, buildupNow, ...gexAgreement(standardNow, buildupNow) }
  }, [standardDay, buildupDay, asOfMs])

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

  const positive = now.net > 0
  const aboveFlip = now.flip != null ? now.spot > now.flip : null
  const between = now.putWall != null && now.callWall != null && now.spot >= now.putWall && now.spot <= now.callWall
  return (
    <>
      {controls}
      <div style={{ borderLeft: `3px solid ${gexColor(now.net)}`, padding: '4px 10px', marginBottom: 8, fontSize: 12 }}>
        <Tag color={positive ? 'green' : 'red'} style={{ marginRight: 8 }}>{positive ? 'Positive gamma' : 'Negative gamma'}</Tag>
        {positive
          ? 'Dealers long gamma: they sell rallies and buy dips - moves are damped (range, pin).'
          : 'Dealers short gamma: they buy rallies and sell dips - moves run (trend, fast moves).'}
        {aboveFlip != null && <> Spot {num(now.spot, 1)} is {aboveFlip ? 'above' : 'below'} the flip {num(now.flip)} ({aboveFlip ? 'the calmer side' : 'moves speed up below it'}).</>}
        {aboveFlip == null && <> No flip within ±3% of spot - the net stays {positive ? 'positive' : 'negative'} there.</>}
        {between && <> Between the put wall {now.putWall} and the call wall {now.callWall}.</>}
      </div>
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Standard </Text>
        <span style={{ color: gexColor(both.standardNow?.net) }}>{cr(both.standardNow?.net)} ({both.standard ?? '-'})</span>
        <Text type="secondary" style={{ fontSize: 12 }}> · OI build-up </Text>
        <span style={{ color: gexColor(both.buildupNow?.net) }}>{cr(both.buildupNow?.net)} ({both.buildup ?? '-'})</span>
        {' → '}
        {both.agree
          ? <><Tag color={both.regime === 'positive' ? 'green' : 'red'} style={{ margin: '0 6px 0 0' }}>agree</Tag>{both.regime === 'positive' ? 'range / pin day - fade the walls, aim at the max gamma strike.' : 'trend / fast day - trade with the break, do not fade it.'}</>
          : <><Tag color="gold" style={{ margin: '0 6px 0 0' }}>disagree</Tag>regime unclear - do not lean on the flip; trade the walls and spot structure.</>}
      </div>
      <Row gutter={[16, 4]} style={{ marginBottom: 8, fontSize: 12 }}>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Net GEX </Text><Text strong style={{ fontSize: 12, color: gexColor(now.net) }}>{cr(now.net)}</Text><Text type="secondary" style={{ fontSize: 12 }}> per 1% move</Text></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Calls </Text><span style={{ color: gexColor(now.calls) }}>{cr(now.calls)}</span><Text type="secondary" style={{ fontSize: 12 }}> · Puts </Text><span style={{ color: gexColor(now.puts) }}>{cr(now.puts)}</span></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Flip </Text><span style={{ color: FLIP_COLOR }}>{num(now.flip)}</span></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Call wall </Text><span style={{ color: UP_COLOR }}>{now.callWall ?? '-'}</span></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Put wall </Text><span style={{ color: DOWN_COLOR }}>{now.putWall ?? '-'}</span></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Max gamma </Text><span style={{ color: MAX_GAMMA_COLOR }}>{now.maxGamma ?? '-'}</span></Col>
        <Col>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {istHhmm(now.time)} · ATM {now.atm} · IV {num(now.atmIv * 100, 1)} ·{' '}
            {now.yearsFrom === 'expiry'
              ? <>expiry {dayjs(expiry).format('ddd D MMM')} ({EXPIRY_SOURCES[expirySource] ?? 'weekday rule'}) - {num(now.years * 365, 2)} days left</>
              : <>≈ {num(now.years * 365, 1)} days to expiry (implied from the ATM straddle{expiry ? ' - past the expiry date' : ' - no expiry date'})</>}
          </Text>
        </Col>
      </Row>
      {now.yearsFrom === 'expiry' && disagrees(now.years * 365, now.impliedYears * 365) && (
        <Text type="warning" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          The ATM straddle at Dhan&apos;s IV prices ≈ {num(now.impliedYears * 365, 1)} days, not {num(now.years * 365, 1)} - the IVs or the expiry date may be off; read the levels with care.
        </Text>
      )}
      <Row gutter={[16, 12]}>
        <Col xs={24} lg={10}>
          <Text strong style={{ fontSize: 12 }}>GEX by strike</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · at {istHhmm(now.time)}; green = dealers long gamma, red = short</Text>
          <StrikeBars minute={now} />
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
