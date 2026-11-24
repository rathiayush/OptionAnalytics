import { useMemo } from 'react'
import { Alert, Checkbox, InputNumber, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { DOWN_COLOR, UP_COLOR, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { TICK_ORDER_DEFAULTS, bigEnough, bigTradesSummary, hitText, ordersUpTo, deltaLots, isLikelyHedge } from './tickBigOrders.js'
import { useBigOptionOrders, useBigOptionOrdersDay } from './useBigOptionOrders.js'
import { TickLiquidityMap } from './TickLiquidityMap.jsx'

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
 * the ATM), each big order read for its side, the book it hit, the OI it changed - and the strikes added up. Live only. The size is set in lots or in
 * QUANTITY (units) - the page's Lots / Quantity switch (`showLots`), each unit keeping its own number.
 */
export function TickBigOrdersCard({ isAdmin, replay, showLots: pageShowLots = true, index, replayDate, clockMs, priceBars }) {
  // The card has its own Lots / Quantity pick (starting from the page's switch), so the size filter is always right here beside "× usual".
  const [unit, setUnit] = usePersistedState('optionanalytics.tickFlow.bigUnit', pageShowLots ? 'lots' : 'qty')
  const showLots = unit === 'lots'
  const [minLots, setMinLots] = usePersistedState('optionanalytics.tickFlow.bigMinLots', TICK_ORDER_DEFAULTS.minLots)
  const [minQty, setMinQty] = usePersistedState('optionanalytics.tickFlow.bigMinQty', TICK_ORDER_DEFAULTS.minLots * 65)
  const [multiple, setMultiple] = usePersistedState('optionanalytics.tickFlow.bigMultiple', TICK_ORDER_DEFAULTS.multiple)
  const [lookback, setLookback] = usePersistedState('optionanalytics.tickFlow.bigLookback', TICK_ORDER_DEFAULTS.lookback)
  const [sweepsOnly, setSweepsOnly] = usePersistedState('optionanalytics.tickFlow.bigSweepsOnly', false)
  const liveFeed = useBigOptionOrders(!replay)
  const dayFeed = useBigOptionOrdersDay(index, replayDate, !!replay)
  const { state, live: enabled, error, now, pick: put } = liveFeed
  const orders = useMemo(() => (replay ? ordersUpTo(dayFeed.orders, clockMs) : liveFeed.orders), [replay, dayFeed.orders, clockMs, liveFeed.orders])

  // LIKELY HEDGES: deep in-the-money orders (>= N strikes) trade like the index itself - tagged, and left out of the lean, the delta flow, the map and the table when asked.
  const [hideHedges, setHideHedges] = usePersistedState('optionanalytics.tickFlow.hideHedges', false)
  const [hedgeSteps, setHedgeSteps] = usePersistedState('optionanalytics.tickFlow.hedgeSteps', 3)
  const sized = useMemo(() => bigEnough(orders, showLots ? { minLots, multiple } : { minQty, multiple }), [orders, showLots, minLots, minQty, multiple])
  const big = useMemo(() => (hideHedges ? sized.filter((o) => !isLikelyHedge(o, hedgeSteps)) : sized), [sized, hideHedges, hedgeSteps])
  const summary = useMemo(() => bigTradesSummary(big, replay ? clockMs ?? null : now || null, lookback, hedgeSteps), [big, replay, clockMs, now, lookback, hedgeSteps])
  const rows = useMemo(() => (sweepsOnly ? big.filter((o) => o.sweep) : big).slice(-SHOWN).reverse().map((o) => ({ ...o, key: o.seq })), [big, sweepsOnly])
  const [word, color] = lean[summary.lean]

  // Why there is nothing to show yet - said BELOW the filters, which stay on the card (size, quantity, × usual).
  const notice = replay && dayFeed.error ? <Alert type="warning" showIcon message={`Big option orders: ${dayFeed.error}`} />
    : replay && dayFeed.answer?.state === 'failed' ? <Alert type="warning" showIcon message="The day's option ticks could not be built" description={dayFeed.answer.error} />
      : replay && !dayFeed.ready ? <Alert type="info" showIcon message={`Loading the day's option ticks from TrueData… ${dayFeed.answer?.done ?? 0} of ${dayFeed.answer?.total ?? '?'} contracts`} description="One history call per option (ATM ± 10 over the day's range) - a few minutes the first time; the day is kept on the server after." />
        : !replay && !enabled ? <Alert type="info" showIcon message="The TrueData live feed is off" /> : null

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
    { title: showLots ? 'Lots' : 'Qty', dataIndex: 'lots', align: 'right', width: 74, render: (_, o) => <Tooltip title={o.bundled ? 'The day\'s volume rose by this in one tick - several trades bundled in it' : 'The tick\'s own last trade'}><span>{showLots ? Math.round(o.lots).toLocaleString('en-IN') : Math.round(o.qty).toLocaleString('en-IN')}{o.bundled ? '*' : ''}</span></Tooltip> },
    { title: '× usual', dataIndex: 'ratio', align: 'right', width: 70, render: (v) => (v > 0 ? `${v.toFixed(1)}×` : '—') },
    { title: 'Price', dataIndex: 'price', align: 'right', width: 76, render: (v, o) => <span>{v.toFixed(2)} <span style={{ color: o.movePct > 0 ? UP_COLOR : o.movePct < 0 ? DOWN_COLOR : undefined, fontSize: 11 }}>{o.movePct > 0 ? '+' : ''}{o.movePct.toFixed(1)}%</span></span> },
    { title: 'Hit the book', width: 150, render: (_, o) => <span style={{ fontWeight: o.through ? 600 : 400 }}>{hitText(o)}</span> },
    { title: 'OI Δ', dataIndex: 'oiChange', align: 'right', width: 90, render: (v, o) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v / (o.lotSize || 1)).toLocaleString('en-IN')} lots`) },
    { title: 'Read', dataIndex: 'read', render: (v, o) => <span>{v}{isLikelyHedge(o, hedgeSteps) && <Tooltip title={`${Math.round(Math.abs(o.atmDistance))} strikes in the money - trades like the index, mostly a hedge or stock replacement`}> <Tag color="default" style={{ marginInlineEnd: 0 }}>HEDGE?</Tag></Tooltip>}</span> },
    { title: 'Δ lots', width: 78, align: 'right', render: (_, o) => { const d = deltaLots(o); return d === 0 ? '—' : <span style={{ color: d > 0 ? UP_COLOR : DOWN_COLOR }}>{d > 0 ? '+' : ''}{Math.round(d).toLocaleString('en-IN')}</span> } },
    { title: 'Index', dataIndex: 'bias', width: 76, render: (b) => (b === 0 ? '—' : <span style={{ color: b > 0 ? UP_COLOR : DOWN_COLOR, fontWeight: Math.abs(b) >= 1 ? 600 : 400 }}>{b > 0 ? '▲' : '▼'} {Math.abs(b) >= 1 ? 'strong' : 'weak'}</span>) },
    { title: '₹', dataIndex: 'value', align: 'right', width: 84, render: (v) => rupees(v) },
    { title: '', dataIndex: 'sweep', width: 70, render: (s) => (s ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>SWEEP</Tag> : null) },
  ]

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={[12, 6]}>
        {!replay && (<>
        <Tooltip title={isAdmin ? 'The index whose options TrueData streams (the trial allows 50 symbols: the two futures and one index\'s ATM ± 10 fit). Kept across a restart.' : 'An admin picks the index.'}>
          <span>Options of{' '}
            <Segmented size="small" value={state?.underlying || ''} disabled={!isAdmin} onChange={(v) => put(v, state?.strikes ?? 10)}
              options={[{ value: '', label: 'Off' }, { value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }]} />
          </span>
        </Tooltip>
        <span>ATM ± <Select size="small" value={state?.strikes ?? 10} disabled={!isAdmin || !state?.underlying} style={{ width: 70 }} options={STRIKE_CHOICES.map((v) => ({ value: v, label: v }))} onChange={(v) => put(state.underlying, v)} /></span>
        </>)}
        <Segmented size="small" value={unit} onChange={setUnit} options={[{ value: 'lots', label: 'Lots' }, { value: 'qty', label: 'Quantity' }]} aria-label="Size unit" />
        <Tooltip title={showLots ? 'At least this many lots in one tick (a lot = the contract\'s lot size).' : 'At least this QUANTITY (units) in one tick.'}>
          {showLots
            ? <span>≥ <InputNumber size="small" min={1} max={100000} value={minLots} onChange={(v) => setMinLots(v ?? TICK_ORDER_DEFAULTS.minLots)} style={{ width: 80 }} /> lots</span>
            : <span>≥ <InputNumber size="small" min={1} max={10_000_000} step={65} value={minQty} onChange={(v) => setMinQty(v ?? TICK_ORDER_DEFAULTS.minLots * 65)} style={{ width: 100 }} /> qty</span>}
        </Tooltip>
        <Tooltip title="And at least this many times the option's OWN usual tick (the median of its last 50) once it has one.">
          <span>≥ <InputNumber size="small" min={1} max={100} value={multiple} onChange={(v) => setMultiple(v ?? TICK_ORDER_DEFAULTS.multiple)} style={{ width: 64 }} /> × usual</span>
        </Tooltip>
        <span>Last <Select size="small" value={lookback} onChange={setLookback} style={{ width: 80 }} options={LOOKBACKS.map((m) => ({ value: m, label: `${m} min` }))} /></span>
        <Tooltip title="A deep in-the-money option trades almost like the index itself, so a big order there is mostly a hedge or a stock replacement, not a fresh view. Tagged HEDGE? on the table; tick to leave them out of the lean, the delta flow, the map and the table.">
          <Checkbox checked={hideHedges} onChange={(e) => setHideHedges(e.target.checked)}>Hide likely hedges (ITM ≥ <Select size="small" value={hedgeSteps} onChange={setHedgeSteps} style={{ width: 56 }} options={[2, 3, 4, 5].map((v) => ({ value: v, label: v }))} onClick={(e) => e.stopPropagation()} /> strikes)</Checkbox>
        </Tooltip>
        <Checkbox checked={sweepsOnly} onChange={(e) => setSweepsOnly(e.target.checked)}>Sweeps only</Checkbox>
      </Space>

      {notice}
      {!notice && (<>

      {replay && dayFeed.ready && (
        <Text type="secondary" style={{ fontSize: 12 }}>{`${index} · expiry ${dayFeed.answer.expiry} · from TrueData's tick history, orders of ${Math.round(TICK_ORDER_DEFAULTS.minLots)}+ lots and ${TICK_ORDER_DEFAULTS.multiple}× usual or more${dayFeed.answer.failed ? ` · ${dayFeed.answer.failed} contracts had no data` : ''}`}</Text>
      )}
      {!replay && state && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {state.underlying
            ? `${state.underlying}${state.expiry ? ` · expiry ${state.expiry}` : ''}${state.atm ? ` · ATM ${state.atm.toLocaleString('en-IN')}` : ''} · ${state.subscribed} of ${state.cap} option symbols streaming · ${state.ticks.toLocaleString('en-IN')} option ticks${state.lastTickAt ? ` · last ${hhmmss(Date.parse(state.lastTickAt))} IST` : ''}`
            : 'No index picked - nothing is streamed.'}
        </Text>
      )}
      {!replay && error && <Alert type="warning" showIcon message={error} />}
      {!replay && state?.error && <Alert type="warning" showIcon message={`Option stream: ${state.error}`} />}

      <Space wrap size={[18, 6]} align="start">
        <Tooltip title={`Money in the big orders of the last ${lookback} min by what they mean for the index: bullish ${rupees(summary.bullValue)} (calls bought, puts written) against bearish ${rupees(summary.bearValue)} (puts bought, calls written); a build-up counts in full, a covering / unwinding / no-OI read half.`}>
          <div>
            <Text type="secondary" style={{ fontSize: 11 }}>Big money, last {lookback} min</Text>
            <div style={{ color, fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{word}{summary.count > 0 ? ` ${summary.net > 0 ? '+' : ''}${Math.round(summary.net * 100)}%` : ''}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{summary.count} order{summary.count === 1 ? '' : 's'}{summary.sweeps ? ` · ${summary.sweeps} in sweeps` : ''}</Text>
          </div>
        </Tooltip>
        <Tooltip title={`The orders as exposure to the INDEX, in futures-equivalent lots: lots x delta (about, from how far in / out of the money - no IV on this feed), + for calls bought / puts written, - for puts bought / calls written. ${summary.hedges} of the ${summary.count} orders are deep in the money (likely hedges).`}>
          <div>
            <Text type="secondary" style={{ fontSize: 11 }}>Net delta flow, last {lookback} min</Text>
            <div style={{ color: summary.netDeltaLots > 0 ? UP_COLOR : summary.netDeltaLots < 0 ? DOWN_COLOR : undefined, fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{summary.netDeltaLots > 0 ? '+' : ''}{Math.round(summary.netDeltaLots).toLocaleString('en-IN')} lots</div>
            <Text type="secondary" style={{ fontSize: 11 }}>futures-equivalent{summary.hedges ? ` · ${summary.hedges} likely hedge${summary.hedges === 1 ? '' : 's'}` : ''}</Text>
          </div>
        </Tooltip>
        {KINDS.map(([key, label, c]) => (
          <div key={key}>
            <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
            <div style={{ color: summary.kinds[key].count ? c : undefined, fontSize: 15, fontWeight: 600, lineHeight: 1.2 }}>{rupees(summary.kinds[key].value)}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{showLots ? `${Math.round(summary.kinds[key].lots).toLocaleString('en-IN')} lots` : `${Math.round(summary.kinds[key].qty).toLocaleString('en-IN')} qty`} · {summary.kinds[key].count}</Text>
          </div>
        ))}
      </Space>

      <TickLiquidityMap orders={big} priceBars={priceBars} step={index === 'BANKNIFTY' ? 100 : 50} />

      <Table size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 'max-content' }}
        locale={{ emptyText: (replay || state?.underlying) ? (orders.length ? 'No order passes the filters' : replay ? 'No big option order up to the clock' : 'No big option order yet') : 'Pick an index above' }} />

      </>)}

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
