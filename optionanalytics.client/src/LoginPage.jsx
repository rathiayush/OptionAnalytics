import { useState } from 'react'
import { Card, Form, Input, Button, Typography, Alert, Space } from 'antd'
import { LockOutlined, MailOutlined } from '@ant-design/icons'

const { Title, Text } = Typography

// The only page reachable without a session - App.jsx renders this instead of the whole app
// (Routes and all) whenever GET /api/auth/me comes back unauthenticated. onLogin is App.jsx's own
// POST /api/auth/login wrapper; this component only owns the form fields and the pending/error
// state around submitting them.
export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = () => {
    if (!email || !password || submitting) return
    setSubmitting(true)
    setError(null)
    onLogin(email, password)
      .catch((err) => setError(err.message || 'Login failed'))
      .finally(() => setSubmitting(false))
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', padding: 16 }}>
      <Card style={{ width: 360, maxWidth: '100%' }}>
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
            <Text type="secondary">Sign in to continue</Text>
          </div>

          <Form layout="vertical" onFinish={submit} disabled={submitting}>
            <Form.Item label="Email">
              <Input
                prefix={<MailOutlined />}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                autoComplete="username"
                placeholder="you@backtest.com"
              />
            </Form.Item>
            <Form.Item label="Password" style={{ marginBottom: 12 }}>
              <Input.Password
                prefix={<LockOutlined />}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Form.Item>

            {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

            <Button type="primary" htmlType="submit" block loading={submitting} disabled={!email || !password}>
              Log in
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  )
}
