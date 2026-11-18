// What the Spot structure page draws (SpotStructurePage.jsx) - the analysis (marketStructure.js) as SHAPES for the chart's
// primitive (StructurePrimitive below), and the primitive itself. A shape's x is a BAR INDEX (the chart's logical index -
// the series starts at 0 with no gaps), so a line from a pivot to a break, a box running to the right edge or a level
// across the whole chart all follow the chart's scroll and zoom.
//
//   box   { kind: 'box', i1, i2, top, bottom, fill, stroke, dash, label, labelColor } - i1 null = the left edge, i2 null =
//         the right edge; drawn BEHIND the candles
//   seg   { kind: 'seg', i1, p1, i2, p2, color, width, dash, label, labelSide: 'above' | 'below', extend } - extend = on to
//         the right edge; drawn over the candles
//   text  { kind: 'text', i, p, text, color, side: 'above' | 'below', bg }
import { activeLevels } from './marketStructure.js'

export const STRUCTURE_COLORS = {
  bull: '#26a69a',
  bear: '#ef5350',
  bullSoft: 'rgba(38,166,154,0.14)',
  bearSoft: 'rgba(239,83,80,0.14)',
  internalBull: 'rgba(38,166,154,0.75)',
  internalBear: 'rgba(239,83,80,0.75)',
  support: 'rgba(64,169,255,0.13)',
  supportLine: 'rgba(64,169,255,0.7)',
  resistance: 'rgba(255,169,64,0.13)',
  resistanceLine: 'rgba(255,169,64,0.7)',
  trend: '#d3adf7',
  pattern: '#ffd666',
  fvgBull: 'rgba(146,84,222,0.16)',
  fvgBear: 'rgba(250,140,22,0.16)',
  liquidity: '#bfbfbf',
  premium: 'rgba(239,83,80,0.07)',
  discount: 'rgba(38,166,154,0.07)',
  eq: 'rgba(255,255,255,0.35)',
  htf: '#91caff',
}

// The page's timeframes (minutes; 1440 = a day - the server's SpotStructureService.Timeframes).
export const TIMEFRAMES = [
  { value: 1440, label: 'Day' },
  { value: 240, label: '4H' },
  { value: 60, label: '1H' },
  { value: 15, label: '15m' },
  { value: 5, label: '5m' },
  { value: 3, label: '3m' },
  { value: 1, label: '1m' },
]
// How many calendar days each timeframe can show (the server's defaults first) - its "History" choices.
export const HISTORY_CHOICES = {
  1440: [400, 730, 1100], 240: [120, 240, 365], 60: [60, 120, 180], 15: [21, 40, 60], 5: [7, 14, 21], 3: [4, 7, 10], 1: [2, 3, 5],
}
/** The lower timeframe kept under the higher one: the one asked when it is lower, else the next lower. */
export function lowerThan(htf, ltf) {
  if (ltf < htf) return ltf
  return TIMEFRAMES.find((t) => t.value < htf)?.value ?? 1
}

export const STRUCTURE_LAYERS = [
  { key: 'swing', label: 'External structure (BOS / CHoCH)' },
  { key: 'internal', label: 'Internal structure' },
  { key: 'labels', label: 'Swing labels (HH / HL / LH / LL)' },
  { key: 'zones', label: 'Support / resistance' },
  { key: 'trendlines', label: 'Trendlines' },
  { key: 'patterns', label: 'Chart patterns' },
  { key: 'ob', label: 'Order blocks' },
  { key: 'fvg', label: 'Fair value gaps' },
  { key: 'liquidity', label: 'Equal highs / lows, sweeps' },
  { key: 'pd', label: 'Premium / discount' },
  { key: 'strongWeak', label: 'Strong / weak high & low' },
  { key: 'htf', label: 'Higher TF levels on the lower TF' },
]
export const DEFAULT_LAYERS = STRUCTURE_LAYERS.map((l) => l.key)

const round = (v) => Math.round(v * 100) / 100
const lineAt = (a, b, j) => a.price + ((b.price - a.price) / (b.index - a.index)) * (j - a.index)

/** The analysis `a` as shapes, with the layers in `on` (a Set or array of STRUCTURE_LAYERS keys). `htf`: the higher
 *  timeframe's analysis whose levels are laid across this chart (only with 'htf' on). `maxInternal`: the newest internal
 *  breaks drawn (older ones would bury the chart). */
