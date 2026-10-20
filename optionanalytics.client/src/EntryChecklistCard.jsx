import { useMemo } from 'react'
import { Col, Row, Tag, Typography } from 'antd'
import { CE_COLOR, PE_COLOR } from './shared.jsx'
import { entryChecklist, indexByStrike } from './entryChecklist.js'
import { optionFlowSeries } from './optionFlow.js'

const { Text } = Typography

const MARK = { true: { sign: '✓', color: '#3ddc84' }, false: { sign: '✗', color: '#ff5c5c' }, null: { sign: '–', color: '#9aa4b2' } }

function SideList({ name, color, side }) {
  const tagColor = side.passed >= 6 ? 'green' : side.passed >= 4 ? 'gold' : 'default'
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
 * PE buy side by side (entryChecklist.js: direction, writers, wall ahead, option flow, location, IV, time), with the
 * ATM / 1-ITM strikes and their premiums. Display only: it places and alerts nothing.
 */
export function EntryChecklistCard({ asOfMs, spotBars, vwap, cePoints, pePoints, step, profile }) {
  const ceIndex = useMemo(() => indexByStrike(cePoints), [cePoints])
  const peIndex = useMemo(() => indexByStrike(pePoints), [pePoints])
  const flow = useMemo(() => optionFlowSeries(cePoints, pePoints, spotBars), [cePoints, pePoints, spotBars])
  const result = useMemo(
    () => (asOfMs == null ? null : entryChecklist({ asOfMs, spotBars, vwap, cePoints, pePoints, step, profile, flow, ceIndex, peIndex })),
    [asOfMs, spotBars, vwap, cePoints, pePoints, step, profile, flow, ceIndex, peIndex],
  )
  if (!result) return <Text type="secondary">Load a day to see the checklist.</Text>
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
