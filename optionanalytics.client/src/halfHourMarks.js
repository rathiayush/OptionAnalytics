// IST checkpoints on every lightweight chart (createZoomableChart attaches this to each pane): a faint vertical line with an
// "HH:MM" label at each :00 and :30 in view - so a time can be read off any OI Replay / Order Flow / External chart without
// hovering. Chart times are IST-shifted seconds (toChartTime), so reading them as UTC gives IST.
//
// The line sits on the first bar at or after each half hour (a bar exists there on a 1 / 3 / 5 / 15-minute chart; a gap -
// no trading - puts it on the next bar). When half hours would be closer than MIN_GAP_PX, only whole hours are marked (then
// every 2, 3 ... hours), so a zoomed-out or multi-day chart does not fill with lines.

const HALF_HOUR = 1800
const MIN_GAP_PX = 44
const LABEL = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })

/** "09:30" for a chart time (IST-shifted seconds). */
export const checkpointLabel = (time) => LABEL.format(new Date(time * 1000))

/**
 * The checkpoints among `times` (ascending chart times): the first time in each `stepSeconds` period (1800 = every half hour,
 * 3600 = every hour ...), periods aligned to the clock (09:00, 09:30 ...). The very first time is not one unless it falls
 * exactly on a boundary (the left edge is not a checkpoint).
 */
export function checkpoints(times, stepSeconds = HALF_HOUR) {
  const out = []
  let previous = null
  for (const t of times) {
    if (!Number.isFinite(t)) continue
    const period = Math.floor(t / stepSeconds)
    if (previous === null ? t % stepSeconds === 0 : period !== previous) out.push({ time: t, label: checkpointLabel(Math.floor(t / stepSeconds) * stepSeconds) })
    previous = period
  }
  return out
}

/** The smallest step (half hour, hour, 2 h, 3 h, 6 h, 12 h, a day) whose checkpoints are at least `minGapPx` apart, given the
 *  pixels one second takes on the chart. */
export function checkpointStep(pxPerSecond, minGapPx = MIN_GAP_PX) {
  for (const step of [1800, 3600, 7200, 10800, 21600, 43200, 86400]) if (step * pxPerSecond >= minGapPx) return step
  return 86400
}

export class HalfHourMarksPrimitive {
  constructor() {
    this._chart = null
    this._series = null
    const self = this
    this._view = { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => self._draw(target) }) }
  }

  attached({ chart, series }) {
    this._chart = chart
    this._series = series
  }

  detached() {
    this._chart = null
    this._series = null
  }

  updateAllViews() {}

  paneViews() {
    return [this._view]
  }

  _draw(target) {
    const chart = this._chart
    const series = this._series
    if (!chart || !series) return
    let data
    try { data = series.data() } catch { return }
    if (!data?.length) return
    const timeScale = chart.timeScale()
    const range = timeScale.getVisibleLogicalRange()
    if (!range) return
    const from = Math.max(0, Math.floor(range.from))
    const to = Math.min(data.length - 1, Math.ceil(range.to))
    if (to - from < 1) return
    const times = []
    for (let i = from; i <= to; i++) if (typeof data[i]?.time === 'number') times.push(data[i].time)
    if (times.length < 2) return
    const x0 = timeScale.timeToCoordinate(times[0])
    const x1 = timeScale.timeToCoordinate(times[times.length - 1])
    if (x0 == null || x1 == null || times[times.length - 1] === times[0]) return
    const step = checkpointStep(Math.abs(x1 - x0) / (times[times.length - 1] - times[0]))
    const marks = checkpoints(times, step)
    if (!marks.length) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      ctx.save()
      ctx.font = `${Math.round(10 * vpr)}px system-ui, -apple-system, sans-serif`
      ctx.textBaseline = 'bottom'
      for (const mark of marks) {
        const x = timeScale.timeToCoordinate(mark.time)
        if (x == null) continue
        const px = Math.round(x * hpr) + 0.5
        const onHour = mark.label.endsWith(':00')
        ctx.strokeStyle = onHour ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.13)'
        ctx.lineWidth = Math.max(1, Math.round(hpr))
        ctx.setLineDash([Math.round(3 * hpr), Math.round(4 * hpr)])
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, bitmapSize.height)
        ctx.stroke()
        ctx.setLineDash([])
        const text = `${mark.label} IST`
        const w = ctx.measureText(text).width + 6 * hpr
        const h = 14 * vpr
        const left = Math.min(Math.max(0, px - w / 2), bitmapSize.width - w)
        ctx.fillStyle = 'rgba(22,26,34,0.85)'
        ctx.fillRect(left, bitmapSize.height - h - 2 * vpr, w, h)
        ctx.fillStyle = onHour ? 'rgba(230,230,230,0.95)' : 'rgba(190,190,190,0.85)'
        ctx.fillText(text, left + 3 * hpr, bitmapSize.height - 4 * vpr)
      }
      ctx.restore()
    })
  }
}

/** Marks every pane of `chart`: the first series added on each pane gets a HalfHourMarksPrimitive. */
export function markHalfHours(chart) {
  const marked = new Set()
  const addSeries = chart.addSeries.bind(chart)
  chart.addSeries = (definition, options, paneIndex = 0) => {
    const series = addSeries(definition, options, paneIndex)
    if (!marked.has(paneIndex)) {
      marked.add(paneIndex)
      try { series.attachPrimitive(new HalfHourMarksPrimitive()) } catch { /* a chart without primitives - no marks */ }
    }
    return series
  }
  return chart
}
