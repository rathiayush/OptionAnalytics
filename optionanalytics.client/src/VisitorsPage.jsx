import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Input, Row, Segmented, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { NavBar, usePersistedState } from './shared.jsx'

const { Title, Text } = Typography

// Who opens which page, when and from where - every account and visitors with no account (GET /api/system/visitors,
// admin only). The place is worked out on the server from the connection (city level); addresses are never kept.
const PERIODS = [
  { value: 1, label: 'Today' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
]
const PAGE_NAMES = {
  '/': 'Dashboard', '/backtest': 'Backtrack', '/strike-data': 'Strike Data · Live', '/rolling-strike-data': 'Strike Data · Rolling',
  '/expired-backtest': 'Expired Backtest', '/oi-replay': 'OI Replay', '/order-flow': 'Order Flow', '/live-strike-data': 'Live Strike Data',
  '/triggers': 'Triggers', '/contracts': 'Contracts', '/trade-settings': 'Trade settings', '/strategy-tuning': 'Strategy tuning',
  '/visitors': 'Visitors', '/login': 'Login screen', '/market-view': 'Market view (External)',
}
const KIND = {
  page: { label: 'Opened page', color: 'default' },
  login: { label: 'Signed in', color: 'green' },
  'login-failed': { label: 'Failed sign-in', color: 'red' },
  logout: { label: 'Signed out', color: 'blue' },
}
const ROLE_COLOR = { Admin: 'gold', User: 'blue', External: 'purple', Runner: 'cyan' }
const REFRESH_MS = 60_000
const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const fmtTime = (iso) => TIME.format(new Date(iso))
const placeOf = (e) => [e.city, e.region, e.country].filter(Boolean).join(', ') || null
const pageName = (p) => (p ? PAGE_NAMES[p] ?? p : '—')
// One person: the signed-in account (a failed sign-in counts as no account), else the browser's visitor id.
const personOf = (e) => (e.account && e.kind !== 'login-failed' ? `acct:${e.account.toLowerCase()}` : e.visitor ? `visitor:${e.visitor}` : null)

function Who({ entry }) {
  if (entry.kind === 'login-failed') {
    return <Space size={4} wrap><Text type="danger">{entry.account || '(blank)'}</Text><Text type="secondary" style={{ fontSize: 11 }}>typed - not signed in</Text></Space>
  }
  if (entry.account) return <Space size={4} wrap><Text>{entry.account}</Text>{entry.role && <Tag color={ROLE_COLOR[entry.role]} style={{ margin: 0 }}>{entry.role}</Tag>}</Space>
  return <Space size={4} wrap><Text type="secondary">No account</Text>{entry.visitor && <Tag style={{ margin: 0 }}>visitor {entry.visitor.slice(2, 8)}</Tag>}</Space>
}

export default function VisitorsPage() {
  const [days, setDays] = usePersistedState('optionanalytics.visitors.days', 1)
  const [who, setWho] = useState('all')
  const [kind, setKind] = useState('all')
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState({ key: null, error: null, report: null })
  const [nonce, setNonce] = useState(0)
  const askKey = `${days}|${nonce}`

  useEffect(() => {
    let cancelled = false
    const key = `${days}|${nonce}`
    const load = () => fetch(`/api/system/visitors?days=${days}`)
      .then(async (r) => { if (!r.ok) throw new Error(`Could not load the visitors (HTTP ${r.status}).`); return r.json() })
      .then((report) => { if (!cancelled) setLoaded({ key, error: null, report }) })
      .catch((err) => { if (!cancelled) setLoaded((prev) => ({ ...prev, key, error: err.message })) })
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [days, nonce])

  // The last answer, kept on screen while a new period loads.
  const state = { loading: loaded.key !== askKey, error: loaded.error, report: loaded.report }
  const entries = useMemo(() => loaded.report?.entries ?? [], [loaded.report])
  const accounts = useMemo(() => [...new Set(entries.filter((e) => e.account && e.kind !== 'login-failed').map((e) => e.account))].sort(), [entries])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (kind !== 'all' && e.kind !== kind) return false
      if (who === 'signed-in' && !(e.account && e.kind !== 'login-failed')) return false
      if (who === 'no-account' && e.account && e.kind !== 'login-failed') return false
      if (who.startsWith('acct:') && personOf(e) !== who) return false
      if (q && ![e.account, e.visitor, pageName(e.page), e.page, placeOf(e), e.device].some((v) => v?.toLowerCase().includes(q))) return false
      return true
    })
  }, [entries, who, kind, search])

  // One row per person: their visits, pages, last place and device.
  const people = useMemo(() => {
    const byPerson = new Map()
    for (const e of shown) {
      const key = personOf(e)
      if (!key) continue
      const p = byPerson.get(key) ?? { key, last: e, visits: 0, pages: new Set(), places: new Set() }
      if (e.kind === 'page') { p.visits++; if (e.page) p.pages.add(pageName(e.page)) }
      const place = placeOf(e)
      if (place) p.places.add(place)
      byPerson.set(key, p)
    }
    return [...byPerson.values()]
  }, [shown])

  const stats = useMemo(() => ({
    views: shown.filter((e) => e.kind === 'page').length,
    people: people.length,
    accounts: people.filter((p) => p.key.startsWith('acct:')).length,
    anonymous: people.filter((p) => p.key.startsWith('visitor:')).length,
    failed: shown.filter((e) => e.kind === 'login-failed').length,
  }), [shown, people])

  const report = state.report
  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Visitors - who opened which page, when and from where"
          extra={<Button size="small" icon={<ReloadOutlined />} loading={state.loading} onClick={() => setNonce((n) => n + 1)}>Refresh</Button>}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap size={12}>
              <Segmented value={days} onChange={setDays} options={PERIODS} aria-label="Period" />
              <Select value={who} onChange={setWho} style={{ width: 230 }} aria-label="Who"
                options={[{ value: 'all', label: 'Everyone' }, { value: 'signed-in', label: 'Signed in (any account)' }, { value: 'no-account', label: 'No account' },
                  ...accounts.map((a) => ({ value: `acct:${a.toLowerCase()}`, label: a }))]} />
              <Select value={kind} onChange={setKind} style={{ width: 170 }} aria-label="Event"
                options={[{ value: 'all', label: 'Everything' }, ...Object.entries(KIND).map(([value, k]) => ({ value, label: k.label }))]} />
              <Input.Search allowClear placeholder="Search page, place, device…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
            </Space>
            {state.error && <Alert type="warning" showIcon message={state.error} />}
            {report && !report.locationsReady && (
              <Alert type="info" showIcon message="The location database is still downloading on the server - places show as unknown until it is ready (a few minutes after a deploy)." />
            )}
            <Row gutter={[16, 16]}>
              <Col xs={12} md={4}><Statistic title="Page views" value={stats.views} /></Col>
              <Col xs={12} md={5}><Statistic title="People" value={stats.people} /></Col>
              <Col xs={12} md={5}><Statistic title="Signed-in accounts" value={stats.accounts} /></Col>
              <Col xs={12} md={5}><Statistic title="Visitors with no account" value={stats.anonymous} /></Col>
              <Col xs={12} md={5}><Statistic title="Failed sign-ins" value={stats.failed} valueStyle={stats.failed ? { color: '#ff4d4f' } : undefined} /></Col>
            </Row>
          </Space>
        </Card>

        <Card size="small" title={`People (${people.length})`}>
          <Table size="small" rowKey="key" dataSource={people} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 900 }}
            columns={[
              { title: 'Who', key: 'who', render: (_, p) => <Who entry={p.last.kind === 'login-failed' ? { ...p.last, account: null } : p.last} /> },
              { title: 'Last seen', key: 'last', width: 150, render: (_, p) => fmtTime(p.last.time) },
              { title: 'Page views', dataIndex: 'visits', width: 100, sorter: (a, b) => a.visits - b.visits },
              { title: 'Pages', key: 'pages', render: (_, p) => [...p.pages].join(', ') || '—' },
              { title: 'Where', key: 'places', render: (_, p) => [...p.places].join(' · ') || <Text type="secondary">unknown</Text> },
              { title: 'Device', key: 'device', width: 170, render: (_, p) => p.last.device || '—' },
            ]} />
        </Card>

        <Card size="small" title={`Activity (${shown.length}${entries.length >= 5000 ? ', newest 5,000' : ''})`}>
          <Table size="small" rowKey={(e, i) => `${e.time}-${i}`} dataSource={shown} loading={state.loading && !report} pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }} scroll={{ x: 900 }}
            columns={[
              { title: 'Time (IST)', key: 'time', width: 150, render: (_, e) => fmtTime(e.time) },
              { title: 'Who', key: 'who', render: (_, e) => <Who entry={e} /> },
              { title: 'What', key: 'kind', width: 130, render: (_, e) => <Tag color={KIND[e.kind]?.color}>{KIND[e.kind]?.label ?? e.kind}</Tag> },
              { title: 'Page', key: 'page', render: (_, e) => (e.kind === 'page' ? pageName(e.page) : '—') },
              { title: 'Where', key: 'place', render: (_, e) => placeOf(e) ?? <Text type="secondary">unknown</Text> },
              { title: 'Device', key: 'device', width: 170, render: (_, e) => e.device || '—' },
            ]} />
        </Card>

        <Text type="secondary" style={{ fontSize: 12 }}>
          Where = the city, region and country of the visitor&apos;s internet connection, worked out on this server (city level - sometimes the
          internet provider&apos;s city, and a VPN shows the VPN&apos;s). IP addresses are not kept. The same person on the same page within a minute
          counts once; the log keeps {report?.keepDays ?? 90} days.{' '}
          <Tooltip title="The free IP-to-city database used for the location, kept on this server and refreshed monthly.">
            <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a>
          </Tooltip>
        </Text>
      </Space>
    </div>
  )
}
