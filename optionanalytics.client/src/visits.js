// Reports the page this browser is on to the server's visitor log (POST /api/auth/visit - the admin Visitors page):
// every account, and visitors not signed in (the login screen). Only the page path and a random id this browser keeps
// (so one visitor's visits group together) are sent; the server works out the city from the connection and keeps no
// address.

const VISITOR_KEY = 'optionanalytics.visitorId'

function randomId() {
  try { if (globalThis.crypto?.randomUUID) return `v-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}` } catch { /* fall through */ }
  return `v-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`
}

export function visitorId() {
  try {
    let id = localStorage.getItem(VISITOR_KEY)
    if (!id || !/^[A-Za-z0-9-]{6,40}$/.test(id)) {
      id = randomId()
      localStorage.setItem(VISITOR_KEY, id)
    }
    return id
  } catch {
    return null
  }
}

/** The page a visitor sees: the login screen when not signed in, the Market view for the External account, else the
 *  route. */
export function visitPage(user, pathname) {
  if (!user) return '/login'
  if (user.role === 'External') return '/market-view'
  return pathname || '/'
}

export function reportVisit(page) {
  try {
    fetch('/api/auth/visit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ page, visitor: visitorId() }),
    }).catch(() => {})
  } catch { /* never in the way */ }
}
