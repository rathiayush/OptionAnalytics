import { useMemo } from 'react'
import { Segmented, Select, Space, Tooltip, Typography } from 'antd'
import { LineStyle } from 'lightweight-charts'
import { AXIS_COLOR, DOWN_COLOR, UP_COLOR, istTimeFormatter, toChartTime, useMediaQuery, usePersistedState } from './shared.jsx'
import { LinesChart } from './StraddleCard.jsx'
import { useFitHeight } from './DashboardCard.jsx'
import { FoldText } from './FoldText.jsx'
import { gexSignOf, gexSignOptions } from './participantOi.js'
import { CRORE, dexDay, dexProfile, dexRead, dexUpTo } from './dex.js'

const { Text } = Typography
const NONE = []
const UP_LINE = '#52c41a'
const DOWN_LINE = '#ff4d4f'
const VANNA_COLOR = '#b37feb'
const CHARM_COLOR = '#faad14'
const FLIP_COLOR = '#13c2c2'
const TONE = { bull: UP_COLOR, bear: DOWN_COLOR, calm: '#8c8c8c' }

const hhmm = (ms) => (ms == null ? '—' : istTimeFormatter(toChartTime(ms)))
const crore = (v) => (Number.isFinite(v) ? `₹${(Math.abs(v) / CRORE).toLocaleString('en-IN', { maximumFractionDigits: Math.abs(v) < 10 * CRORE ? 1 : 0 })} Cr` : '—')
const flowText = (v) => (Number.isFinite(v) ? `${v > 0 ? 'BUY' : v < 0 ? 'SELL' : ''} ${crore(v)}`.trim() : '—')
const flowColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const num = (v) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—')

