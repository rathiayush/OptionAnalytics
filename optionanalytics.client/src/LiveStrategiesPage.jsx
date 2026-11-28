import { Card, Space, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { NavBar } from './shared.jsx'
import { SavedStrategiesCard } from './SignalStrategiesCard.jsx'
import { useSavedStrategies } from './signalStrategiesApi.js'

// The LIVE STRATEGIES page (asked for - "create a new page ... remove live strategy code from [the Signal backtest] and move it to the
// new page ... for each strategy configure lots"): the saved strategies and their daily LIVE scan - Live / Alerts / Daily report, each
// strategy's own LOTS (its paper trades and, with Live orders on, its Dhan orders - empty = as before), the admin's Live orders (Dhan)
// switch, Today / Total, History and Remove. The same server, CSV and live scan as before - only where the card is shown moved. A
// strategy is BUILT and SAVED on the Signal backtest page; "Load" opens it there.

const { Title, Text } = Typography

export default function LiveStrategiesPage() {
  const saved = useSavedStrategies()
  const navigate = useNavigate()
  return (
    <div style={{ padding: '16px 16px 32px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        {saved.loaded
          ? (
            <SavedStrategiesCard
              strategies={saved.strategies} today={saved.today} liveScan={saved.liveScan} refresh={saved.refresh}
              onLoad={(st) => navigate('/signal-backtest', { state: { loadStrategy: st } })}
            />
          )
          : <Card size="small" title="Saved strategies"><Text type="secondary" style={{ fontSize: 12 }}>Loading…</Text></Card>}
      </Space>
    </div>
  )
}
