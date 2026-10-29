// The pop-up alerts' rules (notificationStack.jsx draws them): how many stay spread out before they fold into a pile,
// the room over them for "Clear all", and how many are open.

export const PHONE_MAX_PX = 768
/** Alerts shown spread out before the rest fold into one pile: 1 on a phone (a burst covered its screen), 3 wider. */
export const notificationStackThreshold = (width) => (width > 0 && width <= PHONE_MAX_PX ? 1 : 3)
// Room over the first alert for the Clear all button.
export const NOTIFICATION_TOP_PX = 48
// The alert lists (one a placement) are direct children of <body>; a notice still on the screen - not one leaving.
export const NOTIFICATION_LISTS = 'body > .ant-notification'
export const OPEN_NOTICE = '.ant-notification-notice:not([class*="-leave"])'

/** How many alerts are open in `root` (the page's document). */
export function openNotificationCount(root) {
  let count = 0
  for (const list of root.querySelectorAll(NOTIFICATION_LISTS)) count += list.querySelectorAll(OPEN_NOTICE).length
  return count
}