function Headline({ title, value, color, sub, tip }) {
  const body = (
    <div style={{ minWidth: 120 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>{title}</Text>
      <div style={{ color, fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
      {sub && <Text type="secondary" style={{ fontSize: 11 }}>{sub}</Text>}
    </div>
  )
  return tip ? <Tooltip title={tip}>{body}</Tooltip> : body
}

const WALL_COLORS = { resistance: DOWN_COLOR, support: UP_COLOR, max: '#faad14' }
const WALL_TAGS = { resistance: 'R', support: 'S', max: 'MAX' }

/** Each strike's dealer delta at spot (dexStrikes) as a bar from a centre line - + green right, − red left - the DEX walls
 *  outlined and tagged (R resistance / S support / MAX), the row spot is in marked blue; hover a row for its calls / puts. */
function DexStrikesChart({ strikes, spot, walls, height: asked = 320 }) {
  const height = useFitHeight(asked)
  if (!strikes?.length) return null
  const rows = [...strikes].sort((a, b) => b.strike - a.strike)
  const W = 640, H = height, pad = { l: 64, r: 64, t: 6, b: 6 }
  const rowH = (H - pad.t - pad.b) / rows.length
  const max = Math.max(...rows.map((r) => Math.abs(r.net)), 1)
  const mid = pad.l + (W - pad.l - pad.r) / 2
  const half = (W - pad.l - pad.r) / 2
  const steps = rows.slice(1).map((r, i) => rows[i].strike - r.strike).filter((g) => g > 0)
  const step = steps.length ? Math.min(...steps) : 0
  const spotRow = rows.findIndex((r) => Math.abs(r.strike - spot) <= step / 2)
  const tagsOf = (k) => Object.entries(walls ?? {}).filter(([, v]) => v === k).map(([key]) => key)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Dealers' delta by strike">
      <line x1={mid} x2={mid} y1={pad.t} y2={H - pad.b} stroke="#ffffff55" />
      {rows.map((r, i) => {
        const y = pad.t + i * rowH
        const w = (Math.abs(r.net) / max) * half
        const tags = tagsOf(r.strike)
        const color = r.net >= 0 ? UP_COLOR : DOWN_COLOR
        return (
          <g key={r.strike}>
            <title>{`${r.strike}: net ${r.net < 0 ? '−' : ''}${crore(r.net)} · calls ${r.call < 0 ? '−' : ''}${crore(r.call)} · puts ${r.put < 0 ? '−' : ''}${crore(r.put)}`}</title>
            {i === spotRow && <rect x={0} y={y} width={W} height={rowH} fill="#4c9ffe22" />}
            <rect x={r.net >= 0 ? mid : mid - w} y={y + rowH * 0.15} width={Math.max(1, w)} height={rowH * 0.7} fill={color} fillOpacity={tags.length ? 0.95 : 0.6}
              stroke={tags.length ? WALL_COLORS[tags[0]] : 'none'} strokeWidth={tags.length ? 2 : 0} />
            <text x={pad.l - 6} y={y + rowH / 2 + 4} fill={i === spotRow ? '#4c9ffe' : AXIS_COLOR} fontSize={Math.min(11, rowH)} textAnchor="end">{r.strike}</text>
            {tags.length > 0 && <text x={W - pad.r + 6} y={y + rowH / 2 + 4} fill={WALL_COLORS[tags[0]]} fontSize={Math.min(11, rowH)} fontWeight="600">{tags.map((t) => WALL_TAGS[t]).join(' · ')}</text>}
          </g>
        )
      })}
    </svg>
  )
}

/** The dealers' delta if spot were at each price (dexProfile) - an SVG, zero, spot and the flip marked. */
function DexProfileChart({ profile, spot, flip, height: asked = 180 }) {
  const height = useFitHeight(asked)
  if (profile.length < 2) return null
  const W = 640, H = height, pad = { l: 56, r: 12, t: 10, b: 24 }
  const lo = profile[0].price, hi = profile.at(-1).price
  const vals = profile.map((p) => p.net / CRORE)
  const vMin = Math.min(0, ...vals), vMax = Math.max(0, ...vals)
  const x = (p) => pad.l + ((p - lo) / Math.max(1, hi - lo)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - vMin) / Math.max(1e-9, vMax - vMin)) * (H - pad.t - pad.b)
  const path = profile.map((p, i) => `${i ? 'L' : 'M'}${x(p.price).toFixed(1)},${y(p.net / CRORE).toFixed(1)}`).join(' ')
  const yTicks = Array.from({ length: 5 }, (_, i) => vMin + ((vMax - vMin) * i) / 4)
  const xTicks = Array.from({ length: 5 }, (_, i) => Math.round((lo + ((hi - lo) * i) / 4) / 50) * 50)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Dealers' delta by spot">
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#ffffff14" />
          <text x={pad.l - 6} y={y(v) + 4} fill={AXIS_COLOR} fontSize="11" textAnchor="end">{Math.round(v).toLocaleString('en-IN')}</text>
        </g>
      ))}
      {xTicks.map((k) => <text key={`x${k}`} x={x(k)} y={H - 7} fill={AXIS_COLOR} fontSize="11" textAnchor="middle">{k}</text>)}
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#ffffff55" />
      <path d={path} fill="none" stroke="#4c9ffe" strokeWidth="2" />
      {spot >= lo && spot <= hi && (
        <g>
          <line x1={x(spot)} x2={x(spot)} y1={pad.t} y2={H - pad.b} stroke="#ffffffaa" strokeDasharray="3 3" />
          <text x={x(spot) + 4} y={pad.t + 10} fill={AXIS_COLOR} fontSize="10">spot {Math.round(spot)}</text>
        </g>
      )}
      {Number.isFinite(flip) && flip >= lo && flip <= hi && (
        <g>
          <line x1={x(flip)} x2={x(flip)} y1={pad.t} y2={H - pad.b} stroke={FLIP_COLOR} strokeDasharray="5 3" />
          <text x={x(flip) + 4} y={H - pad.b - 4} fill={FLIP_COLOR} fontSize="10">DEX flip {Math.round(flip)}</text>
        </g>
      )}
    </svg>
  )
}

/**
 * OI Replay's DEALER HEDGING (DEX) card (asked for - "can you also add delta exposure", the hedging-flow version: what the
 * OI cards cannot show, no CE vs PE lean; dex.js): from the page's GEX day (`days` - useGexDays, the Sign picked here) the
 * index the dealers must buy / sell for spot +/- 1%, an IV fall of a vol point (vanna) and time passing (charm - to the
 * close and per hour), the DEX flip and the dealers' net delta, through the day and at the clock (`asOfMs`; live null).
 * A read - it feeds no strategy or alert.
 */
