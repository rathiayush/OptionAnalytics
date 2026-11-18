import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, Empty, Row, Segmented, Select, Space, Tag, Tooltip, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import {
  AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, NavBar, POLL_HEADERS, UP_COLOR, asList, istTickMarkFormatter, istTimeFormatter,
  toChartTime, usePersistedState,
} from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { FoldText } from './FoldText.jsx'
import { useViewport } from './useScreen.js'
import { STRUCTURE_DEFAULTS, activeLevels, analyzeStructure, topDownRead } from './marketStructure.js'
import { DEFAULT_DENSITY, DEFAULT_LAYERS, DENSITY, HISTORY_CHOICES, STRUCTURE_COLORS, STRUCTURE_LAYERS, StructurePrimitive, TIMEFRAMES, ltfLayers, lowerThan, structureShapes } from './structureShapes.js'

const { Title, Text } = Typography

// The SPOT STRUCTURE page: an index's spot candles on a HIGHER and a LOWER timeframe, each read by marketStructure.js -
// swings, internal / external BOS and CHoCH, liquidity, order blocks, fair value gaps, premium / discount, S/R zones,
// trendlines and chart patterns - with the higher timeframe's levels laid on the lower one and the top-down read of the
// two. The candles: GET /api/structure/{u}/candles (past days from the server's disk cache, today from the spot feed).
// It describes the chart - nothing is placed, no alert or strategy is fed.

const TF_NAME = Object.fromEntries(TIMEFRAMES.map((t) => [t.value, t.label]))
const INDICES = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const SWING_CHOICES = [5, 10, 20, 30, 50]
const INTERNAL_CHOICES = [2, 3, 5]

const IST_DATE_TIME = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const IST_DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' })
const when = (bar, tf) => (bar ? (tf >= 1440 ? IST_DATE : IST_DATE_TIME).format(new Date(bar.time)) : '')
const fmt = (v) => (v == null ? '—' : Math.round(v * 100) / 100)

// The candles of one index and timeframe: loaded on a change, then again every minute while today is in them (a page
// timer with POLL_HEADERS - the server's memory for today, the past from its disk); a failed load waits longer each time.
function useStructureCandles(index, tf, days) {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    let timer = null
    let wait = 60_000
    const load = (poll) => {
      if (!poll) setState((s) => ({ ...s, loading: true }))
      fetch(`/api/structure/${index}/candles?tf=${tf}&days=${days}`, poll ? { headers: POLL_HEADERS } : undefined)
        .then((r) => r.json().then((body) => (r.ok ? body : Promise.reject(new Error(body?.error ?? `HTTP ${r.status}`)))))
        .then((body) => {
          if (!alive) return
          const candles = asList(body.candles).map((c) => ({ time: new Date(c.time).getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
          setState({ loading: false, data: { ...body, candles }, error: candles.length ? null : body.error ?? 'No candles' })
          wait = 60_000
          if (body.todayIncluded) timer = setTimeout(() => load(true), wait)
        })
        .catch((e) => {
          if (!alive) return
          setState((s) => ({ loading: false, data: s.data, error: e.message }))
          wait = Math.min(30 * 60_000, wait * 2)
          if (poll) timer = setTimeout(() => load(true), wait)
        })
    }
    load(false)
    return () => { alive = false; clearTimeout(timer) }
  }, [index, tf, days, nonce])
  return { ...state, reload: () => setNonce((n) => n + 1) }
}

function StructureChart({ analysis, shapes, height }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const primitiveRef = useRef(null)
  const fittedRef = useRef(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const chart = createZoomableChart(element, {
      width: element.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, shiftVisibleRangeOnNewBar: false, rightOffset: 8 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
      handleScroll: { vertTouchDrag: false },
    })
    const series = chart.addSeries(CandlestickSeries, { upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR })
    const primitive = new StructurePrimitive()
    series.attachPrimitive(primitive)
    chartRef.current = chart
    seriesRef.current = series
    primitiveRef.current = primitive
    const resize = new ResizeObserver(() => chart.applyOptions({ width: element.clientWidth }))
    resize.observe(element)
    return () => { resize.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; primitiveRef.current = null; fittedRef.current = null }
  }, [height])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    const bars = analysis?.bars ?? []
    series.setData(bars.map((b) => ({ time: toChartTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })))
    // The newest ~160 candles on the first load of a series; a refresh keeps the viewer's view.
    const key = `${bars[0]?.time ?? ''}|${analysis?.options?.swingLen ?? ''}`
    if (bars.length && fittedRef.current !== key) {
      fittedRef.current = key
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(-1, bars.length - 160), to: bars.length + 8 })
    }
  }, [analysis])

  useEffect(() => { primitiveRef.current?.setShapes(shapes) }, [shapes])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

