import { useMemo } from 'react'
import { Checkbox, InputNumber, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { DOWN_COLOR, UP_COLOR, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { PAPER_TRADE_LOT_SIZE } from './tradeDefaults.js'
import { BIG_DEFAULTS, bigOptionTrades, bigTradesSummary } from './bigOptionTrades.js'

const { Text } = Typography
const SHOWN = 40
const CRORE = 1e7
const LOOKBACKS = [5, 15, 30, 60]
const hhmm = (ms) => istTimeFormatter(toChartTime(ms))
const rupees = (v) => {
  if (!Number.isFinite(v) || v === 0) return '₹0'
  return Math.abs(v) >= CRORE ? `₹${(v / CRORE).toFixed(2)} Cr` : `₹${(v / 1e5).toFixed(1)} L`
}
const lean = { bullish: ['BULLISH', UP_COLOR], bearish: ['BEARISH', DOWN_COLOR], mixed: ['MIXED', '#8c8c8c'], none: ['NO BIG TRADES', '#8c8c8c'] }
const KIND_LABELS = [
  ['ceBought', 'Calls bought / covered', UP_COLOR],
  ['peBought', 'Puts bought / covered', DOWN_COLOR],
  ['ceWritten', 'Calls written / unwound', DOWN_COLOR],
  ['peWritten', 'Puts written / unwound', UP_COLOR],
]

/** OI Replay's "Big option trades": the big minutes at the strikes within ATM ± N, read and added up (bigOptionTrades.js). */
export function BigOptionTradesCard({ cePoints, pePoints, spotBars, asOfMs, underlying, isLive }) {
  const [strikesEach, setStrikesEach] = usePersistedState('optionanalytics.oiReplay.bigTradesStrikes', BIG_DEFAULTS.strikesEach)
  const [multiple, setMultiple] = usePersistedState('optionanalytics.oiReplay.bigTradesMultiple', BIG_DEFAULTS.multiple)
  const [minLots, setMinLots] = usePersistedState('optionanalytics.oiReplay.bigTradesMinLots', BIG_DEFAULTS.minLots)
  const [lookback, setLookback] = usePersistedState('optionanalytics.oiReplay.bigTradesLookback', BIG_DEFAULTS.lookback)
  const [sweepsOnly, setSweepsOnly] = usePersistedState('optionanalytics.oiReplay.bigTradesSweepsOnly', false)
  const lotSize = PAPER_TRADE_LOT_SIZE[underlying] ?? 1

  const events = useMemo(() => bigOptionTrades(cePoints, pePoints, spotBars, {
    lotSize, strikesEach, multiple, minLots, asOfMs: isLive ? null : asOfMs, dropForming: !!isLive,
  }), [cePoints, pePoints, spotBars, lotSize, strikesEach, multiple, minLots, asOfMs, isLive])

  // Live: the summary ends at the last COMPLETED minute held (the newest is still forming); a replay at its clock.
  const liveEnd = useMemo(() => {
    if (!isLive) return null
    let max = -Infinity
    for (const list of [cePoints, pePoints]) for (const p of list ?? []) { const t = new Date(p.time).getTime(); if (t > max) max = t }
    return Number.isFinite(max) ? max - 60_000 : null
  }, [cePoints, pePoints, isLive])
  const nowMs = isLive ? liveEnd : asOfMs
  const summary = useMemo(() => bigTradesSummary(events, nowMs, lookback), [events, nowMs, lookback])
  const rows = useMemo(() => (sweepsOnly ? events.filter((e) => e.sweep) : events).slice(-SHOWN).reverse()
    .map((e) => ({ ...e, key: `${e.t}-${e.strike}-${e.type}` })), [events, sweepsOnly])
  const [word, color] = lean[summary.lean]

  const columns = [
    { title: 'Time', dataIndex: 't', width: 62, render: (t) => hhmm(t) },
    {
      title: 'Strike', width: 130,
      render: (_, e) => (
        <Space size={4}>
          <Tag color={e.type === 'CE' ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>{e.type}</Tag>
          <span>{e.strike}</span>
          <Text type="secondary" style={{ fontSize: 11 }}>{e.atmDistance === 0 ? 'ATM' : `ATM${e.atmDistance > 0 ? '+' : ''}${e.atmDistance}`}</Text>
        </Space>
      ),
    },
    { title: 'Lots', dataIndex: 'lots', align: 'right', width: 60, render: (v) => Math.round(v).toLocaleString('en-IN') },
    { title: '× usual', dataIndex: 'ratio', align: 'right', width: 70, render: (v) => `${v.toFixed(1)}×` },
    { title: 'Premium', dataIndex: 'movePct', align: 'right', width: 76, render: (v) => <span style={{ color: v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined }}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span> },
    { title: 'OI Δ', dataIndex: 'oiChange', align: 'right', width: 80, render: (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v / lotSize).toLocaleString('en-IN')} lots`) },
    { title: 'Read', dataIndex: 'read' },
    {
      title: 'Index', dataIndex: 'bias', width: 70,
      render: (b) => (b === 0 ? '—' : <span style={{ color: b > 0 ? UP_COLOR : DOWN_COLOR, fontWeight: Math.abs(b) >= 1 ? 600 : 400 }}>{b > 0 ? '▲' : '▼'} {Math.abs(b) >= 1 ? 'strong' : 'weak'}</span>),
    },
    { title: '₹', dataIndex: 'value', align: 'right', width: 84, render: (v) => rupees(v) },
    { title: '', dataIndex: 'sweep', width: 70, render: (s) => (s ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>SWEEP</Tag> : null) },
  ]

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={[12, 6]}>
        <Tooltip title="Strikes within this many steps of the ATM of each minute (the spot's nearest strike) are read - the calls and the puts together.">
          <span>ATM ± <InputNumber size="small" min={1} max={10} value={strikesEach} onChange={(v) => setStrikesEach(v ?? BIG_DEFAULTS.strikesEach)} style={{ width: 60 }} /></span>
        </Tooltip>
        <Tooltip title="A minute is big when the strike traded at least this many times its OWN usual volume (the median of its earlier bars).">
          <span>≥ <InputNumber size="small" min={2} max={50} value={multiple} onChange={(v) => setMultiple(v ?? BIG_DEFAULTS.multiple)} style={{ width: 60 }} /> × usual</span>
        </Tooltip>
        <Tooltip title="And at least this many lots - a thin strike's 4x of almost nothing is not a big trade.">
          <span>≥ <InputNumber size="small" min={1} max={100000} value={minLots} onChange={(v) => setMinLots(v ?? BIG_DEFAULTS.minLots)} style={{ width: 80 }} /> lots</span>
        </Tooltip>
        <span>Last <Select size="small" value={lookback} onChange={setLookback} style={{ width: 80 }} options={LOOKBACKS.map((m) => ({ value: m, label: `${m} min` }))} /></span>
        <Checkbox checked={sweepsOnly} onChange={(e) => setSweepsOnly(e.target.checked)}>Sweeps only</Checkbox>
      </Space>

      <Space wrap size={[18, 6]} align="start">
        <Tooltip title={`Money in the big trades of the last ${lookback} min by what they mean for the index: bullish ${rupees(summary.bullValue)} (calls bought, puts written) against bearish ${rupees(summary.bearValue)} (puts bought, calls written); a build-up counts in full, a covering / unwinding / no-OI read half.`}>
          <div>
            <Text type="secondary" style={{ fontSize: 11 }}>Big money, last {lookback} min</Text>
            <div style={{ color, fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{word}{summary.count > 0 ? ` ${summary.net > 0 ? '+' : ''}${Math.round(summary.net * 100)}%` : ''}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{summary.count} big minute{summary.count === 1 ? '' : 's'}{summary.sweeps ? ` · ${summary.sweeps} in sweeps` : ''}</Text>
          </div>
        </Tooltip>
        {KIND_LABELS.map(([key, label, c]) => (
          <div key={key}>
            <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
            <div style={{ color: summary.kinds[key].count ? c : undefined, fontSize: 15, fontWeight: 600, lineHeight: 1.2 }}>{rupees(summary.kinds[key].value)}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{Math.round(summary.kinds[key].lots).toLocaleString('en-IN')} lots · {summary.kinds[key].count}</Text>
          </div>
        ))}
      </Space>

      <Table
        size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 'max-content' }}
        locale={{ emptyText: events.length ? 'No sweeps yet' : 'No big option trades yet - needs a few minutes of each strike\'s bars first' }}
      />

      <FoldText id="bigOptionTrades.how" className="oa-note" summary="How it reads big trades from the options - and what it cannot know">
        <div style={{ fontSize: 12 }}>
          Dhan sends no time &amp; sales for options, only a 1-minute bar (price, volume, OI) per strike - so a "big trade" here is a BIG MINUTE
          at a strike: its volume against that strike's own usual (the median of its earlier bars), and at least the lots set. Each is read from
          its bar and OI: price up with OI up = long build-up (buyers opened), price down with OI up = short build-up (writers opened), price
          up with OI down = short covering, price down with OI down = long unwinding; without an OI reading just bought / sold. For the index a
          call bought or put written is bullish, a put bought or call written bearish. Only the strikes within ATM ± N of that minute's ATM are
          read and the strikes are added up; a SWEEP is the same kind at {BIG_DEFAULTS.sweepStrikes}+ strikes within {BIG_DEFAULTS.sweepMinutes} minutes -
          one decision spread over the chain. A big minute can be many small trades, and the bar cannot tell a buyer who opens from a dealer
          who hedges: it is a lead to check against the OI, the straddle and the flow, not a signal. Nothing here places an order or feeds a strategy.
        </div>
      </FoldText>
    </Space>
  )
}