export function structureShapes(a, on, { htf = null, maxInternal = 24, maxInternalLabels = 8, maxPatterns = 3, maxLabels = 40 } = {}) {
  const layers = new Set(on ?? [])
  const shapes = []
  if (!a?.n) return shapes
  const C = STRUCTURE_COLORS
  const last = a.n - 1

  if (layers.has('pd') && a.range) {
    const r = a.range
    const band = (r.top - r.bottom) * 0.025
    shapes.push({ kind: 'box', i1: r.from, i2: null, top: r.top, bottom: r.eq + band, fill: C.premium, label: 'Premium', labelColor: C.bear })
    shapes.push({ kind: 'box', i1: r.from, i2: null, top: r.eq - band, bottom: r.bottom, fill: C.discount, label: 'Discount', labelColor: C.bull })
    shapes.push({ kind: 'seg', i1: r.from, p1: r.eq, i2: last, p2: r.eq, color: C.eq, width: 1, dash: true, label: 'Equilibrium', labelSide: 'above', extend: true })
  }

  const act = activeLevels(a)
  if (layers.has('zones')) {
    for (const z of act.support) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: C.support, stroke: C.supportLine, label: `S ${round(z.mid)} ×${z.touches}`, labelColor: C.supportLine })
    for (const z of act.resistance) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: C.resistance, stroke: C.resistanceLine, label: `R ${round(z.mid)} ×${z.touches}`, labelColor: C.resistanceLine })
  }
  if (layers.has('ob')) {
    for (const b of act.orderBlocks) {
      const bull = b.dir === 'bullish'
      shapes.push({
        kind: 'box', i1: b.index, i2: null, top: b.top, bottom: b.bottom,
        fill: bull ? C.bullSoft : C.bearSoft, stroke: bull ? C.bull : C.bear, dash: b.scope === 'internal',
        label: `${b.scope === 'swing' ? '' : 'i'}${bull ? 'Bull' : 'Bear'} OB`, labelColor: bull ? C.bull : C.bear,
      })
    }
  }
  if (layers.has('fvg')) {
    for (const g of act.fvgs) shapes.push({ kind: 'box', i1: g.index - 2, i2: null, top: g.top, bottom: g.bottom, fill: g.dir === 'bullish' ? C.fvgBull : C.fvgBear, label: 'FVG', labelColor: '#d9d9d9' })
  }

  if (layers.has('htf') && htf?.n) {
    const hAct = activeLevels(htf, { maxZones: 2, maxOb: 2 })
    for (const z of hAct.support) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: 'rgba(145,202,255,0.10)', stroke: C.htf, dash: true, label: `HTF S ${round(z.mid)}`, labelColor: C.htf })
    for (const z of hAct.resistance) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: 'rgba(145,202,255,0.10)', stroke: C.htf, dash: true, label: `HTF R ${round(z.mid)}`, labelColor: C.htf })
    for (const b of hAct.orderBlocks.filter((x) => x.scope === 'swing')) {
      shapes.push({ kind: 'box', i1: null, i2: null, top: b.top, bottom: b.bottom, fill: b.dir === 'bullish' ? 'rgba(38,166,154,0.08)' : 'rgba(239,83,80,0.08)', stroke: C.htf, dash: true, label: `HTF ${b.dir === 'bullish' ? 'bull' : 'bear'} OB`, labelColor: C.htf })
    }
    if (htf.range) {
      shapes.push({ kind: 'seg', i1: 0, p1: htf.range.top, i2: last, p2: htf.range.top, color: C.htf, width: 1, dash: true, label: 'HTF range high', labelSide: 'above', extend: true, fromLeft: true })
      shapes.push({ kind: 'seg', i1: 0, p1: htf.range.eq, i2: last, p2: htf.range.eq, color: C.htf, width: 1, dash: true, label: 'HTF equilibrium', labelSide: 'above', extend: true, fromLeft: true })
      shapes.push({ kind: 'seg', i1: 0, p1: htf.range.bottom, i2: last, p2: htf.range.bottom, color: C.htf, width: 1, dash: true, label: 'HTF range low', labelSide: 'below', extend: true, fromLeft: true })
    }
  }

  if (layers.has('trendlines')) {
    for (const t of a.trendlines) {
      const end = t.brokenAt ?? last
      shapes.push({
        kind: 'seg', i1: t.a.index, p1: t.a.price, i2: end, p2: lineAt(t.a, t.b, end), color: C.trend, width: 2, dash: t.brokenAt != null,
        label: `${t.kind === 'support' ? 'Support' : 'Resistance'} trendline${t.brokenAt != null ? ' (broken)' : ''} ×${t.touches}`,
        labelSide: t.kind === 'support' ? 'below' : 'above', extend: t.brokenAt == null,
      })
    }
  }

  if (layers.has('patterns')) {
    for (const p of a.patterns.slice(0, maxPatterns)) {
      const color = p.side === 'bullish' ? C.bull : p.side === 'bearish' ? C.bear : C.pattern
      for (const l of p.lines) shapes.push({ kind: 'seg', i1: l.a.index, p1: l.a.price, i2: l.b.index, p2: l.b.price, color: C.pattern, width: 1.5 })
      for (let k = 1; k < p.points.length; k++) {
        const x = p.points[k - 1]
        const y = p.points[k]
        shapes.push({ kind: 'seg', i1: x.index, p1: x.price, i2: y.index, p2: y.price, color: 'rgba(255,214,102,0.45)', width: 1 })
      }
      if (p.neckline) {
        const end = p.at ?? last
        shapes.push({ kind: 'seg', i1: p.neckline.a.index, p1: p.neckline.a.price, i2: end, p2: lineAt(p.neckline.a, p.neckline.b, end), color: C.pattern, width: 1, dash: true, label: 'neckline', labelSide: 'below' })
      }
      const top = p.points.reduce((m, q) => (q.price > m.price ? q : m), p.points[0])
      shapes.push({ kind: 'text', i: top.index, p: top.price, text: `${p.name}${p.status === 'confirmed' ? ' ✓' : p.status === 'failed' ? ' ✗' : ' …'}`, color, side: 'above', bg: true })
    }
  }

  if (layers.has('liquidity')) {
    for (const q of act.equal) {
      shapes.push({ kind: 'seg', i1: q.a.index, p1: q.level, i2: q.b.index, p2: q.level, color: C.liquidity, width: 1, dash: true, label: q.type, labelSide: q.type === 'EQH' ? 'above' : 'below' })
    }
    for (const s of a.sweeps.slice(-6)) {
      shapes.push({ kind: 'text', i: s.index, p: s.level, text: '✕ sweep', color: s.dir === 'bullish' ? C.bull : C.bear, side: s.dir === 'bullish' ? 'below' : 'above' })
    }
  }

  if (layers.has('strongWeak') && a.strongWeak) {
    const { strong, weak } = a.strongWeak
    shapes.push({ kind: 'seg', i1: strong.index, p1: strong.price, i2: last, p2: strong.price, color: 'rgba(255,255,255,0.55)', width: 1, label: `Strong ${strong.type}`, labelSide: strong.type === 'high' ? 'above' : 'below', extend: true })
    shapes.push({ kind: 'seg', i1: weak.index, p1: weak.price, i2: last, p2: weak.price, color: 'rgba(255,255,255,0.3)', width: 1, dash: true, label: `Weak ${weak.type}`, labelSide: weak.type === 'high' ? 'above' : 'below', extend: true })
  }

  const breaks = (scope, limit) => a.events.filter((e) => e.scope === scope).slice(-limit)
  if (layers.has('internal')) {
    // The newest internal breaks drawn, only the last few labelled - older ones would bury the chart in text.
    const internals = breaks('internal', maxInternal)
    internals.forEach((e, k) => {
      const bull = e.dir === 'bullish'
      const labelled = k >= internals.length - maxInternalLabels
      shapes.push({ kind: 'seg', i1: e.fromIndex, p1: e.level, i2: e.index, p2: e.level, color: bull ? C.internalBull : C.internalBear, width: 1, dash: true, label: labelled ? (e.kind === 'CHoCH' ? 'i-CHoCH' : 'i-BOS') : null, labelSide: bull ? 'above' : 'below', small: true })
    })
  }
  if (layers.has('swing')) {
    for (const e of breaks('swing', 200)) {
      const bull = e.dir === 'bullish'
      shapes.push({ kind: 'seg', i1: e.fromIndex, p1: e.level, i2: e.index, p2: e.level, color: bull ? C.bull : C.bear, width: 2, label: e.kind, labelSide: bull ? 'above' : 'below', bold: true })
    }
  }
  if (layers.has('labels')) {
    for (const s of a.swing.swings.slice(-maxLabels)) {
      if (!s.label) continue
      const up = s.label === 'HH' || s.label === 'HL'
      shapes.push({ kind: 'text', i: s.index, p: s.price, text: s.label, color: up ? C.bull : C.bear, side: s.type === 'high' ? 'above' : 'below' })
    }
  }
  return shapes
}

