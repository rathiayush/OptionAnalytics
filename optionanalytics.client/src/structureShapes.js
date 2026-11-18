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

/** Which layers the LOWER timeframe's chart draws (asked for - "an option to hide the lower timeframe's details with a
 *  tickbox, so I can see the higher timeframe on the lower timeframe, and see the lower one again when I wish"): with `own`
 *  off only the higher timeframe's levels are drawn over its candles - nothing at all when that layer is unticked too. */
export function ltfLayers(layers, own) {
  const on = [...(layers ?? [])]
  return own ? on : on.filter((k) => k === 'htf')
}

/** HOW MUCH IS DRAWN (asked for - "this is looking a bit messy"): Clean keeps only what a trader marks up first (external
 *  structure, the patterns, the nearest zones, the higher TF), Normal adds the internal breaks and the blocks, Everything is
 *  the lot. Each sets how many of each thing are drawn and how many of them may carry a label; `pdFill` = the premium /
 *  discount shaded (off in Clean - its two big blocks coloured the whole chart). */
export const DENSITY = {
  clean: { label: 'Clean', maxInternal: 6, maxInternalLabels: 0, maxPatterns: 1, maxOb: 1, maxFvg: 2, maxZones: 2, maxEqual: 2, maxSweeps: 2, maxLabels: 10, pdFill: false },
  normal: { label: 'Normal', maxInternal: 14, maxInternalLabels: 3, maxPatterns: 2, maxOb: 2, maxFvg: 3, maxZones: 3, maxEqual: 3, maxSweeps: 3, maxLabels: 22, pdFill: true },
  all: { label: 'Everything', maxInternal: 40, maxInternalLabels: 10, maxPatterns: 4, maxOb: 3, maxFvg: 6, maxZones: 4, maxEqual: 4, maxSweeps: 6, maxLabels: 60, pdFill: true },
}
export const DEFAULT_DENSITY = 'clean'

// A label's PRIORITY: when two would land on the same spot the chart keeps the more important one and drops the other
// (the primitive below) - so "i-BOS" can never be drawn over "Symmetrical triangle" again.
const PRI = { swing: 100, pattern: 90, strongWeak: 80, htf: 70, zone: 60, trendline: 55, pd: 50, ob: 40, liquidity: 35, fvg: 20, internal: 10 }

/** The analysis `a` as shapes, with the layers in `on` (a Set or array of STRUCTURE_LAYERS keys). `htf`: the higher
 *  timeframe's analysis whose levels are laid across this chart (only with 'htf' on). `density`: a DENSITY key - how much
 *  of each thing is drawn. */
