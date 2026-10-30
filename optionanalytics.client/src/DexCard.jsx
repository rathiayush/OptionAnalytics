import { useMemo } from 'react'
import { Button, Col, Popover, Row, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import { AXIS_COLOR, usePersistedState } from './shared.jsx'
import { CardFitBox } from './DashboardCard.jsx'
import { DEX_WINDOW, dexAgreement, dexDivergence, gexUpTo } from './gex.js'
import { NetGexChart } from './GexCard.jsx'
import { FoldText } from './FoldText.jsx'

const { Text } = Typography

// Call-heavy and put-heavy in their own colours - not green / red: neither lean is bullish or bearish by itself.
const CALL_COLOR = '#4096ff'
const PUT_COLOR = '#fa8c16'
const CR = 1e7
const IST_MS = 330 * 60_000

/** HH:mm in IST. */
const istHhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)
// ₹ crore, signed (+ / −) - or its size only (`signed` false) where the words say which way.
const cr = (v, signed = true) => (Number.isFinite(v) ? `${!signed ? '' : v < 0 ? '−' : v > 0 ? '+' : ''}₹${Math.round(Math.abs(v) / CR).toLocaleString('en-IN')} Cr` : '-')
const num = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '-')
const leanColor = (v) => (v < 0 ? CALL_COLOR : v > 0 ? PUT_COLOR : AXIS_COLOR)

// Each strike's DEX at the clock: puts to the left of the middle, calls to the right, the net beside - the ATM marked,
// each call's delta under its strike.
function StrikeBars({ minute }) {
  const rows = minute.strikes.filter((r) => r.dexCall != null || r.dexPut != null)
  const scale = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.dexCall ?? 0), Math.abs(r.dexPut ?? 0))))
  const bar = (v, side) => {
    const width = `${Math.min(100, (Math.abs(v ?? 0) / scale) * 100)}%`
    return (
      <div style={{ flex: 1, display: 'flex', justifyContent: side === 'put' ? 'flex-end' : 'flex-start' }}>
        {v ? <div title={cr(v)} style={{ width, height: 10, background: side === 'put' ? PUT_COLOR : CALL_COLOR, opacity: 0.85, borderRadius: 2 }} /> : null}
      </div>
    )
  }
  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ display: 'flex', gap: 6, color: AXIS_COLOR, marginBottom: 4 }}>
        <div style={{ flex: 1, textAlign: 'right' }}>Put DEX (+)</div>
        <div style={{ width: 96, textAlign: 'center' }}>Strike · Δ call</div>
        <div style={{ flex: 1 }}>Call DEX (−)</div>
        <div style={{ width: 92, textAlign: 'right' }}>Net</div>
      </div>
      {rows.map((r) => (
        <div key={r.strike} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '1px 0', background: r.strike === minute.atm ? 'rgba(255,255,255,0.06)' : undefined }}>
          {bar(r.dexPut, 'put')}
          <div style={{ width: 96, textAlign: 'center', whiteSpace: 'nowrap' }}>
            <span style={{ fontWeight: r.strike === minute.atm ? 600 : 400 }}>{r.strike}</span>
            <Text type="secondary" style={{ fontSize: 10 }}> {num(r.delta, 2)}</Text>
          </div>
          {bar(r.dexCall, 'call')}
          <div style={{ width: 92, textAlign: 'right', color: leanColor(r.dexNet) }}>{cr(r.dexNet)}</div>
        </div>
      ))}
    </div>
  )
}

const HOW_TO_READ = (
  <div style={{ maxWidth: 440, fontSize: 12 }}>
    <p style={{ margin: '0 0 6px' }}><b>DEX</b> (delta exposure) = the option dealers&apos; delta: delta × the dealers&apos; OI × spot, in ₹ crore of index - what their futures hedge holds the other way. As the DEX tools publish it, the dealers are taken as SHORT every contract (customers hold the calls and the puts): DEX = −Σ(delta × OI × spot) - every call counts negative, every put positive. Delta is Black-76 on the forward with each strike&apos;s IV from its own premium - the same as the GEX card&apos;s gamma.</p>
    <p style={{ margin: '0 0 6px' }}><b>Negative = call-heavy</b>: the open options lean to calls (customers net long delta); the dealers&apos; hedge is LONG futures. <b>Positive = put-heavy</b>: customers net short delta; the dealers&apos; hedge is SHORT futures. A lean is not a signal by itself - an extreme one is crowded positioning.</p>
    <p style={{ margin: '0 0 6px' }}><b>Decay to 15:30</b> (charm): how the dealers&apos; options delta changes by the close with time alone (spot, OI and IVs kept), and the futures they trade for it - an out-of-the-money option&apos;s delta runs to 0 as it decays. Put-heavy = they buy back their short hedge (support); call-heavy = they sell their long hedge (a headwind). Biggest on expiry day.</p>
    <p style={{ margin: '0 0 6px' }}><b>Delta added</b> (last {DEX_WINDOW} min): the delta of the OI added or cut, at today&apos;s deltas - the positions that came in. Price up with bullish delta added (calls bought, puts cut) = backed by new positions; price up while bearish delta came in = a divergence - the move is not backed by them. Context, not an entry: confirm with order flow and the levels.</p>
    <p style={{ margin: '0 0 6px' }}><b>DEX by strike</b>: where the options&apos; delta sits. It does not pin price - pinning is gamma (the GEX card&apos;s max gamma strike).</p>
    <p style={{ margin: '0 0 6px' }}><b>Sign.</b> Standard: dealers short every call and put. OI build-up: short at the first reading, then each minute&apos;s OI change signed by the premium (as the GEX card&apos;s) - added while it fell = written by customers (the dealers bought it), added while it rose = bought (the dealers sold it).</p>
    <p style={{ margin: 0 }}>Only the strikes the page has (ATM ± 10) count, and a deep in-the-money option carries a delta near 1 - unlike gamma, delta does not fade away from the money. So the level is partial: read its CHANGE (through the day, added, decay) more than the level.</p>
  </div>
)