const FONT = '"Segoe UI", system-ui, sans-serif'

/** The lightweight-charts series primitive drawing structureShapes' shapes: boxes behind the candles, lines and text over
 *  them. setShapes(shapes) redraws. */
export class StructurePrimitive {
  constructor() {
    this._shapes = []
    this._chart = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._views = [
      { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => self._draw(target, 'back') }) },
      { zOrder: () => 'top', renderer: () => ({ draw: (target) => self._draw(target, 'front') }) },
    ]
  }

  attached({ chart, series, requestUpdate }) { this._chart = chart; this._series = series; this._requestUpdate = requestUpdate }
  detached() { this._chart = null; this._series = null; this._requestUpdate = null }
  updateAllViews() {}
  paneViews() { return this._views }

  setShapes(shapes) {
    this._shapes = shapes ?? []
    this._requestUpdate?.()
  }

  _draw(target, layer) {
    const chart = this._chart
    const series = this._series
    if (!chart || !series || !this._shapes.length) return
    const ts = chart.timeScale()
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const X = (i, edge) => {
        if (i == null) return edge === 'left' ? 0 : bitmapSize.width
        const x = ts.logicalToCoordinate(i)
        return x == null ? null : x * hpr
      }
      const Y = (p) => {
        const y = series.priceToCoordinate(p)
        return y == null ? null : y * vpr
      }
      const label = (text, x, y, color, side, { bg = true, small = false, bold = false, align = 'center' } = {}) => {
        const px = Math.round((small ? 9 : bold ? 11 : 10) * vpr)
        ctx.font = `${bold ? 700 : 600} ${px}px ${FONT}`
        const w = ctx.measureText(text).width
        const pad = 3 * hpr
        const lx = Math.max(2 * hpr, Math.min(bitmapSize.width - w - 2 * pad, align === 'left' ? x : x - w / 2))
        const ly = side === 'below' ? y + 3 * vpr : y - px - 3 * vpr
        if (bg) {
          ctx.fillStyle = 'rgba(13,17,26,0.75)'
          ctx.fillRect(lx - pad, ly - 1 * vpr, w + 2 * pad, px + 2 * vpr)
        }
        ctx.fillStyle = color
        ctx.textBaseline = 'top'
        ctx.fillText(text, lx, ly)
      }
      for (const s of this._shapes) {
        if (layer === 'back' && s.kind === 'box') {
          const x1 = X(s.i1, 'left')
          const x2 = X(s.i2, 'right')
          const yt = Y(s.top)
          const yb = Y(s.bottom)
          if (x1 == null || x2 == null || yt == null || yb == null) continue
          const left = Math.max(0, Math.min(x1, x2))
          const right = Math.min(bitmapSize.width, Math.max(x1, x2))
          const top = Math.min(yt, yb)
          const h = Math.max(1, Math.abs(yb - yt))
          if (right <= 0 || left >= bitmapSize.width) continue
          ctx.fillStyle = s.fill
          ctx.fillRect(left, top, right - left, h)
          if (s.stroke) {
            ctx.strokeStyle = s.stroke
            ctx.lineWidth = Math.max(1, hpr)
            ctx.setLineDash(s.dash ? [4 * hpr, 3 * hpr] : [])
            ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, h - 1)
            ctx.setLineDash([])
          }
          if (s.label) label(s.label, left + 4 * hpr, top, s.labelColor ?? '#d9d9d9', 'below', { small: true, align: 'left' })
        } else if (layer === 'front' && s.kind === 'seg') {
          const x1 = s.fromLeft ? 0 : X(s.i1)
          let x2 = X(s.i2)
          let y1 = Y(s.p1)
          let y2 = Y(s.p2)
          if (x1 == null || x2 == null || y1 == null || y2 == null) continue
          if (s.extend) {
            const right = bitmapSize.width
            if (x2 < right) {
              const slope = x2 !== x1 ? (y2 - y1) / (x2 - x1) : 0
              y2 += slope * (right - x2)
              x2 = right
            }
          }
          ctx.strokeStyle = s.color
          ctx.lineWidth = Math.max(1, (s.width ?? 1) * hpr)
          ctx.setLineDash(s.dash ? [5 * hpr, 4 * hpr] : [])
          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.stroke()
          ctx.setLineDash([])
          if (s.label) {
            const mx = s.extend ? Math.min(x2 - 60 * hpr, (x1 + x2) / 2) : (x1 + x2) / 2
            const my = y1 + ((y2 - y1) * (mx - x1)) / Math.max(1, x2 - x1)
            label(s.label, mx, my, s.color, s.labelSide ?? 'above', { small: s.small, bold: s.bold })
          }
        } else if (layer === 'front' && s.kind === 'text') {
          const x = X(s.i)
          const y = Y(s.p)
          if (x == null || y == null) continue
          label(s.text, x, y, s.color, s.side, { bg: s.bg ?? false, bold: true })
        }
      }
    })
  }
}
