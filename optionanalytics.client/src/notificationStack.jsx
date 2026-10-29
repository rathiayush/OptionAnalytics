import { useEffect, useState } from 'react'
import { App as AntApp, Button, ConfigProvider, notification } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import { NOTIFICATION_LISTS, NOTIFICATION_TOP_PX, PHONE_MAX_PX, notificationStackThreshold, openNotificationCount } from './notificationStackRules.js'

// The pop-up alerts - antd's static `notification`, every page's (OI Replay's S/R breaks and 🎯 signals, the scanner's,
// price / profile alerts, order errors). On a phone each one took a third of the screen and a burst of them covered it,
// each closed on its own. Now:
//   STACKED - past `notificationStackThreshold` (notificationStackRules.js: 1 on a phone, 3 wider) they fold into ONE
//     pile, the newest in front (wider, the next two peeking under it); a tap / hover on the pile spreads it out
//     (antd's own stack).
//   COMPACT on a phone - smaller padding and type, a long text cut to three lines until the pile is opened (index.css,
//     `.ant-notification`).
//   CLEAR ALL - with two or more open, one button over them closes every one (`notification.destroy()`).
// The static API reads its stack setting from an antd App around its holder only (not `notification.config`), so it is
// set through ConfigProvider's `holderRender` (`setUpNotifications`, once, in main.jsx).

export function setUpNotifications() {
  ConfigProvider.config({
    holderRender: (children) => (
      <AntApp component={false} notification={{ stack: { threshold: notificationStackThreshold(window.innerWidth) } }}>
        {children}
      </AntApp>
    ),
  })
  notification.config({ top: NOTIFICATION_TOP_PX })
  // A window turned / resized across the phone width: the holder is drawn again with the other threshold.
  let phone = window.innerWidth <= PHONE_MAX_PX
  window.addEventListener('resize', () => {
    const now = window.innerWidth <= PHONE_MAX_PX
    if (now === phone) return
    phone = now
    notification.config({})
  })
}

/** The "Clear all" button over the alerts - shown while two or more are open. Rendered once, beside the app. */
export function NotificationClearAll() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    // The alert lists are direct children of <body> (one a placement), made when the first alert opens; each is
    // watched on its own, so the rest of the page's DOM changes never count anything.
    const watched = new Map()
    const recount = () => setCount(openNotificationCount(document))
    const watchLists = () => {
      const lists = new Set(document.querySelectorAll(NOTIFICATION_LISTS))
      for (const [list, observer] of watched) if (!lists.has(list)) { observer.disconnect(); watched.delete(list) }
      for (const list of lists) {
        if (watched.has(list)) continue
        const observer = new MutationObserver(recount)
        observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
        watched.set(list, observer)
      }
      recount()
    }
    const bodyObserver = new MutationObserver(watchLists)
    bodyObserver.observe(document.body, { childList: true })
    watchLists()
    return () => {
      bodyObserver.disconnect()
      for (const observer of watched.values()) observer.disconnect()
    }
  }, [])
  if (count < 2) return null
  return (
    <div className="oa-notification-clear-all" style={{ top: NOTIFICATION_TOP_PX - 36 }}>
      <Button size="small" icon={<CloseOutlined />} onClick={() => notification.destroy()}>Clear all ({count})</Button>
    </div>
  )
}
