import { useMemo } from 'react'
import { Segmented, Typography } from 'antd'
import { usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { cdvObvProfiles } from './tickDeltaProfile.js'

const { Text } = Typography
const GREEN = '#26a69a'
const RED = '#ef5350'
const ROW_H = 16
const ROW_CHOICES = { NIFTY: [5, 10, 25, 50], BANKNIFTY: [10, 20, 50, 100] }
const COLUMNS = [
  { key: 'cdv', title: 'CDV (aggressor delta)', note: 'lots bought at the ask less lots sold at the bid on the options' },
  { key: 'obv', title: 'OBV (premium up / down)', note: "each order's lots signed by whether the option's premium rose (+) or fell (−) from its tick before" },
]

/** The option CDV / OBV PROFILE on TrueData's ticks, by the futures' price row (tickDeltaProfile.js `cdvObvProfiles`); Net (CE − PE), CE or PE alone. */
export function TickCdvObvProfileCard({ orders, priceBars, index }) {
  const choices = ROW_CHOICES[index] ?? ROW_CHOICES.NIFTY
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.tickFlow.optProfileRows', {})
  const [side, setSide] = usePersistedState('optionanalytics.tickFlow.cdvObvSide', 'net')
  const rowSize = choices.includes(rowSizes?.[index]) ? rowSizes[index] : choices[1]
  const profile = useMemo(() => cdvObvProfiles(orders, priceBars, rowSize, side), [orders, priceBars, rowSize, side])
  const { rows } = profile
  const maxes = useMemo(() => Object.fromEntries(COLUMNS.map((c) => [c.key, Math.max(1e-9, ...rows.map((r) => Math.abs(r[c.key])))])), [rows])
  const colW = 170
  const gutter = 64

  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 6 }}>
        <Text strong>Option CDV / OBV profile · on the futures' price rows</Text>
        <Segmented size="small" value={side} onChange={setSide} options={[{ value: 'net', label: 'Net (CE − PE)' }, { value: 'ce', label: 'CE' }, { value: 'pe', label: 'PE' }]} />
        <Segmented size="small" value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [index]: v })} options={choices.map((c) => ({ value: c, label: `${c} pt` }))} />
        {COLUMNS.map((c) => <Text key={c.key} style={{ fontSize: 12 }}>{c.key.toUpperCase()}: <b style={{ color: profile[c.key] > 0 ? GREEN : profile[c.key] < 0 ? RED : undefined }}>{Math.round(profile[c.key]).toLocaleString('en-IN')} lots</b></Text>)}
      </div>
      {rows.length === 0
        ? <Text type="secondary">No big option order with a futures price yet.</Text>
        : (
          <div style={{ overflow: 'auto', maxHeight: 460 }}>
            <svg width={gutter + colW * COLUMNS.length} height={ROW_H * rows.length + 22} role="img" aria-label="Option CDV and OBV profile">
              {COLUMNS.map((c, ci) => <text key={c.key} x={gutter + colW * ci + colW / 2} y={11} textAnchor="middle" fontSize="11" fill="#8c8c8c">{c.title}</text>)}
              {rows.map((r, i) => {
                const y = 18 + i * ROW_H
                return (
                  <g key={r.price}>
                    <text x={gutter - 6} y={y + ROW_H / 2 + 4} textAnchor="end" fontSize="11" fill="#d9d9d9">{r.price}</text>
                    {COLUMNS.map((c, ci) => {
                      const v = r[c.key]
                      const cx = gutter + colW * ci + colW / 2
                      const w = (Math.abs(v) / maxes[c.key]) * (colW / 2 - 8)
                      return (
                        <g key={c.key}>
                          <line x1={cx} x2={cx} y1={y} y2={y + ROW_H} stroke="#303030" />
                          {v !== 0 && <rect x={v > 0 ? cx : cx - w} y={y + 2} width={Math.max(1, w)} height={ROW_H - 4} fill={v > 0 ? GREEN : RED} opacity="0.85"><title>{`${r.price} · ${c.key.toUpperCase()}: ${Math.round(v).toLocaleString('en-IN')} lots`}</title></rect>}
                        </g>
                      )
                    })}
                  </g>
                )
              })}
            </svg>
          </div>
        )}
      <FoldText id="tickCdvObvProfile.how" className="oa-note" summary="How the option CDV / OBV profile is worked out">
        <div style={{ fontSize: 12 }}>
          {COLUMNS.map((c) => <div key={c.key}><b>{c.title}</b> - {c.note}.</div>)}
          <div>Net (CE − PE) flips a put (a put bought, or a put whose premium rose, is bearish); CE / PE show that option alone. Positive green = buying / premium rising. The big orders the filters above let through only, on the futures' price row of their minute; up to the replay clock on a replayed day. A read - no signal, alert or order.</div>
        </div>
      </FoldText>
    </div>
  )
}
