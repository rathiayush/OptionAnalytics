import { useEffect, useRef, useState } from 'react'
import * as signalR from '@microsoft/signalr'
import { RECONNECT_RETRY_POLICY, onLiveBatch, joinAllSignalRGroups, syncSignalRGroups } from './shared.jsx'

// The server's "domLive" push for one underlying's nearest futures (SignalR group "dom:{underlying}"): the WHOLE book -
// Dhan's 200 bid and 200 ask levels on NSE - with the day's traded volume at each price and the latest prints. Used by
// the DOM drawer and by the Order Flow page's Market depth card when it shows more than the live push's 50 levels.

// Its own SignalR connection, only while the drawer is open (or the Market depth card shows more than the live push's
// 50 levels - the whole book comes on this feed).
export function useDomFeed(underlying, open) {
  const [dom, setDom] = useState(null)
  const [state, setState] = useState('idle')
  const connectionRef = useRef(null)
  const groupsRef = useRef([])
  const underlyingRef = useRef(underlying)
  underlyingRef.current = underlying

  useEffect(() => {
    if (!open) return undefined
    setState('connecting')
    const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
    connectionRef.current = connection
    onLiveBatch(connection, { domLive: (payload) => { if (payload?.meta?.underlying === underlyingRef.current) setDom(payload) } })
    connection.onreconnecting(() => setState('reconnecting'))
    connection.onreconnected(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current) })
    connection.onclose(() => setState('disconnected'))
    groupsRef.current = [`dom:${underlyingRef.current}`]
    connection.start()
      .then(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current) })
      .catch((err) => { if (err?.name !== 'AbortError') setState('disconnected') })
    return () => { connectionRef.current = null; connection.stop(); setDom(null); setState('idle') }
  }, [open])

  useEffect(() => {
    if (!open) return
    const groups = [`dom:${underlying}`]
    syncSignalRGroups(connectionRef.current, groupsRef.current, groups)
    groupsRef.current = groups
    setDom(null)
  }, [underlying, open])

  return { dom, state }
}
