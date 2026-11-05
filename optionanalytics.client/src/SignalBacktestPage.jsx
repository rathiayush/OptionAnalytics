import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, DatePicker, Input, InputNumber, Progress, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import { CloudServerOutlined, CloseOutlined, DownloadOutlined, PlayCircleOutlined, PlusOutlined, StopOutlined, SwapOutlined, TrophyOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { LineSeries } from 'lightweight-charts'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, NavBar, UP_COLOR, useMediaQuery, usePersistedState } from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { PAPER_TRADE_LOT_SIZE } from './scannerCore.js'
import {
  BACKTEST_DEFAULTS, DEFAULT_THEN_WINDOW, EXPIRY_DAY_CHOICES, LEVEL_UNITS, THEN_WINDOWS, MAX_BACKGROUND_DAYS, MAX_BACKTEST_DAYS, MAX_GROUP_DEPTH, RULE_ACTIONS, RULE_CONDITIONS, TIMEFRAMES, WINDOW_CHOICES, backtestDays, cleanLine, istMinute,
  mirrorIsSame, mirrorLines, normalizeRule, ruleText, setConnectorAt, tradesCsv, treeFromLogic,
} from './signalBacktest.js'
import { backtestReport, cleanBacktestSettings, dayOutcome, engineSettings, loadBacktestDay, reportHead } from './signalBacktestJob.js'
import { BackgroundRunsCard, RunInBackgroundModal } from './SignalBacktestRuns.jsx'
import { runResult, useBackgroundRuns } from './signalBacktestQueue.js'
import { SaveStrategyModal, SavedStrategiesCard } from './SignalStrategiesCard.jsx'
import { RULE_TEMPLATES, TEMPLATE_FAMILIES, templateById, templateRow, withTemplate } from './signalTemplates.js'
import { useSavedStrategies } from './signalStrategiesApi.js'
import { FoldText } from './FoldText.jsx'
import { BacktestDayChartCard } from './SignalBacktestChart.jsx'
import { DATE_INPUT_FORMATS, isPastDay, rangePresets, withRangeEnd } from './backtestDates.js'

// The SIGNAL BACKTEST page: pick an index and a range of past days and BUILD ONE RULE with dropdowns - groups (Match ALL /
// ANY, NOT) of conditions (an indicator, what it says, its number and look-back) and of groups (the brackets), the trade it
// makes and, optionally, its mirror; each day is loaded as OI
// Replay loads it (the server keeps past days on disk - a day never loaded before comes from Dhan once), replayed through
// the rule (signalBacktest.js - each signal from data up to its candle's close only) and every signal's option trade
// simulated; the report sums them for the rule, its mirror and both, per day and trade by trade (signalBacktestJob.js). A
// day is prepared once and kept for the tab's life, so changing the rule, the timeframe or the stop / target re-runs at
// once with no new load. Or the run goes to the server's BACKGROUND queue (now or at a time - SignalBacktestJobService
// runs the same code), the browser can be closed, and its report is opened here from "Background runs".

const { Text, Title } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const LOAD_TIMEOUT_MS = 240_000
const STORE = {
  underlying: 'optionanalytics.signalBacktest.underlying',
  range: 'optionanalytics.signalBacktest.range',
  moneyness: 'optionanalytics.signalBacktest.moneyness',
  slPct: 'optionanalytics.signalBacktest.slPct',
  targetPct: 'optionanalytics.signalBacktest.targetPct',
  levelUnit: 'optionanalytics.signalBacktest.levelUnit',
  trailGap: 'optionanalytics.signalBacktest.trailGap',
  trailStart: 'optionanalytics.signalBacktest.trailStart',
  timeStopMin: 'optionanalytics.signalBacktest.timeStopMin',
  maxTradesPerDay: 'optionanalytics.signalBacktest.maxTradesPerDay',
  cooldownMin: 'optionanalytics.signalBacktest.cooldownMin',
  maxDayLoss: 'optionanalytics.signalBacktest.maxDayLoss',
  maxDayProfit: 'optionanalytics.signalBacktest.maxDayProfit',
  lots: 'optionanalytics.signalBacktest.lots',
  charges: 'optionanalytics.signalBacktest.charges',
  sttPct: 'optionanalytics.signalBacktest.sttPct',
  brokeragePerOrder: 'optionanalytics.signalBacktest.brokeragePerOrder',
  otherPerTrade: 'optionanalytics.signalBacktest.otherPerTrade',
  timeframe: 'optionanalytics.signalBacktest.timeframe',
  rule: 'optionanalytics.signalBacktest.rule',
  bgTelegram: 'optionanalytics.signalBacktest.bgTelegram',
  expiryDay: 'optionanalytics.signalBacktest.expiryDay',
  chartOpen: 'optionanalytics.signalBacktest.chartOpen',
  strategyName: 'optionanalytics.signalBacktest.strategyName',
}
const SIDE = { rule: { name: 'Rule', color: '#4096ff' }, mirror: { name: 'Mirror', color: '#fa8c16' }, all: { name: 'Both', color: '#e6e6e6' } }
const GROUPS = [...new Set(RULE_CONDITIONS.map((c) => c.group))]
const GROUP_TITLE = {
  OI: 'OI (OI Replay)', GEX: 'GEX', Price: 'Price', Indicators: 'Indicators (spot candles - RSI, EMA)', Options: "Option premium - the ATM strike's own chart (VWAP, EMA, RSI)", Straddle: 'ATM straddle', Profile: "Today's market profile",
  PrevProfile: "Previous day's volume profile (yesterday's levels)", Pivots: "Pivot points / CPR (the previous day's high, low, close)",
}
const CONDITION_OF = Object.fromEntries(RULE_CONDITIONS.map((c) => [c.id, c]))
const OPPOSITE_ACTION = Object.fromEntries(RULE_ACTIONS.map((a) => [a.value, a.opposite]))
// The indicator dropdown: the conditions under their group's title.
const INDICATOR_OPTIONS = GROUPS.map((g) => ({ label: GROUP_TITLE[g] ?? g, options: RULE_CONDITIONS.filter((c) => c.group === g).map((c) => ({ value: c.id, label: c.name })) }))
const POPUP = { popup: { root: 'oa-rule-popup' } }
// A new line for condition `id`: its first value, that value's own number and window.
const freshLine = (id, join = 'and') => cleanLine({ id, value: CONDITION_OF[id].options[0].value, join })

// ---- The rule builder: groups of conditions and groups, all dropdowns -------------------------------------------------

/** The tree with the group at `path` (each step a group's place in its parent's items) replaced by fn(group). */
function editGroup(tree, path, fn) {
  if (!path.length) return fn(tree)
  const [k, ...rest] = path
  return { ...tree, items: tree.items.map((it, j) => (j === k && it.group ? { group: editGroup(it.group, rest, fn) } : it)) }
}
/** A condition changed: a new value keeps the number only when it is the same kind of number. */
function editLine(line, change) {
  const next = { ...line, ...change }
  if (change.value) {
    const before = CONDITION_OF[line.id].options.find((o) => o.value === line.value)
    const after = CONDITION_OF[line.id].options.find((o) => o.value === change.value)
    if (before?.param?.label !== after?.param?.label) delete next.param
    if (before?.param2?.label !== after?.param2?.label) delete next.param2
    if (before?.param3?.label !== after?.param3?.label) delete next.param3
    if (before?.param4?.label !== after?.param4?.label) delete next.param4
  }
  return cleanLine(next) ?? line
}
/** Every condition id in the tree (a new condition starts on one not used yet). */
function idsIn(tree, out = new Set()) {
  for (const it of tree.items) if (it.line) out.add(it.line.id); else idsIn(it.group, out)
  return out
}
const nextId = (tree) => (RULE_CONDITIONS.find((c) => !idsIn(tree).has(c.id)) ?? RULE_CONDITIONS[0]).id
/** Each condition's number (as the logic names it - the tree's order), by its path "0.2.1". */
function lineNumbers(tree) {
  const out = new Map()
  let n = 0
  const walk = (g, path) => g.items.forEach((it, k) => (it.line ? out.set([...path, k].join('.'), ++n) : walk(it.group, [...path, k])))
  walk(tree, [])
  return out
}