export function structureShapes(a, on, { htf = null, density = DEFAULT_DENSITY, ...overrides } = {}) {
  const d = { ...(DENSITY[density] ?? DENSITY[DEFAULT_DENSITY]), ...overrides }
  const layers = new Set(on ?? [])
  const shapes = []
  if (!a?.n) return shapes
  const C = STRUCTURE_COLORS
  const last = a.n - 1

  if (layers.has('pd') && a.range) {
    const r = a.range
    const band = (r.top - r.bottom) * 0.025
    if (d.pdFill) {
      shapes.push({ kind: 'box', i1: r.from, i2: null, top: r.top, bottom: r.eq + band, fill: C.premium, label: 'Premium', labelColor: C.bear, pri: PRI.pd })
      shapes.push({ kind: 'box', i1: r.from, i2: null, top: r.eq - band, bottom: r.bottom, fill: C.discount, label: 'Discount', labelColor: C.bull, pri: PRI.pd })
    }
    shapes.push({ kind: 'seg', i1: r.from, p1: r.eq, i2: last, p2: r.eq, color: C.eq, width: 1, dash: true, label: 'Equilibrium', labelSide: 'above', extend: true, pri: PRI.pd })
  }

  const act = activeLevels(a, { maxOb: d.maxOb, maxFvg: d.maxFvg, maxZones: d.maxZones })
  if (layers.has('zones')) {
    for (const z of act.support) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: C.support, stroke: C.supportLine, label: `S ${round(z.mid)} x${z.touches}`, labelColor: C.supportLine, pri: PRI.zone })
    for (const z of act.resistance) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: C.resistance, stroke: C.resistanceLine, label: `R ${round(z.mid)} x${z.touches}`, labelColor: C.resistanceLine, pri: PRI.zone })
  }
  if (layers.has('ob')) {
    for (const b of act.orderBlocks) {
      const bull = b.dir === 'bullish'
      shapes.push({
        kind: 'box', i1: b.index, i2: null, top: b.top, bottom: b.bottom,
        fill: bull ? C.bullSoft : C.bearSoft, stroke: bull ? C.bull : C.bear, dash: b.scope === 'internal',
        label: `${b.scope === 'swing' ? '' : 'i'}${bull ? 'Bull' : 'Bear'} OB`, labelColor: bull ? C.bull : C.bear, pri: PRI.ob,
      })
    }
  }
  if (layers.has('fvg')) {
    for (const g of act.fvgs) shapes.push({ kind: 'box', i1: g.index - 2, i2: null, top: g.top, bottom: g.bottom, fill: g.dir === 'bullish' ? C.fvgBull : C.fvgBear, label: 'FVG', labelColor: '#d9d9d9', pri: PRI.fvg })
  }

  if (layers.has('htf') && htf?.n) {
    const hAct = activeLevels(htf, { maxZones: Math.max(1, d.maxZones - 1), maxOb: Math.max(1, d.maxOb) })
    for (const z of hAct.support) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: 'rgba(145,202,255,0.10)', stroke: C.htf, dash: true, label: `HTF S ${round(z.mid)}`, labelColor: C.htf, pri: PRI.htf })
    for (const z of hAct.resistance) shapes.push({ kind: 'box', i1: null, i2: null, top: z.high, bottom: z.low, fill: 'rgba(145,202,255,0.10)', stroke: C.htf, dash: true, label: `HTF R ${round(z.mid)}`, labelColor: C.htf, pri: PRI.htf })
    for (const b of hAct.orderBlocks.filter((x) => x.scope === 'swing')) {
      shapes.push({ kind: 'box', i1: null, i2: null, top: b.top, bottom: b.bottom, fill: b.dir === 'bullish' ? 'rgba(38,166,154,0.08)' : 'rgba(239,83,80,0.08)', stroke: C.htf, dash: true, label: `HTF ${b.dir === 'bullish' ? 'bull' : 'bear'} OB`, labelColor: C.htf, pri: PRI.htf })
    }
    if (htf.range) {
      shapes.push({ kind: 'seg', i1: 0, p1: htf.range.top, i2: last, p2: htf.range.top, color: C.htf, width: 1, dash: true, label: 'HTF range high', labelSide: 'above', extend: true, fromLeft: true, pri: PRI.htf })
      shapes.push({ kind: 'seg', i1: 0, p1: htf.range.eq, i2: last, p2: htf.range.eq, color: C.htf, width: 1, dash: true, label: 'HTF equilibrium', labelSide: 'above', extend: true, fromLeft: true, pri: PRI.htf - 1 })
      shapes.push({ kind: 'seg', i1: 0, p1: htf.range.bottom, i2: last, p2: htf.range.bottom, color: C.htf, width: 1, dash: true, label: 'HTF range low', labelSide: 'below', extend: true, fromLeft: true, pri: PRI.htf })
    }
  }

  if (layers.has('trendlines')) {
    for (const t of a.trendlines) {
      const end = t.brokenAt ?? last
      shapes.push({
        kind: 'seg', i1: t.a.index, p1: t.a.price, i2: end, p2: lineAt(t.a, t.b, end), color: C.trend, width: 2, dash: t.brokenAt != null,
        label: `${t.kind === 'support' ? 'Support' : 'Resistance'} trendline${t.brokenAt != null ? ' (broken)' : ''} x${t.touches}`,
        labelSide: t.kind === 'support' ? 'below' : 'above', extend: t.brokenAt == null, pri: PRI.trendline,
      })
    }
  }

  if (layers.has('patterns')) {
    for (const p of a.patterns.slice(0, d.maxPatterns)) {
      const color = p.side === 'bullish' ? C.bull : p.side === 'bearish' ? C.bear : C.pattern
      for (const l of p.lines) shapes.push({ kind: 'seg', i1: l.a.index, p1: l.a.price, i2: l.b.index, p2: l.b.price, color: C.pattern, width: 1.5 })
      for (let k = 1; k < p.points.length; k++) {
        const x = p.points[k - 1]
        const y = p.points[k]
        shapes.push({ kind: 'seg', i1: x.index, p1: x.price, i2: y.index, p2: y.price, color: 'rgba(255,214,102,0.45)', width: 1 })
      }
      if (p.neckline) {
        const end = p.at ?? last
        shapes.push({ kind: 'seg', i1: p.neckline.a.index, p1: p.neckline.a.price, i2: end, p2: lineAt(p.neckline.a, p.neckline.b, end), color: C.pattern, width: 1, dash: true, label: 'neckline', labelSide: 'below', pri: PRI.pattern - 5 })
      }
      const top = p.points.reduce((m, q) => (q.price > m.price ? q : m), p.points[0])
      shapes.push({ kind: 'text', i: top.index, p: top.price, text: `${p.name}${p.status === 'confirmed' ? ' ✓' : p.status === 'failed' ? ' ✗' : ' …'}`, color, side: 'above', bg: true, pri: PRI.pattern })
    }
  }

  if (layers.has('liquidity')) {
    for (const q of act.equal.slice(-d.maxEqual)) {
      shapes.push({ kind: 'seg', i1: q.a.index, p1: q.level, i2: q.b.index, p2: q.level, color: C.liquidity, width: 1, dash: true, label: q.type, labelSide: q.type === 'EQH' ? 'above' : 'below', pri: PRI.liquidity })
    }
    for (const s of a.sweeps.slice(-d.maxSweeps)) {
      shapes.push({ kind: 'text', i: s.index, p: s.level, text: '✕ sweep', color: s.dir === 'bullish' ? C.bull : C.bear, side: s.dir === 'bullish' ? 'below' : 'above', pri: PRI.liquidity })
    }
  }

  if (layers.has('strongWeak') && a.strongWeak) {
    const { strong, weak } = a.strongWeak
    shapes.push({ kind: 'seg', i1: strong.index, p1: strong.price, i2: last, p2: strong.price, color: 'rgba(255,255,255,0.55)', width: 1, label: `Strong ${strong.type}`, labelSide: strong.type === 'high' ? 'above' : 'below', extend: true, pri: PRI.strongWeak })
    shapes.push({ kind: 'seg', i1: weak.index, p1: weak.price, i2: last, p2: weak.price, color: 'rgba(255,255,255,0.3)', width: 1, dash: true, label: `Weak ${weak.type}`, labelSide: weak.type === 'high' ? 'above' : 'below', extend: true, pri: PRI.strongWeak })
  }

  const breaks = (scope, limit) => a.events.filter((e) => e.scope === scope).slice(-limit)
  if (layers.has('internal')) {
    // The newest internal breaks drawn, only the last few labelled - older ones would bury the chart in text.
    const internals = breaks('internal', d.maxInternal)
    internals.forEach((e, k) => {
      const bull = e.dir === 'bullish'
      const labelled = k >= internals.length - d.maxInternalLabels
      shapes.push({ kind: 'seg', i1: e.fromIndex, p1: e.level, i2: e.index, p2: e.level, color: bull ? C.internalBull : C.internalBear, width: 1, dash: true, label: labelled ? (e.kind === 'CHoCH' ? 'i-CHoCH' : 'i-BOS') : null, labelSide: bull ? 'above' : 'below', small: true, pri: PRI.internal })
    })
  }
  if (layers.has('swing')) {
    for (const e of breaks('swing', 200)) {
      const bull = e.dir === 'bullish'
      shapes.push({ kind: 'seg', i1: e.fromIndex, p1: e.level, i2: e.index, p2: e.level, color: bull ? C.bull : C.bear, width: 2, label: e.kind, labelSide: bull ? 'above' : 'below', bold: true, pri: PRI.swing })
    }
  }
  if (layers.has('labels')) {
    for (const s of a.swing.swings.slice(-d.maxLabels)) {
      if (!s.label) continue
      const up = s.label === 'HH' || s.label === 'HL'
      shapes.push({ kind: 'text', i: s.index, p: s.price, text: s.label, color: up ? C.bull : C.bear, side: s.type === 'high' ? 'above' : 'below', pri: PRI.swing - 5 })
    }
  }
  return shapes
}

