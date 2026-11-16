import { useLocation } from 'react-router-dom'
import { ShoppingCartOutlined } from '@ant-design/icons'
import { usePersistedState } from './shared.jsx'
import { STORED_ORDER_FAB, STORED_ORDER_FAB_ANCHOR, STORED_QUICK_FAB, STORED_QUICK_FAB_ANCHOR } from './dashboardLayout.js'
import { QUICK_VIEWS } from './quickViews.js'
import { QuickViewFab } from './QuickViewFab.jsx'
import { OrderFab } from './OrderFab.jsx'
import OiReplayPage from './OiReplayPage.jsx'
import { floatingHost, floatingModeFor, useFloatingHost } from './floatingHost.js'

// The Order button and the quick views' button on the pages that have no OI Replay data of their own (the Profiles page, the
// Order Flow page) - see floatingHost.js. Until one is tapped they are LAUNCHERS (the same buttons, the same places - the
// anchors and the "Quick button" / "Order button" ticks are OI Replay's own account preferences); the tap mounts a popup-only
// OI Replay page and, once its data is in, that page draws the real buttons (`fabsShown`) and opens what was asked for.
// OI Replay itself draws its own, so nothing here on that page.
export default function GlobalFloating() {
  const { pathname } = useLocation()
  const mode = floatingModeFor(pathname)
  const host = useFloatingHost()
  const [quickOn] = usePersistedState(STORED_QUICK_FAB, true)
  const [quickAnchor, setQuickAnchor] = usePersistedState(STORED_QUICK_FAB_ANCHOR, null)
  const [orderOn] = usePersistedState(STORED_ORDER_FAB, true)
  const [orderAnchor, setOrderAnchor] = usePersistedState(STORED_ORDER_FAB_ANCHOR, null)
  if (mode !== 'launch') return null
  return (
    <>
      {host.hostOn && <OiReplayPage popupOnly />}
      {!host.fabsShown && (
        <>
          <QuickViewFab
            views={QUICK_VIEWS} enabled={quickOn} anchor={quickAnchor} onAnchorChange={setQuickAnchor}
            onOpen={(key) => floatingHost.launch({ type: 'view', key })}
            actions={[{
              key: 'order', label: 'Order', icon: ShoppingCartOutlined, active: false,
              title: 'Punch a trade - the Paper / Live order panel', onClick: () => floatingHost.launch({ type: 'order' }),
            }]}
          />
          <OrderFab enabled={orderOn} anchor={orderAnchor} onAnchorChange={setOrderAnchor} onToggle={() => floatingHost.launch({ type: 'order' })} />
        </>
      )}
    </>
  )
}
