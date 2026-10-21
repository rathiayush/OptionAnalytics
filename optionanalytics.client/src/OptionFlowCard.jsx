import { useEffect, useMemo, useRef } from 'react'
import { Col, Row, Typography } from 'antd'
import { CrosshairMode, LineSeries } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, CE_COLOR, GRID_COLOR, PE_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime } from './shared.jsx'
import { formatOiMillions, useFitContentAsDataGrows } from './oiShared.jsx'
import { optionFlowSeries } from './optionFlow.js'

const { Text } = Typography

const toLine = (series) => series.map((p) => ({ time: toChartTime(p.time), value: p.value }))

// One CE-vs-PE line chart (CDV or OBV), the dashboard's own two-line shape.
function FlowChart({ ce, pe, dayKey, height }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const ceRef = useRef(null)
  const peRef = useRef(null)

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
      localization: { timeFormatter: istTimeFormatter, priceFormatter: (v) => formatOiMillions(v, { signed: true }) },
    })
    chartRef.current = chart
    ceRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, title: 'CE', priceLineVisible: false })
    peRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, title: 'PE', priceLineVisible: false })
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      ceRef.current = null
      peRef.current = null
    }
  }, [height])

  useEffect(() => {
    ceRef.current?.setData(ce)
    peRef.current?.setData(pe)
  }, [ce, pe])
  useFitContentAsDataGrows(chartRef, Math.max(ce.length, pe.length), dayKey)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

/**
 * The day's option CDV and OBV, CE against PE, as the dashboard shows them for today - worked out from the replayed
 * day's own 1-minute option bars (optionFlow.js: the dashboard's formulas) and drawn only up to the replay clock
 * (`endTime`, chart time; null - live - draws it all), so nothing later in the day shows early. Live, `dashboardFlow`
 * (the dashboard's own tick-by-tick series - dashboardFlow.js) is shown instead when the dashboard has it.
 */
export function OptionFlowCard({ cePoints, pePoints, spotBars, endTime, dayKey, dashboardFlow = null, sourceNote = null, height = 260 }) {
  // Live, the dashboard's own tick-by-tick numbers when it has them (dashboardFlow.js); else worked out from the bars.
  const ownFlow = useMemo(() => (dashboardFlow ? null : optionFlowSeries(cePoints, pePoints, spotBars)), [dashboardFlow, cePoints, pePoints, spotBars])
  const flow = dashboardFlow ?? ownFlow
  const lines = useMemo(() => {
    const cut = (series) => (endTime == null ? toLine(series) : toLine(series).filter((p) => p.time <= endTime))
    return { ceCdv: cut(flow.ceCdv), peCdv: cut(flow.peCdv), ceObv: cut(flow.ceObv), peObv: cut(flow.peObv) }
  }, [flow, endTime])
  const last = (series) => series.at(-1)?.value
  const hasVolume = flow.ceCdv.some((p) => p.value !== 0) || flow.peCdv.some((p) => p.value !== 0)

  if (!hasVolume) return <Text type="secondary">No option volume for this day - CDV and OBV need each strike&apos;s traded volume.</Text>
  return (
    <>
    {sourceNote && <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>{sourceNote}</Text>}
    <Row gutter={[16, 12]}>
      <Col xs={24} lg={12}>
        <Text strong style={{ fontSize: 12 }}>CDV (cumulative delta volume) </Text>
        <Text style={{ fontSize: 12, color: CE_COLOR }}>CE {formatOiMillions(last(lines.ceCdv) ?? 0, { signed: true })}</Text>
        <Text style={{ fontSize: 12 }}> · </Text>
        <Text style={{ fontSize: 12, color: PE_COLOR }}>PE {formatOiMillions(last(lines.peCdv) ?? 0, { signed: true })}</Text>
        <FlowChart ce={lines.ceCdv} pe={lines.peCdv} dayKey={`cdv-${dayKey}`} height={height} />
      </Col>
      <Col xs={24} lg={12}>
        <Text strong style={{ fontSize: 12 }}>OBV (delta-weighted, EMA 9) </Text>
        <Text style={{ fontSize: 12, color: CE_COLOR }}>CE {formatOiMillions(last(lines.ceObv) ?? 0, { signed: true })}</Text>
        <Text style={{ fontSize: 12 }}> · </Text>
        <Text style={{ fontSize: 12, color: PE_COLOR }}>PE {formatOiMillions(last(lines.peObv) ?? 0, { signed: true })}</Text>
        <FlowChart ce={lines.ceObv} pe={lines.peObv} dayKey={`obv-${dayKey}`} height={height} />
      </Col>
    </Row>
    </>
  )
}
