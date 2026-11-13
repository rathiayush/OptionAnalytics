// The ORDER BOOK LADDER drawn inside a lightweight-charts pane, beside the futures candles (attached to the candle series
// as a primitive, so the chart redraws it on every scroll, zoom, price-scale drag and resize) - the Order Flow page's
// "Chart and order book" card. `ladder` is bookLadder.js' (rows [{ price, bid, ask, bought, sold, pulledBid, pulledAsk,
// bigBid, bigAsk }], row, price, maxWaiting, maxTraded, buyers, sellers). A panel at the right of the plot (the chart
// leaves its share empty - rightOffset - so the candles stand beside it): the row's price in the middle, BUYERS to its
// left (bids waiting - solid green, bought in the window - the light strip under it) and SELLERS to its right (offers
// waiting - solid red, sold - light), what was PULLED as an orange outline running on past the waiting bar, the big rows
// brighter with their lots; the nearest big buyers / sellers zones as faint bands across the candles.

export const LADDER_SHARE = 0.42
export const LADDER_SHARE_NARROW = 0.52
const PANEL_BG = 'rgba(10,13,18,0.9)'
const BUY = 'rgba(38,166,154,0.78)'
const BUY_BIG = 'rgba(52,211,153,1)'
const BUY_TRADED = 'rgba(38,166,154,0.38)'
const SELL = 'rgba(239,83,80,0.78)'
const SELL_BIG = 'rgba(255,99,90,1)'
const SELL_TRADED = 'rgba(239,83,80,0.38)'
const PULLED = 'rgba(250,173,20,0.95)'
const PULLED_FILL = 'rgba(250,173,20,0.16)'
const BUY_BAND = 'rgba(38,166,154,0.10)'
const SELL_BAND = 'rgba(239,83,80,0.10)'
const LABEL = 'rgba(200,205,215,0.85)'
const LABEL_DIM = 'rgba(160,170,185,0.55)'
const PRICE_BG = 'rgba(64,150,255,0.9)'

