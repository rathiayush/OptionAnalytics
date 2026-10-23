import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Input, Row, Segmented, Space, Statistic, Switch, Table, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { NavBar } from './shared.jsx'

const { Title, Text } = Typography

const IST_TIME = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const CATEGORY_COLOR = { Order: 'red', Data: 'blue', Quote: 'purple', NonTrading: 'default' }

// "What is this server sending to Dhan, and why is it failing?" - every Dhan REST call of the last 15 minutes (GET
// /api/system/dhan-calls, DhanRestRateLimiter's call log): per endpoint, any request asked again and again (a loop), and
// each call with its body exactly as sent, Dhan's answer and the likely cause of a failure. Admin only.
export default function DhanCallsPage() {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(true)
  const [show, setShow] = useState('Failed')
  const [search, setSearch] = useState('')

  const load = useCallback(() => {
    fetch('/api/system/dhan-calls')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 403 ? 'Admin only.' : `HTTP ${r.status}`))))
      .then((d) => { setReport(d); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    if (!auto) return undefined
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [auto, load])

  const calls = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (report?.recent ?? []).filter((c) => (show === 'All' || !c.success)
      && (!q || `${c.path} ${c.context} ${c.error ?? ''} ${c.body ?? ''}`.toLowerCase().includes(q)))
  }, [report, show, search])

  // The causes behind the failures, most frequent first - the quickest way to see what to fix.
  const causes = useMemo(() => {
    const counts = new Map()
    for (const c of report?.recent ?? []) if (!c.success) counts.set(c.diagnosis ?? c.error ?? 'unknown', (counts.get(c.diagnosis ?? c.error ?? 'unknown') ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [report])

  const columns = [
    { title: 'Time (IST)', dataIndex: 'at', width: 90, render: (t) => IST_TIME.format(new Date(t)) },
    { title: 'Kind', dataIndex: 'category', width: 100, render: (c) => <Tag color={CATEGORY_COLOR[c]}>{c}</Tag> },
    { title: 'Request', key: 'req', render: (_, c) => <span><Text code>{c.method} {c.path}</Text><br /><Text type="secondary" style={{ fontSize: 12 }}>{c.context}</Text></span> },
    {
      title: 'Answer', key: 'ans', width: 120,
      render: (_, c) => <span><Tag color={c.success ? 'green' : 'red'}>{c.success ? 'OK' : 'failed'}{c.status ? ` ${c.status}` : ''}</Tag><br /><Text type="secondary" style={{ fontSize: 12 }}>{c.durationMs} ms</Text></span>,
    },
    {
      title: 'Error / likely cause', key: 'err',
      render: (_, c) => (c.success ? null : (
        <span>
          <Text type="danger" style={{ fontSize: 12 }}>{c.error}</Text>
          {c.diagnosis && <><br /><Text strong style={{ fontSize: 12 }}>→ {c.diagnosis}</Text></>}
        </span>
      )),
    },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card
          title="Dhan calls - last 15 minutes"
          extra={(
            <Space wrap>
              <Space size={4}><Switch size="small" checked={auto} onChange={setAuto} /><Text type="secondary">every 5 s</Text></Space>
              <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => { setLoading(true); load() }}>Refresh</Button>
            </Space>
          )}
        >
          {error && <Alert type="error" showIcon message={`Could not load: ${error}`} style={{ marginBottom: 12 }} />}
          <Text type="secondary">
            Every request this server sent to Dhan&apos;s REST API (each attempt, retries included), with its body exactly as sent. A request
            asked again and again shows under Repeated - a loop. Dhan allows 5 data calls and 10 orders a second for the whole account.
          </Text>
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={12} md={6}><Statistic title="Last minute" value={report?.lastMinute ?? '-'} /></Col>
            <Col xs={12} md={6}><Statistic title="Last 15 minutes" value={report?.last15Minutes ?? '-'} /></Col>
            <Col xs={12} md={6}><Statistic title="Failed" value={report?.failed ?? '-'} valueStyle={report?.failed ? { color: '#ff4d4f' } : undefined} /></Col>
            <Col xs={12} md={6}><Statistic title="Repeated 3+ times" value={report?.repeated?.length ?? '-'} valueStyle={report?.repeated?.length ? { color: '#faad14' } : undefined} /></Col>
          </Row>
        </Card>

        {causes.length > 0 && (
          <Card size="small" title="Why calls failed">
            <Space direction="vertical" style={{ width: '100%' }}>
              {causes.map(([cause, n]) => <Text key={cause}><Tag color="red">{n}×</Tag>{cause}</Text>)}
            </Space>
          </Card>
        )}

        <Card size="small" title="By endpoint">
          <Table
            size="small" rowKey={(e) => `${e.method} ${e.path}`} pagination={false} dataSource={report?.endpoints ?? []} scroll={{ x: true }}
            columns={[
              { title: 'Kind', dataIndex: 'category', render: (c) => <Tag color={CATEGORY_COLOR[c]}>{c}</Tag> },
              { title: 'Endpoint', key: 'ep', render: (_, e) => <Text code>{e.method} {e.path}</Text> },
              { title: 'Last minute', dataIndex: 'lastMinute', align: 'right' },
              { title: '15 min', dataIndex: 'last15Minutes', align: 'right' },
              { title: 'Failed', dataIndex: 'failed', align: 'right', render: (n) => (n ? <Text type="danger">{n}</Text> : 0) },
            ]}
          />
        </Card>

        {report?.repeated?.length > 0 && (
          <Card size="small" title="Repeated - the same request 3+ times (a loop?)">
            <Table
              size="small" rowKey="context" pagination={false} dataSource={report.repeated} scroll={{ x: true }}
              columns={[
                { title: 'Request', dataIndex: 'context' },
                { title: 'Times', dataIndex: 'times', align: 'right' },
                { title: 'Failed', dataIndex: 'failed', align: 'right', render: (n) => (n ? <Text type="danger">{n}</Text> : 0) },
                { title: 'Last error', dataIndex: 'lastError', render: (e) => <Text type="danger" style={{ fontSize: 12 }}>{e}</Text> },
                { title: 'Last', dataIndex: 'lastAt', render: (t) => IST_TIME.format(new Date(t)) },
              ]}
            />
          </Card>
        )}

        <Card
          size="small" title="Calls"
          extra={(
            <Space wrap>
              <Segmented size="small" value={show} onChange={setShow} options={['Failed', 'All']} />
              <Input.Search size="small" allowClear placeholder="path, strike, error..." onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
            </Space>
          )}
        >
          <Table
            size="small" rowKey={(c, i) => `${c.at}-${i}`} dataSource={calls} columns={columns} scroll={{ x: 900 }}
            pagination={{ pageSize: 50, showSizeChanger: false }}
            expandable={{
              rowExpandable: (c) => !!c.body,
              expandedRowRender: (c) => <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>{pretty(c.body)}</pre>,
            }}
            locale={{ emptyText: show === 'Failed' ? 'No failed calls in the last 15 minutes.' : 'No calls to Dhan in the last 15 minutes.' }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>Expand a row to see the request body as sent (the account&apos;s client id masked).</Text>
        </Card>
      </Space>
    </div>
  )
}

function pretty(body) {
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}