const sideColor = (side) => (side === 'bullish' ? UP_COLOR : side === 'bearish' ? DOWN_COLOR : AXIS_COLOR)

function TrendTag({ name, trend }) {
  return (
    <Tag color={trend === 'bullish' ? 'green' : trend === 'bearish' ? 'red' : 'default'} style={{ marginInlineEnd: 4 }}>
      {name}: {trend === 'bullish' ? '▲ bullish' : trend === 'bearish' ? '▼ bearish' : 'undecided'}
    </Tag>
  )
}

// What a timeframe's analysis says, in words - under its chart.
function StructureSummary({ a, tf }) {
  if (!a?.n) return null
  const act = activeLevels(a)
  const bar = (i) => a.bars[i]
  const recent = a.events.slice(-6).reverse()
  const lineNow = (t) => t.a.price + ((t.b.price - t.a.price) / (t.b.index - t.a.index)) * (a.n - 1 - t.a.index)
  const row = (label, content) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: '18px' }}>
      <Text type="secondary" style={{ fontSize: 12, minWidth: 104, flex: 'none' }}>{label}</Text>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{content}</span>
    </div>
  )
  return (
    <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 8 }}>
      <div>
        <TrendTag name="External" trend={a.bias.swing} />
        <TrendTag name="Internal" trend={a.bias.internal} />
        {a.range && <Tag color={a.range.zone === 'premium' ? 'volcano' : a.range.zone === 'discount' ? 'cyan' : 'default'}>{a.range.zone} · {Math.round(a.range.pos * 100)}% of the range</Tag>}
      </div>
      {row('Last breaks', recent.length ? recent.map((e, k) => (
        <span key={k}>
          <span style={{ whiteSpace: 'nowrap' }}>
            <span style={{ color: sideColor(e.dir), fontWeight: e.scope === 'swing' ? 700 : 500 }}>{e.scope === 'internal' ? 'i-' : ''}{e.kind} {e.dir === 'bullish' ? '▲' : '▼'}</span>
            {` ${fmt(e.level)} · ${when(bar(e.index), tf)}`}
          </span>
          {k < recent.length - 1 ? ' · ' : ''}
        </span>
      )) : 'none yet')}
      {a.range && row('Dealing range', `${fmt(a.range.bottom)} – ${fmt(a.range.top)} · equilibrium ${fmt(a.range.eq)} · price ${fmt(a.price)}`)}
      {a.strongWeak && row('Strong / weak', `strong ${a.strongWeak.strong.type} ${fmt(a.strongWeak.strong.price)} (must hold) · weak ${a.strongWeak.weak.type} ${fmt(a.strongWeak.weak.price)} (target)`)}
      {row('Support', act.support.length ? act.support.map((z) => `${fmt(z.low)}–${fmt(z.high)} (${z.touches} touches)`).join(' · ') : 'none below')}
      {row('Resistance', act.resistance.length ? act.resistance.map((z) => `${fmt(z.low)}–${fmt(z.high)} (${z.touches} touches)`).join(' · ') : 'none above')}
      {row('Trendlines', a.trendlines.length ? a.trendlines.map((t) => `${t.kind} ${t.brokenAt != null ? `broken ${when(bar(t.brokenAt), tf)}` : `at ${fmt(lineNow(t))} now`} (${t.touches} touches)`).join(' · ') : 'none')}
      {row('Patterns', a.patterns.length ? a.patterns.slice(0, 4).map((p, k) => (
        <span key={k} style={{ marginInlineEnd: 10 }}>
          <span style={{ color: sideColor(p.side), fontWeight: 600 }}>{p.name}</span>
          {` ${p.status}${p.at != null ? ` ${when(bar(p.at), tf)}` : ''}${p.target != null && p.status === 'confirmed' ? ` · target ${fmt(p.target)}` : ''}`}
        </span>
      )) : 'none on these candles')}
      {row('Order blocks', act.orderBlocks.length ? act.orderBlocks.map((b) => `${b.scope === 'internal' ? 'i-' : ''}${b.dir === 'bullish' ? 'bull' : 'bear'} ${fmt(b.bottom)}–${fmt(b.top)}`).join(' · ') : 'none unmitigated')}
      {row('Fair value gaps', act.fvgs.length ? act.fvgs.map((g) => `${g.dir === 'bullish' ? 'bull' : 'bear'} ${fmt(g.bottom)}–${fmt(g.top)}`).join(' · ') : 'none open')}
      {row('Liquidity', [
        ...act.equal.map((q) => `${q.type} ${fmt(q.level)}`),
        ...a.sweeps.slice(-3).map((s) => `${s.dir === 'bullish' ? 'low' : 'high'} ${fmt(s.level)} swept ${when(bar(s.index), tf)}`),
      ].join(' · ') || 'no equal highs / lows open')}
    </Space>
  )
}