export function DexCard({ days, asOfMs, dayKey, isLive }) {
  const [sign, setSign] = usePersistedState('optionanalytics.oiReplay.dexSign', 'standard')
  const narrow = useMediaQuery('(max-width: 768px)')
  const picked = gexSignOf(days, sign)
  const gex = days?.[picked] ?? NONE
  const day = useMemo(() => dexDay(gex), [gex])
  const minutes = useMemo(() => dexUpTo(day, asOfMs), [day, asOfMs])
  const now = minutes.at(-1) ?? null
  const gexNow = useMemo(() => (now ? gex.find((m) => m.time === now.time) ?? null : null), [gex, now])
  const profile = useMemo(() => dexProfile(gexNow), [gexNow])
  const read = useMemo(() => dexRead(now), [now])
  const lines = useMemo(() => {
    const line = (pick) => minutes.map((m) => ({ time: m.time, value: pick(m) / CRORE }))
    return [
      { id: 'up', title: '+1%', color: UP_LINE, width: 2, data: line((m) => m.up) },
      { id: 'down', title: '−1%', color: DOWN_LINE, width: 2, data: line((m) => m.down) },
      { id: 'vanna', title: 'IV −1', color: VANNA_COLOR, width: 1, style: LineStyle.Dashed, data: line((m) => m.vanna) },
      { id: 'charm', title: 'Charm /h', color: CHARM_COLOR, width: 2, pane: 1, data: line((m) => m.charmHour) },
    ]
  }, [minutes])

  if (!days) return <Text type="secondary">Working out the day&apos;s dealer positions…</Text>
  const signPicker = narrow
    ? <Select size="small" value={picked} onChange={setSign} options={gexSignOptions(days)} style={{ width: 150 }} />
    : <Segmented size="small" value={picked} onChange={setSign} options={gexSignOptions(days)} />
  return (
    <div>
      <Space size={[12, 6]} wrap style={{ marginBottom: 6 }}>
        <Tooltip title="Who the dealers are, as on the GEX card: Standard = long every call, short every put; OI build-up = each OI change signed by its own IV's move; NSE + build-up = NSE's participant positions, then the day's changes.">
          {signPicker}
        </Tooltip>
        {now?.expiries > 1 && <Text type="secondary" style={{ fontSize: 12 }}>Σ {now.expiries} expiries</Text>}
      </Space>
      {!now ? <Text type="secondary">No dealer positions yet - it needs the option chain&apos;s premiums and a time to expiry.</Text> : (
        <>
          <Space size={[22, 8]} wrap style={{ marginBottom: 6 }}>
            <Headline title={`Spot +1% · ${hhmm(now.time)}${isLive ? ' live' : ''}`} value={flowText(now.up)} color={flowColor(now.up)}
              sub="dealers' hedge for a 1% rally" tip="The index the dealers trade to stay hedged if spot rose 1% now, each option keeping its IV - the whole move, not the slope at spot." />
            <Headline title="Spot −1%" value={flowText(now.down)} color={flowColor(now.down)} sub="for a 1% fall" />
            <Headline title="IV −1 vol pt (vanna)" value={flowText(now.vanna)} color={flowColor(now.vanna)} sub="spot and time held"
              tip="Every option's IV down one vol point, spot held: how the dealers' delta shifts and what they trade for it. An IV rise is about the opposite." />
            <Headline title={`Charm to 15:30 (${now.minutesToClose} min)`} value={flowText(now.charmClose)} color={flowColor(now.charmClose)}
              sub={`${flowText(now.charmHour)} per hour`} tip="Time passing alone, spot and IV held: the out-of-the-money options' delta melts and the dealers' hedge with it." />
            <Headline title="DEX flip" value={num(now.flip)} color={FLIP_COLOR}
              sub={now.flip == null ? (picked === 'standard' ? 'none under Standard' : 'none within ±3%') : `${now.flip >= now.spot ? 'above' : 'below'} spot by ${num(Math.abs(now.flip - now.spot))}${now.flipEdge ? ' · rough (edge)' : ''}`}
              tip="The spot at which the dealers' book would turn from net long to net short delta (OI, IV and time kept). Under Standard both legs are long delta, so there is none - pick OI build-up / NSE + build-up." />
            <Headline title="Dealers' net delta" value={`${now.net < 0 ? '−' : ''}${crore(now.net)}`} sub="of the strikes loaded"
              tip="Rupees of index the dealers' options are worth in delta - only the strikes loaded (ATM ± 10), so a level for those strikes; the flows above are local and not affected." />
            <Headline title="DEX resistance" value={num(now.walls?.resistance)} color={WALL_COLORS.resistance}
              sub={now.walls?.resistance != null ? `${num(now.walls.resistance - now.spot)} above spot` : 'none above spot'}
              tip="The strike ABOVE spot holding the most dealer delta (either sign) - where their hedging is heaviest, often a barrier or a magnet. It moves to another strike only with 10% more." />
            <Headline title="DEX support" value={num(now.walls?.support)} color={WALL_COLORS.support}
              sub={now.walls?.support != null ? `${num(now.spot - now.walls.support)} below spot` : 'none below spot'}
              tip="The strike BELOW spot holding the most dealer delta - the floor side of their hedging. Read it with the regime: dealers leaning against moves = it tends to hold; chasing = a break can run." />
            <Headline title="DEX max" value={num(now.walls?.max)} color={WALL_COLORS.max} sub="most dealer delta of any strike"
              tip="The strike with the most dealer delta of all - the biggest hedge in the book, a pin candidate into expiry." />
          </Space>
          {read.map((r) => (
            <div key={r.key} style={{ borderLeft: `3px solid ${TONE[r.tone]}`, padding: '2px 10px', marginBottom: 3 }}>
              <Text style={{ fontSize: 12 }}>{r.text}</Text>
            </div>
          ))}
          <FoldText id="dex.note" label="what it is" className="oa-note" style={{ margin: '4px 0' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              Dealer hedging, not order flow: the index the option dealers must buy (+) or sell (−) to stay delta-neutral when spot moves 1%, when IV moves a vol point (vanna) or as time passes (charm), from each strike&apos;s OI and the IV of its own premium (Black-76 on the forward). Charm and vanna are flows that come with no price move - into the close, or as IV is sold / bought. Who the dealers are is the Sign&apos;s assumption, as on the GEX card. A read - it feeds no strategy or alert.
            </Text>
          </FoldText>
          {now.strikes?.length > 0 && (
            <>
              <Text strong style={{ fontSize: 12 }}>Dealers&apos; delta by strike</Text>
              <Text type="secondary" style={{ fontSize: 11 }}> · ₹ Cr at {hhmm(now.time)} - each strike&apos;s calls + puts (dealers&apos; OI x delta x spot) · R / S / MAX = the DEX walls · hover a row for its calls / puts</Text>
              {picked === 'standard' && (
                <div><Text type="secondary" style={{ fontSize: 11 }}>Under Standard a call&apos;s and a put&apos;s deltas add up to 1, so each strike&apos;s bar is just its call + put OI x spot - the walls are the biggest-OI strikes. Pick OI build-up / NSE + build-up to read who holds them (bars can then turn red).</Text></div>
              )}
              <DexStrikesChart strikes={now.strikes} spot={now.spot} walls={now.walls} />
            </>
          )}
          {profile.length > 1 && (
            <>
              <Text strong style={{ fontSize: 12 }}>Dealers&apos; delta by spot</Text>
              <Text type="secondary" style={{ fontSize: 11 }}> · ₹ Cr at {hhmm(now.time)}, OI / IV / time kept · it crosses zero at the DEX flip</Text>
              <DexProfileChart profile={profile} spot={now.spot} flip={now.flip} />
            </>
          )}
          <Text strong style={{ fontSize: 12 }}>Through the day</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · ₹ Cr the dealers trade (+ buy / − sell) for spot +1% / −1% and IV −1 vol pt · below: charm per hour</Text>
          <LinesChart lines={lines} dayKey={`dex-${dayKey}`} height={200} paneHeight={110} />
        </>
      )}
    </div>
  )
}
