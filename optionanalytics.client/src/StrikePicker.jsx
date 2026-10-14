import { Button, Segmented, Space, Typography } from 'antd'

const { Text } = Typography

// Strikes are stored as an offset in strikes from ATM (strike = ATM + offset x step), so a selection
// keeps meaning the same thing as ATM drifts. This picker shows it the way a trader thinks about it:
// ITM / ATM / OTM and how many strikes away - which direction that is depends on the side. A CE is
// in the money BELOW spot and a PE ABOVE it, so "ATM+3" (what the old dropdown said) was 3 OTM for a
// CE but 3 ITM for a PE.

// { kind: 'ATM' | 'ITM' | 'OTM', depth } for an offset on a side.
export function moneyness(offset, side) {
  if (!offset) return { kind: 'ATM', depth: 0 }
  const itm = side === 'PE' ? offset > 0 : offset < 0
  return { kind: itm ? 'ITM' : 'OTM', depth: Math.abs(offset) }
}

// "ATM" / "2 ITM" / "3 OTM".
export function moneynessLabel(offset, side) {
  const { kind, depth } = moneyness(offset, side)
  return kind === 'ATM' ? 'ATM' : `${depth} ${kind}`
}

// The offset for a moneyness on a side.
export function offsetFor(kind, depth, side) {
  if (kind === 'ATM' || !depth) return 0
  const below = (kind === 'ITM') === (side !== 'PE') // CE ITM and PE OTM sit below ATM
  return below ? -depth : depth
}

export function StrikePicker({ atmStrike, step, side, offset, onChange, maxDepth = 10, size = 'middle', showStrike = true }) {
  const disabled = atmStrike == null || !step
  const { kind, depth } = moneyness(offset, side)
  const strike = disabled ? null : atmStrike + offset * step
  const setDepth = (next) => onChange(offsetFor(kind, Math.max(1, Math.min(maxDepth, next)), side))

  return (
    <Space size={6} wrap align="center">
      <Segmented
        size={size} disabled={disabled} value={kind}
        options={[{ label: 'ITM', value: 'ITM' }, { label: 'ATM', value: 'ATM' }, { label: 'OTM', value: 'OTM' }]}
        onChange={(next) => onChange(offsetFor(next, next === 'ATM' ? 0 : Math.max(1, depth), side))}
      />
      {kind !== 'ATM' && (
        <Space.Compact size={size}>
          <Button size={size} disabled={disabled || depth <= 1} onClick={() => setDepth(depth - 1)} aria-label="Closer to ATM">−</Button>
          <Button size={size} style={{ pointerEvents: 'none', minWidth: 34 }}>{depth}</Button>
          <Button size={size} disabled={disabled || depth >= maxDepth} onClick={() => setDepth(depth + 1)} aria-label="Further from ATM">+</Button>
        </Space.Compact>
      )}
      {showStrike && (
        <Text strong style={{ fontSize: size === 'small' ? 12 : 13, whiteSpace: 'nowrap' }}>
          {strike != null ? `${strike.toLocaleString('en-IN')} ${side}` : '—'}
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>{` · ${moneynessLabel(offset, side)}`}</Text>
        </Text>
      )}
    </Space>
  )
}