// Where a chart's past days came from - every timeframe is built from the spot's 1-minute days: already in the server's
// memory, read from its disk cache (the days OI Replay and the backtests keep), or asked of Dhan (the first time only).
function SourceLine({ data }) {
  const held = data.daysHeld ?? 0
  const disk = data.daysFromDisk ?? 0
  const dhan = data.daysAskedOfDhan ?? 0
  if (!held && !disk && !dhan) return null
  const parts = [held && `${held} in memory`, disk && `${disk} from the server's disk`, dhan && `${dhan} asked of Dhan (kept on disk now)`].filter(Boolean)
  return (
    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
      {`Built from 1-minute spot candles - past days: ${parts.join(' · ')}${data.todayIncluded ? ' · today from the live feed' : ''}`}
    </Text>
  )
}

export default function SpotStructurePage() {
  const { width } = useViewport()
  const narrow = width <= 768
  const [index, setIndex] = usePersistedState('optionanalytics.structure.index', 'NIFTY')
  const [htfPicked, setHtf] = usePersistedState('optionanalytics.structure.htf', 60)
  const htf = HISTORY_CHOICES[htfPicked] && htfPicked !== 1 ? htfPicked : 60
  const [ltfPicked, setLtf] = usePersistedState('optionanalytics.structure.ltf', 5)
  const ltf = lowerThan(htf, HISTORY_CHOICES[ltfPicked] ? ltfPicked : 5)
  const [htfDaysPicked, setHtfDays] = usePersistedState('optionanalytics.structure.htfDays', {})
  const [ltfDaysPicked, setLtfDays] = usePersistedState('optionanalytics.structure.ltfDays', {})
  const htfDays = htfDaysPicked?.[htf] ?? HISTORY_CHOICES[htf][0]
  const ltfDays = ltfDaysPicked?.[ltf] ?? HISTORY_CHOICES[ltf][0]
  const [swingLen, setSwingLen] = usePersistedState('optionanalytics.structure.swingLen', STRUCTURE_DEFAULTS.swingLen)
  const [internalLen, setInternalLen] = usePersistedState('optionanalytics.structure.internalLen', STRUCTURE_DEFAULTS.internalLen)
  const [layers, setLayers] = usePersistedState('optionanalytics.structure.layers', DEFAULT_LAYERS)
  // On a phone the twelve layer ticks fold behind one button (they took a whole screen).
  const [layersOpen, setLayersOpen] = usePersistedState('optionanalytics.structure.layersOpen', false)
  // How much is drawn - Clean / Normal / Everything (DENSITY): every marking at once was unreadable.
  const [densityPicked, setDensity] = usePersistedState('optionanalytics.structure.density', DEFAULT_DENSITY)
  const density = DENSITY[densityPicked] ? densityPicked : DEFAULT_DENSITY
  // The lower chart's OWN markings - off, it shows the higher timeframe's levels over its candles and nothing else.
  const [ltfOwn, setLtfOwn] = usePersistedState('optionanalytics.structure.ltfOwn', true)

  const high = useStructureCandles(index, htf, htfDays)
  const low = useStructureCandles(index, ltf, ltfDays)
  const opts = useMemo(() => ({ swingLen, internalLen, trendLen: Math.max(3, Math.round((swingLen + internalLen) / 3)) }), [swingLen, internalLen])
  const ha = useMemo(() => analyzeStructure(high.data?.candles ?? [], opts), [high.data, opts])
  const la = useMemo(() => analyzeStructure(low.data?.candles ?? [], opts), [low.data, opts])
  const read = useMemo(() => topDownRead(ha, la, { htf: TF_NAME[htf], ltf: TF_NAME[ltf] }), [ha, la, htf, ltf])
  const layerSet = useMemo(() => new Set(asList(layers)), [layers])
  const htfShapes = useMemo(() => structureShapes(ha, [...layerSet].filter((k) => k !== 'htf'), { density }), [ha, layerSet, density])
  const ltfShapes = useMemo(() => structureShapes(la, ltfLayers(layerSet, ltfOwn), { htf: ha, density }), [la, layerSet, ltfOwn, ha, density])
  const chartHeight = narrow ? 420 : Math.min(620, Math.max(420, Math.round(window.innerHeight * 0.6)))

  const card = (title, tf, data, a, shapes, days, setDays, daysPicked, extra = null) => (
    <Card
      size="small"
      title={<span>{title} · {TF_NAME[tf]}{data.data?.todayIncluded ? <Tag color="green" style={{ marginInlineStart: 8 }}>live</Tag> : null}</span>}
      extra={(
        <Space size={6}>
          {extra}
          <Select size="small" value={days} onChange={(v) => setDays({ ...(daysPicked ?? {}), [tf]: v })} style={{ width: 104 }} aria-label={`${title} history`}
            options={HISTORY_CHOICES[tf].map((d) => ({ value: d, label: `${d} days` }))} />
          <Button size="small" icon={<ReloadOutlined />} onClick={data.reload} loading={data.loading} aria-label={`Reload ${title}`} />
        </Space>
      )}
    >
      {data.error && <Alert type={a.n ? 'warning' : 'error'} showIcon style={{ marginBottom: 8 }} message={a.n ? `Partly loaded - ${data.error}` : `Could not load the candles - ${data.error}`} />}
      {a.n ? <StructureChart analysis={a} shapes={shapes} height={chartHeight} /> : <Empty description={data.loading ? 'Loading candles…' : 'No candles'} style={{ padding: 40 }} />}
      {a.n && shapes.length === 0 && <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>Nothing drawn - every layer is off for this chart.</Text>}
      {data.data && <SourceLine data={data.data} />}
      <StructureSummary a={a} tf={tf} />
    </Card>
  )

  return (
    <div style={{ maxWidth: 2600, margin: '0 auto', padding: narrow ? '16px 8px 120px' : '24px 16px 120px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Spot structure - market structure on a higher and a lower timeframe">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={[12, 8]}>
              <Segmented value={index} onChange={setIndex} options={INDICES} />
              <Space size={4}><Text style={{ fontSize: 12 }}>Higher TF</Text>
                <Select value={htf} onChange={setHtf} style={{ width: 86 }} aria-label="Higher timeframe" options={TIMEFRAMES.filter((t) => t.value > 1)} />
              </Space>
              <Space size={4}><Text style={{ fontSize: 12 }}>Lower TF</Text>
                <Select value={ltf} onChange={setLtf} style={{ width: 86 }} aria-label="Lower timeframe" options={TIMEFRAMES.filter((t) => t.value < htf)} />
              </Space>
              <Space size={4}><Text style={{ fontSize: 12 }}>Swing length</Text>
                <Select value={swingLen} onChange={setSwingLen} style={{ width: 70 }} aria-label="Swing length" options={SWING_CHOICES.map((v) => ({ value: v, label: v }))} />
              </Space>
              <Space size={4}><Text style={{ fontSize: 12 }}>Internal</Text>
                <Select value={internalLen} onChange={setInternalLen} style={{ width: 64 }} aria-label="Internal length" options={INTERNAL_CHOICES.map((v) => ({ value: v, label: v }))} />
              </Space>
              <Space size={4}><Text style={{ fontSize: 12 }}>Detail</Text>
                <Segmented value={density} onChange={setDensity} aria-label="Detail"
                  options={Object.entries(DENSITY).map(([key, v]) => ({ value: key, label: v.label }))} />
              </Space>
            </Space>
            {narrow && (
              <Button size="small" onClick={() => setLayersOpen(!layersOpen)} aria-expanded={layersOpen}>
                {`Layers (${asList(layers).length} of ${STRUCTURE_LAYERS.length}) ${layersOpen ? '▴' : '▾'}`}
              </Button>
            )}
            {(!narrow || layersOpen) && (
              <Checkbox.Group value={asList(layers)} onChange={setLayers} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}
                options={STRUCTURE_LAYERS.map((l) => ({ value: l.key, label: <Text style={{ fontSize: 12 }}>{l.label}</Text> }))} />
            )}
            <FoldText id="structure.intro" className="oa-note" style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}
              summary="How it reads the chart: swings, BOS / CHoCH, liquidity, order blocks, gaps, zones, trendlines, patterns.">
              {'SWINGS: a pivot high / low is higher / lower than the "length" candles each side, and is only known once those on its right have printed - nothing is read from later candles. '}
              {'STRUCTURE is read twice - EXTERNAL (the swing length, the trend) and INTERNAL (the short length, the moves inside it): a candle CLOSING past the last unbroken pivot is a break - with the trend a BOS (break of structure), against it a CHoCH (change of character, the first sign of a turn). '}
              {'LIQUIDITY: a wick past the swing high / low that closes back inside = a SWEEP (stops taken, rejected); EQH / EQL = two highs / lows level within a tenth of an ATR - resting stops, a magnet. '}
              {'ORDER BLOCK = the candle a break started from (the lowest before a bullish break, the highest before a bearish one), spent once a candle closes through it; FAIR VALUE GAP = three candles whose first and third do not overlap, filled when price trades back across. '}
              {'STRONG / WEAK: after a bullish break the low it started from must hold (strong), the high is the target (weak) - the mirror after a bearish one. PREMIUM / DISCOUNT: the dealing range between the last swing high and low - buy in the discount (bottom half), sell in the premium. '}
              {'S/R ZONES: where price turned at least twice (pivots within half an ATR). TRENDLINES: rising lows / falling highs no close crossed between them - the one with the most touches. PATTERNS on the swings: double top / bottom, head & shoulders, triangles, wedges, channels - ✓ confirmed by a close through the neckline / boundary, ✗ failed, … still forming. '}
              {'TOP-DOWN: trade the higher timeframe\'s trend, time the entry on the lower one - a lower-TF CHoCH back in the higher trend\'s direction, from its discount (longs) / premium (shorts).'}
            </FoldText>
          </Space>
        </Card>

        <Card size="small" title="Top-down read">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Text strong style={{ fontSize: 15, color: sideColor(read.side) }}>{read.verdict}</Text>
            {read.lines.map((l, k) => <Text key={k} style={{ fontSize: 12 }}>{l}</Text>)}
            <Text type="secondary" style={{ fontSize: 11 }}>
              {`On the ${TF_NAME[ltf]} chart the ${TF_NAME[htf]}'s S/R, swing order blocks and dealing range are drawn in light blue (HTF). "Detail" sets how much is drawn; where two labels would overlap only the more important one is kept, so the rest of the reading is in the lines under each chart. A read of the chart - not a signal.`}
            </Text>
          </Space>
        </Card>

        <Row gutter={[14, 14]}>
          <Col xs={24} xl={12}>{card('Higher timeframe', htf, high, ha, htfShapes, htfDays, setHtfDays, htfDaysPicked)}</Col>
          <Col xs={24} xl={12}>
            {card('Lower timeframe', ltf, low, la, ltfShapes, ltfDays, setLtfDays, ltfDaysPicked, (
              <Tooltip title={`Off: only the ${TF_NAME[htf]}'s levels are drawn over the ${TF_NAME[ltf]} candles - its own structure, zones, blocks and patterns are hidden. The reading under the chart stays either way.`}>
                <Checkbox checked={ltfOwn} onChange={(e) => setLtfOwn(e.target.checked)}>
                  <Text style={{ fontSize: 12 }}>{narrow ? 'Own' : 'Its own structure'}</Text>
                </Checkbox>
              </Tooltip>
            ))}
          </Col>
        </Row>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {'Colours: '}<span style={{ color: STRUCTURE_COLORS.bull }}>bullish</span>{' / '}<span style={{ color: STRUCTURE_COLORS.bear }}>bearish</span>
          {' breaks (solid = external, dashed = internal) · '}<span style={{ color: STRUCTURE_COLORS.supportLine }}>support</span>{' / '}
          <span style={{ color: STRUCTURE_COLORS.resistanceLine }}>resistance</span>{' zones · '}<span style={{ color: STRUCTURE_COLORS.trend }}>trendlines</span>
          {' · '}<span style={{ color: STRUCTURE_COLORS.pattern }}>patterns</span>{' · '}<span style={{ color: STRUCTURE_COLORS.htf }}>higher TF levels</span>
        </Text>
      </Space>
    </div>
  )
}
