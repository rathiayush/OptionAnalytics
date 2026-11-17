// Replay sync's message BUS (asked for - "connect different devices for OI Replay ... so many components, I can see all of
// them at once - maybe through wifi and bluetooth"): a browser page cannot reach another device over Wi-Fi or Bluetooth on
// its own (Web Bluetooth talks to gadgets, not to another browser; a direct WebRTC link still needs a server to introduce
// the two), so the other devices are reached THROUGH THIS SERVER - any network, the same account signed in on each.
// The bus sends every message on this browser's BroadcastChannel (its other tabs - as before) and, with Devices on, on
// the server relay (SpotHub.ReplaySync - the account's other connections); a tab of this browser with Devices on hears a
// message both ways, so each carries an id (`mid`) and is handed on ONCE.
// Pure, apart from the BroadcastChannel / relay it is given - tests/sync-bus.test.mjs.

const DEVICE_KEY = 'optionanalytics.replaySync.deviceId'

/** A set of the last `max` ids: seen(id) - true the second time an id comes. */
export function makeDeduper(max = 500) {
  const set = new Set()
  const order = []
  return (id) => {
    if (id == null) return false
    if (set.has(id)) return true
    set.add(id)
    order.push(id)
    if (order.length > max) set.delete(order.shift())
    return false
  }
}

/** A short name for the kind of device a user agent is ("iPad", "iPhone", "Android tablet", "Mac"...). */
export function deviceKind(ua = '', { touchPoints = 0 } = {}) {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/CrOS/.test(ua)) return 'Chromebook'
  if (/Linux/.test(ua)) return 'Linux PC'
  return 'device'
}

let device = null
/** This browser: { id (kept in this browser only - LOCAL_ONLY), name }. */
export function thisDevice() {
  if (device) return device
  let id = null
  try { id = window.localStorage.getItem(DEVICE_KEY) } catch { /* private window */ }
  if (!id) {
    id = Math.random().toString(36).slice(2, 10)
    try { window.localStorage.setItem(DEVICE_KEY, id) } catch { /* only a convenience */ }
  }
  const nav = typeof navigator === 'undefined' ? {} : navigator
  device = { id, name: deviceKind(nav.userAgent ?? '', { touchPoints: nav.maxTouchPoints ?? 0 }) }
  return device
}

/**
 * A bus over `channel` (a BroadcastChannel or anything with postMessage / onmessage / close; null = none) and `relay`
 * (null, or { send(msg), subscribe(handler) -> unsubscribe }). Same shape as a BroadcastChannel: postMessage(data),
 * onmessage = ({ data }) => ..., close(). Every message posted gets `mid` (unique), `device` and `deviceName`.
 */
// `topic`: what the bus carries on the shared relay - 'sync' (the two-way replay sync; a message with none is one) or 'clock'
// (OI Replay's one-way clock for the Profiles page) - a bus hands on its own topic's only.
export function createSyncBus({ channel = null, relay = null, from = 'tab', dev = { id: 'dev', name: 'device' }, topic = 'sync' } = {}) {
  const seen = makeDeduper()
  let n = 0
  const bus = {
    onmessage: null,
    postMessage(data) {
      const msg = { ...data, mid: `${from}:${++n}`, device: dev.id, deviceName: dev.name, topic }
      seen(msg.mid)
      channel?.postMessage(msg)
      relay?.send(msg)
    },
    close() { if (channel) channel.onmessage = null; unsubscribe?.(); channel?.close?.() },
  }
  const receive = (data) => {
    if (!data || typeof data !== 'object' || (data.topic ?? 'sync') !== topic || seen(data.mid)) return
    bus.onmessage?.({ data })
  }
  if (channel) channel.onmessage = ({ data }) => receive(data)
  const unsubscribe = relay?.subscribe(receive)
  return bus
}