function ConditionRow({ line, no, onChange, onRemove }) {
  const c = CONDITION_OF[line.id]
  const o = c.options.find((x) => x.value === line.value)
  return (
    <div className="oa-rule-line">
      <span className="oa-rule-no" title={`Condition ${no} - its number in the logic shown under the rule`}>{no}</span>
      <Select size="small" className="oa-rule-ind" value={line.id} onChange={(id) => onChange(freshLine(id))} options={INDICATOR_OPTIONS} popupMatchSelectWidth={false} classNames={POPUP} />
      <Select size="small" className="oa-rule-val" value={line.value} onChange={(v) => onChange(editLine(line, { value: v }))} options={c.options.map((x) => ({ value: x.value, label: x.label }))} popupMatchSelectWidth={false} classNames={POPUP} />
      {o.param && (
        <InputNumber
          size="small" className="oa-rule-num" min={o.param.min} max={o.param.max} step={o.param.step} value={line.param}
          onChange={(v) => onChange(editLine(line, { param: v ?? o.param.default }))} addonBefore={o.param.label} addonAfter={o.param.unit}
        />
      )}
      {o.param2 && (
        <InputNumber
          size="small" className="oa-rule-num oa-rule-num--wide" min={o.param2.min} max={o.param2.max} step={o.param2.step} value={line.param2}
          onChange={(v) => onChange(editLine(line, { param2: v ?? o.param2.default }))} addonBefore={o.param2.label} addonAfter={o.param2.after ? o.param2.after(line.param2) : o.param2.unit}
        />
      )}
      {o.param3 && (
        <InputNumber
          size="small" className="oa-rule-num oa-rule-num--wide" min={o.param3.min} max={o.param3.max} step={o.param3.step} value={line.param3}
          onChange={(v) => onChange(editLine(line, { param3: v ?? o.param3.default }))} addonBefore={o.param3.label} addonAfter={o.param3.unit}
        />
      )}
      {o.param4 && (
        <Tooltip title={o.param4.tip}>
          <InputNumber
            size="small" className="oa-rule-num oa-rule-num--slope" min={o.param4.min} max={o.param4.max} step={o.param4.step} value={line.param4}
            onChange={(v) => onChange(editLine(line, { param4: v ?? o.param4.default }))} addonBefore={o.param4.label} addonAfter={o.param4.unit}
          />
        </Tooltip>
      )}
      {o.windowed && (
        <Select size="small" className="oa-rule-win" value={line.windowMin} onChange={(v) => onChange(editLine(line, { windowMin: v }))} options={WINDOW_CHOICES.map((m) => ({ value: m, label: `last ${m} min` }))} />
      )}
      <Button size="small" type="text" icon={<CloseOutlined />} onClick={onRemove} aria-label="Remove this condition" title="Remove this condition" />
    </div>
  )
}

/** The AND / OR between two items of a group - a tap switches THAT one only (`setConnectorAt`: AND binds tighter, so a
 *  run of AND-ed items gets its own box - the brackets); disabled where that would need a group deeper than allowed. */
function Connector({ op, tree, path, k, onConnector, touch }) {
  // In an IN ORDER group every connector is THEN: the order is the point - not a switch.
  if (op === 'then') {
    return (
      <div className="oa-rule-connector">
        <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, paddingInline: 8 }}>THEN ↓</Text>
      </div>
    )
  }
  const other = op === 'and' ? 'or' : 'and'
  const can = setConnectorAt(tree, path, k, other) !== tree
  const button = (
    <Button size="small" type="text" className="oa-rule-connector-btn" disabled={!can} onClick={() => onConnector(path, k, other)} aria-label={`${op.toUpperCase()} - tap to make it ${other.toUpperCase()}`}>
      {op === 'and' ? 'AND' : 'OR'} <SwapOutlined />
    </Button>
  )
  // No tooltip on a touch screen: a tap opened it over the conditions below (the hint under the rule says the same).
  return (
    <div className="oa-rule-connector">
      {touch ? button : (
        <Tooltip title={can ? `Make this one ${other.toUpperCase()} - only between these two (the others stay; AND binds tighter, so AND-ed conditions get a box of their own - the brackets)` : 'A group cannot go deeper here'}>
          {button}
        </Tooltip>
      )}
    </div>
  )
}

/**
 * The rule's LOGIC as text, both ways: it shows the builder's logic ("(1 AND 2) OR 3"), and logic typed here and applied
 * (Apply, Enter, or leaving the box) redraws the builder to it (`treeFromLogic`) - every condition in it once, AND before
 * OR, brackets at most MAX_GROUP_DEPTH deep; what cannot be read says why and changes nothing. Mounted again (`key`) when
 * the builder's logic changes, so a half-typed line never sits over a rule changed with the dropdowns.
 */
function LogicInput({ tree, logic, onApply }) {
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState(null)
  const [choices, setChoices] = useState([])
  const changed = draft != null && draft.trim() !== logic
  const clear = () => { setDraft(null); setError(null); setChoices([]) }
  const applyText = (text, quiet = false) => {
    if (text == null || text.trim() === logic) { clear(); return }
    const r = treeFromLogic(tree, text)
    if (!r.ok) {
      if (!quiet || text.trim()) { setError(r.error); setChoices(r.choices ?? []) }
      return
    }
    onApply(r.tree)
    // The same rule written another way ("1 or 2") leaves the logic as it was: show the rule's own again.
    clear()
  }
  return (
    <div className="oa-rule-logic">
      <div className="oa-rule-logic-row">
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Logic</Text>
        <Input
          size="small" value={draft ?? logic} status={error ? 'error' : undefined} placeholder="(1 AND 2) OR 3" spellCheck={false} autoComplete="off"
          autoCorrect="off" autoCapitalize="characters" onChange={(e) => { setDraft(e.target.value); setError(null); setChoices([]) }}
          onPressEnter={() => applyText(draft)} onBlur={() => changed && applyText(draft, true)}
          aria-label="The rule's logic - condition numbers with AND, OR, NOT, THEN and brackets"
        />
        <Button size="small" type="primary" disabled={!changed} onMouseDown={(e) => e.preventDefault()} onClick={() => applyText(draft)}>Apply</Button>
        {changed && <Button size="small" onMouseDown={(e) => e.preventDefault()} onClick={clear}>Undo</Button>}
      </div>
      {error
        ? (
            <>
              <Text type="danger" style={{ fontSize: 12 }}>{error}{choices.length ? ':' : ' - nothing changed.'}</Text>
              {choices.length > 0 && (
                <Space size={6} wrap>
                  {choices.map((c) => (
                    <Button key={c} size="small" className="oa-rule-logic-choice" onMouseDown={(e) => e.preventDefault()} onClick={() => applyText(c)}>{c}</Button>
                  ))}
                </Space>
              )}
            </>
          )
        : <Text type="secondary" style={{ fontSize: 12 }}>Type the condition numbers with AND, OR, NOT and brackets - e.g. (1 AND 2) OR (3 AND 4) - and Apply: the conditions above follow, numbered in the order written. AND and OR side by side need brackets to say which goes first. THEN puts them in order - 1 THEN 2 THEN 3 WITHIN 60 (each after the one before, the first within the last 60 min). Changing the conditions above changes this too.</Text>}
    </div>
  )
}

/** A group: NOT, Match ALL / ANY, its conditions and groups (the brackets) - each group inside a box of its own. */
function RuleGroup({ group, path, tree, numbers, onEdit, onRemove, onConnector, touch }) {
  const depth = path.length
  const edit = (fn) => onEdit(path, fn)
  const items = (fn) => edit((g) => ({ ...g, items: fn(g.items) }))
  return (
    <div className={`oa-rule-group oa-rule-group--d${depth % 4}`}>
      <div className="oa-rule-group-head">
        {depth === 0 && <Text strong style={{ fontSize: 12 }}>Signal when</Text>}
        <Tooltip title="NOT: the group holds when what is inside it does NOT.">
          <Checkbox checked={group.not} onChange={(e) => edit((g) => ({ ...g, not: e.target.checked }))}><Text style={{ fontSize: 12 }}>NOT</Text></Checkbox>
        </Tooltip>
        <Tooltip title={touch ? null : 'Sets EVERY AND / OR in this box at once (to change just one, click the AND / OR between two conditions). IN ORDER: each one after the one before it, all within the minutes picked.'}>
          <Select
            size="small" value={group.op} onChange={(op) => edit((g) => ({ ...g, op }))} style={{ width: 170 }}
            options={[{ value: 'and', label: 'ALL of these (AND)' }, { value: 'or', label: 'ANY of these (OR)' }, { value: 'then', label: 'IN ORDER (THEN)' }]}
          />
        </Tooltip>
        {group.op === 'then' && (
          <Select
            size="small" value={group.within ?? DEFAULT_THEN_WINDOW} onChange={(within) => edit((g) => ({ ...g, within }))} style={{ width: 130 }} aria-label="All of them within"
            options={[...new Set([...THEN_WINDOWS, group.within ?? DEFAULT_THEN_WINDOW])].sort((a, b) => a - b).map((m) => ({ value: m, label: `within ${m} min` }))}
          />
        )}
        <Space size={6} wrap className="oa-rule-group-add">
          <Button size="small" icon={<PlusOutlined />} onClick={() => items((list) => [...list, { line: freshLine(nextId(tree)) }])}>Condition</Button>
          {depth < MAX_GROUP_DEPTH && (
            <Tooltip title="A group inside this one - its own ALL / ANY: that is a pair of brackets.">
              <Button size="small" icon={<PlusOutlined />} onClick={() => items((list) => [...list, { group: { op: group.op === 'and' ? 'or' : 'and', not: false, items: [{ line: freshLine(nextId(tree)) }] } }])}>Group ( )</Button>
            </Tooltip>
          )}
          {onRemove && <Button size="small" type="text" icon={<CloseOutlined />} onClick={onRemove} aria-label="Remove this group" title="Remove this group (and what is in it)" />}
        </Space>
      </div>
      {group.items.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>Empty - add a condition or a group (an empty group is left out).</Text>}
      {group.items.map((it, k) => (
        <Fragment key={k}>
          {k > 0 && <Connector op={group.op} tree={tree} path={path} k={k} onConnector={onConnector} touch={touch} />}
          {it.line
            ? <ConditionRow
                line={it.line} no={numbers.get([...path, k].join('.'))}
                onChange={(line) => items((list) => list.map((x, j) => (j === k ? { line } : x)))}
                onRemove={() => items((list) => list.filter((_, j) => j !== k))}
              />
            : <RuleGroup
                group={it.group} path={[...path, k]} tree={tree} numbers={numbers} onEdit={onEdit} onConnector={onConnector} touch={touch}
                onRemove={() => items((list) => list.filter((_, j) => j !== k))}
              />}
        </Fragment>
      ))}
    </div>
  )
}

