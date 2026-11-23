import { useEffect, useRef } from 'react'
import * as signalR from '@microsoft/signalr'
import { RECONNECT_RETRY_POLICY, joinAllSignalRGroups, onLiveBatch, syncSignalRGroups } from './shared.jsx'

/** The live feed OI Replay listens to: the "/hubs/spot" connection, group "u:{index}" while `enabled` (live), and its
 *  conflated "liveBatch" (shared.jsx onLiveBatch - the newest state only, acknowledged after paint, so the page never
 *  falls behind): "spotUpdate" (the index's forming minute - OHLC; Dhan's index ticks carry no volume) and
 *  "futuresTicks" (the near futures, with Dhan's day volume). One connection for the page's life; only the group
 *  follows the index. A reconnect joins again and says so (onReconnected - the page loads again what it missed).
 *  The Profiles page and the Spot structure page. */
export function useLiveIndexFeed(underlying, enabled, handlers, name = 'Live feed') {
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers })
  const connectionRef = useRef(null)
  const groupsRef = useRef([])
  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
    connectionRef.current = connection
    onLiveBatch(connection, {
      spotUpdate: (snapshot) => handlersRef.current.onSpot?.(snapshot),
      futuresTicks: (ticks) => handlersRef.current.onFutures?.(ticks ?? []),
    })
    connection.onreconnected(() => { joinAllSignalRGroups(connection, groupsRef.current); handlersRef.current.onReconnected?.() })
    connection.start()
      .then(() => joinAllSignalRGroups(connection, groupsRef.current))
      .catch((err) => { if (err?.name !== 'AbortError') console.error(`${name} connection failed:`, err) })
    return () => { connectionRef.current = null; connection.stop() }
  }, [name])
  useEffect(() => {
    const groups = enabled && underlying ? [`u:${underlying}`] : []
    syncSignalRGroups(connectionRef.current, groupsRef.current, groups)
    groupsRef.current = groups
  }, [underlying, enabled])
}
