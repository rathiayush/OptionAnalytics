import { useEffect, useSyncExternalStore } from 'react'
import * as signalR from '@microsoft/signalr'
import { RECONNECT_RETRY_POLICY } from './shared.jsx'

// The server relay for replay sync across DEVICES (syncBus.js, SpotHub.JoinReplaySync / ReplaySync): ONE hub connection a
// tab, opened while a page with Devices on needs it and closed when none does. The server puts it in the ACCOUNT's group
// (from who is signed in) and hands each message to the account's other connections. Re-joined after every reconnect.
// status: 'off' | 'connecting' | 'on' | 'denied' (an account that may not sync) | 'offline' (reconnecting / failed).

let connection = null
let users = 0
let status = 'off'
const handlers = new Set()
const statusListeners = new Set()
const upListeners = new Set()

const setStatus = (s) => { status = s; for (const l of statusListeners) l(s) }

async function join() {
  try {
    const ok = await connection.invoke('JoinReplaySync')
    setStatus(ok ? 'on' : 'denied')
    if (ok) for (const l of upListeners) l()
  } catch { setStatus('offline') }
}

function open() {
  if (connection) return
  setStatus('connecting')
  const c = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
  connection = c
  c.on('replaySync', (msg) => { for (const h of handlers) h(msg) })
  c.onreconnecting(() => setStatus('offline'))
  c.onreconnected(() => join())
  c.onclose(() => { if (connection === c) setStatus('offline') })
  c.start().then(() => (connection === c ? join() : undefined)).catch(() => { if (connection === c) setStatus('offline') })
}

function close() {
  const c = connection
  connection = null
  setStatus('off')
  c?.stop().catch(() => {})
}

/** The relay for the bus: send while joined (a message missed while not - a presence, a heartbeat - is sent again soon). */
export const relay = {
  send(msg) {
    if (status !== 'on' || !connection) return
    connection.invoke('ReplaySync', msg).catch(() => {})
  },
  subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler) },
  /** Called each time the relay (re)joins - a page says hello again, so the other devices answer. */
  onUp(listener) { upListeners.add(listener); return () => upListeners.delete(listener) },
}

const subscribeStatus = (l) => { statusListeners.add(l); return () => statusListeners.delete(l) }

/** Keep the relay open while `wanted`; returns its status. */
export function useSyncRelay(wanted) {
  const s = useSyncExternalStore(subscribeStatus, () => status)
  useEffect(() => {
    if (!wanted) return undefined
    users += 1
    open()
    return () => { users -= 1; if (users === 0) close() }
  }, [wanted])
  return wanted ? s : 'off'
}
