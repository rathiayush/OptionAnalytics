import { RUNNING_PROFILE } from './profileColors.js'
// A volume profile drawn inside a lightweight-charts pane, attached to a candle series as a series
// primitive (so the chart itself redraws it on every scroll, zoom, price-scale drag and resize):
// one horizontal bar per price row, anchored to the right edge of the plot and at most `widthPct` of
// it wide, sell volume then buy volume, the value area brighter than the rest. The POC and the value
// area's edges (VAH / VAL) are separate price lines on the series - see setProfileLines.
//
// `profile` is orderFlowMath's volumeProfile / volumeProfileFromCandles result; `rowSize` its rows.

const SELL = [239, 83, 80]
const BUY = [38, 166, 154]
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`

export class VolumeProfilePrimitive {
  constructor() {
    this._profile = null
    this._rowSize = 0
    this._widthPct = 0.28
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = {
      zOrder: () => 'bottom',
      renderer: () => ({ draw: (target) => self._draw(target) }),
    }
  }

  attached({ series, requestUpdate }) {
    this._series = series
    this._requestUpdate = requestUpdate
  }

  detached() {
    this._series = null
    this._requestUpdate = null
  }

  setProfile(profile, rowSize) {
    this._profile = profile
    this._rowSize = rowSize
    this._requestUpdate?.()
  }

  updateAllViews() {}

  paneViews() {
    return [this._view]
  }

  _draw(target) {
    const profile = this._profile
    const series = this._series
    if (!profile?.rows?.length || !series || !(this._rowSize > 0)) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const maxLen = bitmapSize.width * this._widthPct
      const right = bitmapSize.width
      for (const row of profile.rows) {
        const yTop = series.priceToCoordinate(row.price + this._rowSize)
        const yBottom = series.priceToCoordinate(row.price)
        if (yTop == null || yBottom == null) continue
        const top = Math.round(Math.min(yTop, yBottom) * vpr) + 1
        const height = Math.max(1, Math.round(Math.abs(yBottom - yTop) * vpr) - 1)
        if (top > bitmapSize.height || top + height < 0) continue
        const inValue = row.price >= profile.val && row.price <= profile.vah
        const alpha = inValue ? 0.42 : 0.18
        const buyLen = (row.buy / profile.maxRow) * maxLen
        const sellLen = (row.sell / profile.maxRow) * maxLen
        ctx.fillStyle = rgba(BUY, alpha)
        ctx.fillRect(right - buyLen, top, buyLen, height)
        ctx.fillStyle = rgba(SELL, alpha)
        ctx.fillRect(right - buyLen - sellLen, top, sellLen, height)
        if (row.price === profile.poc) {
          ctx.strokeStyle = 'rgba(250,219,20,0.9)'
          ctx.lineWidth = Math.max(1, hpr)
          ctx.strokeRect(right - buyLen - sellLen, top, buyLen + sellLen, height)
        }
      }
    })
  }
}

// The futures chart's profile is TODAY's running one - its own colours, never the previous session's.
const LINE_STYLES = { POC: { color: RUNNING_PROFILE.poc, lineStyle: 0 }, VAH: { color: RUNNING_PROFILE.va, lineStyle: 2 }, VAL: { color: RUNNING_PROFILE.va, lineStyle: 2 } }

// Replaces the POC / VAH / VAL price lines on `series`; returns the new lines for the next call.
// A row's line sits at the row's middle (POC) or its outer edge (VAH top, VAL bottom).
// `pocLabel` is added to the POC line's title (" (20 Oct)" for a previous day's profile).
export function setProfileLines(series, previous, profile, rowSize, pocLabel = '') {
  for (const line of previous ?? []) series.removePriceLine(line)
  if (!profile?.rows?.length || !(rowSize > 0)) return []
  const at = { POC: profile.poc + rowSize / 2, VAH: profile.vah + rowSize, VAL: profile.val }
  return Object.entries(at).map(([title, price]) => series.createPriceLine({
    price, title: title === 'POC' ? `${title}${pocLabel}` : title, lineWidth: 1, axisLabelVisible: true, ...LINE_STYLES[title],
  }))
}
