import { useMemo } from 'react'
import { Typography } from 'antd'
import { FoldText } from './FoldText.jsx'
import { cumulativeSeries } from './tickDeltaProfile.js'

const { Text } = Typography
const PANES = [
  { key: 'fut', title: 'Futures cumulative delta (lots)', color: '#40a9ff', bullish: 'up' },
  { key: 'net', title: 'Option net flow, CE − PE (lots, cumulative)', color: '#26a69a', bullish: 'up' },
  { key: 'oi', title: 'OI CE − PE added (lots, cumulative)', color: '#faad14', bullish: 'down' },
]
const W = 900
const PANE_H = 110
const PAD = { l: 8, r: 70, t: 18, b: 6 }

const timeText = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })

/** Three stacked lines through the day (tickDeltaProfile.js `cumulativeSeries`): the futures' cumulative delta, the options' net CE − PE flow and the OI CE − PE added. */
export function TickCumulativeCard({ orders, flowBars, lotSize }) {
  const series = useMemo(() => cumulativeSeries(orders, flowBars, lotSize), [orders, flowBars, lotSize])
  const t0 = series[0]?.ms
  const t1 = series.at(-1)?.ms
  return (
    <div style={{ margin: '12px 0' }}>
      <Text strong>Cumulative delta · futures, option net flow and OI (CE − PE)</Text>
      {series.length < 2
        ? <div><Text type="secondary">Waiting for a few minutes of ticks.</Text></div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <svg width={W} height={PANE_H * PANES.length + 20} role="img" aria-label="Cumulative delta and OI lines">
              {PANES.map((p, pi) => {
                const vals = series.map((s) => s[p.key])
                const lo = Math.min(0, ...vals)
                const hi = Math.max(0, ...vals)
                const span = hi - lo || 1
                const top = pi * PANE_H
                const x = (ms) => PAD.l + ((ms - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r)
                const y = (v) => top + PAD.t + (1 - (v - lo) / span) * (PANE_H - PAD.t - PAD.b)
                const last = vals.at(-1)
                const bullish = p.bullish === 'up' ? last > 0 : last < 0
                return (
                  <g key={p.key}>
                    <text x={PAD.l} y={top + 12} fontSize="11" fill="#8c8c8c">{p.title}</text>
                    <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#303030" strokeDasharray="3 3" />
                    <polyline fill="none" stroke={p.color} strokeWidth="1.6" points={series.map((s) => `${x(s.ms).toFixed(1)},${y(s[p.key]).toFixed(1)}`).join(' ')} />
                    <text x={W - PAD.r + 6} y={y(last) + 4} fontSize="11" fill={last === 0 ? '#8c8c8c' : bullish ? '#26a69a' : '#ef5350'}>{`${last >= 0 ? '+' : ''}${Math.round(last).toLocaleString('en-IN')}`}</text>
                  </g>
                )
              })}
              <text x={PAD.l} y={PANE_H * PANES.length + 14} fontSize="10" fill="#8c8c8c">{timeText(t0)}</text>
              <text x={W - PAD.r} y={PANE_H * PANES.length + 14} fontSize="10" fill="#8c8c8c" textAnchor="end">{timeText(t1)}</text>
            </svg>
          </div>
        )}
      <FoldText id="tickCumulative.how" className="oa-note" summary="How these three lines are worked out">
        <div style={{ fontSize: 12 }}>
          <div><b>Futures cumulative delta</b> - the footprint's buy − sell, added up from the first minute, in lots.</div>
          <div><b>Option net flow</b> - calls' flow less puts' flow (call bought / put sold +), added up; rising = bullish.</div>
          <div><b>OI CE − PE added</b> - call OI added less put OI added, added up; FALLING (negative) = puts written = bullish, the writer's view.</div>
          <div>The two option lines count only the big orders the filters above let through, up to the end of each minute (the replay clock on a replayed day); the OI line moves only where a big order's OI changed. A read - no signal, alert or order.</div>
        </div>
      </FoldText>
    </div>
  )
}
