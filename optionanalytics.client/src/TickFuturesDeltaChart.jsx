import { useMemo } from 'react'
import { Segmented, Typography } from 'antd'
import { usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { aggregateTickBars, cumulativeDelta, msOf } from './tickFlowMath.js'

const { Text } = Typography
const GREEN = '#26a69a'
const RED = '#ef5350'
const YELLOW = '#faad14'
const W = 900
const H = 260
const PAD = { l: 52, r: 56, t: 14, b: 22 }
const TIMEFRAMES = [1, 3, 5, 15]
const timeText = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })

/** The near futures' DELTA and CUMULATIVE DELTA (asked for): a histogram of each bucket's buy − sell (lots, green / red) with the running sum from the day's first
 *  bucket as a yellow line on its own scale at the right - from the same footprint bars the page draws (TrueData's trade prints, each on the side of the quote
 *  before it). Up to the replay clock on a replayed day. */
export function TickFuturesDeltaChart({ dayBars, lotSize }) {
  const [tf, setTf] = usePersistedState('optionanalytics.tickFlow.deltaChartTf', 5)
  const lot = Math.max(1, lotSize || 1)
  const data = useMemo(() => {
    const bars = aggregateTickBars(dayBars ?? [], tf)
    const cum = cumulativeDelta(bars)
    return bars.map((b, i) => ({ ms: msOf(b.time), delta: (b.buy - b.sell) / lot, cum: (cum[i] ?? 0) / lot, vol: (b.buy + b.sell) / lot }))
  }, [dayBars, tf, lot])

  const dMax = Math.max(1e-9, ...data.map((d) => Math.abs(d.delta)))
  const cLo = Math.min(0, ...data.map((d) => d.cum))
  const cHi = Math.max(0, ...data.map((d) => d.cum))
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const slot = plotW / Math.max(30, data.length)
  const yD = (v) => PAD.t + plotH / 2 - (v / dMax) * (plotH / 2)
  const yC = (v) => PAD.t + (1 - (v - cLo) / (cHi - cLo || 1)) * plotH
  const last = data.at(-1)

  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 6 }}>
        <Text strong>{`Futures delta & cumulative delta · ${tf} min`}</Text>
        <Segmented size="small" value={tf} onChange={setTf} options={TIMEFRAMES.map((v) => ({ value: v, label: `${v}m` }))} />
        {last && <Text style={{ fontSize: 12 }}>Cumulative: <b style={{ color: last.cum >= 0 ? GREEN : RED }}>{`${last.cum >= 0 ? '+' : ''}${Math.round(last.cum).toLocaleString('en-IN')} lots`}</b> · last bucket <b style={{ color: last.delta >= 0 ? GREEN : RED }}>{`${last.delta >= 0 ? '+' : ''}${Math.round(last.delta).toLocaleString('en-IN')}`}</b></Text>}
      </div>
      {data.length === 0
        ? <Text type="secondary">No futures trades yet.</Text>
        : (
          <div style={{ overflowX: 'auto' }}>
            <svg width={W} height={H} role="img" aria-label="Futures delta and cumulative delta">
              <line x1={PAD.l} x2={W - PAD.r} y1={yD(0)} y2={yD(0)} stroke="#303030" />
              <text x={PAD.l - 6} y={PAD.t + 8} textAnchor="end" fontSize="10" fill="#8c8c8c">{`+${Math.round(dMax)}`}</text>
              <text x={PAD.l - 6} y={yD(0) + 4} textAnchor="end" fontSize="10" fill="#8c8c8c">0</text>
              <text x={PAD.l - 6} y={H - PAD.b} textAnchor="end" fontSize="10" fill="#8c8c8c">{`−${Math.round(dMax)}`}</text>
              <text x={W - PAD.r + 6} y={PAD.t + 8} fontSize="10" fill={YELLOW}>{Math.round(cHi).toLocaleString('en-IN')}</text>
              <text x={W - PAD.r + 6} y={H - PAD.b} fontSize="10" fill={YELLOW}>{Math.round(cLo).toLocaleString('en-IN')}</text>
              {data.map((d, i) => {
                const x = PAD.l + i * slot
                const top = Math.min(yD(0), yD(d.delta))
                return <rect key={d.ms} x={x + 1} y={top} width={Math.max(1, slot - 2)} height={Math.max(1, Math.abs(yD(d.delta) - yD(0)))} fill={d.delta >= 0 ? GREEN : RED} opacity="0.85"><title>{`${timeText(d.ms)} · delta ${Math.round(d.delta)} lots · cumulative ${Math.round(d.cum)} · volume ${Math.round(d.vol)}`}</title></rect>
              })}
              <polyline fill="none" stroke={YELLOW} strokeWidth="1.8" points={data.map((d, i) => `${(PAD.l + i * slot + slot / 2).toFixed(1)},${yC(d.cum).toFixed(1)}`).join(' ')} />
              <text x={PAD.l} y={H - 6} fontSize="10" fill="#8c8c8c">{timeText(data[0].ms)}</text>
              <text x={PAD.l + (data.length - 1) * slot + slot} y={H - 6} fontSize="10" fill="#8c8c8c" textAnchor="end">{timeText(last.ms)}</text>
            </svg>
          </div>
        )}
      <FoldText id="tickFuturesDelta.how" className="oa-note" summary="How delta and cumulative delta are worked out">
        <div style={{ fontSize: 12 }}>
          <div><b>Delta</b> - each bucket's aggressor buy volume less sell volume of the near futures, in lots (bars: green buyers, red sellers; scale at the left).</div>
          <div><b>Cumulative delta</b> - the running sum from the day's first bucket (yellow line; scale at the right). A rising line with a falling price, or the opposite, is a divergence to look at on the footprint. A read - no signal, alert or order.</div>
        </div>
      </FoldText>
    </div>
  )
}
