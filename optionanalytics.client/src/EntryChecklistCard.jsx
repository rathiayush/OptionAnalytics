import { useMemo } from 'react'
import { Col, Row, Tag, Typography } from 'antd'
import { CE_COLOR, PE_COLOR } from './shared.jsx'
import { entryChecklist, indexByStrike } from './entryChecklist.js'
import { optionFlowSeries } from './optionFlow.js'
import { gexUpTo } from './gex.js'

const { Text } = Typography

const MARK = { true: { sign: '✓', color: '#3ddc84' }, false: { sign: '✗', color: '#ff5c5c' }, null: { sign: '–', color: '#9aa4b2' } }

function SideList({ name, color, side }) {
  const n = side.checks.length
  const tagColor = side.passed >= n - 1 ? 'green' : side.passed >= Math.round((n * 4) / 7) ? 'gold' : 'default'
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Text strong style={{ color }}>{name} buy</Text>{' '}
        <Tag color={tagColor}>{side.passed}/{side.checks.length} checks</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {side.strikes.map((s) => `${s.label} ${s.strike}${s.premium != null ? ` @ ${s.premium.toFixed(1)}` : ''}`).join(' · ')}
        </Text>
      </div>
      {side.checks.map((c) => {
        const mark = MARK[String(c.pass)]
        return (
          <div key={c.key} style={{ fontSize: 12, lineHeight: 1.6 }}>
            <span style={{ color: mark.color, fontWeight: 700, display: 'inline-block', width: 16 }}>{mark.sign}</span>
            <Text style={{ fontSize: 12 }}>{c.label}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}> - {c.detail}</Text>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Which of a good option-buying entry's usual conditions hold right now (the replay clock, or live) - for a CE buy and a
 * PE buy side by side (entryChecklist.js: direction, writers, wall ahead, option flow, location, IV, time, gamma), with
 * the ATM / 1-ITM strikes and their premiums. `gexDays`: the day's GEX under both signs
 * (`{ standard, buildup }` - gexDay, worked out once on the page for this and the GEX card). Display only: it places and
 * alerts nothing.
 */
export function EntryChecklistCard({ asOfMs, spotBars, vwap, cePoints, pePoints, step, profile, dashboardFlow = null, gexDays = null }) {
  const ceIndex = useMemo(() => indexByStrike(cePoints), [cePoints])
  const peIndex = useMemo(() => indexByStrike(pePoints), [pePoints])
  // Live, the option-flow check reads the dashboard's own CDV (the same numbers the CDV / OBV card shows).
  const ownFlow = useMemo(() => (dashboardFlow ? null : optionFlowSeries(cePoints, pePoints, spotBars)), [dashboardFlow, cePoints, pePoints, spotBars])
  const flow = dashboardFlow ?? ownFlow
  // The GEX at the clock under both signs.
  const gex = useMemo(() => (asOfMs == null || !gexDays ? null : {
    standard: gexUpTo(gexDays.standard ?? [], asOfMs).at(-1) ?? null,
    buildup: gexUpTo(gexDays.buildup ?? [], asOfMs).at(-1) ?? null,
  }), [asOfMs, gexDays])
  const result = useMemo(
    () => (asOfMs == null ? null : entryChecklist({ asOfMs, spotBars, vwap, cePoints, pePoints, step, profile, flow, ceIndex, peIndex, gex })),
    [asOfMs, spotBars, vwap, cePoints, pePoints, step, profile, flow, ceIndex, peIndex, gex],
  )
  if (!result) return <Text type="secondary">Load a day to see the checklist.</Text>
  if (result.waiting) {
    return (
      <Text type="secondary">
        The market opens at 09:15 - the checklist starts with today&apos;s first minute (the index&apos;s pre-open prices and
        yesterday&apos;s VWAP are not used, and today&apos;s option OI, flow and IV start then too).
      </Text>
    )
  }
  return (
    <>
      <Row gutter={[24, 12]}>
        <Col xs={24} md={12}><SideList name="CE" color={CE_COLOR} side={result.ce} /></Col>
        <Col xs={24} md={12}><SideList name="PE" color={PE_COLOR} side={result.pe} /></Col>
      </Row>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
        A checklist, not a signal - more ticks means more of the usual conditions line up, not that the trade will work. Use a
        stop on the premium and on the index level. – means there is not enough data yet to judge.
      </Text>
    </>
  )
}
