import { useMemo } from 'react'
import { Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import { LineStyle } from 'lightweight-charts'
import { AXIS_COLOR, DOWN_COLOR, UP_COLOR, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { LinesChart } from './StraddleCard.jsx'
import { useFitHeight } from './DashboardCard.jsx'
import { FoldText } from './FoldText.jsx'
import { SKEW_DEFAULTS, SKEW_READ_TABLE, skewDay, skewRead, skewUpTo } from './volSkew.js'

const { Text } = Typography

const RR_COLOR = '#ff7a45'
const ATM_COLOR = '#4c9ffe'
const BF_COLOR = '#b37feb'
const OPEN_COLOR = '#8c8c8c'
const WINDOWS = [15, 30, 60]

const vol = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—')
const signed = (v, d = 2) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}` : '—')
const hhmm = (ms) => (ms == null ? '—' : istTimeFormatter(toChartTime(ms)))
const changeColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const readColor = (key) => ({ fearConfirms: 'red', hedgedRally: 'orange', fearBuilding: 'orange', putsFade: 'green', callChase: 'green', fearEasing: 'cyan' }[key] ?? 'default')

/** The smile at the clock (solid) against the first minute's (dotted): IV by strike, the forward marked - an SVG. */
function SmileChart({ now, open, height: asked = 220 }) {
  const height = useFitHeight(asked)
  const points = [...(now?.smile ?? []), ...(open?.smile ?? [])]
  if (!points.length) return <Text type="secondary" style={{ fontSize: 12 }}>No smile to draw yet.</Text>
  const W = 640, H = height, pad = { l: 44, r: 12, t: 10, b: 26 }
  const ks = points.map((p) => p.strike), ivs = points.map((p) => p.iv)
  const kMin = Math.min(...ks), kMax = Math.max(...ks)
  const lo = Math.floor(Math.min(...ivs) - 0.5), hi = Math.ceil(Math.max(...ivs) + 0.5)
  const x = (k) => pad.l + ((k - kMin) / Math.max(1, kMax - kMin)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - lo) / Math.max(0.01, hi - lo)) * (H - pad.t - pad.b)
  const path = (smile) => [...smile].sort((a, b) => a.strike - b.strike).map((p, i) => `${i ? 'L' : 'M'}${x(p.strike).toFixed(1)},${y(p.iv).toFixed(1)}`).join(' ')
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4)
  const xTicks = Array.from({ length: 5 }, (_, i) => Math.round((kMin + ((kMax - kMin) * i) / 4) / 50) * 50)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Implied volatility by strike">
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#ffffff14" />
          <text x={pad.l - 6} y={y(v) + 4} fill={AXIS_COLOR} fontSize="11" textAnchor="end">{v.toFixed(1)}</text>
        </g>
      ))}
      {xTicks.map((k) => <text key={`x${k}`} x={x(k)} y={H - 8} fill={AXIS_COLOR} fontSize="11" textAnchor="middle">{k}</text>)}
      {now?.forward != null && now.forward >= kMin && now.forward <= kMax && (
        <g>
          <line x1={x(now.forward)} x2={x(now.forward)} y1={pad.t} y2={H - pad.b} stroke="#ffffff55" strokeDasharray="3 3" />
          <text x={x(now.forward) + 4} y={pad.t + 10} fill={AXIS_COLOR} fontSize="10">F {Math.round(now.forward)}</text>
        </g>
      )}
      {open?.smile?.length ? <path d={path(open.smile)} fill="none" stroke={OPEN_COLOR} strokeWidth="1.5" strokeDasharray="4 3" /> : null}
      {now?.smile?.length ? <path d={path(now.smile)} fill="none" stroke={RR_COLOR} strokeWidth="2" /> : null}
      {now?.smile?.map((p) => <circle key={p.strike} cx={x(p.strike)} cy={y(p.iv)} r="2.2" fill={p.side === 'put' ? DOWN_COLOR : UP_COLOR} />)}
    </svg>
  )
}

function ReadTable({ active }) {
  return (
    <div style={{ fontSize: 12, maxWidth: 460 }}>
      <div style={{ marginBottom: 6 }}>RR25 = 25-delta call IV − 25-delta put IV (vol points). An index&apos;s is usually negative (puts richer). Read its CHANGE against price:</div>
      {SKEW_READ_TABLE.map((r) => (
        <div key={r.key} style={{ padding: '2px 4px', background: r.key === active ? '#1668dc55' : undefined, borderRadius: 3 }}>
          <b>{r.read}</b> - price {r.price}, RR {r.rr}: {r.detail}
        </div>
      ))}
      <div style={{ marginTop: 6, opacity: 0.8 }}>A read, not a signal - it feeds no strategy or alert.</div>
    </div>
  )
}

/**
 * OI Replay's VOLATILITY SKEW card (volSkew.js): the smile now against the open's, the 25-delta risk reversal / butterfly and
 * the ATM IV through the day, and the read of the risk reversal's change against price. `cePoints` / `pePoints` / `spotBars`
 * / `expiry` - the straddle card's inputs; `asOfMs` - the replay clock (null live).
 */
export function VolSkewCard({ cePoints, pePoints, spotBars, expiry, asOfMs, dayKey }) {
  const [windowMin, setWindowMin] = usePersistedState('optionanalytics.oiReplay.skewWindow', SKEW_DEFAULTS.window)
  const win = WINDOWS.includes(windowMin) ? windowMin : SKEW_DEFAULTS.window
  const day = useMemo(() => skewDay(cePoints, pePoints, spotBars, { expiry }), [cePoints, pePoints, spotBars, expiry])
  const minutes = useMemo(() => skewUpTo(day, asOfMs), [day, asOfMs])
  const read = useMemo(() => skewRead(minutes, { window: win }), [minutes, win])
  const now = minutes.at(-1)
  const open = minutes.find((m) => m.smile.length)
  const lines = useMemo(() => {
    const line = (pick) => minutes.filter((m) => Number.isFinite(pick(m))).map((m) => ({ time: m.time, value: pick(m) }))
    return [
      { id: 'rr25', title: 'RR25', color: RR_COLOR, width: 2, data: line((m) => m.rr25) },
      { id: 'bf25', title: 'BF25', color: BF_COLOR, width: 1, style: LineStyle.Dashed, data: line((m) => m.bf25) },
      { id: 'atmIv', title: 'ATM IV', color: ATM_COLOR, width: 2, pane: 1, data: line((m) => m.atmIv) },
    ]
  }, [minutes])
  const controls = (
    <Space wrap size={[8, 6]} align="center" style={{ marginBottom: 6 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>Read over</Text>
      <Segmented size="small" value={win} onChange={setWindowMin} options={WINDOWS.map((w) => ({ value: w, label: `${w}m` }))} />
    </Space>
  )
  if (!now) {
    return <>{controls}<Text type="secondary">No skew yet - it needs the option chain&apos;s premiums and a time to expiry.</Text></>
  }
  return (
    <>
      {controls}
      <Tooltip title={<ReadTable active={read?.row.key} />} overlayStyle={{ maxWidth: 480 }}>
        <div style={{ borderLeft: '3px solid #ff7a45', padding: '4px 10px', marginBottom: 4 }}>
          {read
            ? <>
              <Tag color={readColor(read.row.key)} style={{ marginRight: 8 }}>{read.row.read}</Tag>
              <Text style={{ fontSize: 12 }}>
                RR25 {signed(read.rrChange)} vol pts, spot {signed(read.priceChangePct)}% in {read.minutes} min - {read.row.detail}
              </Text>
            </>
            : <Text type="secondary" style={{ fontSize: 12 }}>The 25-delta strikes are not in the chain loaded yet - the smile is shown, the risk reversal is not.</Text>}
        </div>
      </Tooltip>
      <Space wrap size={[14, 2]} style={{ fontSize: 12, marginBottom: 6 }}>
        <Text style={{ fontSize: 12 }}><Text strong style={{ fontSize: 12 }}>{hhmm(now.time)}</Text> ATM {now.atm} IV <Text strong style={{ fontSize: 12, color: ATM_COLOR }}>{vol(now.atmIv)}</Text>{read ? <> ({signed(read.atmIvChange)} in {read.minutes}m, {signed(read.atmIvSinceOpen)} since {hhmm(read.first.time)})</> : null}</Text>
        <Text style={{ fontSize: 12 }}>25Δ put {vol(now.put25)} · 25Δ call {vol(now.call25)}</Text>
        <Text style={{ fontSize: 12 }}>RR25 <Text strong style={{ fontSize: 12, color: RR_COLOR }}>{signed(now.rr25)}</Text>{read ? <> (<span style={{ color: changeColor(read.rrSinceOpen) }}>{signed(read.rrSinceOpen)}</span> since {hhmm(read.first.time)})</> : null}</Text>
        <Text style={{ fontSize: 12 }}>BF25 <span style={{ color: BF_COLOR }}>{signed(now.bf25)}</span></Text>
      </Space>
      <FoldText id="volSkew.note" label="what it is" className="oa-note" style={{ marginBottom: 4 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          Each strike&apos;s IV from its own out-of-the-money premium (Black-76 on the put-call-parity forward, to 15:30 on the expiry day). RR25 below 0 = puts priced over calls (normal for an index); it FALLING = puts being bid (fear / protection), RISING = calls bid or puts offered. BF25 = the wings over the ATM (tail risk). Hover the read for the table.
        </Text>
      </FoldText>
      <Text strong style={{ fontSize: 12 }}>Smile now</Text>
      <Text type="secondary" style={{ fontSize: 11 }}> · IV by strike at {hhmm(now.time)} (puts red, calls green) · dotted: at {hhmm(open?.time)}</Text>
      <SmileChart now={now} open={open !== now ? open : null} />
      <Text strong style={{ fontSize: 12 }}>Through the day</Text>
      <Text type="secondary" style={{ fontSize: 11 }}> · RR25 and BF25 (vol points) · below: ATM IV</Text>
      <LinesChart lines={lines} dayKey={`skew-${dayKey}`} height={200} paneHeight={110} />
    </>
  )
}
