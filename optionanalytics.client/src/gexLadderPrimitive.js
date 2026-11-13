// The GEX LADDER drawn inside the "GEX levels on spot" chart's pane, beside the spot candles (attached to the candle
// series as a primitive, so the chart redraws it on every scroll, zoom, price-scale drag and resize; asked for - the GEX
// levels shown "like" the order-book ladder). `ladder` is gexSpot.js' gexLadder: a row per strike (centred on it, a strike
// step tall), PUTS' GEX left of the strike and CALLS' right, each bar green when positive (dealers long gamma there) and
// red when negative, its ₹ Cr at the bar's end; the call wall / put wall / max gamma rows outlined and tagged, the strike
// spot is at marked, the flip a dashed line across. The chart leaves the panel's share of the plot empty on the right
// (rightOffset), so the candles stand beside it.

export const GEX_LADDER_SHARE = 0.38
export const GEX_LADDER_SHARE_NARROW = 0.46
const PANEL_BG = 'rgba(10,13,18,0.9)'
const POS = 'rgba(38,166,154,0.8)'
const NEG = 'rgba(239,83,80,0.8)'
const LABEL = 'rgba(200,205,215,0.85)'
const LABEL_DIM = 'rgba(160,170,185,0.6)'
const SPOT_BG = 'rgba(64,150,255,0.9)'
const TAGS = [
  { key: 'callWall', text: 'CW', color: '#26a69a' },
  { key: 'putWall', text: 'PW', color: '#ef5350' },
  { key: 'maxGamma', text: 'MG', color: '#b37feb' },
]
const FLIP = '#ffd54f'
const CR = 1e7

/** ₹ crore, short: "1.2k" past a thousand. */
export const crShort = (v) => {
  const c = Math.abs(v) / CR
  return c >= 1000 ? `${(c / 1000).toFixed(1)}k` : c >= 10 ? String(Math.round(c)) : c.toFixed(1)
}

export class GexLadderPrimitive {
  constructor() {
    this._ladder = null
    this._share = GEX_LADDER_SHARE
    this._hover = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = { zOrder: () => 'top', renderer: () => ({ draw: (target) => self._draw(target) }) }
  }

  attached({ series, requestUpdate }) {
    this._series = series
    this._requestUpdate = requestUpdate
  }

  detached() {
    this._series = null
    this._requestUpdate = null
  }

  setLadder(ladder, share = GEX_LADDER_SHARE) {
    this._ladder = ladder
    this._share = share
    this._requestUpdate?.()
  }

  /** The strike under the crosshair, outlined - null for none. */
  setHover(strike) {
    if (strike === this._hover) return
    this._hover = strike
    this._requestUpdate?.()
  }

  updateAllViews() {}

  paneViews() {
    return [this._view]
  }

