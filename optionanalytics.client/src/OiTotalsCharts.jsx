import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, Modal, Space, Tooltip, Typography } from 'antd'
import { CrosshairMode, HistogramSeries, LineSeries, LineStyle, createSeriesMarkers } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, GRID_COLOR, istTickMarkFormatter, istTimeFormatter, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { sanitizeLine } from './chartLine.js'
import { oiTotalsSeries } from './oiTotalsHeatmap.js'
import { lineLevels } from './lineLevels.js'

const { Text } = Typography

// What the cumulative line going UP or DOWN means, per side (oiMeaning).
const SIDES = [
  { key: 'ce', label: 'CE', up: 'call writing - bearish', down: 'calls unwinding - bullish' },
  { key: 'pe', label: 'PE', up: 'put writing - bullish', down: 'puts unwinding - bearish' },
  { key: 'net', label: 'Net (CE − PE)', up: 'call writers gaining - bearish', down: 'put writers gaining - bullish' },
]
const RESISTANCE_COLOR = '#ffa940'
const SUPPORT_COLOR = '#69b1ff'
const NEUTRAL_COLOR = '#d9d9d9'

// One side's totals: the cumulative Δ as a line (each point coloured by who is ahead) and each bucket's Δ as bars
// (coloured by what that bucket did) in a pane under it - the totals table's own colours. `levels` (lineLevels) are
// drawn on the line: R / S, ×n = how many swings held there, an arrow where the line broke through one.
function TotalsChart({ cum, delta, levels, dayKey, height, format, bullish, bearish }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const lineRef = useRef(null)
  const barsRef = useRef(null)
  const markersRef = useRef(null)
  const formatRef = useRef(format)
  useEffect(() => { formatRef.current = format })
  const colour = (meaning, alpha = '') => (meaning > 0 ? bullish : meaning < 0 ? bearish : NEUTRAL_COLOR) + alpha

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
      localization: { timeFormatter: istTimeFormatter, priceFormatter: (v) => formatRef.current(v) },
    })
    chartRef.current = chart
    lineRef.current = chart.addSeries(LineSeries, { color: NEUTRAL_COLOR, lineWidth: 2, title: 'cumulative Δ', priceLineVisible: false })
    barsRef.current = chart.addSeries(HistogramSeries, { title: 'Δ', priceLineVisible: false, lastValueVisible: false }, 1)
    const [linePane, barsPane] = chart.panes()
    linePane?.setStretchFactor(3)
    barsPane?.setStretchFactor(1)
    markersRef.current = createSeriesMarkers(lineRef.current, [])
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      lineRef.current = null
      barsRef.current = null
      markersRef.current = null
    }
  }, [height])

  useEffect(() => {
    lineRef.current?.setData(sanitizeLine(cum.map((p) => ({ time: p.time, value: p.value, color: colour(p.meaning) }))))
    barsRef.current?.setData(sanitizeLine(delta.map((p) => ({ time: p.time, value: p.value, color: colour(p.meaning, 'cc') }))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cum, delta, bullish, bearish, height])
  useFitContentAsDataGrows(chartRef, cum.length, dayKey)

  // The levels and their breaks - redrawn when they change (or the chart was rebuilt).
  useEffect(() => {
    const series = lineRef.current
    if (!series) return undefined
    const drawn = (levels ?? []).map((level) => series.createPriceLine({
      price: level.value, color: level.role === 'resistance' ? RESISTANCE_COLOR : SUPPORT_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: `${level.role === 'resistance' ? 'R' : 'S'}${level.touches > 1 ? ` ×${level.touches}` : ''}`,
    }))
    markersRef.current?.setMarkers((levels ?? [])
      .filter((level) => level.brokenAt != null)
      .sort((a, b) => a.brokenAt - b.brokenAt)
      .map((level) => ({
        time: level.brokenAt, position: level.brokeUp ? 'belowBar' : 'aboveBar', shape: level.brokeUp ? 'arrowUp' : 'arrowDown',
        color: level.brokeUp ? SUPPORT_COLOR : RESISTANCE_COLOR, text: level.brokeUp ? 'broke R' : 'broke S',
      })))
    return () => {
      // The chart may already be gone (rebuilt or closed) - then its lines went with it.
      if (lineRef.current !== series) return
      for (const line of drawn) series.removePriceLine(line)
      markersRef.current?.setMarkers([])
    }
  }, [levels, height])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// One side's levels in words: where the cumulative is, the nearest resistance above and support below, and the
// latest break with what it means.
function LevelsText({ side, read, format }) {
  if (read.now == null) return null
  const level = (l) => `${format(l.value)}${l.touches > 1 ? ` (${l.touches} swings)` : ''}`
  const lastBreak = read.levels.filter((l) => l.brokenAt != null).sort((a, b) => b.brokenAt - a.brokenAt)[0]
  return (
    <Text style={{ fontSize: 12, display: 'block' }}>
      <span style={{ color: RESISTANCE_COLOR }}>resistance {read.resistance ? level(read.resistance) : 'none above'}</span>
      {' · '}
      <span style={{ color: SUPPORT_COLOR }}>support {read.support ? level(read.support) : 'none below'}</span>
      {lastBreak && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {' · '}broke {lastBreak.brokeUp ? 'above' : 'below'} {format(lastBreak.value)} at {istTimeFormatter(lastBreak.brokenAt)} ({lastBreak.brokeUp ? side.up : side.down})
        </Text>
      )}
    </Text>
  )
}

/**
 * The OI totals (OiReplayPage's "Totals: CE, PE and Net" table) as charts for the whole day so far, in a popup: per
 * side, the cumulative Δ line with each bucket's Δ under it. `totals` is the table's own buildOiTotalsRows result, so a
 * replay stops at its clock. "Support / resistance" (remembered) marks each cumulative line's levels automatically
 * (lineLevels.js). `format` / `bullish` / `bearish`: the table's number format and colours.
 */
export function OiTotalsChartsModal({ open, onClose, totals, dayKey, format, bullish, bearish, extra = null }) {
  const [showLevels, setShowLevels] = usePersistedState('optionanalytics.oiReplay.totalsLevels', true)
  const [height, setHeight] = useState(260)
  useEffect(() => {
    if (!open) return undefined
    const fit = () => setHeight(Math.max(220, Math.round((window.innerHeight - 200) / SIDES.length) - 56))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [open])
  const series = useMemo(() => (totals ? oiTotalsSeries(totals) : null), [totals])
  const reads = useMemo(() => {
    if (!series || !showLevels) return null
    return Object.fromEntries(SIDES.map((side) => [side.key, lineLevels(series[side.key].cum)]))
  }, [series, showLevels])

  return (
    <Modal
      open={open} onCancel={onClose} footer={null} destroyOnHidden width="96vw" style={{ top: 12, maxWidth: 1800 }}
      title={(
        <Space size={16} wrap>
          <span>OI totals - CE, PE and Net: Δ and cumulative Δ</span>
          {extra}
          <Tooltip title="Marks where each cumulative line turned back: swing highs it fell away from and swing lows it rose from, grouped into levels. R = resistance above the line now, S = support below, ×n = how many swings held there; an arrow = the line broke through one (a broken resistance is support now). Only what is drawn is used - a replay up to its clock.">
            <Checkbox checked={showLevels} onChange={(e) => setShowLevels(e.target.checked)}>Support / resistance</Checkbox>
          </Tooltip>
        </Space>
      )}
    >
      {!series || series.ce.cum.length === 0
        ? <Text type="secondary">No OI data yet.</Text>
        : SIDES.map((side, i) => {
          const s = series[side.key]
          const now = s.cum.at(-1)
          return (
            <div key={side.key} style={{ marginBottom: i < SIDES.length - 1 ? 14 : 0 }}>
              <Text strong style={{ fontSize: 13 }}>{side.label} </Text>
              <Text style={{ fontSize: 12, color: now?.meaning > 0 ? bullish : now?.meaning < 0 ? bearish : AXIS_COLOR }}>cumulative Δ {format(now?.value)}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}> · last Δ {format(s.delta.at(-1)?.value)} · line = cumulative Δ, bars = Δ per bucket</Text>
              <TotalsChart
                cum={s.cum} delta={s.delta} levels={reads?.[side.key]?.levels ?? null} dayKey={`${dayKey}-${side.key}`}
                height={height} format={format} bullish={bullish} bearish={bearish}
              />
              {reads && <LevelsText side={side} read={reads[side.key]} format={format} />}
            </div>
          )
        })}
    </Modal>
  )
}
