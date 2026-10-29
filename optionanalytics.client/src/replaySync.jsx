import { useEffect, useRef, useState } from 'react'
import { Space, Switch, Tag, Tooltip, Typography } from 'antd'

// Replay sync: keeps the OI Replay and Order Flow replays in step across browser tabs/windows of this
// site (BroadcastChannel - nothing goes through the server). With Sync on, pressing Play/Pause,
// seeking, jumping or changing speed on either page does the same on the other; whichever page was
// used last leads, and while playing it sends its clock every second so the other corrects any
// drift. Turning Sync on asks the pages already synced where they are and follows them.
//
// The DAY moves too: picking a date (with Sync on), Load day or Go Live on either page sends a "day"
// message - the day itself, not the page's state, which only changes once the day has loaded - and
// the other page sets the same date and starts loading it right away (or goes live with it). A
// heartbeat never moves a page to another day, so the two cannot bounce between days.
//
// The ONE switch is global: it is stored in localStorage and followed live across tabs (the
// "storage" event), so turning it on or off on either page does it on both. A page listens while it
// is live too; one that is not replaying anything follows the other onto its day as soon as they
// connect.
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

// kind: 'oi' | 'of'. active: whether this page is replaying something it can sync right now (only
// then does it send its clock; it listens either way).
// state: { underlying, date, ms, playing, speed, live } - the page's CURRENT replay (fresh every render).
// onRemote(message): apply another page's message - type 'day' (the user picked a day there:
// { underlying, date, live } - load the same) or type 'state' with reason 'user' (they acted - follow
// exactly), 'tick' (heartbeat - correct only real drift, never change day) or 'reply' (answer to our
// joining).
// Returns { userAction, announceDay, peers, leading }: call userAction() in every handler where the
// USER moved the replay (play, seek, speed - the new state is sent once it has rendered), and
// announceDay({ underlying, date, live }) where the user picked a day or went live.
export function useReplaySync({ enabled, active, kind, state, onRemote }) {
  const channelRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const activeRef = useRef(active)
  activeRef.current = active
  const onRemoteRef = useRef(onRemote)
  onRemoteRef.current = onRemote
  const pendingRef = useRef(false)
  const leadingRef = useRef(false)
  const [leading, setLeading] = useState(false)
  const [peers, setPeers] = useState({})
  const on = enabled && typeof BroadcastChannel !== 'undefined'

  const post = (reason) => {
    const current = stateRef.current
    if (!channelRef.current || !activeRef.current || !current?.date) return
    channelRef.current.postMessage({ type: 'state', reason, from: tabId, kind, ...current })
  }

  useEffect(() => {
    if (!on) return undefined
    const channel = new BroadcastChannel(CHANNEL)
    channelRef.current = channel
    channel.onmessage = ({ data }) => {
      if (!data || data.from === tabId) return
      // A page closing (or turning Sync off) drops off the other's "synced with" tag at once.
      if (data.type === 'bye') {
        setPeers((prev) => Object.fromEntries(Object.entries(prev).filter(([from]) => from !== data.from)))
        return
      }
      setPeers((prev) => ({ ...prev, [data.from]: { kind: data.kind, date: data.date, underlying: data.underlying, live: !!data.live, seen: Date.now() } }))
      // A page joining asks where everyone is. A page with no replay of its own (e.g. a page on Live)
      // asks the joiner instead - so whichever side is replaying leads the other onto its day.
      if (data.type === 'hello') {
        if (activeRef.current && stateRef.current?.date) post('reply')
        else channel.postMessage({ type: 'need', from: tabId, kind })
        return
      }
      if (data.type === 'need') { post('reply'); return }
      // The user picked a day (or went live) there: that page leads now.
      if (data.type === 'day') {
        leadingRef.current = false
        setLeading(false)
        onRemoteRef.current?.(data)
        return
      }
      if (data.type !== 'state') return
      if (data.reason === 'user') { leadingRef.current = false; setLeading(false) }
      onRemoteRef.current?.(data)
    }
    channel.postMessage({ type: 'hello', from: tabId, kind, date: stateRef.current?.date, underlying: stateRef.current?.underlying, live: !!stateRef.current?.live })
    const heartbeat = setInterval(() => {
      if (leadingRef.current && stateRef.current?.playing) post('tick')
      setPeers((prev) => {
        const now = Date.now()
        const next = Object.fromEntries(Object.entries(prev).filter(([, p]) => now - p.seen < PEER_TIMEOUT_MS))
        return Object.keys(next).length === Object.keys(prev).length ? prev : next
      })
    }, HEARTBEAT_MS)
    // Peers keep each other listed even while paused.
    const presence = setInterval(() => channel.postMessage({ type: 'presence', from: tabId, kind, date: stateRef.current?.date, underlying: stateRef.current?.underlying, live: !!stateRef.current?.live }), PEER_TIMEOUT_MS / 2)
    const bye = () => channel.postMessage({ type: 'bye', from: tabId, kind })
    window.addEventListener('pagehide', bye)
    return () => {
      window.removeEventListener('pagehide', bye)
      bye()
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

  // The other page's "synced with" tag follows a change of day here at once, not at the next presence.
  useEffect(() => {
    channelRef.current?.postMessage({ type: 'presence', from: tabId, kind, date: state?.date, underlying: state?.underlying, live: !!state?.live })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, state?.date, state?.underlying, state?.live])

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

  // Sent at once with the day itself (the page's own state only shows it once the day has loaded).
  const announceDay = ({ underlying, date, live = false }) => {
    if (!on || !channelRef.current || !underlying || (!live && !date)) return
    leadingRef.current = !live
    setLeading(!live)
    channelRef.current.postMessage({ type: 'day', from: tabId, kind, underlying, date: live ? null : date, live })
  }

  return { userAction, announceDay, peers: Object.values(peers), leading: on && leading, on }
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
      <Tooltip title={`Play, pause, seek, speed and the day move together with the ${other} page in another tab or window: picking a date, Load day or Go Live here loads the same there. One switch for both pages.`}>
        <Space size={4}>
          <Switch size="small" checked={enabled} onChange={onChange} aria-label="Replay sync" />
          <Typography.Text style={{ fontSize: 12 }}>Sync</Typography.Text>
        </Space>
      </Tooltip>
      {enabled && mismatch && <Tag color="warning" style={{ margin: 0 }}>{mismatch}</Tag>}
      {enabled && !mismatch && (others.length
        ? <Tag color="cyan" style={{ margin: 0 }}>⇄ {others.map((p) => `${PAGE_NAMES[p.kind] ?? p.kind}${p.live ? ' live' : p.date ? ` ${p.date}` : ''}`).join(', ')}{sync.leading ? ' · leading' : ''}</Tag>
        : <Tag style={{ margin: 0 }}>Open the {other} page in another tab</Tag>)}
    </Space>
  )
}

// ---- OI Replay's clock, for a page that FOLLOWS it (one way) ----------------------------------------------
//
// The Profiles page follows OI Replay by default: whichever index and day OI Replay shows - live, or a past
// day at its replay clock - the profiles show the same. That is a different thing from the two-way Sync
// above (whose one switch is off by default and also moves the Order Flow page): OI Replay always says where
// it is on its own channel, a follower listens when it wants to, and nothing a follower does moves OI Replay.
//
// The message: { type: 'clock', underlying, date ('YYYY-MM-DD' - null while a day is loading), ms (the
// replay clock: the END of the newest minute shown - null when live), live, playing }.

const CLOCK_CHANNEL = 'optionanalytics.replayClock'
const CLOCK_HEARTBEAT_MS = 2000
const CLOCK_TIMEOUT_MS = 6000

/** OI Replay: say where its replay is - on every change and every couple of seconds (a follower that
 *  opens later hears it at once too: it asks with "hello"). */
export function useReplayClockBroadcast(state) {
  const channelRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const post = () => {
    const s = stateRef.current
    if (channelRef.current && s?.underlying) channelRef.current.postMessage({ type: 'clock', from: tabId, ...s })
  }
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined
    const channel = new BroadcastChannel(CLOCK_CHANNEL)
    channelRef.current = channel
    channel.onmessage = ({ data }) => { if (data?.type === 'hello') post() }
    const heartbeat = setInterval(post, CLOCK_HEARTBEAT_MS)
    post()
    return () => { clearInterval(heartbeat); channel.close(); channelRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    post()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.underlying, state?.date, state?.ms, state?.live, state?.playing])
}

/** A follower: while `enabled`, hands every OI Replay clock message to onClock. Returns { connected (an OI
 *  Replay tab heard from in the last few seconds), clock (its latest message) }. */
export function useFollowReplayClock(enabled, onClock) {
  const onClockRef = useRef(onClock)
  onClockRef.current = onClock
  const [clock, setClock] = useState(null)
  const [seenAt, setSeenAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') { setClock(null); return undefined }
    const channel = new BroadcastChannel(CLOCK_CHANNEL)
    channel.onmessage = ({ data }) => {
      if (data?.type !== 'clock' || !data.underlying) return
      setClock(data)
      setSeenAt(Date.now())
      onClockRef.current?.(data)
    }
    channel.postMessage({ type: 'hello', from: tabId })
    const tick = setInterval(() => setNow(Date.now()), CLOCK_HEARTBEAT_MS)
    return () => { clearInterval(tick); channel.close() }
  }, [enabled])
  return { connected: enabled && clock != null && now - seenAt < CLOCK_TIMEOUT_MS, clock }
}
