import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Checkbox, InputNumber, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { DOWN_COLOR, POLL_HEADERS, UP_COLOR, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { TICK_ORDER_DEFAULTS, addOrders, bigEnough, bigTradesSummary, hitText } from './tickBigOrders.js'

const { Text } = Typography
const SHOWN = 50
const CRORE = 1e7
const LOOKBACKS = [5, 15, 30, 60]
const STRIKE_CHOICES = [3, 5, 8, 10, 12, 15]
const hhmmss = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })
const rupees = (v) => (!Number.isFinite(v) || v === 0 ? '₹0' : Math.abs(v) >= CRORE ? `₹${(v / CRORE).toFixed(2)} Cr` : `₹${(v / 1e5).toFixed(1)} L`)
const lean = { bullish: ['BULLISH', UP_COLOR], bearish: ['BEARISH', DOWN_COLOR], mixed: ['MIXED', '#8c8c8c'], none: ['NO BIG ORDERS', '#8c8c8c'] }
const KINDS = [
  ['ceBought', 'Calls bought / covered', UP_COLOR],
  ['peBought', 'Puts bought / covered', DOWN_COLOR],
  ['ceWritten', 'Calls written / unwound', DOWN_COLOR],
  ['peWritten', 'Puts written / unwound', UP_COLOR],
]

/**
 * The Tick Flow page's BIG OPTION ORDERS: TrueData's live ticks of the options ATM ± N of the index picked (the server subscribes and follows
 * the ATM), each big order read for its side, the book it hit, the OI it changed - and the strikes added up. Live only; a page timer (POLL_HEADERS).
 */
