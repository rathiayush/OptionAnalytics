import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTIFICATION_LISTS, OPEN_NOTICE, notificationStackThreshold, openNotificationCount } from '../src/notificationStackRules.js'

test('alerts fold into one pile from the second on a phone, from the fourth on a wider screen', () => {
  assert.equal(notificationStackThreshold(390), 1)
  assert.equal(notificationStackThreshold(768), 1)
  assert.equal(notificationStackThreshold(769), 3)
  assert.equal(notificationStackThreshold(1600), 3)
  assert.equal(notificationStackThreshold(0), 3) // no window width known: the wide setting
})

test('Clear all counts the open alerts of every list, not the ones already leaving', () => {
  const list = (open) => ({ querySelectorAll: (selector) => (selector === OPEN_NOTICE ? Array(open).fill({}) : []) })
  const root = { querySelectorAll: (selector) => (selector === NOTIFICATION_LISTS ? [list(3), list(1)] : []) }
  assert.equal(openNotificationCount(root), 4)
  assert.equal(openNotificationCount({ querySelectorAll: () => [] }), 0)
  assert.match(OPEN_NOTICE, /:not\(\[class\*="-leave"\]\)/)
})