/** Does `r` { x, y, w, h } clear every rectangle in `taken`? The chart's labels are placed through this, most important
 *  first, so one is never drawn over another (it is pure, so it is tested). */
export function clears(taken, r, gap = 2) {
  return !taken.some((t) => r.x < t.x + t.w + gap && r.x + r.w + gap > t.x && r.y < t.y + t.h + gap && r.y + r.h + gap > t.y)
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
      // Every label is collected while the shapes are drawn and PLACED AFTERWARDS, most important first (`pri`): one that
      // would land on a label already placed is dropped, so nothing is ever drawn over anything else.
      const wanted = []
      const want = (text, x, y, color, side, opts = {}) => wanted.push({ text, x, y, color, side, ...opts })

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
        } else if (layer === 'front' && s.kind === 'box' && s.label) {
          // The box is drawn behind the candles, its label over them - and through the same placing as every other.
          const x1 = X(s.i1, 'left')
          const yt = Y(s.top)
          const yb = Y(s.bottom)
          if (x1 == null || yt == null || yb == null) continue
          want(s.label, Math.max(0, x1) + 4 * hpr, Math.min(yt, yb), s.labelColor ?? '#d9d9d9', 'below', { small: true, align: 'left', pri: s.pri })
        } else if (layer === 'front' && s.kind === 'seg') {
          const x1 = s.fromLeft ? 0 : X(s.i1)
          let x2 = X(s.i2)
          const y1 = Y(s.p1)
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
            want(s.label, mx, my, s.color, s.labelSide ?? 'above', { small: s.small, bold: s.bold, pri: s.pri })
          }
        } else if (layer === 'front' && s.kind === 'text') {
          const x = X(s.i)
          const y = Y(s.p)
          if (x == null || y == null) continue
          want(s.text, x, y, s.color, s.side, { bg: s.bg ?? false, bold: true, pri: s.pri })
        }
      }

      if (layer !== 'front' || !wanted.length) return
      const taken = []
      for (const l of wanted.sort((a, b) => (b.pri ?? 0) - (a.pri ?? 0))) {
        const px = Math.round((l.small ? 9 : l.bold ? 11 : 10) * vpr)
        ctx.font = `${l.bold ? 700 : 600} ${px}px ${FONT}`
        const w = ctx.measureText(l.text).width
        const pad = 3 * hpr
        const x = Math.max(2 * hpr, Math.min(bitmapSize.width - w - 2 * pad, l.align === 'left' ? l.x : l.x - w / 2))
        const h = px + 2 * vpr
        // Its own side first; the other side rather than lose it (a wick's label has room above AND below).
        let y = l.side === 'below' ? l.y + 3 * vpr : l.y - px - 3 * vpr
        const rect = { x: x - pad, y: y - vpr, w: w + 2 * pad, h }
        if (!clears(taken, rect, 2 * vpr)) {
          y = l.side === 'below' ? l.y - px - 3 * vpr : l.y + 3 * vpr
          rect.y = y - vpr
          if (!clears(taken, rect, 2 * vpr)) continue
        }
        if (rect.y < 0 || rect.y + rect.h > bitmapSize.height) continue
        taken.push(rect)
        if (l.bg !== false) {
          ctx.fillStyle = 'rgba(13,17,26,0.78)'
          ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
        }
        ctx.fillStyle = l.color
        ctx.textBaseline = 'top'
        ctx.fillText(l.text, x, y)
      }
    })
  }
}
