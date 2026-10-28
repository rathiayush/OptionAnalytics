import { Empty, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { suddenWallText } from './suddenOi.js'

const { Text } = Typography

const STATE = {
  absorption: { label: 'ABSORPTION', tip: 'Heavy aggression into the wall and the wall held (or refilled): the other side is being absorbed - a turn away from the wall is likely.' },
  exhaustion: { label: 'EXHAUSTION', tip: 'Price pressing toward the wall on fading volume and a shrinking delta: the push is running out before the wall.' },
  break: { label: 'WALL BREAKING', tip: 'The wall is being eaten (its size falling while it trades): the move is likely to continue into the next zone.' },
  pulled: { label: 'WALL PULLED', tip: 'The wall vanished with little traded there - it was not real (spoofing). Price usually slips the way it was "protecting".' },
  testing: { label: 'TESTING WALL', tip: 'Price is at a wall with no absorption or exhaustion read yet - watch whether it holds or breaks.' },
  vacuum: { label: 'THIN ZONE', tip: 'Little resting liquidity here - price can move fast through it, the way the flow points.' },
  between: { label: 'BETWEEN WALLS', tip: 'No wall in play - the drift the book and the delta lean to.' },
}
const fmt = (p) => (p == null ? '-' : Number.isInteger(p) ? p.toLocaleString('en-IN') : p.toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`

/** The heatmap read: what is happening now and the possible move, the support / resistance walls with
 *  what lines up at each, the high / low liquidity zones, and the sudden OI walls. */
export function LiquidityMapCard({ map, sudden = [], basis = null, estimated }) {
  if (estimated) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No liquidity map for an estimated day - it needs market depth." />
  if (!map) return <Text type="secondary">Waiting for 5+ book snapshots…</Text>
  const now = map.now
  const st = STATE[now.state] ?? { label: now.state.toUpperCase() }
  const color = now.bullish == null ? undefined : now.bullish ? UP_COLOR : DOWN_COLOR
  const tol = (w) => Math.max(2 * (Math.abs(w.high - w.low) || 1), 0.0003 * Math.abs(w.price))
  const linesUp = (w) => map.confluence.filter((g) => Math.abs(g.price - w.price) <= tol(w) && g.kinds.some((k) => k !== 'heatmap'))
    .flatMap((g) => g.parts.filter((x) => x.kind !== 'heatmap').map((x) => x.label))
  const rows = [
    ...map.resistance.slice(0, 4).reverse().map((w) => ({ ...w, key: `r${w.price}` })),
    ...map.support.slice(0, 4).map((w) => ({ ...w, key: `s${w.price}` })),
  ]
  const columns = [
    { title: 'Level', key: 'level', width: 110, render: (_, w) => <Text strong>{w.low === w.high ? fmt(w.price) : `${fmt(w.low)}–${fmt(w.high)}`}</Text> },
    { title: 'Type', key: 'type', width: 92, render: (_, w) => <Tag color={w.kind === 'support' ? 'green' : 'red'} style={{ margin: 0 }}>{w.kind === 'support' ? 'Support' : 'Resistance'}</Tag> },
    { title: 'Distance', key: 'dist', width: 76, render: (_, w) => signed(w.distance) },
    { title: 'Resting', key: 'size', width: 110, render: (_, w) => <Tooltip title={`${w.strength.toFixed(1)}x the book's median row`}>{w.lots.toLocaleString('en-IN')} lots · {w.strength.toFixed(1)}x</Tooltip> },
    { title: 'Stays', key: 'presence', width: 64, render: (_, w) => <Tooltip title={`A wall in ${Math.round(w.presence * 100)}% of the last ${map.windowMin} min of snapshots`}>{Math.round(w.presence * 100)}%</Tooltip> },
    { title: 'Now', key: 'trend', width: 86, render: (_, w) => <Tag color={w.trend === 'building' ? 'blue' : w.trend === 'pulling' ? 'orange' : 'default'} style={{ margin: 0 }}>{w.trend}</Tag> },
    { title: 'Lines up with', key: 'conf', render: (_, w) => { const l = linesUp(w); return l.length ? <Text style={{ fontSize: 11 }}>{l.join(' · ')}</Text> : <Text type="secondary" style={{ fontSize: 11 }}>heatmap only</Text> } },
  ]
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }} aria-label="Liquidity map">
      <div style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${color ?? '#ffffff33'}`, background: '#ffffff08' }}>
        <Space wrap size={8} align="center">
          <Tooltip title={st.tip}><Tag color={now.bullish == null ? 'default' : now.bullish ? 'green' : 'red'} style={{ margin: 0, fontWeight: 700 }}>{st.label}</Tag></Tooltip>
          <Text style={{ fontSize: 13 }}>{now.text}</Text>
        </Space>
        <div style={{ marginTop: 4, fontSize: 14 }}>
          Possible move: <b style={{ color }}>{now.move.dir > 0 ? '▲ ' : now.move.dir < 0 ? '▼ ' : ''}{now.move.text}</b>
          <Text type="secondary" style={{ fontSize: 11 }}> · {now.confidence}% confidence · a read of the book, not advice</Text>
        </div>
      </div>

      {rows.length
        ? <Table dataSource={rows} columns={columns} rowKey="key" size="small" pagination={false} scroll={{ x: 640 }} aria-label="Liquidity levels" />
        : <Text type="secondary" style={{ fontSize: 12 }}>No wall has stayed in the book over the last {map.windowMin} min.</Text>}

      {map.confluence.length > 0 && (
        <div>
          <Text strong style={{ fontSize: 12 }}>Confluence (strongest first): </Text>
          {map.confluence.slice(0, 6).map((g) => (
            <Tooltip key={`${g.price}`} title={g.items.join(' · ')}>
              <Tag color={g.strength === 'Strong' ? (g.side === 'support' ? 'green' : g.side === 'resistance' ? 'red' : 'gold') : 'default'} style={{ marginBottom: 4 }}>
                {g.side === 'support' ? 'S' : g.side === 'resistance' ? 'R' : '='} {fmt(g.price)} · {g.strength} ({g.kinds.length} lines)
              </Tag>
            </Tooltip>
          ))}
        </div>
      )}

      <div>
        <Text strong style={{ fontSize: 12 }}>Zones: </Text>
        {map.zones.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>none stand out</Text>}
        {[...map.zones].sort((a, b) => b.low - a.low).map((z) => (
          <Tooltip key={`${z.kind}${z.low}`} title={z.kind === 'high' ? 'High liquidity: a lot resting here - price tends to slow, stall or turn at it.' : 'Low liquidity: little resting here - price tends to move fast through it.'}>
            <Tag color={z.kind === 'high' ? 'orange' : 'geekblue'} style={{ marginBottom: 4 }}>
              {z.kind === 'high' ? 'High' : 'Low'} {fmt(z.low)}–{fmt(z.high)} ({z.side === 'bid' ? 'bids' : 'offers'}, {z.rel.toFixed(1)}x)
            </Tag>
          </Tooltip>
        ))}
      </div>

      <div aria-label="Sudden OI walls">
        <Text strong style={{ fontSize: 12 }}>Sudden OI walls: </Text>
        {sudden.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>none in the last 5 min</Text>}
        {sudden.map((w) => (
          <Tooltip key={`${w.side}${w.strike}`} title={`${suddenWallText(w)}${basis != null ? ` · ${fmt(w.strike + basis)} in futures terms` : ''}`}>
            <Tag color={w.side === 'PE' ? 'green' : 'red'} style={{ marginBottom: 4 }}>
              {w.side === 'PE' ? 'PUT' : 'CALL'} {w.strike} +{(w.add / 1e5).toFixed(1)}L ({(w.pct * 100).toFixed(1)}%){basis != null ? ` · fut ${fmt(Math.round(w.strike + basis))}` : ''}
            </Tag>
          </Tooltip>
        ))}
      </div>
      <Text className="oa-note" type="secondary" style={{ fontSize: 11 }}>
        Read off the last {map.windowMin} min of the heatmap: walls that stay (3x+ the book&apos;s median, in 60%+ of the snapshots), zones of
        high / low resting liquidity, and what lines up at each wall (OI walls, sudden OI walls, POC / value area / HVN, VWAP, the previous
        day&apos;s high / low, icebergs). The read at the top comes from the wall price is at and the last 3 minutes&apos; footprints.
      </Text>
    </Space>
  )
}
