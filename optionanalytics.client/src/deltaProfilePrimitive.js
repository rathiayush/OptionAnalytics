// A DELTA PROFILE drawn inside a lightweight-charts pane (attached to the candle series as a primitive, so the chart
// redraws it on every scroll, zoom, price-scale drag and resize): a panel at the right of the plot with two columns -
// VOLUME (how much traded at each price row: grey, the value area brighter, the POC amber) and DELTA (buyers minus
// sellers there: green to the right of its centre line, red to the left) - and the POC row as a faint amber band across
// the candles ("the big volume node"). `profile` is deltaProfile.js' (rows [{ price, volume, delta }], rowSize, poc,
// vah, val, maxVolume, maxAbsDelta). The chart leaves the panel's share of the plot empty on the right (rightOffset), so
// the candles stand beside it, not under it.

export const PANEL_SHARE = 0.38
const PANEL_BG = 'rgba(13,17,23,0.86)'
const VOL_OUT = 'rgba(150,170,200,0.45)'
const VOL_IN = 'rgba(150,170,200,0.75)'
const POC = 'rgba(245,179,1,0.95)'
const POC_BAND = 'rgba(245,179,1,0.10)'
const BUY = 'rgba(38,166,154,0.9)'
const SELL = 'rgba(239,83,80,0.9)'
const AXIS = 'rgba(160,170,185,0.5)'
const LABEL = 'rgba(200,205,215,0.85)'

export class DeltaProfilePrimitive {
  constructor() {
    this._profile = null
    this._hover = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = {
      zOrder: () => 'top',
      renderer: () => ({ draw: (target) => self._draw(target) }),
    }
    this._bandView = {
      zOrder: () => 'bottom',
      renderer: () => ({ draw: (target) => self._drawBand(target) }),
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

  setProfile(profile) {
    this._profile = profile
    this._requestUpdate?.()
  }

  /** The row under the crosshair (its price), outlined - null for none. */
  setHover(price) {
    if (price === this._hover) return
    this._hover = price
    this._requestUpdate?.()
  }

  updateAllViews() {}

  paneViews() {
    return [this._bandView, this._view]
  }

  // A row's top and height on the bitmap, or null when it is off the price scale.
  _rowBox(row, vpr) {
    const p = this._profile
    const yTop = this._series.priceToCoordinate(row.price + p.rowSize)
    const yBottom = this._series.priceToCoordinate(row.price)
    if (yTop == null || yBottom == null) return null
    const top = Math.round(Math.min(yTop, yBottom) * vpr) + 1
    return { top, height: Math.max(1, Math.round(Math.abs(yBottom - yTop) * vpr) - 1) }
  }

  _drawBand(target) {
    const p = this._profile
    if (!p?.rows?.length || !this._series || p.poc == null) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vpr }) => {
      const box = this._rowBox({ price: p.poc }, vpr)
      if (!box) return
      ctx.fillStyle = POC_BAND
      ctx.fillRect(0, box.top, bitmapSize.width * (1 - PANEL_SHARE), box.height)
    })
  }

  _draw(target) {
    const p = this._profile
    if (!p?.rows?.length || !this._series || !(p.rowSize > 0)) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const W = bitmapSize.width, H = bitmapSize.height
      const left = Math.round(W * (1 - PANEL_SHARE))
      const pad = Math.round(6 * hpr)
      const colW = Math.max(4, Math.floor((W - left - 3 * pad) / 2))
      const volX = left + pad
      const deltaX = volX + colW + pad
      const mid = deltaX + Math.round(colW / 2)
      const head = Math.round(16 * vpr)
      ctx.fillStyle = PANEL_BG
      ctx.fillRect(left, 0, W - left, H)
      // Column titles and the delta's centre line.
      ctx.fillStyle = LABEL
      ctx.font = `${Math.round(10 * vpr)}px sans-serif`
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillText('VOLUME', volX, Math.round(3 * vpr))
      // Over its own centre line - beside VOLUME it ran into it on a phone.
      ctx.textAlign = 'center'
      ctx.fillText('DELTA', mid, Math.round(3 * vpr))
      ctx.textAlign = 'left'
      ctx.fillStyle = AXIS
      ctx.fillRect(mid, head, Math.max(1, Math.round(hpr)), H - head)
      for (const row of p.rows) {
        const box = this._rowBox(row, vpr)
        if (!box || box.top > H || box.top + box.height < head) continue
        const top = Math.max(head, box.top)
        const height = Math.max(1, box.top + box.height - top)
        if (p.maxVolume > 0 && row.volume > 0) {
          const inValue = p.val != null && row.price >= p.val && row.price <= p.vah
          ctx.fillStyle = row.price === p.poc ? POC : inValue ? VOL_IN : VOL_OUT
          ctx.fillRect(volX, top, Math.max(1, (row.volume / p.maxVolume) * colW), height)
        }
        if (p.maxAbsDelta > 0 && row.delta !== 0) {
          const len = Math.max(1, (Math.abs(row.delta) / p.maxAbsDelta) * (colW / 2))
          ctx.fillStyle = row.delta > 0 ? BUY : SELL
          ctx.fillRect(row.delta > 0 ? mid : mid - len, top, len, height)
        }
        if (this._hover != null && row.price === this._hover) {
          ctx.strokeStyle = LABEL
          ctx.lineWidth = Math.max(1, hpr)
          ctx.strokeRect(left + 1, top, W - left - 2, height)
        }
      }
    })
  }
}
