import { Alert, InputNumber, Space, Tooltip, Typography } from 'antd'
import { DOWN_COLOR, UP_COLOR } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { deltaBreaches } from './positionGreeks.js'

const { Text } = Typography

const rupees = (v) => {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : v > 0 ? '+' : ''
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L`
  return `${sign}₹${a.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
const lots = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—')
const tone = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)

function Figure({ label, value, color, tip }) {
  const body = (
    <div style={{ minWidth: 92 }}>
      <Text type="secondary" style={{ fontSize: 10 }}>{label}</Text>
      <div style={{ fontSize: 13, fontWeight: 600, color, lineHeight: 1.25 }}>{value}</div>
    </div>
  )
  return tip ? <Tooltip title={tip}>{body}</Tooltip> : body
}

/**
 * The order panel's POSITION GREEKS (positionGreeks.js): per index the book's net delta (lots, and its ₹ notional), gamma
 * (₹ of notional per 1% move), theta (₹ a day), vega (₹ a vol point) and the P&L of a ±1% move; what the order set on the
 * panel would change; the delta limit (`limitLots`, 0 = off) and a warning past it. A read - it places nothing.
 */
export function PositionGreeks({ book, change = null, limitLots = 0, onLimitChange, title = 'Position Greeks' }) {
  const shown = book?.byIndex?.filter((s) => s.legs > 0 || s.missing > 0) ?? []
  const breaches = deltaBreaches(book, limitLots)
  return (
    <div style={{ border: '1px solid #ffffff1f', borderRadius: 6, padding: '6px 8px' }}>
      <Space size={[10, 4]} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text strong style={{ fontSize: 12 }}>{title}</Text>
        {onLimitChange && (
          <Tooltip title="Warn when an index's net delta goes past this many lots either way (0 = off). Kept for your account.">
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>Warn past ±</Text>
              <InputNumber size="small" min={0} max={500} step={0.5} value={limitLots} onChange={(v) => onLimitChange(Number(v) || 0)} style={{ width: 70 }} aria-label="Delta limit in lots" />
              <Text type="secondary" style={{ fontSize: 11 }}>lots Δ</Text>
            </Space>
          </Tooltip>
        )}
      </Space>
      {shown.length === 0 ? <Text type="secondary" style={{ fontSize: 11 }}>No open option position.</Text> : shown.map((s) => (
        <div key={s.underlying} style={{ marginTop: 4 }}>
          {shown.length > 1 && <Text type="secondary" style={{ fontSize: 11 }}>{s.underlying}</Text>}
          <Space size={[14, 4]} wrap>
            <Figure label="Net delta" value={`${lots(s.deltaLots)} lots`} color={tone(s.delta)}
              tip={`${Math.round(s.delta).toLocaleString('en-IN')} units of ${s.underlying} - the book moves like ${lots(s.deltaLots)} lots of the index (+ long, − short).`} />
            <Figure label="Delta notional" value={rupees(s.notional)} color={tone(s.notional)}
              tip="Delta x spot: the rupees of index you are really exposed to - what the premium you paid hides on cheap out-of-the-money options." />
            <Figure label="Gamma / 1%" value={rupees(s.gammaPct)} color={tone(s.gammaPct)}
              tip="How much the delta notional changes for a 1% move up (+ bought options: it grows with the move; − sold: it turns against you)." />
            <Figure label="Theta / day" value={rupees(s.theta)} color={tone(s.theta)} tip="What one calendar day of time decay alone does to the book (spot and IV kept)." />
            <Figure label="Vega / vol pt" value={rupees(s.vega)} color={tone(s.vega)} tip="What the IV one point higher does to the book (spot and time kept)." />
            <Figure label="±1% move" value={<span><span style={{ color: tone(s.pnlUp) }}>{rupees(s.pnlUp)}</span> / <span style={{ color: tone(s.pnlDown) }}>{rupees(s.pnlDown)}</span></span>}
              tip="The P&L a 1% move up / down would make now, from the delta and gamma (IV and time kept)." />
          </Space>
          {(s.missing > 0 || s.intrinsic > 0) && (
            <div><Text type="secondary" style={{ fontSize: 10 }}>
              {s.missing > 0 && `${s.missing} leg${s.missing > 1 ? 's' : ''} not worked out (no spot or expiry for it yet). `}
              {s.intrinsic > 0 && `${s.intrinsic} at intrinsic value (no IV from its premium) - counted as delta 1 / 0.`}
            </Text></div>
          )}
        </div>
      ))}
      {breaches.map((s) => (
        <Alert key={s.underlying} type="error" showIcon style={{ marginTop: 6, padding: '2px 8px', fontSize: 12 }}
          message={`${s.underlying}: net delta ${lots(s.deltaLots)} lots is past your ±${limitLots} limit (${rupees(s.notional)} of index).`} />
      ))}
      {change && (
        <div style={{ marginTop: 4 }}>
          <Text style={{ fontSize: 11, color: change.breaches ? DOWN_COLOR : undefined }}>
            This order: Δ {lots(change.adds)} lots ({rupees(change.notionalAdds)}) → net {lots(change.after)} lots{change.breaches ? ` - past your ±${limitLots} limit` : ''}
          </Text>
        </div>
      )}
      <FoldText id="positionGreeks.note" label="how it is worked out" className="oa-note" style={{ marginTop: 2 }}>
        <Text type="secondary" style={{ fontSize: 10 }}>
          Each leg priced Black-76 on the spot with the IV of its own premium, to 15:30 on its expiry day; x its quantity (+ bought, − sold) and added up per index. Delta notional = delta x spot. A read - nothing is placed.
        </Text>
      </FoldText>
    </div>
  )
}
