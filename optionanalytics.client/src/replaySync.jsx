import { useEffect, useRef, useState } from 'react'
import { Space, Switch, Tag, Tooltip, Typography } from 'antd'

// Replay sync: keeps the OI Replay and Order Flow replays in step across browser tabs/windows of this
// site (BroadcastChannel - nothing goes through the server). With Sync on, pressing Play/Pause,
// seeking, jumping or changing speed or day on either page does the same on the other; whichever
// page was used last leads, and while playing it sends its clock every second so the other corrects
// any drift. Turning Sync on asks the pages already synced where they are and follows them.
//
// The ONE switch is global: it is stored in localStorage and followed live across tabs (the
// "storage" event), so turning it on or off on either page does it on both.
//
// Both pages speak in the same terms:
//   ms      - the replay clock (epoch ms): everything that had happened by then is shown; a minute
//             bar counts once it has COMPLETED (its start + 60s <= ms).
//   speed   - market seconds per real second (60 = a minute per second).
//   date    - 'YYYY-MM-DD' (IST trading day), underlying - 'NIFTY' / 'BANKNIFTY' / 'SENSEX'.

const CHANNEL = 'optionanalytics.replaySync'
const ENABLED_KEY = 'optionanalytics.replaySync.enabled'
const HEARTBEAT_MS = 1000
const PEER_TIMEOUT_MS = 5000
// How far a follower may drift (market time) before a heartbeat snaps it back.
export const SYNC_DRIFT_MS = 120_000

const readEnabled = () => { try { return window.localStorage.getItem(ENABLED_KEY) === 'true' } catch { return false } }

export function useReplaySyncEnabled() {
  const [enabled, setEnabledState] = useState(readEnabled)
  useEffect(() => {
    const onStorage = (e) => { if (e.key === ENABLED_KEY) setEnabledState(e.newValue === 'true') }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const setEnabled = (value) => {
    try { window.localStorage.setItem(ENABLED_KEY, String(value)) } catch { /* only a convenience */ }
    setEnabledState(value)
  }
  return [enabled, setEnabled]
}

const tabId = Math.random().toString(36).slice(2)

// kind: 'oi' | 'of'. active: whether this page is replaying something it can sync right now.
// state: { underlying, date, ms, playing, speed } - the page's CURRENT replay (fresh every render).
// onRemote(message): apply another page's state; message.reason is 'user' (they acted - follow
// exactly), 'tick' (heartbeat - correct only real drift) or 'reply' (answer to our joining).
// Returns { userAction, peers, leading }: call userAction() in every handler where the USER changed
// the replay; the new state is sent once it has rendered.
export function useReplaySync({ enabled, active, kind, state, onRemote }) {
  const channelRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const onRemoteRef = useRef(onRemote)
  onRemoteRef.current = onRemote
  const pendingRef = useRef(false)
  const leadingRef = useRef(false)
  const [leading, setLeading] = useState(false)
  const [peers, setPeers] = useState({})
  const on = enabled && active && typeof BroadcastChannel !== 'undefined'

  const post = (reason) => {
    const current = stateRef.current
    if (!channelRef.current || !current?.date) return
    channelRef.current.postMessage({ type: 'state', reason, from: tabId, kind, ...current })
  }

  useEffect(() => {
    if (!on) return undefined
    const channel = new BroadcastChannel(CHANNEL)
    channelRef.current = channel
    channel.onmessage = ({ data }) => {
      if (!data || data.from === tabId) return
      setPeers((prev) => ({ ...prev, [data.from]: { kind: data.kind, date: data.date, underlying: data.underlying, seen: Date.now() } }))
      if (data.type === 'hello') { post('reply'); return }
      if (data.type !== 'state') return
      if (data.reason === 'user') { leadingRef.current = false; setLeading(false) }
      onRemoteRef.current?.(data)
    }
    channel.postMessage({ type: 'hello', from: tabId, kind, date: stateRef.current?.date, underlying: stateRef.current?.underlying })
    const heartbeat = setInterval(() => {
      if (leadingRef.current && stateRef.current?.playing) post('tick')
      setPeers((prev) => {
        const now = Date.now()
        const next = Object.fromEntries(Object.entries(prev).filter(([, p]) => now - p.seen < PEER_TIMEOUT_MS))
        return Object.keys(next).length === Object.keys(prev).length ? prev : next
      })
    }, HEARTBEAT_MS)
    // Peers keep each other listed even while paused.
    const presence = setInterval(() => channel.postMessage({ type: 'presence', from: tabId, kind, date: stateRef.current?.date, underlying: stateRef.current?.underlying }), PEER_TIMEOUT_MS / 2)
    return () => {
      clearInterval(heartbeat)
      clearInterval(presence)
      channel.close()
      channelRef.current = null
      setPeers({})
      leadingRef.current = false
      setLeading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, kind])

  // A user action's state goes out once it has rendered (so it carries the new values).
  useEffect(() => {
    if (!pendingRef.current) return
    pendingRef.current = false
    post('user')
  })

  const userAction = () => {
    if (!on) return
    pendingRef.current = true
    leadingRef.current = true
    setLeading(true)
  }

  return { userAction, peers: Object.values(peers), leading: on && leading, on }
}

// The option list for a speed select, with `value` added when it is not one of `options` (a speed
// set by the other page). toOption(value) builds that extra option.
export function withSpeedOption(options, value, toOption) {
  return value == null || options.some((o) => o.value === value) ? options : [...options, toOption(value)]
}

const PAGE_NAMES = { oi: 'OI Replay', of: 'Order Flow' }

// The global Sync switch plus who this page is synced with. `mismatch`: a short note when the other
// page is on a different day/underlying (shown instead of the peer list).
export function ReplaySyncControl({ enabled, onChange, sync, kind, mismatch = null }) {
  const others = sync.peers.filter((p) => p.kind !== kind)
  const other = kind === 'oi' ? 'Order Flow' : 'OI Replay'
  return (
    <Space size={6} wrap align="center">
      <Tooltip title={`Play, pause, seek, speed and day move together with the ${other} replay in another tab or window. One switch for both pages.`}>
        <Space size={4}>
          <Switch size="small" checked={enabled} onChange={onChange} aria-label="Replay sync" />
          <Typography.Text style={{ fontSize: 12 }}>Sync</Typography.Text>
        </Space>
      </Tooltip>
      {enabled && mismatch && <Tag color="warning" style={{ margin: 0 }}>{mismatch}</Tag>}
      {enabled && !mismatch && (others.length
        ? <Tag color="cyan" style={{ margin: 0 }}>⇄ {others.map((p) => `${PAGE_NAMES[p.kind] ?? p.kind}${p.date ? ` ${p.date}` : ''}`).join(', ')}{sync.leading ? ' · leading' : ''}</Tag>
        : <Tag style={{ margin: 0 }}>Open the {other} replay in another tab</Tag>)}
    </Space>
  )
}
