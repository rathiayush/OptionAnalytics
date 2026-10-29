import { TPO_LETTERS } from './profiles.js'

// Two drawings for the Profiles page's charts, each a lightweight-charts series primitive attached to the
// candle series - so the chart redraws them itself on every scroll, zoom, price-scale drag and resize:
//
//   ZoneBoxesPrimitive - price ZONES as translucent boxes across the whole plot, behind the candles, each
//     with a short label at its left edge (the profile is drawn at the right edge, so the two never meet).
//   TpoProfilePrimitive - the market profile itself: each price row's TPO letters (A = 09:15, one letter a
//     30-minute period), laid out from the right edge of the plot; plain blocks when the rows are too thin
//     for a letter to read. The value area brighter, the initial balance (A and B) in its own colour,
//     single prints in the single-print colour, the POC row outlined.

const FONT = '"Segoe UI", system-ui, sans-serif'

/** A row's top / bottom on the chart, in bitmap pixels - or null when either edge is off the price scale. */
function rowBand(series, low, high, vpr) {
  const yHigh = series.priceToCoordinate(high)
  const yLow = series.priceToCoordinate(low)
  if (yHigh == null || yLow == null) return null
  const top = Math.round(Math.min(yHigh, yLow) * vpr)
  const bottom = Math.round(Math.max(yHigh, yLow) * vpr)
  return { top, height: Math.max(1, bottom - top) }
}

class BasePrimitive {
  constructor() {
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = { zOrder: () => self._zOrder(), renderer: () => ({ draw: (target) => self._draw(target) }) }
  }

  attached({ series, requestUpdate }) { this._series = series; this._requestUpdate = requestUpdate }
  detached() { this._series = null; this._requestUpdate = null }
  updateAllViews() {}
  paneViews() { return [this._view] }
  _zOrder() { return 'bottom' }
}

/** Zones: [{ low, high, fill, stroke, label, labelColor, dashed }] - prices are the box's edges. */
export class ZoneBoxesPrimitive extends BasePrimitive {
  constructor() {
    super()
    this._zones = []
  }

  setZones(zones) {
    this._zones = zones ?? []
    this._requestUpdate?.()
  }

  _draw(target) {
    const series = this._series
    if (!series || !this._zones.length) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const fontPx = Math.round(10.5 * vpr)
      ctx.font = `600 ${fontPx}px ${FONT}`
      ctx.textBaseline = 'top'
      // Labels are stacked down the left edge when two boxes overlap, so neither hides the other's.
      const usedLabelRows = []
      for (const z of this._zones) {
        const band = rowBand(series, z.low, z.high, vpr)
        if (!band || band.top > bitmapSize.height || band.top + band.height < 0) continue
        ctx.fillStyle = z.fill
        ctx.fillRect(0, band.top, bitmapSize.width, band.height)
        if (z.stroke) {
          ctx.strokeStyle = z.stroke
          ctx.lineWidth = Math.max(1, Math.round(hpr))
          ctx.setLineDash(z.dashed ? [4 * hpr, 3 * hpr] : [])
          ctx.strokeRect(0.5, band.top + 0.5, bitmapSize.width - 1, band.height - 1)
          ctx.setLineDash([])
        }
        if (!z.label) continue
        let y = Math.max(0, band.top) + Math.round(2 * vpr)
        while (usedLabelRows.some((u) => Math.abs(u - y) < fontPx + 2 * vpr)) y += fontPx + Math.round(2 * vpr)
        if (y + fontPx > band.top + band.height + fontPx * 2) continue // no room near its own box
        usedLabelRows.push(y)
        const pad = Math.round(3 * hpr)
        const width = ctx.measureText(z.label).width + pad * 2
        ctx.fillStyle = 'rgba(13,17,26,0.72)'
        ctx.fillRect(Math.round(4 * hpr), y - Math.round(1 * vpr), width, fontPx + Math.round(3 * vpr))
        ctx.fillStyle = z.labelColor ?? z.stroke ?? '#e6e6e6'
        ctx.fillText(z.label, Math.round(4 * hpr) + pad, y)
      }
    })
  }
}

// Period letters a hue each, from blue (morning) through violet to rose (afternoon) - the order of the day
// reads at a glance; the initial balance (A, B) in its own colour.
const periodColour = (index, alpha) => `hsla(${210 + Math.min(index, 13) * 9}, 70%, 66%, ${alpha})`
const IB_COLOUR = (alpha) => `rgba(250,173,20,${alpha})`
const SINGLE_COLOUR = (alpha) => `rgba(255,122,69,${alpha})`
const POC_STROKE = 'rgba(250,219,20,0.95)'

/** The market profile drawn from the right edge of the plot, at most `widthPct` of it wide. */
export class TpoProfilePrimitive extends BasePrimitive {
  constructor() {
    super()
    this._tpo = null
    this._singles = new Set()
    this._widthPct = 0.28
  }

  /** `tpo`: profiles.tpoProfile's result; `singlePrices`: the rows to colour as single prints. */
  setProfile(tpo, singlePrices = []) {
    this._tpo = tpo
    this._singles = new Set(singlePrices)
    this._requestUpdate?.()
  }

  _draw(target) {
    const tpo = this._tpo
    const series = this._series
    if (!tpo?.rows?.length || !series || !(tpo.rowSize > 0)) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const maxCount = Math.max(...tpo.rows.map((r) => r.count))
      const maxWidth = bitmapSize.width * this._widthPct
      const cell = Math.max(2 * hpr, Math.min(13 * hpr, Math.floor(maxWidth / Math.max(1, maxCount))))
      for (const row of tpo.rows) {
        const band = rowBand(series, row.price, row.price + tpo.rowSize, vpr)
        if (!band || band.top > bitmapSize.height || band.top + band.height < 0) continue
        const inValue = row.price >= tpo.val && row.price <= tpo.vah
        const single = this._singles.has(row.price)
        const height = Math.max(1, band.height - 1)
        const showLetters = band.height >= 9 * vpr && cell >= 7 * hpr
        const fontPx = Math.min(Math.round(height * 0.86), Math.round(12 * vpr))
        if (showLetters) {
          ctx.font = `600 ${fontPx}px ${FONT}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
        }
        // Letters run left to right in time order, the whole row pushed against the right edge.
        const letters = row.letters.split('')
        const left = bitmapSize.width - letters.length * cell
        letters.forEach((letter, k) => {
          const index = Math.max(0, TPO_LETTERS.indexOf(letter))
          const alpha = inValue ? 0.95 : 0.55
          const colour = single ? SINGLE_COLOUR(alpha) : index < 2 ? IB_COLOUR(alpha) : periodColour(index, alpha)
          const x = left + k * cell
          if (showLetters) {
            ctx.fillStyle = single ? SINGLE_COLOUR(0.16) : inValue ? 'rgba(54,207,201,0.10)' : 'rgba(255,255,255,0.03)'
            ctx.fillRect(x, band.top, cell - 1, height)
            ctx.fillStyle = colour
            ctx.fillText(letter, x + cell / 2, band.top + height / 2 + 0.5)
          } else {
            ctx.fillStyle = colour
            ctx.fillRect(x, band.top, Math.max(1, cell - 1), height)
          }
        })
        if (row.price === tpo.poc) {
          ctx.strokeStyle = POC_STROKE
          ctx.lineWidth = Math.max(1, Math.round(hpr))
          ctx.strokeRect(left - 1, band.top, bitmapSize.width - left, height)
        }
      }
    })
  }
}