export function TickBigOrdersCard({ isAdmin, replay }) {
  const [minLots, setMinLots] = usePersistedState('optionanalytics.tickFlow.bigMinLots', TICK_ORDER_DEFAULTS.minLots)
  const [multiple, setMultiple] = usePersistedState('optionanalytics.tickFlow.bigMultiple', TICK_ORDER_DEFAULTS.multiple)
  const [lookback, setLookback] = usePersistedState('optionanalytics.tickFlow.bigLookback', TICK_ORDER_DEFAULTS.lookback)
  const [sweepsOnly, setSweepsOnly] = usePersistedState('optionanalytics.tickFlow.bigSweepsOnly', false)
  const [orders, setOrders] = useState([])
  const [state, setState] = useState(null)       // the server's option stream: index, expiry, ATM, subscribed, ticks, error
  const [enabled, setEnabled] = useState(true)
  const [now, setNow] = useState(0)
  const [error, setError] = useState(null)
  const [reload, setReload] = useState(0)
  const since = useRef(0)

  useEffect(() => {
    if (replay) return undefined
    let stop = false
    const load = async () => {
      try {
        const r = await fetch(`/api/tick-flow/options?since=${since.current}`, { headers: POLL_HEADERS })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = await r.json()
        if (stop) return
        setEnabled(body.enabled !== false)
        setState(body.options ?? null)
        setNow(Date.now())
        setError(null)
        // The server restarted (its sequence began again): start over.
        if (body.options && body.options.lastSeq < since.current) { since.current = 0; setOrders([]); return }
        if (body.events?.length) {
          since.current = body.events[body.events.length - 1].seq
          setOrders((kept) => addOrders(kept, body.events))
        }
      } catch (e) { if (!stop) setError(e.message) }
    }
    load()
    const timer = setInterval(load, 2000)
    return () => { stop = true; clearInterval(timer) }
  }, [replay, reload])

  const put = async (underlying, strikes) => {
    try {
      const r = await fetch('/api/tick-flow/options', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ underlying, strikes }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
      since.current = 0
      setOrders([])
      setReload((n) => n + 1)
    } catch (e) { setError(e.message) }
  }

  const big = useMemo(() => bigEnough(orders, { minLots, multiple }), [orders, minLots, multiple])
  const summary = useMemo(() => bigTradesSummary(big, now || null, lookback), [big, now, lookback])
  const rows = useMemo(() => (sweepsOnly ? big.filter((o) => o.sweep) : big).slice(-SHOWN).reverse().map((o) => ({ ...o, key: o.seq })), [big, sweepsOnly])
  const [word, color] = lean[summary.lean]

  if (replay) return <Alert type="info" showIcon message="Big option orders are live only" description="They come from TrueData's live ticks of the options ATM ± N; the tick history of 40 option contracts for a past day is not loaded." />
  if (!enabled) return <Alert type="info" showIcon message="The TrueData live feed is off" />

  const columns = [
    { title: 'Time', dataIndex: 't', width: 78, render: (t) => hhmmss(t) },
    {
      title: 'Option', width: 150,
      render: (_, o) => (
        <Space size={4}>
          <Tag color={o.type === 'CE' ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>{o.type}</Tag>
          <span>{o.strike}</span>
          <Text type="secondary" style={{ fontSize: 11 }}>{o.atmDistance === 0 ? 'ATM' : `ATM${o.atmDistance > 0 ? '+' : ''}${o.atmDistance}`}</Text>
        </Space>
      ),
    },
    { title: 'Order', width: 70, render: (_, o) => <span style={{ color: o.side > 0 ? UP_COLOR : DOWN_COLOR, fontWeight: 600 }}>{o.side > 0 ? 'BUY' : 'SELL'}</span> },
    { title: 'Lots', dataIndex: 'lots', align: 'right', width: 64, render: (v, o) => <Tooltip title={o.bundled ? 'The day\'s volume rose by this in one tick - several trades bundled in it' : 'The tick\'s own last trade'}><span>{Math.round(v).toLocaleString('en-IN')}{o.bundled ? '*' : ''}</span></Tooltip> },
    { title: '× usual', dataIndex: 'ratio', align: 'right', width: 70, render: (v) => (v > 0 ? `${v.toFixed(1)}×` : '—') },
    { title: 'Price', dataIndex: 'price', align: 'right', width: 76, render: (v, o) => <span>{v.toFixed(2)} <span style={{ color: o.movePct > 0 ? UP_COLOR : o.movePct < 0 ? DOWN_COLOR : undefined, fontSize: 11 }}>{o.movePct > 0 ? '+' : ''}{o.movePct.toFixed(1)}%</span></span> },
    { title: 'Hit the book', width: 150, render: (_, o) => <span style={{ fontWeight: o.through ? 600 : 400 }}>{hitText(o)}</span> },
    { title: 'OI Δ', dataIndex: 'oiChange', align: 'right', width: 90, render: (v, o) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v / (o.lotSize || 1)).toLocaleString('en-IN')} lots`) },
    { title: 'Read', dataIndex: 'read' },
    { title: 'Index', dataIndex: 'bias', width: 76, render: (b) => (b === 0 ? '—' : <span style={{ color: b > 0 ? UP_COLOR : DOWN_COLOR, fontWeight: Math.abs(b) >= 1 ? 600 : 400 }}>{b > 0 ? '▲' : '▼'} {Math.abs(b) >= 1 ? 'strong' : 'weak'}</span>) },
    { title: '₹', dataIndex: 'value', align: 'right', width: 84, render: (v) => rupees(v) },
    { title: '', dataIndex: 'sweep', width: 70, render: (s) => (s ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>SWEEP</Tag> : null) },
  ]

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={[12, 6]}>
        <Tooltip title={isAdmin ? 'The index whose options TrueData streams (the trial allows 50 symbols: the two futures and one index\'s ATM ± 10 fit). Kept across a restart.' : 'An admin picks the index.'}>
          <span>Options of{' '}
            <Segmented size="small" value={state?.underlying || ''} disabled={!isAdmin} onChange={(v) => put(v, state?.strikes ?? 10)}
              options={[{ value: '', label: 'Off' }, { value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }]} />
          </span>
        </Tooltip>
        <span>ATM ± <Select size="small" value={state?.strikes ?? 10} disabled={!isAdmin || !state?.underlying} style={{ width: 70 }} options={STRIKE_CHOICES.map((v) => ({ value: v, label: v }))} onChange={(v) => put(state.underlying, v)} /></span>
        <Tooltip title="At least this many lots in one tick (a lot = the contract's lot size).">
          <span>≥ <InputNumber size="small" min={1} max={100000} value={minLots} onChange={(v) => setMinLots(v ?? TICK_ORDER_DEFAULTS.minLots)} style={{ width: 80 }} /> lots</span>
        </Tooltip>
        <Tooltip title="And at least this many times the option's OWN usual tick (the median of its last 50) once it has one.">
          <span>≥ <InputNumber size="small" min={1} max={100} value={multiple} onChange={(v) => setMultiple(v ?? TICK_ORDER_DEFAULTS.multiple)} style={{ width: 64 }} /> × usual</span>
        </Tooltip>
        <span>Last <Select size="small" value={lookback} onChange={setLookback} style={{ width: 80 }} options={LOOKBACKS.map((m) => ({ value: m, label: `${m} min` }))} /></span>
        <Checkbox checked={sweepsOnly} onChange={(e) => setSweepsOnly(e.target.checked)}>Sweeps only</Checkbox>
      </Space>

      {state && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {state.underlying
            ? `${state.underlying}${state.expiry ? ` · expiry ${state.expiry}` : ''}${state.atm ? ` · ATM ${state.atm.toLocaleString('en-IN')}` : ''} · ${state.subscribed} of ${state.cap} option symbols streaming · ${state.ticks.toLocaleString('en-IN')} option ticks${state.lastTickAt ? ` · last ${hhmmss(Date.parse(state.lastTickAt))} IST` : ''}`
            : 'No index picked - nothing is streamed.'}
        </Text>
      )}
      {error && <Alert type="warning" showIcon message={error} />}
      {state?.error && <Alert type="warning" showIcon message={`Option stream: ${state.error}`} />}

      <Space wrap size={[18, 6]} align="start">
        <Tooltip title={`Money in the big orders of the last ${lookback} min by what they mean for the index: bullish ${rupees(summary.bullValue)} (calls bought, puts written) against bearish ${rupees(summary.bearValue)} (puts bought, calls written); a build-up counts in full, a covering / unwinding / no-OI read half.`}>
          <div>
            <Text type="secondary" style={{ fontSize: 11 }}>Big money, last {lookback} min</Text>
            <div style={{ color, fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{word}{summary.count > 0 ? ` ${summary.net > 0 ? '+' : ''}${Math.round(summary.net * 100)}%` : ''}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{summary.count} order{summary.count === 1 ? '' : 's'}{summary.sweeps ? ` · ${summary.sweeps} in sweeps` : ''}</Text>
          </div>
        </Tooltip>
        {KINDS.map(([key, label, c]) => (
          <div key={key}>
            <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
            <div style={{ color: summary.kinds[key].count ? c : undefined, fontSize: 15, fontWeight: 600, lineHeight: 1.2 }}>{rupees(summary.kinds[key].value)}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{Math.round(summary.kinds[key].lots).toLocaleString('en-IN')} lots · {summary.kinds[key].count}</Text>
          </div>
        ))}
      </Space>

      <Table size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 'max-content' }}
        locale={{ emptyText: state?.underlying ? (orders.length ? 'No order passes the filters' : 'No big option order yet') : 'Pick an index above' }} />

      <FoldText id="tickBigOrders.how" className="oa-note" summary="How big option orders are read from TrueData's live ticks - and what they cannot tell">
        <div style={{ fontSize: 12 }}>
          The server subscribes the calls and puts ATM ± N of the index picked (the ATM from the options' own put-call parity once they tick, else the
          futures' price - it follows as spot moves, within TrueData's symbol cap). An order is one TrueData TICK of an option - a snapshot about every
          second, carrying the quantity traded since the one before; when the day's volume rose by more than the tick's own last trade the rise is taken
          (marked *, several trades in one second). Its SIDE is the quote before it (at / through the ask = bought, at / through the bid = sold); "hit
          the book" is its size against the size shown at the touch it took, and "swept" when its price went past the touch; × usual is against the
          option's own median tick; OI Δ is the open interest change since the option's tick before - with the side it reads as long build-up (buyers
          opened), short build-up (writers opened), short covering or long unwinding, and for the index a call bought / put written is bullish, a put
          bought / call written bearish. A SWEEP is the same kind at 3+ strikes within 3 minutes. It cannot see WHO - a market maker hedging looks like
          a buyer - and one tick can hold many small trades: a lead to check against the footprint, not a signal. Nothing here places an order.
        </div>
      </FoldText>
    </Space>
  )
}