const pad = (v) => String(v).padStart(2, '0')
const clock = (ms) => { const m = istMinute(ms); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }
const rupees = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}` : '—')
const num = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
const pnlColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)

// The days prepared, for the tab's life (a past day never changes; a failed load is not kept - it is asked again next run).
const PREPARED = new Map()
const PREPARED_MAX = 150
function remember(key, day) {
  PREPARED.set(key, day)
  while (PREPARED.size > PREPARED_MAX) PREPARED.delete(PREPARED.keys().next().value)
}

async function loadDay(underlying, date, signal) {
  const key = `${underlying}|${date}`
  if (PREPARED.has(key)) return { day: PREPARED.get(key), cached: true }
  const day = await loadBacktestDay(underlying, date, { signal, timeoutMs: LOAD_TIMEOUT_MS })
  // A day whose own data cannot be read is kept as such; one that failed on the way is asked again next run.
  if (day.ok || day.final) remember(key, day.ok ? day : { ok: false, date, reason: day.reason })
  return { day }
}

// The running net of the rule, its mirror and both at the end of each day.
function EquityChart({ lines, height = 280 }) {
  const ref = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(new Map())
  useEffect(() => {
    if (!ref.current) return undefined
    const chart = createZoomableChart(ref.current, {
      width: ref.current.clientWidth, height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR }, timeScale: { borderColor: BORDER_COLOR },
      handleScroll: { vertTouchDrag: false },
    })
    chartRef.current = chart
    const series = seriesRef.current
    const resize = new ResizeObserver(() => { if (ref.current) chart.applyOptions({ width: ref.current.clientWidth }) })
    resize.observe(ref.current)
    return () => { resize.disconnect(); chart.remove(); chartRef.current = null; series.clear() }
  }, [height])
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const s of seriesRef.current.values()) chart.removeSeries(s)
    seriesRef.current.clear()
    for (const line of lines) {
      const s = chart.addSeries(LineSeries, { color: line.color, lineWidth: line.id === 'all' ? 3 : 2, title: line.name, priceLineVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } })
      s.setData(line.points)
      seriesRef.current.set(line.id, s)
    }
    chart.timeScale().fitContent()
  }, [lines])
  return <div ref={ref} style={{ width: '100%', height }} />
}

// The DAYS to run (`backtestDates.js`): on a wide screen the range picker - two months side by side, with the quick ranges;
// on a phone, where two months do not fit (the older one ran off the left edge with its ◀ / « - the dates showing there
// were that month's, and earlier years could not be reached), a From and a To picker of one month each and the quick
// ranges in a dropdown. Every picker takes a date TYPED in any of DATE_INPUT_FORMATS (2025-01-06, 06/01/2025, 6-1-2025…);
// « / » and the year in its header go back years.
function DaysPicker({ range, setRange, disabled }) {
  const narrow = useMediaQuery('(max-width: 768px)')
  const today = dayjs().format('YYYY-MM-DD')
  const presets = useMemo(() => rangePresets(today), [today])
  const at = (k) => (range?.[k] && dayjs(range[k]).isValid() ? dayjs(range[k]) : null)
  const common = {
    size: 'small', allowClear: false, disabled, format: DATE_INPUT_FORMATS, className: 'oa-date-input', showNow: false,
    disabledDate: (d) => !isPastDay(d, today),
  }
  if (!narrow) {
    return (
      <DatePicker.RangePicker
        {...common} value={[at(0), at(1)]} aria-label="Days to run"
        presets={presets.map((p) => ({ label: p.label, value: [dayjs(p.from), dayjs(p.to)] }))}
        onChange={(v) => v?.[0] && v?.[1] && setRange([v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')])}
      />
    )
  }
  const pick = (side) => (d) => d && setRange(withRangeEnd(range, side, d.format('YYYY-MM-DD')))
  return (
    <Space wrap size={[8, 8]} align="center">
      <Space size={4} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>From</Text>
        <DatePicker {...common} value={at(0)} onChange={pick('from')} aria-label="From date" style={{ width: 132 }} />
      </Space>
      <Space size={4} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>To</Text>
        <DatePicker {...common} value={at(1)} onChange={pick('to')} aria-label="To date" style={{ width: 132 }} />
      </Space>
      <Select
        size="small" value={null} placeholder="Quick range" disabled={disabled} aria-label="Quick range" style={{ width: 150 }}
        options={presets.map((p) => ({ value: p.key, label: p.label }))}
        onChange={(key) => { const p = presets.find((x) => x.key === key); if (p) setRange([p.from, p.to]) }}
      />
    </Space>
  )
}

export default function SignalBacktestPage() {
  const [underlying, setUnderlying] = usePersistedState(STORE.underlying, 'NIFTY')
  const [range, setRange] = usePersistedState(STORE.range, [dayjs().subtract(14, 'day').format('YYYY-MM-DD'), dayjs().subtract(1, 'day').format('YYYY-MM-DD')])
  const [moneyness, setMoneyness] = usePersistedState(STORE.moneyness, BACKTEST_DEFAULTS.moneyness)
  const [slPct, setSlPct] = usePersistedState(STORE.slPct, BACKTEST_DEFAULTS.slPct)
  const [targetPct, setTargetPct] = usePersistedState(STORE.targetPct, BACKTEST_DEFAULTS.targetPct)
  const [storedUnit, setLevelUnit] = usePersistedState(STORE.levelUnit, BACKTEST_DEFAULTS.levelUnit)
  const levelUnit = LEVEL_UNITS.includes(storedUnit) ? storedUnit : BACKTEST_DEFAULTS.levelUnit
  const [trailGap, setTrailGap] = usePersistedState(STORE.trailGap, BACKTEST_DEFAULTS.trailGap)
  const [trailStart, setTrailStart] = usePersistedState(STORE.trailStart, BACKTEST_DEFAULTS.trailStart)
  const unitText = levelUnit === 'pts' ? ' pts' : '%'
  const unitMax = levelUnit === 'pts' ? 5000 : 1000
  const [timeStopMin, setTimeStopMin] = usePersistedState(STORE.timeStopMin, BACKTEST_DEFAULTS.timeStopMin)
  const [maxTradesPerDay, setMaxTradesPerDay] = usePersistedState(STORE.maxTradesPerDay, BACKTEST_DEFAULTS.maxTradesPerDay)
  const [cooldownMin, setCooldownMin] = usePersistedState(STORE.cooldownMin, BACKTEST_DEFAULTS.cooldownMin)
  // The day's limits in rupees (0 = off): the day stops at its max loss / max profit.
  const [maxDayLoss, setMaxDayLoss] = usePersistedState(STORE.maxDayLoss, BACKTEST_DEFAULTS.maxDayLoss)
  const [maxDayProfit, setMaxDayProfit] = usePersistedState(STORE.maxDayProfit, BACKTEST_DEFAULTS.maxDayProfit)
  const [lots, setLots] = usePersistedState(STORE.lots, BACKTEST_DEFAULTS.lots)
  const [charges, setCharges] = usePersistedState(STORE.charges, BACKTEST_DEFAULTS.charges)
  // The charges taken off the P&L: STT on the sell side, brokerage on each order, anything else a trade.
  const [sttPct, setSttPct] = usePersistedState(STORE.sttPct, BACKTEST_DEFAULTS.sttPct)
  const [brokeragePerOrder, setBrokeragePerOrder] = usePersistedState(STORE.brokeragePerOrder, BACKTEST_DEFAULTS.brokeragePerOrder)
  const [otherPerTrade, setOtherPerTrade] = usePersistedState(STORE.otherPerTrade, BACKTEST_DEFAULTS.otherPerTrade)
  const [storedTimeframe, setTimeframe] = usePersistedState(STORE.timeframe, BACKTEST_DEFAULTS.timeframe)
  const timeframe = TIMEFRAMES.includes(storedTimeframe) ? storedTimeframe : BACKTEST_DEFAULTS.timeframe
  // On the options' expiry day: as the rule, or always buy / always sell (overriding the rule's buy / sell there).
  const [storedExpiryDay, setExpiryDay] = usePersistedState(STORE.expiryDay, BACKTEST_DEFAULTS.expiryDay)
  const expiryDay = EXPIRY_DAY_CHOICES.some((c) => c.value === storedExpiryDay) ? storedExpiryDay : BACKTEST_DEFAULTS.expiryDay
  const [storedRule, setStoredRule] = usePersistedState(STORE.rule, BACKTEST_DEFAULTS.rule)
  // The strategy's NAME (asked for - "add strategy name ... to runs"): a template's or a saved strategy's when one is
  // loaded, or typed - carried by the run's settings into its report heading, a background run's name and the list.
  const [strategyNameText, setStrategyName] = usePersistedState(STORE.strategyName, '')
  // Always through its tree: a rule saved before the builder (lines + typed logic) opens as groups, numbered as shown.
  const rule = useMemo(() => {
    const saved = normalizeRule(storedRule)
    return normalizeRule({ tree: saved.tree, action: saved.action, mirror: saved.mirror })
  }, [storedRule])
  // The rule is kept as its tree (the builder's); the lines and the logic the engine reads come from it (normalizeRule).
  const setRule = (change) => setStoredRule({ tree: rule.tree, action: rule.action, mirror: rule.mirror, ...change })
  const editTree = (path, fn) => setRule({ tree: editGroup(rule.tree, path, fn) })
  // One AND / OR between two items switched - only that one (the brackets follow).
  const setConnector = (path, k, op) => setRule({ tree: setConnectorAt(rule.tree, path, k, op) })
  const touch = useMediaQuery('(hover: none), (max-width: 768px)')
  const numbers = useMemo(() => lineNumbers(rule.tree), [rule.tree])
  const hasLines = rule.lines.length > 0
  const mirrorSame = hasLines && mirrorIsSame(rule.lines)
  const mirrorOn = rule.mirror && !mirrorSame
  const index = UNDERLYINGS.includes(underlying) ? underlying : 'NIFTY'
  const lotSize = PAPER_TRADE_LOT_SIZE[index] ?? 1

  // The run: the days asked for, each loaded and prepared in turn.
  const [run, setRun] = useState({ status: 'idle', underlying: null, dates: [], done: 0, current: null, results: [] })
  const abortRef = useRef(null)
  // A background run opened on the page (its report shown instead of the page's run) and the trades table's filter.
  const [viewing, setViewing] = useState(null)
  const [tradeFilter, setTradeFilter] = useState('all')
  const dates = useMemo(() => backtestDays(range?.[0], range?.[1], dayjs().format('YYYY-MM-DD')), [range])
  // The same range in the background: up to MAX_BACKGROUND_DAYS (only each day's outcome is kept there).
  const backgroundDays = useMemo(() => backtestDays(range?.[0], range?.[1], dayjs().format('YYYY-MM-DD'), MAX_BACKGROUND_DAYS).length, [range])
  // Every weekday of the range - an earlier year picked can make it longer than either run takes (each the LATEST days).
  const rangeDays = useMemo(() => backtestDays(range?.[0], range?.[1], dayjs().format('YYYY-MM-DD'), Infinity).length, [range])
  const start = async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const u = index
    const list = dates
    setViewing(null)
    setRun({ status: 'running', underlying: u, dates: list, done: 0, current: list[0] ?? null, results: [] })
    const results = []
    for (let k = 0; k < list.length; k++) {
      setRun((r) => ({ ...r, current: list[k], done: k }))
      try {
        const { day, cached } = await loadDay(u, list[k], controller.signal)
        results.push({ date: list[k], day, cached: Boolean(cached) })
      } catch {
        setRun((r) => ({ ...r, status: 'stopped', current: null, results: [...results] }))
        return
      }
      setRun((r) => ({ ...r, results: [...results] }))
    }
    setRun((r) => ({ ...r, status: 'done', done: list.length, current: null, results: [...results] }))
  }
  const stop = () => abortRef.current?.abort()
  useEffect(() => () => abortRef.current?.abort(), [])

  // The settings as set - held to their ranges exactly as a background run holds them (cleanBacktestSettings).
  const pageSettings = useMemo(() => cleanBacktestSettings({
    underlying: index, from: range?.[0], to: range?.[1], rule: { tree: rule.tree, action: rule.action, mirror: rule.mirror },
    moneyness, slPct, targetPct, levelUnit, trailGap, trailStart, timeStopMin, maxTradesPerDay, cooldownMin, maxDayLoss, maxDayProfit, lots, charges, sttPct, brokeragePerOrder, otherPerTrade,
    timeframe, expiryDay, strategyName: strategyNameText,
  }), [index, range, rule, moneyness, slPct, targetPct, levelUnit, trailGap, trailStart, timeStopMin, maxTradesPerDay, cooldownMin, maxDayLoss, maxDayProfit, lots, charges, sttPct, brokeragePerOrder,
    otherPerTrade, timeframe, expiryDay, strategyNameText])
  // The report - worked out again, in an instant, whenever a setting or the rule changes: each day's outcome, put together.
  const runSettings = useMemo(() => ({ ...pageSettings, underlying: run.underlying ?? index }), [pageSettings, run.underlying, index])
  const engine = useMemo(() => engineSettings(runSettings), [runSettings])
  const outcomes = useMemo(() => run.results.map((r) => dayOutcome(r.date, r.day, engine)), [run.results, engine])
  const localReport = useMemo(() => backtestReport(outcomes, engine), [outcomes, engine])

  // The background runs (the server's queue) and the one opened here, if any - its report is shown instead of the page's.
  const { jobs, refresh: refreshJobs } = useBackgroundRuns()
  const [bgTelegram, setBgTelegram] = usePersistedState(STORE.bgTelegram, true)
  const [bgOpen, setBgOpen] = useState(false)
  const openRun = async (job) => {
    try {
      const result = await runResult(job.id)
      setViewing({ job, result })
      setTradeFilter('all')
    } catch (err) {
      message.error(`The report could not be opened: ${err.message}`)
    }
  }
  // A background run's or a saved strategy's settings put on the page - with its strategy's name (a saved strategy's own).
  const applyRunSettings = (job, name = cleanBacktestSettings(job.settings).strategyName) => {
    const s = cleanBacktestSettings(job.settings)
    setStrategyName(name ?? '')
    setUnderlying(s.underlying)
    if (s.from && s.to) setRange([s.from, s.to])
    setStoredRule(s.rule)
    setMoneyness(s.moneyness); setSlPct(s.slPct); setTargetPct(s.targetPct); setLevelUnit(s.levelUnit); setTrailGap(s.trailGap); setTrailStart(s.trailStart)
    setTimeStopMin(s.timeStopMin); setMaxTradesPerDay(s.maxTradesPerDay); setCooldownMin(s.cooldownMin); setLots(s.lots); setCharges(s.charges); setTimeframe(s.timeframe)
    setMaxDayLoss(s.maxDayLoss); setMaxDayProfit(s.maxDayProfit)
    setSttPct(s.sttPct); setBrokeragePerOrder(s.brokeragePerOrder); setOtherPerTrade(s.otherPerTrade)
    setExpiryDay(s.expiryDay)
    message.success(`"${job.name}" - its index, days, rule and settings are on the page.`)
  }
  // The saved strategies (the server's CSV) and their daily live scan.
  const saved = useSavedStrategies()
  const [saveOpen, setSaveOpen] = useState(false)

  // The 20 TEMPLATES (signalTemplates.js): one loaded puts its rule and its own levels on the page (Undo puts back what was
  // there); "Compare all 20" runs every one over the days this page has loaded and ranks them - each through the same engine.
  const [undoTemplate, setUndoTemplate] = useState(null)
  const applyTemplate = (id, quiet = false) => {
    const tpl = templateById(id)
    if (!tpl) return
    setUndoTemplate({ name: tpl.name, rule: storedRule, strategyName: strategyNameText, levels: { timeframe, slPct, targetPct, levelUnit, trailGap, trailStart, timeStopMin } })
    const s = withTemplate(pageSettings, tpl)
    setStoredRule(s.rule)
    setStrategyName(tpl.name)
    setTimeframe(s.timeframe); setSlPct(s.slPct); setTargetPct(s.targetPct); setLevelUnit(s.levelUnit)
    setTrailGap(s.trailGap); setTrailStart(s.trailStart); setTimeStopMin(s.timeStopMin)
    if (!quiet) message.success(`"${tpl.name}" is on the page - its rule, timeframe and levels. Change anything, then Run.`)
  }
  const undoTemplateLoad = () => {
    if (!undoTemplate) return
    const { rule: before, levels, strategyName: nameBefore } = undoTemplate
    setStoredRule(before)
    setStrategyName(nameBefore ?? '')
    setTimeframe(levels.timeframe); setSlPct(levels.slPct); setTargetPct(levels.targetPct); setLevelUnit(levels.levelUnit)
    setTrailGap(levels.trailGap); setTrailStart(levels.trailStart); setTimeStopMin(levels.timeStopMin)
    setUndoTemplate(null)
  }
  const phone = useMediaQuery('(max-width: 640px)')
  const [compare, setCompare] = useState({ status: 'idle', rows: [], done: 0, total: 0, days: 0 })
  const compareToken = useRef(0)
  const loadedDays = run.results.filter((r) => r.day?.ok)
  const compareAll = async () => {
    const results = loadedDays
    if (!results.length) return
    const token = ++compareToken.current
    const settings = runSettings
    setCompare({ status: 'running', rows: [], done: 0, total: RULE_TEMPLATES.length, days: results.length, underlying: settings.underlying })
    const rows = []
    for (const t of RULE_TEMPLATES) {
      // One template at a time, the page drawn between them.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (compareToken.current !== token) return
      rows.push(templateRow(results, settings, t))
      setCompare((c) => ({ ...c, done: rows.length }))
    }
    rows.sort((a, b) => b.net - a.net || b.trades - a.trades)
    setCompare((c) => ({ ...c, status: 'done', rows }))
  }
  const closeCompare = () => { compareToken.current++; setCompare({ status: 'idle', rows: [], done: 0, total: 0, days: 0 }) }
  // What the report cards show: the opened background run, else this page's run.
  const shown = useMemo(() => {
    if (viewing) {
      const s = cleanBacktestSettings(viewing.result.settings)
      return { report: viewing.result.report, settings: s, dates: viewing.result.dates ?? [], job: viewing.job }
    }
    return run.results.length ? { report: localReport, settings: runSettings, dates: run.dates, job: null } : null
  }, [viewing, run.results.length, run.dates, localReport, runSettings])
  const report = shown?.report
  // The day chart: the day picked (a click on a day / trade row picks it too) - the page's own days are already loaded, a
  // background run's day is loaded when it is picked.
  const [chartDate, setChartDate] = useState(null)
  const [chartOpen, setChartOpen] = usePersistedState(STORE.chartOpen, true)
  const chartRef = useRef(null)
  const ownDays = useMemo(() => new Map(run.results.filter((r) => r.day?.ok).map((r) => [r.date, r.day])), [run.results])
  const dayOf = useMemo(() => (viewing ? () => null : (date) => ownDays.get(date) ?? null), [viewing, ownDays])
  const showOnChart = (date) => {
    setChartDate(date)
    setChartOpen(true)
    chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const chartLines = useMemo(() => (report?.lines ?? []).map((l) => ({ ...l, color: SIDE[l.id]?.color ?? '#e6e6e6' })), [report])

  const shownTrades = useMemo(() => {
    const all = report?.trades ?? []
    return tradeFilter === 'all' ? all : all.filter((t) => t.strategy === tradeFilter)
  }, [report, tradeFilter])
  const downloadCsv = () => {
    const blob = new Blob([tradesCsv(report.trades)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `signal-backtest-${shown.settings.underlying}-${shown.dates[0] ?? ''}-${shown.dates.at(-1) ?? ''}-${shown.settings.rule.action}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const running = run.status === 'running'
  const failed = report?.failed ?? []
  // Days run without the previous day's volume profile, when the rule reads it.
  const noPrev = report?.noPrev ?? []
  // Days run without the previous session's high / low / close (its volume profile's own bars), when the rule reads the pivots.
  const noPivots = report?.noPivots ?? []
  const sides = report?.sides ?? ['rule']
  const sideTag = (id) => <Space size={6}><span style={{ width: 10, height: 10, borderRadius: 2, background: SIDE[id].color, display: 'inline-block' }} />{SIDE[id].name}</Space>
  const summaryColumns = [
    { title: '', dataIndex: 'name', key: 'name', fixed: 'left', width: 100, render: (v, r) => (r.id === 'all' ? <Text strong>{v}</Text> : <Tooltip title={r.what}>{sideTag(r.id)}</Tooltip>) },
    { title: 'Signals', dataIndex: 'signals', key: 'signals', width: 70, align: 'right' },
    { title: 'Trades', dataIndex: 'trades', key: 'trades', width: 70, align: 'right' },
    { title: 'Win %', dataIndex: 'winRate', key: 'winRate', width: 70, align: 'right', render: (v) => num(v, 0) },
    { title: 'Net P&L', dataIndex: 'net', key: 'net', width: 100, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> },
    { title: 'Points', dataIndex: 'points', key: 'points', width: 80, align: 'right', render: (v) => num(v) },
    { title: 'Avg win', dataIndex: 'avgWin', key: 'avgWin', width: 90, align: 'right', render: (v) => rupees(v) },
    { title: 'Avg loss', dataIndex: 'avgLoss', key: 'avgLoss', width: 90, align: 'right', render: (v) => rupees(v) },
    { title: 'Profit factor', dataIndex: 'profitFactor', key: 'pf', width: 90, align: 'right', render: (v) => (v === Infinity ? '∞' : num(v, 2)) },
    { title: 'Max drawdown', dataIndex: 'maxDrawdown', key: 'dd', width: 100, align: 'right', render: (v) => rupees(-v) },
    { title: 'Per trade', dataIndex: 'expectancy', key: 'exp', width: 90, align: 'right', render: (v) => <span style={{ color: pnlColor(v) }}>{rupees(v)}</span> },
    { title: 'Green days', key: 'days', width: 90, align: 'right', render: (_, r) => (r.days ? `${r.winningDays} / ${r.days}` : '—') },
    { title: 'Avg hold', dataIndex: 'avgHoldMin', key: 'hold', width: 80, align: 'right', render: (v) => (Number.isFinite(v) ? `${Math.round(v)} min` : '—') },
    { title: 'Charges', dataIndex: 'charges', key: 'charges', width: 90, align: 'right', render: (v) => rupees(v) },
  ]
  const dayColumns = [
    {
      title: 'Day', dataIndex: 'date', key: 'date', fixed: 'left', width: 150, render: (v, r) => (
        <Space size={4} wrap>
          {dayjs(v).format('ddd D MMM')}
          {r.expiry && <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4 }}>expiry</Tag>}
          {r.limit && <Tag color={r.limit === 'loss' ? 'red' : 'green'} style={{ margin: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4 }}>max {r.limit}</Tag>}
        </Space>
      ),
    },
    { title: 'Trades', dataIndex: 'trades', key: 'trades', width: 70, align: 'right', render: (v, r) => (r.ok ? v : <Tooltip title={r.reason}><Tag style={{ margin: 0 }}>no data</Tag></Tooltip>) },
    { title: 'Net', dataIndex: 'net', key: 'net', width: 100, align: 'right', render: (v, r) => (r.ok ? <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> : '') },
    ...(sides.length > 1 ? sides.map((id) => ({
      title: SIDE[id].name, dataIndex: id, key: id, width: 100, align: 'right', render: (v, r) => (r.ok && v ? <span style={{ color: pnlColor(v) }}>{rupees(v)}</span> : ''),
    })) : []),
  ]
  const tradeColumns = [
    { title: 'Day', dataIndex: 'date', key: 'date', width: 100, render: (v) => dayjs(v).format('D MMM') },
    ...(sides.length > 1 ? [{ title: 'From', dataIndex: 'strategy', key: 'strategy', width: 90, render: (v) => sideTag(v) }] : []),
    { title: 'Signal', dataIndex: 'dir', key: 'dir', width: 80, render: (v) => <Tag color={v > 0 ? 'green' : 'red'} style={{ margin: 0 }}>{v > 0 ? 'bullish' : 'bearish'}</Tag> },
    {
      title: 'Trade', key: 'trade', width: 150, render: (_, t) => (
        <Space size={4}>
          <Text>{t.action} {t.strike} {t.side}</Text>
          {t.overridden && <Tooltip title="Expiry day: the Expiry day setting overrode the rule's buy / sell (the signal's direction kept)."><Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4 }}>expiry</Tag></Tooltip>}
        </Space>
      ),
    },
    { title: 'Entry', key: 'entry', width: 110, render: (_, t) => `${clock(t.entryTime)} · ${num(t.entry, 2)}` },
    { title: 'Exit', key: 'exit', width: 110, render: (_, t) => `${clock(t.exitTime)} · ${num(t.exit, 2)}` },
    { title: 'Why out', dataIndex: 'exitReason', key: 'reason', width: 150 },
    { title: 'Points', dataIndex: 'points', key: 'points', width: 80, align: 'right', render: (v) => <span style={{ color: pnlColor(v) }}>{num(v, 2)}</span> },
    { title: 'Gross', dataIndex: 'gross', key: 'gross', width: 90, align: 'right', render: (v) => <span style={{ color: pnlColor(v) }}>{rupees(v)}</span> },
    { title: 'Charges', dataIndex: 'charges', key: 'charges', width: 80, align: 'right', render: (v) => rupees(v) },
    { title: 'Net', dataIndex: 'net', key: 'net', width: 90, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> },
    { title: 'At the signal', dataIndex: 'why', key: 'why', width: 360, ellipsis: { showTitle: false }, render: (v) => <Tooltip title={v}><span>{v}</span></Tooltip> },
  ]
  // The days the report covers, not the range picker's - that can have moved on since the run.
  const head = shown ? reportHead({ ...shown.settings, from: report.dayRows[0]?.date, to: report.dayRows.at(-1)?.date }, report.okDays) : ''

  return (
    <div style={{ padding: '16px 16px 32px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Signal backtest - your rule over past days">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap size={[12, 8]} align="center">
              <Segmented size="small" value={index} options={UNDERLYINGS} onChange={setUnderlying} disabled={running} />
              <DaysPicker range={range} setRange={setRange} disabled={running} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {rangeDays > MAX_BACKGROUND_DAYS
                  ? `${rangeDays} weekdays - here the latest ${MAX_BACKTEST_DAYS}; Run in background the latest ${MAX_BACKGROUND_DAYS}`
                  : backgroundDays > dates.length
                    ? `${backgroundDays} weekdays - here the latest ${MAX_BACKTEST_DAYS}; Run in background takes all ${backgroundDays} (up to ${MAX_BACKGROUND_DAYS})`
                    : `${dates.length} trading day${dates.length === 1 ? '' : 's'} (weekdays; up to ${MAX_BACKTEST_DAYS} here, ${MAX_BACKGROUND_DAYS} in the background)`}
              </Text>
              {running
                ? <Button size="small" danger icon={<StopOutlined />} onClick={stop}>Stop</Button>
                : <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={start} disabled={!dates.length}>Run backtest</Button>}
              <Tooltip title="Run it on the server instead - now, after the close or at a time. Close the browser; the report waits under Background runs.">
                <Button size="small" icon={<CloudServerOutlined />} onClick={() => setBgOpen(true)} disabled={!backgroundDays || !hasLines}>Run in background</Button>
              </Tooltip>
            </Space>

            <div className="oa-rule">
              <Space wrap size={[8, 8]} align="center" style={{ marginBottom: 10, width: '100%' }}>
                <Text strong>Templates</Text>
                <Select
                  size="small" value={null} placeholder={`Load one of ${RULE_TEMPLATES.length} strategies…`} onChange={(id) => applyTemplate(id)}
                  style={{ width: touch ? 'calc(100vw - 64px)' : 360, maxWidth: '100%' }} popupMatchSelectWidth={touch ? true : 520} showSearch optionFilterProp="label"
                  classNames={POPUP} aria-label="Load a template"
                  options={TEMPLATE_FAMILIES.map((f) => ({ label: f.name, options: RULE_TEMPLATES.filter((t) => t.family === f.id).map((t) => ({ value: t.id, label: t.name })) }))}
                  optionRender={(o) => (
                    <div style={{ whiteSpace: 'normal', padding: '2px 0' }}>
                      <div style={{ fontSize: 13 }}>{o.label}</div>
                      <div style={{ fontSize: 11, opacity: 0.65, lineHeight: 1.35 }}>{templateById(o.value)?.idea}</div>
                    </div>
                  )}
                />
                {undoTemplate && <Button size="small" onClick={undoTemplateLoad}>Undo &quot;{undoTemplate.name}&quot;</Button>}
                <Tooltip title={touch ? null : loadedDays.length ? `Run all ${RULE_TEMPLATES.length} over the ${loadedDays.length} days loaded and rank them (each with its own timeframe and levels; lots, charges and limits from the page)` : 'Run the backtest first - the templates are compared on the days it loads'}>
                  <Button size="small" icon={<TrophyOutlined />} onClick={compareAll} disabled={!loadedDays.length || compare.status === 'running' || running}>
                    Compare all {RULE_TEMPLATES.length}
                  </Button>
                </Tooltip>
              </Space>
              <Input
                size="small" value={strategyNameText} onChange={(e) => setStrategyName(e.target.value)} maxLength={80} allowClear
                addonBefore="Strategy name" placeholder="Optional - shown on its runs and reports" aria-label="Strategy name"
                style={{ width: touch ? '100%' : 460, maxWidth: '100%', marginBottom: 10 }}
              />
              <Space wrap size={[12, 8]} align="center" style={{ marginBottom: 8 }}>
                <Text strong>The rule</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>read at each completed {timeframe}m candle - pick ALL (AND), ANY (OR) or IN ORDER (THEN) for each group; a group inside a group is a pair of brackets</Text>
              </Space>
              <RuleGroup group={rule.tree} path={[]} tree={rule.tree} numbers={numbers} onEdit={editTree} onConnector={setConnector} touch={touch} />
              {hasLines && <LogicInput key={rule.logic} tree={rule.tree} logic={rule.logic} onApply={(tree) => setRule({ tree })} />}
              <Space wrap size={[8, 8]} style={{ marginTop: 8, display: 'flex' }}>
                <Button size="small" onClick={() => setRule({ tree: { op: 'and', not: false, items: [] } })} disabled={!hasLines}>Clear all</Button>
                {rule.lines.length > 1 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {touch ? 'Tap' : 'Click'} an AND / OR between two conditions to change just that one; the ALL / ANY dropdown changes every one in its box.
                  </Text>
                )}
              </Space>
              <Space wrap size={[16, 8]} align="center" style={{ marginTop: 10 }}>
                <Space size={4}>
                  <Text strong style={{ fontSize: 12 }}>Then</Text>
                  <Select size="small" value={rule.action} onChange={(v) => setRule({ action: v })} style={{ width: 100 }} options={RULE_ACTIONS.map((a) => ({ value: a.value, label: a.label }))} />
                </Space>
                <Tooltip title="Also trade the mirror: every condition the other way (above ↔ below, support ↔ resistance, rising ↔ falling; RSI's level from the other end - above 60 ↔ below 40; pivot R1 ↔ S1; GEX regime, the straddle, 'inside' and 'stable' stay as they are) - numbers, windows and the groups kept - and the opposite trade.">
                  <Space size={4}><Switch size="small" checked={rule.mirror} onChange={(v) => setRule({ mirror: v })} /><Text style={{ fontSize: 12 }}>Mirror (other side)</Text></Space>
                </Tooltip>
              </Space>
              <div style={{ marginTop: 8 }}>
                {hasLines
                  ? <Text style={{ fontSize: 12 }}><span style={{ color: SIDE.rule.color }}>■</span> {ruleText(rule.lines, rule.action, rule.logic)}</Text>
                  : <Alert type="info" showIcon message="Add a condition - with none the rule never signals." style={{ padding: '4px 10px' }} />}
                {hasLines && rule.mirror && (mirrorSame
                  ? <div><Text type="secondary" style={{ fontSize: 12 }}>No mirror: none of these conditions has a side (add one that does - e.g. VWAP, OI, a wall).</Text></div>
                  : <div><Text style={{ fontSize: 12 }}><span style={{ color: SIDE.mirror.color }}>■</span> {ruleText(mirrorLines(rule.lines), OPPOSITE_ACTION[rule.action], rule.logic)}</Text></div>)}
              </div>
            </div>

            <Space wrap size={[16, 8]} align="center">
              <Tooltip title="The candles the rule reads: a signal only at a completed candle's close (candles from 09:15; the OI totals' breaks on buckets of the same size). Longer = fewer, steadier signals. The trade is still managed on the option's 1-minute bars.">
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
                  <Segmented size="small" value={timeframe} onChange={setTimeframe} options={TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
                </Space>
              </Tooltip>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strike</Text>
                <Select size="small" value={moneyness} onChange={setMoneyness} style={{ width: 100 }} options={[{ value: 0, label: 'ATM' }, { value: 1, label: '1 ITM' }, { value: -1, label: '1 OTM' }]} />
              </Space>
              <Tooltip title="On the options' expiry day (the weekly's - BANKNIFTY's monthly): trade as the rule says, or always BUY or always SELL options - overriding the rule's Buy / Sell that day. The signal's direction is kept: a bullish signal buys the call or sells the put, a bearish one buys the put or sells the call. The SL, target and trail are the same.">
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Expiry day</Text>
                  <Select size="small" value={expiryDay} onChange={setExpiryDay} style={{ width: 120 }} options={EXPIRY_DAY_CHOICES} />
                </Space>
              </Tooltip>
              <Tooltip title="Stop-loss, target and trailing stop in % of the entry premium, or in premium points.">
                <Segmented size="small" value={levelUnit} onChange={setLevelUnit} options={[{ value: 'pct', label: '% premium' }, { value: 'pts', label: 'Points' }]} />
              </Tooltip>
              <Tooltip title="Bought: out when the premium FALLS this much below the entry. Sold: out when it RISES this much above it. 0 = no stop-loss.">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>SL</Text><InputNumber size="small" min={0} max={unitMax} value={slPct} onChange={(v) => setSlPct(v ?? 0)} addonAfter={unitText.trim()} style={{ width: 110 }} /></Space>
              </Tooltip>
              <Tooltip title="Bought: out when the premium RISES this much. Sold: out when it FALLS this much (the decay kept). 0 = no target.">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Target</Text><InputNumber size="small" min={0} max={unitMax} value={targetPct} onChange={(v) => setTargetPct(v ?? 0)} addonAfter={unitText.trim()} style={{ width: 110 }} /></Space>
              </Tooltip>
              <Tooltip title="Trailing stop: this far behind the best premium reached (a bought option's highest, a sold one's lowest), once the trade is 'after +' in profit (0 = from the entry). It moves after each completed 1-minute bar and only tightens; the tighter of it and the SL is the stop. 0 = no trailing.">
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Trail</Text>
                  <InputNumber size="small" min={0} max={unitMax} value={trailGap} onChange={(v) => setTrailGap(v ?? 0)} addonAfter={unitText.trim()} style={{ width: 110 }} />
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>after +</Text>
                  <InputNumber size="small" min={0} max={unitMax} value={trailStart} onChange={(v) => setTrailStart(v ?? 0)} addonAfter={unitText.trim()} disabled={!(trailGap > 0)} style={{ width: 110 }} />
                </Space>
              </Tooltip>
              <Tooltip title="Out at the bar's close this many minutes after the entry (0 = off). Every trade is out by 15:10 anyway.">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Time stop</Text><InputNumber size="small" min={0} max={360} value={timeStopMin} onChange={(v) => setTimeStopMin(v ?? 0)} addonAfter="min" style={{ width: 110 }} /></Space>
              </Tooltip>
              <Tooltip title="A day: at most this many trades (the rule and its mirror together), one open at a time, and this long after an exit before the next.">
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Max</Text><InputNumber size="small" min={1} max={20} value={maxTradesPerDay} onChange={(v) => setMaxTradesPerDay(v ?? BACKTEST_DEFAULTS.maxTradesPerDay)} style={{ width: 60 }} />
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>a day · cooldown</Text><InputNumber size="small" min={0} max={120} value={cooldownMin} onChange={(v) => setCooldownMin(v ?? 0)} addonAfter="min" style={{ width: 100 }} />
                </Space>
              </Tooltip>
              <Tooltip title="The DAY's limits in rupees (0 = off): once the day's P&L - the trades closed today and the one open, net of the charges - reaches the max loss (or the max profit), the open trade exits right there and no more trades are taken that day (nor one with no room left for its own charges).">
                <Space size={[8, 4]} wrap>
                  <Space size={4}>
                    <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Day max loss</Text>
                    <InputNumber size="small" min={0} max={10000000} step={500} value={maxDayLoss} onChange={(v) => setMaxDayLoss(v ?? 0)} addonBefore="₹" style={{ width: 120 }} />
                  </Space>
                  <Space size={4}>
                    <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>max profit</Text>
                    <InputNumber size="small" min={0} max={10000000} step={500} value={maxDayProfit} onChange={(v) => setMaxDayProfit(v ?? 0)} addonBefore="₹" style={{ width: 120 }} />
                  </Space>
                </Space>
              </Tooltip>
              <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Lots</Text><InputNumber size="small" min={1} max={100} value={lots} onChange={(v) => setLots(v ?? 1)} style={{ width: 60 }} /><Text type="secondary" style={{ fontSize: 12 }}>× {lotSize}</Text></Space>
              <Tooltip title="P&L net of the charges: STT on the SELL side's premium (a bought option's exit, a sold one's entry), brokerage on each order - the buy and the sell - and anything else a trade. Off = the gross P&L.">
                <Space size={4} wrap>
                  <Switch size="small" checked={charges} onChange={setCharges} /><Text style={{ fontSize: 12 }}>Charges</Text>
                  <InputNumber size="small" min={0} max={1} step={0.01} value={sttPct} onChange={(v) => setSttPct(v ?? 0)} disabled={!charges} addonBefore="STT" addonAfter="%" style={{ width: 130 }} />
                  <InputNumber size="small" min={0} max={500} value={brokeragePerOrder} onChange={(v) => setBrokeragePerOrder(v ?? 0)} disabled={!charges} addonBefore="₹" addonAfter="an order" style={{ width: 150 }} />
                  <InputNumber size="small" min={0} max={500} value={otherPerTrade} onChange={(v) => setOtherPerTrade(v ?? 0)} disabled={!charges} addonBefore="+ ₹" addonAfter="a trade" style={{ width: 150 }} />
                </Space>
              </Tooltip>
            </Space>
            {(running || run.status === 'stopped') && (
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Progress percent={run.dates.length ? Math.round((run.done / run.dates.length) * 100) : 0} size="small" status={run.status === 'stopped' ? 'exception' : 'active'} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {run.status === 'stopped' ? `Stopped after ${run.results.length} of ${run.dates.length} days.` : `Day ${run.done + 1} of ${run.dates.length}: ${run.current ? dayjs(run.current).format('ddd D MMM') : ''} - a day the server has not kept yet comes from Dhan once (up to a minute or two).`}
                </Text>
              </Space>
            )}
            <FoldText id="signalBacktest.how" label="how it works" className="oa-note">
              <Text type="secondary" style={{ fontSize: 12 }}>
                Build ONE rule with the dropdowns: each condition is what an indicator says on the OI Replay or Volume &amp; Market Profile
                page, with its number (a threshold %) and how far back it looks (crossed, turned, broke, near, a 🎯, spot&apos;s move -
                &quot;last N min&quot;; a cross / turn / break must still hold now). A group holds when ALL (AND) or ANY (OR) of what is in it
                holds - NOT turns it round - and a group inside a group is a pair of brackets: (1 AND 2) OR (3 AND (4 AND 5)) is ANY of two
                ALL groups, the second with a group inside it. IN ORDER (THEN) wants its parts one after another: each becomes true at or
                after the one before it, the first within the minutes picked, the last still holding - e.g. PE crossed above CE, THEN a
                bullish divergence, THEN the EMA crossed down and back up; a part that was already true before the window (a state
                since the morning) did not happen in it - pick its cross / turn. The rule signals at a completed candle of the Timeframe (from 09:15) where it
                holds - once, when it becomes true (it has to stop holding before it signals again). The Mirror adds the same rule the
                other way round with the opposite trade. A signal uses only what was known at its candle&apos;s close - the end of its last minute (no look-ahead),
                and the times shown are that last minute (a 5m candle from 10:30 signals at 10:34). Its trade enters at that minute&apos;s
                option close and is managed from the next minute on the option&apos;s own 1-minute bars: a bar opening through the stop fills
                at its open, the stop before the target in the same bar, a trailing stop (if set) moving after each bar behind the best
                premium and only tightening, the time stop and the 15:10 square-off at the bar&apos;s close. No
                entries before 09:30 or after 14:45. Only the strikes OI Replay loads (ATM ± 10) and the near expiry. Change the rule after a
                run and the report follows at once - nothing is loaded again. Every comparison - crossings and turns too - takes a
                &quot;by ≥ %&quot; (0 = any, the default): price against a level (VWAP, a wall, the IB, yesterday&apos;s levels) in % of that level;
                OI since open in % of CE + PE added; Total OI CE vs PE in % of the lower line; a cumulative Δ line and the net GEX - which
                have no price - in % of their own range so far (how far past 0, or past the level broken, they are now); a straddle in % of
                its VWAP or of the decay-only line. RSI and the EMAs (price vs one, or a fast / slow crossover - their periods on the
                row) are worked out on the spot candles of the Timeframe, run on from the previous session&apos;s; RSI&apos;s number is
                its level (the mirror reads it from the other end: above 60 is below 40). The pivot points (P, R1 - R3, S1 - S3) and the
                CPR are the classic floor pivots of the previous session&apos;s high, low and close (the mirror of R1 is S1). The ATM CE /
                PE premium conditions read the ATM strike&apos;s own chart - its premium against its own VWAP (from its traded volume), an
                EMA, an EMA crossover or RSI, on the Timeframe&apos;s candles from 09:15; the mirror reads the other side&apos;s (CE ↔ PE). After a run
                the spot chart shows any day with its trades tagged BUY / SELL - click a day or a trade. Run in background hands the same run to the server - now,
                after the close or at a time - so the browser can be closed; its report waits under Background runs (Open).
              </Text>
            </FoldText>
          </Space>
        </Card>

        {compare.status !== 'idle' && (
          <Card
            size="small" title={`${RULE_TEMPLATES.length} templates on the ${compare.days} day${compare.days === 1 ? '' : 's'} loaded${compare.underlying ? ` · ${compare.underlying}` : ''}`}
            extra={<Button size="small" type="text" icon={<CloseOutlined />} onClick={closeCompare} aria-label="Close the comparison" />}
          >
            {compare.status === 'running'
              ? <Progress percent={Math.round((compare.done / Math.max(1, compare.total)) * 100)} size="small" format={() => `${compare.done} / ${compare.total}`} />
              : (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {/* On a phone a block a template (a table there hid the names under its pinned column). */}
                    {phone ? compare.rows.map((r, k) => (
                      <div key={r.id} className="oa-template-row">
                        <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                          <Space direction="vertical" size={0}>
                            <Text style={{ fontSize: 13 }}>{k + 1}. {r.name}</Text>
                            <Text type="secondary" style={{ fontSize: 11 }}>{TEMPLATE_FAMILIES.find((f) => f.id === r.family)?.name} · {r.timeframe}m</Text>
                          </Space>
                          <Button size="small" onClick={() => applyTemplate(r.id)}>Load</Button>
                        </Space>
                        <Text style={{ fontSize: 12 }}>
                          <Text strong style={{ color: pnlColor(r.net), fontSize: 12 }}>{rupees(r.net)}</Text> · {r.trades} trades · {num(r.winRate, 0)}% win · PF {r.profitFactor === Infinity ? '∞' : num(r.profitFactor, 2)} · DD {rupees(-r.maxDrawdown)}
                        </Text>
                      </div>
                    )) : (
                    <Table
                      size="small" pagination={false} scroll={{ x: 1000 }} dataSource={compare.rows}
                      columns={[
                        { title: '#', key: 'rank', width: 40, render: (_, __, k) => k + 1 },
                        {
                          title: 'Template', dataIndex: 'name', key: 'name', width: 300, render: (v, r) => (
                            <Space direction="vertical" size={0}>
                              <Text style={{ fontSize: 13 }}>{v}</Text>
                              <Text type="secondary" style={{ fontSize: 11 }}>{TEMPLATE_FAMILIES.find((f) => f.id === r.family)?.name} · {r.timeframe}m</Text>
                            </Space>
                          ),
                        },
                        { title: 'Trades', dataIndex: 'trades', key: 'trades', width: 70, align: 'right' },
                        { title: 'Win %', dataIndex: 'winRate', key: 'winRate', width: 70, align: 'right', render: (v) => num(v, 0) },
                        { title: 'Net P&L', dataIndex: 'net', key: 'net', width: 100, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> },
                        { title: 'Profit factor', dataIndex: 'profitFactor', key: 'pf', width: 90, align: 'right', render: (v) => (v === Infinity ? '∞' : num(v, 2)) },
                        { title: 'Max drawdown', dataIndex: 'maxDrawdown', key: 'dd', width: 100, align: 'right', render: (v) => rupees(-v) },
                        { title: 'Per trade', dataIndex: 'expectancy', key: 'exp', width: 90, align: 'right', render: (v) => <span style={{ color: pnlColor(v) }}>{rupees(v)}</span> },
                        {
                          title: 'Rule / mirror', key: 'sides', width: 140, align: 'right', render: (_, r) => (
                            <span><span style={{ color: pnlColor(r.ruleNet) }}>{rupees(r.ruleNet)}</span>{r.mirrorNet != null && <> / <span style={{ color: pnlColor(r.mirrorNet) }}>{rupees(r.mirrorNet)}</span></>}</span>
                          ),
                        },
                        {
                          title: '', key: 'load', width: 120, fixed: 'right', render: (_, r) => (
                            <Button size="small" onClick={() => applyTemplate(r.id)}>Load &amp; edit</Button>
                          ),
                        },
                      ]}
                    />
                    )}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Each template with its own timeframe and SL / target / trail; the lots, charges, max trades, cooldown, day limits
                      and expiry-day choice are the page&apos;s. Ranked by net on these days only - a few days rank luck as much as an
                      edge: run the best over more days (or in the background) before trusting it. Load &amp; edit puts one on the page.
                    </Text>
                  </Space>
                )}
          </Card>
        )}
        {saved.loaded && (
          <SavedStrategiesCard
            strategies={saved.strategies} today={saved.today} liveScan={saved.liveScan} refresh={saved.refresh} pageSettings={pageSettings}
            onLoad={(st) => applyRunSettings(st, st.name)} onSave={() => setSaveOpen(true)}
          />
        )}
        <BackgroundRunsCard jobs={jobs} refresh={refreshJobs} viewingId={viewing?.job.id ?? null} onOpen={openRun} onUse={applyRunSettings} />

        {shown && (
          <>
            {shown.job && (
              <Alert
                type="info" showIcon
                message={`Background run "${shown.job.name}" - finished ${dayjs(shown.job.finishedUtc).format('ddd D MMM HH:mm')}`}
                description={(
                  <Space direction="vertical" size={2}>
                    <Text style={{ fontSize: 12 }}><span style={{ color: SIDE.rule.color }}>■</span> {ruleText(normalizeRule(shown.settings.rule).lines, shown.settings.rule.action, normalizeRule(shown.settings.rule).logic)}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>Its own rule and settings - changing the page&apos;s does not change it (Use settings puts them on the page).</Text>
                  </Space>
                )}
                action={(
                  <Space direction="vertical" size={4}>
                    <Button size="small" onClick={() => applyRunSettings(shown.job)}>Use settings</Button>
                    <Button size="small" onClick={() => setViewing(null)}>{run.results.length ? 'Back to this page\'s run' : 'Close'}</Button>
                  </Space>
                )}
              />
            )}
            {failed.length > 0 && (
              <Alert type="warning" showIcon message={`${failed.length} day${failed.length === 1 ? '' : 's'} not run`} description={failed.map((r) => `${dayjs(r.date).format('D MMM')}: ${r.reason}`).join(' · ')} />
            )}
            {noPrev.length > 0 && (
              <Alert
                type="info" showIcon message={`No previous day's volume profile for ${noPrev.length} day${noPrev.length === 1 ? '' : 's'} - the rule's previous-day lines never hold on ${noPrev.length === 1 ? 'it' : 'them'}`}
                description={`${noPrev.map((date) => dayjs(date).format('D MMM')).join(' · ')} (the index has volume from January 2026 on).`}
              />
            )}
            {noPivots.length > 0 && (
              <Alert
                type="info" showIcon message={`No previous session for ${noPivots.length} day${noPivots.length === 1 ? '' : 's'} - the rule's pivot / CPR lines never hold on ${noPivots.length === 1 ? 'it' : 'them'}`}
                description={`${noPivots.map((date) => dayjs(date).format('D MMM')).join(' · ')} (the previous session comes with its volume profile - the index has volume from January 2026 on).`}
              />
            )}
            <Card
              size="small" title={head}
              extra={<Text strong style={{ color: pnlColor(report.all.net) }}>{rupees(report.all.net)} · {report.all.trades} trades · {num(report.all.winRate, 0)}% win</Text>}
            >
              <Table size="small" pagination={false} scroll={{ x: 1200 }} columns={summaryColumns} dataSource={sides.length > 1 ? [report.all, ...report.rows] : report.rows} />
            </Card>
            <Card size="small" title="Running P&L, day by day">
              <EquityChart lines={chartLines} />
            </Card>
            <Card size="small" title="Day by day">
              <Table
                size="small" pagination={false} scroll={{ x: 300 + 100 * sides.length }} columns={dayColumns} dataSource={report.dayRows}
                onRow={(r) => ({ onClick: () => r.ok && showOnChart(r.date), style: r.ok ? { cursor: 'pointer' } : undefined })}
              />
            </Card>
            <BacktestDayChartCard
              report={report} settings={shown.settings} runKey={shown.job?.id ?? 'page'} dayOf={dayOf} loadDay={loadDay}
              date={chartDate} onDate={setChartDate} open={chartOpen !== false} onOpen={setChartOpen} cardRef={chartRef}
            />
            <Card
              size="small" title={`Trades (${shownTrades.length})`}
              extra={(
                <Space size={8}>
                  {sides.length > 1 && (
                    <Select size="small" value={tradeFilter} onChange={setTradeFilter} style={{ width: 120 }} options={[{ value: 'all', label: 'Both' }, { value: 'rule', label: 'Rule' }, { value: 'mirror', label: 'Mirror' }]} />
                  )}
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadCsv} disabled={!report.trades.length}>CSV</Button>
                </Space>
              )}
            >
              <Table
                size="small" rowKey={(t) => `${t.strategy}|${t.entryTime}`} scroll={{ x: 1480 }} columns={tradeColumns} dataSource={shownTrades} pagination={{ pageSize: 25, showSizeChanger: false }}
                onRow={(t) => ({ onClick: () => showOnChart(t.date), style: { cursor: 'pointer' } })}
              />
            </Card>
          </>
        )}
      </Space>
      {saveOpen && (
        <SaveStrategyModal
          settings={pageSettings} ruleSummary={ruleText(rule.lines, rule.action, rule.logic) + (mirrorOn ? ' (and its mirror)' : '')}
          onClose={() => setSaveOpen(false)} onSaved={() => { setSaveOpen(false); saved.refresh() }}
        />
      )}
      {bgOpen && (
        <RunInBackgroundModal
          settings={pageSettings} days={backgroundDays} telegram={bgTelegram} setTelegram={setBgTelegram}
          ruleSummary={ruleText(rule.lines, rule.action, rule.logic) + (mirrorOn ? ' (and its mirror)' : '') + (expiryDay !== 'rule' ? ` · on expiry day: ${expiryDay} options` : '')}
          onClose={() => setBgOpen(false)} onQueued={() => { setBgOpen(false); refreshJobs() }}
        />
      )}
    </div>
  )
}
