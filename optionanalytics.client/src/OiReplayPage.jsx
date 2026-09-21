import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Card, Button, Statistic, Row, Col, DatePicker, Alert, Empty, Tooltip, Slider } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { createChart, CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import {
  UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  istTimeFormatter, istTickMarkFormatter, toBar,
  NavBar, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState,
} from './shared.jsx'

const { Text, Title } = Typography

// One entry per distinct strike this side ever reported, its own points sorted ascending by time -
// built once per fetched run (see useMemo below), not recomputed on every replay tick. Grouping by
// strike here is what lets the replay loop below look up "this strike's latest reading at or before
// time T" as a simple per-strike scan instead of re-filtering the whole flat point list every tick.
function groupByStrike(points) {
  const byStrike = new Map()
  for (const p of points) {
    let list = byStrike.get(p.strike)
    if (!list) byStrike.set(p.strike, (list = []))
    list.push(p)
  }
  for (const list of byStrike.values()) list.sort((a, b) => new Date(a.time) - new Date(b.time))
  return byStrike
}

// The last point at or before asOfMs in a time-ascending list - null if the series hasn't started
// yet as of this point in the replay. Linear scan from the end: a real day's own per-strike series
// is at most a few hundred points, and this runs once per strike per tick, so this is nowhere near
// hot enough to need a binary search.
function latestAtOrBefore(sortedPoints, asOfMs) {
  for (let i = sortedPoints.length - 1; i >= 0; i--) {
    const t = new Date(sortedPoints[i].time).getTime()
    if (t <= asOfMs) return sortedPoints[i]
  }
  return null
}

// The classic Max Pain read: the strike where option WRITERS (as a whole, both legs) would owe the
// least if the underlying settled there today - candidates are exactly the strikes this run actually
// has OI for, since anywhere else is not a real strike price to consider.
function computeMaxPain(rows) {
  if (rows.length === 0) return null
  let best = null
  let bestPain = Infinity
  for (const candidate of rows) {
    let pain = 0
    for (const row of rows) {
      if (row.ceOi) pain += row.ceOi * Math.max(0, candidate.strike - row.strike)
      if (row.peOi) pain += row.peOi * Math.max(0, row.strike - candidate.strike)
    }
    if (pain < bestPain) { bestPain = pain; best = candidate.strike }
  }
  return best
}

// How many strikes on EACH side get an actual line drawn on the chart - the ladder already shows
// every strike; the chart would just be noise at that density, so only the strongest few (by OI)
// per side earn a line there. Support/resistance is a relative-strength read anyway.
const CHART_LEVELS_PER_SIDE = 5

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Linear interpolation between a light and a dark shade, t in [0,1] - t=0 is the lightest (weakest
// OI among the levels actually drawn), t=1 the darkest (heaviest, "hardest" wall). Used for both
// the resistance (red) and support (green) lines below with their own two endpoints.
function shade(lightHex, darkHex, t) {
  const [lr, lg, lb] = hexToRgb(lightHex)
  const [dr, dg, db] = hexToRgb(darkHex)
  const r = Math.round(lr + (dr - lr) * t)
  const g = Math.round(lg + (dg - lg) * t)
  const b = Math.round(lb + (db - lb) * t)
  return `rgb(${r}, ${g}, ${b})`
}

const RESISTANCE_LIGHT = '#ffb3b3'
const RESISTANCE_DARK = '#7a0000'
const SUPPORT_LIGHT = '#b3f0c2'
const SUPPORT_DARK = '#0a5c1f'

// Candlestick chart that reveals `bars` progressively as the replay advances - a single visibleCount
// controls exactly how many of the (already-loaded) day's bars are shown, so playback needs no
// further data fetch, just a local re-render. Also draws the strongest OI levels on each side as
// horizontal price lines directly on the chart (darker = heavier OI = a "harder" level) - the same
// data the ladder shows in table form, here as the market-structure read on the price chart itself.
function ReplayChart({ bars, visibleCount, ladderRows, height = 440 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const priceLinesRef = useRef([])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      priceLinesRef.current = [] // the series they belonged to is gone along with the chart
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars.slice(0, visibleCount))
  }, [bars, visibleCount])

  // Re-fit once when a brand new day's own bars first load - not on every tick, which would fight
  // the user's own pan/zoom during playback.
  useEffect(() => {
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars])

  // Redraws the strongest CHART_LEVELS_PER_SIDE resistance (CE OI) / support (PE OI) lines on
  // every tick, since OI itself changes as the replay advances - always clears the previous set
  // first rather than trying to diff/reuse handles, since which strikes even qualify as "top 5" can
  // change from one tick to the next.
  useEffect(() => {
    if (!seriesRef.current) return
    for (const line of priceLinesRef.current) seriesRef.current.removePriceLine(line)
    priceLinesRef.current = []
    if (!ladderRows || ladderRows.length === 0) return

    const drawSide = (key, ivKey, lightColor, darkColor, labelPrefix) => {
      const top = [...ladderRows]
        .filter((r) => (r[key] ?? 0) > 0)
        .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
        .slice(0, CHART_LEVELS_PER_SIDE)
      if (top.length === 0) return
      const maxOi = top[0][key]
      const minOi = top[top.length - 1][key]
      const span = maxOi - minOi

      for (const row of top) {
        const t = span > 0 ? (row[key] - minOi) / span : 1
        const line = seriesRef.current.createPriceLine({
          price: row.strike,
          color: shade(lightColor, darkColor, t),
          lineWidth: 1 + Math.round(t * 2), // thicker as OI (and darkness) increases too
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title: `${labelPrefix} ${row.strike} (${row[key].toLocaleString()} OI${row[ivKey] != null ? `, IV ${row[ivKey].toFixed(1)}` : ''})`,
        })
        priceLinesRef.current.push(line)
      }
    }

    drawSide('ceOi', 'ceIv', RESISTANCE_LIGHT, RESISTANCE_DARK, 'R')
    drawSide('peOi', 'peIv', SUPPORT_LIGHT, SUPPORT_DARK, 'S')
  }, [ladderRows])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// The right-hand OI/IV ladder: every strike in the fetched band gets its own row (never just the
// single heaviest one - see this page's own "there could be multiple [levels]" request), a CE bar
// extending right and a PE bar extending left from a shared center scale, both sides' IV printed
// alongside. The row(s) actually carrying the MOST OI on each side are called out as the current
// resistance (CE)/support (PE) read, since a wall only means something relative to the rest of the
// chain, not in isolation.
function OiLadder({ rows, atmStrike }) {
  if (rows.length === 0) return <Empty description="No stored OI/IV data yet at this point in the replay." />

  const maxCeOi = Math.max(1, ...rows.map((r) => r.ceOi ?? 0))
  const maxPeOi = Math.max(1, ...rows.map((r) => r.peOi ?? 0))
  const resistanceStrike = rows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)?.strike
  const supportStrike = rows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)?.strike

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Row style={{ fontSize: 11, color: AXIS_COLOR, marginBottom: 4 }}>
        <Col span={9} style={{ textAlign: 'right', paddingRight: 6 }}>PE OI (support)</Col>
        <Col span={6} style={{ textAlign: 'center' }}>Strike</Col>
        <Col span={9} style={{ paddingLeft: 6 }}>CE OI (resistance)</Col>
      </Row>
      {rows.map((row) => {
        const isAtm = atmStrike != null && row.strike === atmStrike
        const isResistance = row.strike === resistanceStrike && (row.ceOi ?? 0) > 0
        const isSupport = row.strike === supportStrike && (row.peOi ?? 0) > 0
        return (
          <Row
            key={row.strike}
            align="middle"
            style={{
              background: isAtm ? '#ffffff12' : 'transparent',
              borderTop: isResistance ? `1px solid ${CE_COLOR}` : isSupport ? `1px solid ${PE_COLOR}` : '1px solid transparent',
              borderBottom: isResistance ? `1px solid ${CE_COLOR}` : isSupport ? `1px solid ${PE_COLOR}` : '1px solid transparent',
              padding: '1px 0',
            }}
          >
            <Col span={9} style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
              <Text style={{ fontSize: 10, color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.peIv != null ? `IV ${row.peIv.toFixed(1)}` : ''}
              </Text>
              <div style={{ width: 90, display: 'flex', justifyContent: 'flex-end' }}>
                <Tooltip title={row.peOi != null ? `PE OI: ${row.peOi.toLocaleString()}` : 'No data'}>
                  <div style={{
                    width: `${((row.peOi ?? 0) / maxPeOi) * 100}%`, minWidth: row.peOi ? 2 : 0, height: 14,
                    background: isSupport ? PE_COLOR : `${PE_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
            </Col>
            <Col span={6} style={{ textAlign: 'center' }}>
              <Text strong={isAtm} style={{ fontSize: 12, color: isAtm ? '#fff' : undefined }}>{row.strike.toLocaleString()}</Text>
            </Col>
            <Col span={9} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 90 }}>
                <Tooltip title={row.ceOi != null ? `CE OI: ${row.ceOi.toLocaleString()}` : 'No data'}>
                  <div style={{
                    width: `${((row.ceOi ?? 0) / maxCeOi) * 100}%`, minWidth: row.ceOi ? 2 : 0, height: 14,
                    background: isResistance ? CE_COLOR : `${CE_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
              <Text style={{ fontSize: 10, color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.ceIv != null ? `IV ${row.ceIv.toFixed(1)}` : ''}
              </Text>
            </Col>
          </Row>
        )
      })}
    </div>
  )
}

const SPEED_OPTIONS = [
  { value: 2000, label: '0.5x' },
  { value: 1000, label: '1x' },
  { value: 500, label: '2x' },
  { value: 250, label: '4x' },
  { value: 100, label: '10x' },
]

// Candle-by-candle replay of one stored trading day - spot chart on the left, an OI/IV ladder
// across the whole fetched strike band on the right, updating together as playback advances. Every
// byte this page ever reads comes from NiftyDataCollector's own TimescaleDB via OiReplayService -
// this page makes NO live Dhan call under any circumstance (unlike Expired Backtest's own
// useStoredData toggle, which only ever prefers stored data and can still fall back to Dhan).
export default function OiReplayPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 5)
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  const [date, setDate] = useState(null)
  const [speedMs, setSpeedMs] = useState(500)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const [visibleCount, setVisibleCount] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timerRef = useRef(null)

  // BANKNIFTY has no weekly expiry - NSE discontinued it (same rule Expired Backtest enforces).
  // Corrected right in the underlying picker's own onChange below, not a separate effect - this
  // is a direct response to that one user action, not a value derived from external state.
  const selectUnderlying = (value) => {
    setUnderlying(value)
    if (value === 'BANKNIFTY' && expiryFlag === 'WEEK') setExpiryFlag('MONTH')
  }

  const canLoad = Boolean(underlying && date)

  const load = () => {
    if (!canLoad) return
    setPlaying(false)
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({
      date: date.format('YYYY-MM-DD'),
      timeframeMinutes: String(timeframe),
      expiryFlag,
    })
    fetch(`/api/oi-replay/${underlying}/run?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => {
        if (!body?.success) throw new Error(body?.error || 'This run did not succeed.')
        setResult(body)
        setVisibleCount(body.spotCandles?.length > 0 ? 1 : 0)
      })
      .catch((err) => {
        console.error('Failed to load OI replay data:', err)
        setResult(null)
        setError(err.message || 'Failed to load this day.')
      })
      .finally(() => setLoading(false))
  }

  const bars = useMemo(() => (result?.spotCandles ?? []).map(toBar), [result])
  const ceByStrike = useMemo(() => groupByStrike(result?.cePoints ?? []), [result])
  const peByStrike = useMemo(() => groupByStrike(result?.pePoints ?? []), [result])

  // Playback loop - a single interval that advances visibleCount by one bar per tick, self-stopping
  // at the end of the day's own bars rather than needing a separate "are we done" effect.
  useEffect(() => {
    if (!playing) return
    timerRef.current = setInterval(() => {
      setVisibleCount((c) => {
        if (c >= bars.length) { setPlaying(false); return c }
        return c + 1
      })
    }, speedMs)
    return () => clearInterval(timerRef.current)
  }, [playing, speedMs, bars.length])

  const currentBar = bars[visibleCount - 1] ?? null
  const asOfMs = currentBar ? currentBar.time * 1000 : null

  const ladderRows = useMemo(() => {
    if (asOfMs == null) return []
    const strikes = new Set([...ceByStrike.keys(), ...peByStrike.keys()])
    const rows = [...strikes].map((strike) => {
      const ce = latestAtOrBefore(ceByStrike.get(strike) ?? [], asOfMs)
      const pe = latestAtOrBefore(peByStrike.get(strike) ?? [], asOfMs)
      return {
        strike,
        ceOi: ce?.openInterest ?? null, ceIv: ce?.impliedVolatility ?? null,
        peOi: pe?.openInterest ?? null, peIv: pe?.impliedVolatility ?? null,
      }
    })
    return rows.sort((a, b) => b.strike - a.strike)
  }, [ceByStrike, peByStrike, asOfMs])

  const step = result?.step || 50
  const atmStrike = currentBar ? Math.round(currentBar.close / step) * step : null

  // PCR (Put-Call Ratio, total PE OI / total CE OI across the whole fetched band) and Max Pain -
  // the two standard derived reads a real OI chain gets used for beyond "where's the wall" (per the
  // user's own "and other things whatever you want to deduce").
  const { pcr, totalCeOi, totalPeOi } = useMemo(() => {
    const totalCe = ladderRows.reduce((s, r) => s + (r.ceOi ?? 0), 0)
    const totalPe = ladderRows.reduce((s, r) => s + (r.peOi ?? 0), 0)
    return { pcr: totalCe > 0 ? totalPe / totalCe : null, totalCeOi: totalCe, totalPeOi: totalPe }
  }, [ladderRows])

  const maxPain = useMemo(() => computeMaxPain(ladderRows), [ladderRows])

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="OI Replay">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Plays a stored trading day back candle by candle, with the nearest-expiry OI/IV ladder across the whole
              strike band alongside it. Reads only from your NiftyDataCollector database - this page never calls Dhan live.
            </Text>
            <Space wrap size={12}>
              <Select value={underlying} onChange={selectUnderlying} style={{ width: 130 }} options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }]} />
              <Select
                value={expiryFlag} onChange={setExpiryFlag} style={{ width: 130 }}
                options={[{ value: 'WEEK', label: 'Weekly', disabled: underlying === 'BANKNIFTY' }, { value: 'MONTH', label: 'Monthly' }]}
              />
              <DatePicker value={date} onChange={setDate} format="DD MMM YYYY" placeholder="Trading day" />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              <Button type="primary" onClick={load} loading={loading} disabled={!canLoad}>Load day</Button>
            </Space>
            {error && <Alert type="error" showIcon message={error} />}
          </Space>
        </Card>

        {result && (
          <>
            <Card size="small">
              <Space align="center" size={16} wrap>
                <Button
                  icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  onClick={() => setPlaying((p) => !p)}
                  disabled={bars.length === 0 || visibleCount >= bars.length}
                >
                  {playing ? 'Pause' : 'Start'}
                </Button>
                <Button icon={<ReloadOutlined />} onClick={() => { setPlaying(false); setVisibleCount(bars.length > 0 ? 1 : 0) }}>Reset</Button>
                <Text type="secondary" style={{ fontSize: 12 }}>Speed</Text>
                <Select value={speedMs} onChange={setSpeedMs} style={{ width: 90 }} options={SPEED_OPTIONS} />
                <div style={{ flex: 1, minWidth: 200 }}>
                  <Slider
                    min={0} max={Math.max(0, bars.length - 1)} value={visibleCount - 1}
                    onChange={(v) => { setPlaying(false); setVisibleCount(v + 1) }}
                    tooltip={{ formatter: (v) => bars[v] ? istTimeFormatter(bars[v].time) : '' }}
                  />
                </div>
                <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {currentBar ? `${istTimeFormatter(currentBar.time)} (${visibleCount}/${bars.length})` : '—'}
                </Text>
              </Space>
            </Card>

            <Card size="small">
              <Row gutter={24}>
                <Col><Statistic title="Spot" value={currentBar?.close ?? '—'} precision={2} /></Col>
                <Col><Statistic title="ATM" value={atmStrike ?? '—'} /></Col>
                <Col><Statistic title="PCR (PE OI / CE OI)" value={pcr != null ? pcr : '—'} precision={2}
                  valueStyle={{ color: pcr == null ? undefined : pcr > 1 ? PE_COLOR : CE_COLOR }} /></Col>
                <Col><Statistic title="Max Pain" value={maxPain ?? '—'} /></Col>
                <Col><Statistic title="Total CE OI" value={totalCeOi} valueStyle={{ color: CE_COLOR }} /></Col>
                <Col><Statistic title="Total PE OI" value={totalPeOi} valueStyle={{ color: PE_COLOR }} /></Col>
              </Row>
            </Card>

            <Row gutter={16}>
              <Col span={15}>
                <Card size="small" title="Spot (replaying)">
                  {bars.length > 0
                    ? <ReplayChart bars={bars} visibleCount={visibleCount} ladderRows={ladderRows} height={460} />
                    : <Empty description="No spot candles for this day." />}
                </Card>
              </Col>
              <Col span={9}>
                <Card size="small" title="OI / IV ladder (nearest expiry, as of the current candle)" bodyStyle={{ maxHeight: 460, overflowY: 'auto' }}>
                  <OiLadder rows={ladderRows} atmStrike={atmStrike} />
                </Card>
              </Col>
            </Row>
          </>
        )}

        {!result && !loading && (
          <Card size="small">
            <Empty description="Pick a stored trading day and click Load day." />
          </Card>
        )}
      </Space>
    </div>
  )
}
