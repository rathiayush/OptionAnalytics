import { PREV_PROFILE } from './profileColors.js'
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

/** How the bars are drawn: the longest (the POC row's) `widthPct` of the plot, the value area's rows at `alphaIn` and the
 *  rest at `alphaOut`, a row with no buy / sell split of its own (the index's volume, the spot profile's server-side
 *  bins) one bar in `neutral`; `tip` - a brighter line at each bar's end, so its length reads over a coloured box.
 *  These defaults are OI Replay's: the previous day's profile, faint behind its candles. The Profiles page, where the
 *  profile is what the chart is for, draws them wider and solid (`PROFILE_PAGE_BARS`). */
export const DEFAULT_BAR_STYLE = Object.freeze({ widthPct: 0.28, alphaIn: 0.42, alphaOut: 0.18, neutral: [150, 170, 200], tip: false })
export const PROFILE_PAGE_BARS = Object.freeze({ alphaIn: 0.82, alphaOut: 0.55, neutral: [77, 148, 255], tip: true })

export class VolumeProfilePrimitive {
  constructor(style = {}) {
    this._profile = null
    this._rowSize = 0
    this._style = { ...DEFAULT_BAR_STYLE, ...style }
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

  /** Changes how the bars are drawn (DEFAULT_BAR_STYLE's keys; the ones not given stay). */
  setStyle(style) {
    this._style = { ...this._style, ...style }
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
    const { widthPct, alphaIn, alphaOut, neutral, tip } = this._style
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const maxLen = bitmapSize.width * widthPct
      const right = bitmapSize.width
      const tipWidth = Math.max(1, Math.round(hpr))
      for (const row of profile.rows) {
        const yTop = series.priceToCoordinate(row.price + this._rowSize)
        const yBottom = series.priceToCoordinate(row.price)
        if (yTop == null || yBottom == null) continue
        const top = Math.round(Math.min(yTop, yBottom) * vpr) + 1
        const height = Math.max(1, Math.round(Math.abs(yBottom - yTop) * vpr) - 1)
        if (top > bitmapSize.height || top + height < 0) continue
        const inValue = row.price >= profile.val && row.price <= profile.vah
        const alpha = inValue ? alphaIn : alphaOut
        const buy = row.buy ?? 0
        const sell = row.sell ?? 0
        // Bins with no side of their own (binsProfile) are one neutral bar as wide as the whole row.
        const parts = buy > 0 || sell > 0
          ? [[buy, BUY], [sell, SELL]]
          : [[row.total ?? 0, neutral]]
        let x = right
        let last = null
        for (const [value, color] of parts) {
          const len = (value / profile.maxRow) * maxLen
          if (!(len > 0)) continue
          ctx.fillStyle = rgba(color, alpha)
          ctx.fillRect(x - len, top, len, height)
          x -= len
          last = color
        }
        if (tip && last && right - x >= tipWidth) {
          ctx.fillStyle = rgba(last, Math.min(1, alpha + 0.3))
          ctx.fillRect(Math.round(x), top, tipWidth, height)
        }
        if (row.price === profile.poc) {
          ctx.strokeStyle = 'rgba(250,219,20,0.9)'
          ctx.lineWidth = Math.max(1, hpr)
          ctx.strokeRect(x, top, right - x, height)
        }
      }
    })
  }
}

// The futures chart's profile is the PREVIOUS session's - the previous session's colours, as on every other chart
// (profileColors.js). HVN / LVN dotted, like the entry charts'.
const LINE_STYLES = {
  POC: { color: PREV_PROFILE.poc, lineStyle: 0 }, VAH: { color: PREV_PROFILE.va, lineStyle: 2 }, VAL: { color: PREV_PROFILE.va, lineStyle: 2 },
  HVN: { color: PREV_PROFILE.hvn, lineStyle: 1 }, LVN: { color: PREV_PROFILE.lvn, lineStyle: 1 },
}

// Replaces the POC / VAH / VAL (and, when the profile has them - profiles.profileNodes - its one HVN and one LVN)
// price lines on `series`; returns the new lines for the next call.
// A row's line sits at the row's middle (POC, HVN, LVN) or its outer edge (VAH top, VAL bottom).
// `pocLabel` is added to the POC line's title (" (20 Oct)" for a previous day's profile).
export function setProfileLines(series, previous, profile, rowSize, pocLabel = '') {
  for (const line of previous ?? []) series.removePriceLine(line)
  if (!profile?.rows?.length || !(rowSize > 0)) return []
  const at = { POC: profile.poc + rowSize / 2, VAH: profile.vah + rowSize, VAL: profile.val }
  if (profile.hvnTop != null) at.HVN = profile.hvnTop + rowSize / 2
  if (profile.lvnTop != null) at.LVN = profile.lvnTop + rowSize / 2
  return Object.entries(at).map(([title, price]) => series.createPriceLine({
    price, title: title === 'POC' ? `${title}${pocLabel}` : title, lineWidth: 1, axisLabelVisible: true, ...LINE_STYLES[title],
  }))
}
