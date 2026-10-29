import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { NotificationClearAll, setUpNotifications } from './notificationStack.jsx'

// The pop-up alerts: stacked, compact, one Clear all (notificationStack.jsx).
setUpNotifications()

// The last line of defense - every page already wraps its OWN charts in a per-chart error
// boundary (see e.g. OiReplayPage's ChartErrorBoundary), but nothing previously caught an error
// thrown OUTSIDE any of those (a page's own top-level hooks/useMemo, a hooks-order bug, anything
// not literally inside a chart). With no boundary anywhere above App, react-dom's own default
// behavior for an uncaught render error is to unmount the ENTIRE tree - a blank white page, with
// the actual reason visible only in devtools console, which is exactly the "clicking X crashed the
// app" reports this exists to stop. Deliberately dependency-free (no antd, inline styles only) so
// it still renders even if whatever crashed was ConfigProvider/theming-related itself.
class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Uncaught render error - the app would otherwise have gone blank with no trace:', error, info)
  }

  render() {
    if (this.state.error) {
      const err = this.state.error
      // WebKit's (Safari/mobile) Error.stack is JUST the call-frame trace - no leading "Error:
      // message" line the way V8 formats it - so showing .stack alone (this component's own first
      // cut) silently hid the one thing that actually explains a crash on that engine. message/
      // toString() is shown first and always, on every engine; the stack is still useful (it at
      // least narrows down WHERE), so it stays, just demoted to supporting detail underneath.
      const message = (err && (err.message || String(err))) || 'Unknown error (no message was thrown).'
      return (
        <div style={{ padding: 24, maxWidth: 680, margin: '48px auto', fontFamily: 'sans-serif', color: '#e6e6e6', background: '#0d0e12', minHeight: '100vh' }}>
          <h2 style={{ color: '#f0a020' }}>Something went wrong</h2>
          <p>This page hit an unexpected error and stopped, instead of silently going blank. The actual error:</p>
          <p style={{ background: '#15161c', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#ff6b6b', fontSize: 14, fontWeight: 600 }}>
            {message}
          </p>
          {err?.stack && (
            <>
              <p style={{ color: '#9a9a9a', fontSize: 12, marginBottom: 4 }}>Where (call stack):</p>
              <pre style={{ background: '#15161c', padding: 12, borderRadius: 6, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#9a9a9a', fontSize: 12 }}>
                {String(err.stack)}
              </pre>
            </>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 20px', cursor: 'pointer', background: '#1668dc', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14 }}
          >
            Reload page
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorBgContainer: '#15161c', colorBgLayout: '#0d0e12' } }}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <NotificationClearAll />
      </ConfigProvider>
    </AppErrorBoundary>
  </StrictMode>,
)
