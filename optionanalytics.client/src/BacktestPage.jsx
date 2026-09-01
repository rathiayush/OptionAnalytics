import { useEffect, useState } from 'react'
import { Select, Space, Typography, Spin, Card, Button, Table, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, NavBar, DirectionTag, ALERT_KIND_LABEL } from './App.jsx'

const { Title, Text } = Typography

// Re-runs ConfluenceAlertService's exact leg-flip + confluence logic offline over whatever
// spot/ATM CE/PE candle history the backend currently holds in memory (see BacktestService) - lets
// you check what the live alert engine would have fired without waiting for it to happen live.
export default function BacktestPage() {
  const [underlyings, setUnderlyings] = useState([])
  const [selected, setSelected] = useState(null)
  const [signals, setSignals] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list)
        if (list.length > 0) setSelected(list[0].underlying)
      })
      .catch((err) => console.error('Failed to load underlyings:', err))
  }, [])

  const load = (underlying) => {
    if (!underlying) return
    setLoading(true)
    fetch(`/api/backtest/${underlying}`)
      .then((r) => r.json())
      .then((data) => setSignals(data ?? []))
      .catch((err) => console.error('Failed to load backtest signals:', err))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(selected) }, [selected])

  const columns = [
    {
      title: 'Time',
      dataIndex: 'timeUtc',
      key: 'timeUtc',
      width: 200,
      render: (t) => new Date(t).toLocaleString(),
    },
    {
      title: 'Signal',
      dataIndex: 'kind',
      key: 'kind',
      width: 160,
      render: (kind, row) => {
        const isConfluence = kind === 'Confluence'
        return (
          <Tag
            color={isConfluence ? (row.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR) : undefined}
            style={{ fontWeight: isConfluence ? 700 : 400 }}
          >
            {isConfluence ? 'CONFLUENCE' : (ALERT_KIND_LABEL[kind] ?? kind)}
          </Tag>
        )
      },
    },
    {
      title: 'Direction',
      dataIndex: 'direction',
      key: 'direction',
      width: 130,
      render: (direction) => <DirectionTag direction={direction} />,
    },
    {
      title: 'Summary',
      dataIndex: 'summary',
      key: 'summary',
    },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
          <Select
            value={selected}
            onChange={setSelected}
            style={{ width: 160 }}
            options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => load(selected)} loading={loading} disabled={!selected}>
            Re-run
          </Button>
        </Space>

        <Card
          size="small"
          title="Backtrack — Signal Replay"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>Replays EMA 9/21 + confluence logic over in-memory history</Text>}
        >
          <Text type="secondary">
            Every spot / ATM CE / ATM PE EMA 9/21 flip and three-way CONFLUENCE alignment that would have
            fired across {selected ?? 'the selected underlying'}'s currently-backfilled candle history
            (up to the last few trading days held in memory), computed fresh from scratch - not the live
            alert log, so it also covers bars that closed before this session's alert engine started.
          </Text>
        </Card>

        {loading && !signals ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => `${row.timeUtc}-${row.kind}`}
            dataSource={signals ?? []}
            columns={columns}
            pagination={{ pageSize: 25, showSizeChanger: false }}
            locale={{ emptyText: 'No signals - not enough closed-bar history yet, or the underlying has no backfilled candles.' }}
          />
        )}
      </Space>
    </div>
  )
}
