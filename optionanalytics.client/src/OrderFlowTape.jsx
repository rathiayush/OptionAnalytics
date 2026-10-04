import { useMemo, useState } from 'react'
import { Card, Empty, InputNumber, Space, Tooltip, Typography } from 'antd'
import { UP_COLOR, DOWN_COLOR, AXIS_COLOR } from './shared.jsx'
import { formatVolume } from './OrderFlowCharts.jsx'

const { Text } = Typography
const IST_HHMMSS = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const MAX_ROWS = 150

// Tape reading: who is aggressive (market orders bought at the offer vs sold at the bid, over 30s / 1m
// / 5m, and how fast the tape runs), what resting limit orders are doing near price (pulled vs
// stacked), and the Time & Sales prints themselves - big prints bold, prints that were part of a sweep
// marked ⚡.
export function TapeCard({ prints, aggression, pressure, sweeps, lotSize, largeLots, error, estimated }) {
  const [minLots, setMinLots] = useState(1)
  const rows = useMemo(() => {
    const out = []
    for (let i = (prints?.length ?? 0) - 1; i >= 0 && out.length < MAX_ROWS; i--) {
      if (prints[i].quantity >= minLots * lotSize) out.push(prints[i])
    }
    return out
  }, [prints, minLots, lotSize])
  const inSweep = useMemo(() => {
    const ranges = (sweeps ?? []).map((w) => ({ from: msOf(w.startedAt), to: msOf(w.endedAt), buy: w.buy }))
    return (p) => {
      const t = msOf(p.time)
      return ranges.some((r) => r.buy === p.buy && t >= r.from && t <= r.to)
    }
  }, [sweeps])

  return (
    <Card
      size="small" title="Tape · Time & Sales"
      extra={<InputNumber size="small" value={minLots} onChange={(v) => setMinLots(Math.max(1, v ?? 1))} min={1} style={{ width: 118 }} addonBefore="≥" addonAfter="lots" aria-label="Tape minimum lots" />}
    >
      {estimated ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tape for an estimated day - Dhan keeps no tick history. Days the server saw live have it." />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <AggressionMeter windows={aggression} lotSize={lotSize} />
          {pressure && <BookPressure pressure={pressure} />}
          {error && <Text type="secondary" style={{ fontSize: 11 }}>{error}</Text>}
          <div style={{ maxHeight: 300, overflowY: 'auto', fontVariantNumeric: 'tabular-nums', fontSize: 12 }} aria-label="Time and sales">
            <div style={{ display: 'grid', gridTemplateColumns: '62px 1fr 64px 46px', gap: 6, color: AXIS_COLOR, fontSize: 11, position: 'sticky', top: 0, background: '#141414', padding: '2px 0' }}>
              <span>Time</span><span>Price</span><span style={{ textAlign: 'right' }}>Lots</span><span>Side</span>
            </div>
            {rows.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>No prints yet.</Text>}
            {rows.map((p) => {
              const big = p.quantity >= largeLots * lotSize
              const color = p.buy ? UP_COLOR : DOWN_COLOR
              return (
                <div
                  key={p.seq}
                  style={{
                    display: 'grid', gridTemplateColumns: '62px 1fr 64px 46px', gap: 6, padding: '1px 0', fontWeight: big ? 700 : 400,
                    background: big ? (p.buy ? 'rgba(38,166,154,0.16)' : 'rgba(239,83,80,0.16)') : undefined,
                  }}
                >
                  <span style={{ color: AXIS_COLOR }}>{IST_HHMMSS.format(new Date(p.time))}</span>
                  <span style={{ color }}>{p.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}{inSweep(p) ? ' ⚡' : ''}</span>
                  <span style={{ textAlign: 'right', color }}>{formatVolume(p.quantity, lotSize, true)}</span>
                  <span style={{ color }}>{p.buy ? 'BUY' : 'SELL'}</span>
                </div>
              )
            })}
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            BUY = bought at the offer (aggressive buyer, a market buy) · SELL = sold at the bid · bold = big order (≥ {largeLots} lots) · ⚡ = part of a sweep through several levels
          </Text>
        </Space>
      )}
    </Card>
  )
}

function AggressionMeter({ windows, lotSize }) {
  if (!windows?.length) return null
  return (
    <div>
      {windows.map((w) => {
        const net = w.buy - w.sell
        const verdict = w.total === 0 ? 'no prints' : w.buyPct >= 60 ? 'buyers aggressive' : w.buyPct <= 40 ? 'sellers aggressive' : 'balanced'
        return (
          <Tooltip key={w.label} title={`${w.label}: ${formatVolume(w.buy, lotSize, true)} lots bought at the offer, ${formatVolume(w.sell, lotSize, true)} sold at the bid · ${w.prints} prints (${w.perMin}/min)`}>
            <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(70px, 1fr) auto', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>{w.label}</Text>
              <div style={{ display: 'flex', height: 12, borderRadius: 3, overflow: 'hidden', background: '#ffffff14' }} aria-label={`Aggression ${w.label}`}>
                {w.total > 0 && <div style={{ width: `${w.buyPct}%`, background: UP_COLOR }} />}
                {w.total > 0 && <div style={{ width: `${100 - w.buyPct}%`, background: DOWN_COLOR }} />}
              </div>
              <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                <span style={{ color: w.total === 0 ? AXIS_COLOR : w.buyPct >= 50 ? UP_COLOR : DOWN_COLOR, fontWeight: 600 }}>{w.total > 0 ? `${w.buyPct}% buy` : '-'}</span>
                {w.total > 0 && <span style={{ color: AXIS_COLOR }}> · {net >= 0 ? '+' : ''}{formatVolume(net, lotSize, true)} · {verdict}</span>}
              </span>
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}

function BookPressure({ pressure }) {
  const line = (label, s, bullishWhenPulled) => {
    const net = s.added - s.removed
    const pulling = s.removed > s.added
    // A small net change either way is just the book breathing.
    const steady = Math.abs(net) < Math.max(1, 0.1 * s.usual)
    const color = steady ? AXIS_COLOR : (pulling === bullishWhenPulled ? UP_COLOR : DOWN_COLOR)
    return (
      <span>
        {label} <span style={{ color: UP_COLOR }}>+{s.added.toLocaleString('en-IN')}</span> / <span style={{ color: DOWN_COLOR }}>−{s.removed.toLocaleString('en-IN')}</span>
        {' '}<span style={{ color, fontWeight: 600 }}>{steady ? 'steady' : pulling ? 'pulling' : 'stacking'}</span>
      </span>
    )
  }
  return (
    <Tooltip title={`Resting limit orders added (+) and pulled (−) near price over the last ${Math.round(pressure.windowMs / 1000)}s, in lots - only rows away from the touch, so this is orders placed/cancelled, not trades. Usual near-touch depth: bids ~${pressure.bid.usual.toLocaleString('en-IN')}, offers ~${pressure.ask.usual.toLocaleString('en-IN')} lots.`}>
      <div style={{ fontSize: 11, display: 'flex', gap: 14, flexWrap: 'wrap' }} aria-label="Book pressure">
        <Text type="secondary" style={{ fontSize: 11 }}>Book {Math.round(pressure.windowMs / 1000)}s:</Text>
        {line('bids', pressure.bid, false)}
        {line('offers', pressure.ask, true)}
      </div>
    </Tooltip>
  )
}