export class BookLadderPrimitive {
  constructor() {
    this._ladder = null
    this._format = (q) => String(Math.round(q))
    this._share = LADDER_SHARE
    this._hover = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = { zOrder: () => 'top', renderer: () => ({ draw: (target) => self._draw(target) }) }
    this._bandView = { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => self._drawBands(target) }) }
  }

  attached({ series, requestUpdate }) {
    this._series = series
    this._requestUpdate = requestUpdate
  }

  detached() {
    this._series = null
    this._requestUpdate = null
  }

  /** `format(quantity)` - the text of a row's waiting size (the page's lots / contracts). */
  setLadder(ladder, format, share = LADDER_SHARE) {
    this._ladder = ladder
    if (format) this._format = format
    this._share = share
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

  _box(lo, hi, vpr) {
    const yTop = this._series.priceToCoordinate(hi)
    const yBottom = this._series.priceToCoordinate(lo)
    if (yTop == null || yBottom == null) return null
    const top = Math.round(Math.min(yTop, yBottom) * vpr)
    return { top, height: Math.max(1, Math.round(Math.abs(yBottom - yTop) * vpr)) }
  }

  _drawBands(target) {
    const l = this._ladder
    if (!l || !this._series) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vpr }) => {
      const right = Math.round(bitmapSize.width * (1 - this._share))
      for (const [zone, color] of [[l.buyers, BUY_BAND], [l.sellers, SELL_BAND]]) {
        if (!zone) continue
        const box = this._box(zone.lo, zone.hi, vpr)
        if (!box) continue
        ctx.fillStyle = color
        ctx.fillRect(0, box.top, right, box.height)
      }
    })
  }

  _draw(target) {
    const l = this._ladder
    if (!l?.rows?.length || !this._series || !(l.row > 0)) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const W = bitmapSize.width, H = bitmapSize.height
      const left = Math.round(W * (1 - this._share))
      const pad = Math.round(4 * hpr)
      const font = Math.round(10 * vpr)
      ctx.font = `${font}px sans-serif`
      const labelW = Math.ceil(ctx.measureText('00,000.0').width) + Math.round(8 * hpr)
      const cx = left + Math.round((W - left) / 2)
      const bidRight = cx - Math.round(labelW / 2)
      const askLeft = cx + Math.round(labelW / 2)
      const bidW = Math.max(4, bidRight - left - pad)
      const askW = Math.max(4, W - pad - askLeft)
      const head = Math.round(15 * vpr)
      ctx.fillStyle = PANEL_BG
      ctx.fillRect(left, 0, W - left, H)
      ctx.textBaseline = 'top'
      ctx.fillStyle = LABEL
      ctx.textAlign = 'right'
      ctx.fillText('BUYERS', bidRight - pad, Math.round(3 * vpr))
      ctx.textAlign = 'left'
      ctx.fillText('SELLERS', askLeft + pad, Math.round(3 * vpr))
      const fmt = this._format
      // The bars scale on the rows near the price (bookLadder's maxWaiting / maxTraded) - a far wall runs to the edge.
      const waitScale = l.maxWaiting > 0 ? 0.82 / l.maxWaiting : 0
      const tradeScale = l.maxTraded > 0 ? 0.82 / l.maxTraded : 0
      const rowPx = Math.abs((this._series.priceToCoordinate(l.price) ?? 0) - (this._series.priceToCoordinate(l.price + l.row) ?? 0)) * vpr
      const showText = rowPx >= 9 * vpr
      const every = showText ? 1 : Math.max(1, Math.ceil((11 * vpr) / Math.max(1, rowPx)))
      ctx.textBaseline = 'middle'
      for (const r of l.rows) {
        const box = this._box(r.price, r.price + l.row, vpr)
        if (!box || box.top > H || box.top + box.height < head) continue
        const top = Math.max(head, box.top) + 1
        const height = Math.max(1, box.top + box.height - top - 1)
        const waitH = r.bought > 0 || r.sold > 0 ? Math.max(1, Math.round(height * 0.64)) : height
        const tradeTop = top + waitH
        const tradeH = Math.max(1, height - waitH)
        const mid = top + height / 2
        // BUYERS (left of the price): bids waiting, the pulled outline past them, bought under them.
        const bidLen = Math.min(bidW, r.bid * waitScale * bidW)
        if (r.bid > 0) {
          ctx.fillStyle = r.bigBid ? BUY_BIG : BUY
          ctx.fillRect(bidRight - bidLen, top, Math.max(1, bidLen), waitH)
        }
        if (r.pulledBid > 0) {
          const len = Math.min(bidW - bidLen, r.pulledBid * waitScale * bidW)
          if (len >= 1) this._pulled(ctx, bidRight - bidLen - len, top, len, waitH, hpr)
        }
        if (r.bought > 0) {
          ctx.fillStyle = BUY_TRADED
          ctx.fillRect(bidRight - Math.min(bidW, r.bought * tradeScale * bidW), tradeTop, Math.max(1, Math.min(bidW, r.bought * tradeScale * bidW)), tradeH)
        }
        // SELLERS (right of the price): offers waiting, pulled, sold.
        const askLen = Math.min(askW, r.ask * waitScale * askW)
        if (r.ask > 0) {
          ctx.fillStyle = r.bigAsk ? SELL_BIG : SELL
          ctx.fillRect(askLeft, top, Math.max(1, askLen), waitH)
        }
        if (r.pulledAsk > 0) {
          const len = Math.min(askW - askLen, r.pulledAsk * waitScale * askW)
          if (len >= 1) this._pulled(ctx, askLeft + askLen, top, len, waitH, hpr)
        }
        if (r.sold > 0) {
          ctx.fillStyle = SELL_TRADED
          ctx.fillRect(askLeft, tradeTop, Math.max(1, Math.min(askW, r.sold * tradeScale * askW)), tradeH)
        }
        // The row's price in the middle (the price's own row marked), its waiting lots at the bars' inner ends.
        const atPrice = l.price >= r.price && l.price < r.price + l.row
        const idx = Math.round((l.priceRow - r.price) / l.row)
        if (atPrice) {
          ctx.fillStyle = PRICE_BG
          ctx.fillRect(bidRight + 1, top, askLeft - bidRight - 2, height)
        }
        if (atPrice || idx % every === 0) {
          ctx.fillStyle = atPrice ? '#fff' : r.bigBid || r.bigAsk ? LABEL : LABEL_DIM
          ctx.textAlign = 'center'
          ctx.fillText(r.price.toLocaleString('en-IN', { maximumFractionDigits: 2 }), cx, mid)
        }
        if (showText) {
          ctx.font = `${Math.round(9 * vpr)}px sans-serif`
          if (r.bid > 0) {
            ctx.fillStyle = r.bigBid ? '#fff' : LABEL_DIM
            ctx.textAlign = 'right'
            ctx.fillText(fmt(r.bid), Math.max(left + Math.round(18 * hpr), bidRight - bidLen - Math.round(3 * hpr)), top + waitH / 2)
          }
          if (r.ask > 0) {
            ctx.fillStyle = r.bigAsk ? '#fff' : LABEL_DIM
            ctx.textAlign = 'left'
            ctx.fillText(fmt(r.ask), Math.min(W - Math.round(18 * hpr), askLeft + askLen + Math.round(3 * hpr)), top + waitH / 2)
          }
          ctx.font = `${font}px sans-serif`
        }
        if (this._hover != null && r.price === this._hover) {
          ctx.strokeStyle = LABEL
          ctx.lineWidth = Math.max(1, hpr)
          ctx.strokeRect(left + 1, top, W - left - 2, height)
        }
      }
    })
  }

  _pulled(ctx, x, y, w, h, hpr) {
    ctx.fillStyle = PULLED_FILL
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = PULLED
    ctx.lineWidth = Math.max(1, Math.round(hpr))
    ctx.setLineDash([Math.round(3 * hpr), Math.round(2 * hpr)])
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1))
    ctx.setLineDash([])
  }
}