/**
 * DEX (delta exposure) from the day's option OI, IV and premium - worked out with the GEX in the same minutes (gex.js -
 * `days`, useGexDays), up to the replay clock (`asOfMs`; null - live - every minute given; 0 - the replay not started).
 */
export function DexCard({ days, asOfMs, dayKey, height = 260 }) {
  const [sign, setSign] = usePersistedState('optionanalytics.oiReplay.dexSign', 'standard')
  const minutes = useMemo(() => gexUpTo((sign === 'buildup' ? days?.buildup : days?.standard) ?? [], asOfMs), [days, sign, asOfMs])
  const now = minutes.at(-1)
  const both = useMemo(() => {
    const standardNow = gexUpTo(days?.standard ?? [], asOfMs).at(-1)
    const buildupNow = gexUpTo(days?.buildup ?? [], asOfMs).at(-1)
    return { standardNow, buildupNow, ...dexAgreement(standardNow, buildupNow) }
  }, [days, asOfMs])
  const charts = useMemo(() => ({
    net: minutes.filter((m) => Number.isFinite(m.dex?.net)).map((m) => ({ time: m.time, value: m.dex.net / CR })),
    spot: minutes.map((m) => ({ time: m.time, value: m.spot })),
  }), [minutes])

  const controls = (
    <Space wrap size={[16, 6]} style={{ marginBottom: 8 }}>
      <Tooltip title="Who holds the other side of the OI is not in the data. Standard: dealers short every call and put (calls −, puts +), as DEX is usually shown. OI build-up: short at the first reading, then each minute's OI change signed by the premium - added while it fell = written (the dealers bought it), added while it rose = bought (the dealers sold it).">
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>Sign</Text>
          <Segmented size="small" value={sign} onChange={setSign} options={[{ value: 'standard', label: 'Standard' }, { value: 'buildup', label: 'OI build-up' }]} />
        </Space>
      </Tooltip>
      <Popover content={HOW_TO_READ} title="How to read DEX" trigger="click" placement="bottomLeft">
        <Button size="small" type="link" style={{ padding: 0 }}>How to read</Button>
      </Popover>
    </Space>
  )

  if (!now?.dex) {
    return (
      <>
        {controls}
        <Text type="secondary" style={{ display: 'block' }}>
          {asOfMs === 0 ? 'Start the replay to read DEX.' : 'No DEX yet - it needs the ATM call and put with their IV and OI.'}
        </Text>
      </>
    )
  }

  const { dex } = now
  const callHeavy = dex.net < 0
  const divergence = dexDivergence(now)
  // The dealers trade the opposite of their options' delta change: the decay up = they sell futures.
  const hedge = dex.decayToClose == null ? null : -dex.decayToClose
  return (
    <>
      {controls}
      <FoldText id="dex.read" label="the read" style={{ marginBottom: 4 }}>
        <div style={{ borderLeft: `3px solid ${leanColor(dex.net)}`, padding: '4px 10px', fontSize: 12 }}>
          <Tag color={callHeavy ? 'blue' : 'orange'} style={{ marginRight: 8 }}>{callHeavy ? 'Call-heavy' : 'Put-heavy'}</Tag>
          {callHeavy
            ? 'The open options lean to calls - customers net long delta; the dealers hedge with long futures.'
            : 'The open options lean to puts - customers net short delta; the dealers hedge with short futures.'}
          {hedge != null && (Math.abs(hedge) >= 0.005 * (Math.abs(dex.calls) + Math.abs(dex.puts))
            ? <> Time decay to 15:30 has the dealers <b style={{ color: hedge > 0 ? '#49aa19' : '#d32029' }}>{hedge > 0 ? 'buying' : 'selling'} {cr(hedge, false)}</b> of futures ({hedge > 0 ? 'support' : 'a headwind'}).</>
            : <> Time decay to 15:30 moves the dealers&apos; hedge little ({cr(hedge)}).</>)}
          {divergence && divergence.verdict !== 'flat' && (
            <> Last {divergence.minutes} min: spot {divergence.spotChange >= 0 ? '+' : '−'}{num(Math.abs(divergence.spotChange), 1)} while customers added {divergence.customers >= 0 ? 'bullish' : 'bearish'} delta ({cr(divergence.customers, false)}) - {divergence.verdict === 'confirms'
              ? <Tag color="green" style={{ margin: 0 }}>backed by new positions</Tag>
              : <Tag color="gold" style={{ margin: 0 }}>divergence - not backed by new positions</Tag>}.</>
          )}
          {divergence?.verdict === 'flat' && <> Last {divergence.minutes} min: spot flat or no new delta - nothing to read against it.</>}
        </div>
      </FoldText>
      <FoldText id="dex.agreement" label="the two signs' verdict" style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Standard </Text>
          <span style={{ color: leanColor(both.standardNow?.dex?.net) }}>{cr(both.standardNow?.dex?.net)} ({both.standard ?? '-'})</span>
          <Text type="secondary" style={{ fontSize: 12 }}> · OI build-up </Text>
          <span style={{ color: leanColor(both.buildupNow?.dex?.net) }}>{cr(both.buildupNow?.dex?.net)} ({both.buildup ?? '-'})</span>
          {' → '}
          {both.agree
            ? <Tag color={both.lean === 'call-heavy' ? 'blue' : 'orange'} style={{ margin: 0 }}>agree: {both.lean}</Tag>
            : <><Tag color="gold" style={{ margin: '0 6px 0 0' }}>disagree</Tag>the lean is unclear - read the change, not the level.</>}
        </div>
      </FoldText>
      <Row gutter={[16, 4]} style={{ marginBottom: 8, fontSize: 12 }}>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Net DEX </Text><Text strong style={{ fontSize: 12, color: leanColor(dex.net) }}>{cr(dex.net)}</Text></Col>
        <Col><Text type="secondary" style={{ fontSize: 12 }}>Calls </Text><span style={{ color: CALL_COLOR }}>{cr(dex.calls)}</span><Text type="secondary" style={{ fontSize: 12 }}> · Puts </Text><span style={{ color: PUT_COLOR }}>{cr(dex.puts)}</span></Col>
        <Col>
          <Tooltip title={`The delta of the OI added or cut since ${dex.addedFrom ? istHhmm(dex.addedFrom) : '-'}, at today's deltas, as customers hold it (+ = bullish positions came in).`}>
            <Text type="secondary" style={{ fontSize: 12 }}>Delta added ({DEX_WINDOW} min) </Text>
            <span style={{ color: divergence ? (divergence.customers >= 0 ? '#49aa19' : '#d32029') : undefined }}>{divergence ? cr(divergence.customers) : '-'}</span>
          </Tooltip>
        </Col>
        <Col>
          <Tooltip title="The futures the dealers trade by 15:30 for time decay alone (spot, OI and IVs kept): + they buy, − they sell.">
            <Text type="secondary" style={{ fontSize: 12 }}>Decay hedge to 15:30 </Text>
            <span style={{ color: hedge == null ? undefined : hedge >= 0 ? '#49aa19' : '#d32029' }}>{hedge == null ? '-' : cr(hedge)}</span>
          </Tooltip>
        </Col>
        <Col flex="1 1 280px" style={{ minWidth: 0 }}>
          <FoldText id="dex.basis" label="how it is worked out" className="oa-note">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {istHhmm(now.time)} · spot {num(now.spot, 1)} · ATM {now.atm} (call Δ {num(now.strikes.find((r) => r.strike === now.atm)?.delta, 2)}) · forward {num(now.forward, 1)} · ≈ {num(now.years * 365, 2)} days to expiry · the GEX card&apos;s forward, IVs and time to expiry
            </Text>
          </FoldText>
        </Col>
      </Row>
      <Row gutter={[16, 12]}>
        <Col xs={24} lg={10}>
          <FoldText id="dex.strikeNote" label="the table's note">
            <Text strong style={{ fontSize: 12 }}>DEX by strike</Text>
            <Text className="oa-note" type="secondary" style={{ fontSize: 11 }}> · at {istHhmm(now.time)}; blue = the calls&apos; delta (dealers short it), orange = the puts&apos;</Text>
          </FoldText>
          <CardFitBox min={100}>
            <StrikeBars minute={now} />
          </CardFitBox>
        </Col>
        <Col xs={24} lg={14}>
          <Text strong style={{ fontSize: 12 }}>Net DEX through the day</Text>
          <Text type="secondary" style={{ fontSize: 11 }}> · ₹ crore, with spot (left scale) - price and DEX against each other</Text>
          <NetGexChart
            data={charts.net} spot={charts.spot} dayKey={`dex-net-${dayKey}-${sign}`} height={height}
            title="Net DEX (₹ Cr)" upColor={PUT_COLOR} downColor={CALL_COLOR}
          />
        </Col>
      </Row>
    </>
  )
}