  _draw(target) {
    const l = this._ladder
    if (!l?.rows?.length || !this._series || !(l.step > 0)) return
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const W = bitmapSize.width, H = bitmapSize.height
      const left = Math.round(W * (1 - this._share))
      const pad = Math.round(4 * hpr)
      ctx.font = `${Math.round(10 * vpr)}px sans-serif`
      // The strike in the middle - with its tags (CW / PW / MG) when the panel is wide enough, else the strike alone (the
      // row's outline still marks it): on a phone the tags took the bars' room.
      const panelW = W - left
      const tagged = Math.ceil(ctx.measureText('00,000 PW/MG').width) + Math.round(6 * hpr)
      const plain = Math.ceil(ctx.measureText('00,000').width) + Math.round(6 * hpr)
      const withTags = panelW >= tagged * 2.6
      const labelW = withTags ? tagged : plain
      const cx = left + Math.round(panelW / 2)
      const putRight = cx - Math.round(labelW / 2)
      const callLeft = cx + Math.round(labelW / 2)
      const sideW = Math.max(4, Math.min(putRight - left - pad, W - pad - callLeft))
      const head = Math.round(15 * vpr)
      ctx.fillStyle = PANEL_BG
      ctx.fillRect(left, 0, panelW, H)
      ctx.textBaseline = 'top'
      ctx.fillStyle = LABEL
      ctx.textAlign = 'left'
      ctx.fillText('PUTS γ', left + pad, Math.round(3 * vpr))
      ctx.textAlign = 'right'
      ctx.fillText('CALLS γ', W - pad, Math.round(3 * vpr))
      const yOf = (p) => this._series.priceToCoordinate(p)
      const y0 = yOf(l.rows[0].strike), y1 = yOf(l.rows[0].strike - l.step)
      const rowPx = y0 != null && y1 != null ? Math.abs(y1 - y0) * vpr : 0
      // The ₹ Cr at a bar's end, when the row is tall enough and the side has room - the bars stop short of it.
      ctx.font = `${Math.round(9 * vpr)}px sans-serif`
      const valueW = Math.ceil(ctx.measureText('0.0k').width) + Math.round(4 * hpr)
      ctx.font = `${Math.round(10 * vpr)}px sans-serif`
      const showLabels = rowPx >= 10 * vpr
      const showValues = showLabels && sideW >= valueW * 2.5
      const barMax = showValues ? sideW - valueW : sideW
      const scale = l.maxAbs > 0 ? 0.95 / l.maxAbs : 0
      const spotRow = l.rows.reduce((b, r) => (b == null || Math.abs(r.strike - l.spot) < Math.abs(b.strike - l.spot) ? r : b), null)
      ctx.textBaseline = 'middle'
      for (const r of l.rows) {
        const yt = yOf(r.strike + l.step / 2)
        const yb = yOf(r.strike - l.step / 2)
        if (yt == null || yb == null) continue
        const top = Math.max(head, Math.round(Math.min(yt, yb) * vpr) + 1)
        const bottom = Math.round(Math.max(yt, yb) * vpr) - 1
        if (bottom <= top || top > H) continue
        const height = bottom - top
        const barH = Math.max(1, Math.round(height * 0.7))
        const barTop = top + Math.round((height - barH) / 2)
        const mid = top + height / 2
        // PUTS left of the strike, CALLS right - green dealers long gamma there, red short.
        const putLen = Math.min(barMax, Math.abs(r.put) * scale * barMax)
        if (putLen >= 0.5) {
          ctx.fillStyle = r.put >= 0 ? POS : NEG
          ctx.fillRect(putRight - putLen, barTop, Math.max(1, putLen), barH)
        }
        const callLen = Math.min(barMax, Math.abs(r.call) * scale * barMax)
        if (callLen >= 0.5) {
          ctx.fillStyle = r.call >= 0 ? POS : NEG
          ctx.fillRect(callLeft, barTop, Math.max(1, callLen), barH)
        }
        const tags = TAGS.filter((t) => l[t.key] === r.strike)
        for (const [k, t] of tags.entries()) {
          ctx.strokeStyle = t.color
          ctx.lineWidth = Math.max(1, Math.round(hpr))
          const inset = k * Math.round(2 * hpr)
          ctx.strokeRect(left + 1 + inset, top + inset, W - left - 2 - 2 * inset, Math.max(1, height - 2 * inset))
        }
        const atSpot = r === spotRow
        if (atSpot) {
          ctx.fillStyle = SPOT_BG
          ctx.fillRect(putRight + 1, top, callLeft - putRight - 2, height)
        }
        if (showLabels || atSpot || tags.length) {
          ctx.textAlign = 'center'
          ctx.fillStyle = atSpot ? '#fff' : tags.length ? tags[0].color : LABEL_DIM
          const text = `${r.strike.toLocaleString('en-IN')}${withTags && tags.length ? ` ${tags.map((t) => t.text).join('/')}` : ''}`
          ctx.fillText(text, cx, mid)
        }
        if (showValues) {
          ctx.font = `${Math.round(9 * vpr)}px sans-serif`
          ctx.fillStyle = LABEL_DIM
          if (putLen >= 0.5) { ctx.textAlign = 'right'; ctx.fillText(crShort(r.put), putRight - putLen - Math.round(2 * hpr), mid) }
          if (callLen >= 0.5) { ctx.textAlign = 'left'; ctx.fillText(crShort(r.call), callLeft + callLen + Math.round(2 * hpr), mid) }
          ctx.font = `${Math.round(10 * vpr)}px sans-serif`
        }
        if (this._hover != null && r.strike === this._hover) {
          ctx.strokeStyle = LABEL
          ctx.lineWidth = Math.max(1, hpr)
          ctx.strokeRect(left + 1, top, W - left - 2, height)
        }
      }
      // The flip across the panel.
      if (Number.isFinite(l.flip)) {
        const y = yOf(l.flip)
        if (y != null && y * vpr > head) {
          ctx.strokeStyle = FLIP
          ctx.lineWidth = Math.max(1, Math.round(hpr))
          ctx.setLineDash([Math.round(4 * hpr), Math.round(3 * hpr)])
          ctx.beginPath()
          ctx.moveTo(left, Math.round(y * vpr) + 0.5)
          ctx.lineTo(W, Math.round(y * vpr) + 0.5)
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
    })
  }
}
