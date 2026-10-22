import { useCallback, useEffect, useRef, useState } from 'react'

// OI Replay's paper positions for today, kept on the server per account and day (GET / POST /api/paper-positions -
// PaperPositionStore) so every browser shows the same positions and P&L; the page's localStorage copy is only a fallback.
// The page keeps changing its positions as before (punch, exit, SL / target hits, clear); this sends each change, and
// every POLL_MS takes what another browser changed - the page's own changes not yet answered stay on top of it. The
// server keeps a closed position as it first closed.

const POLL_MS = 3_000
// A change the server did not take (no connection, a server error) is sent again after this - not a refusal (4xx):
// the same change would only be refused again.
const RETRY_MS = 5_000
const stamp = (p) => JSON.stringify(p)

/** What turns `previous` (the server's) into `current` (the page's): `{ upsert, remove, clear }`, or null when nothing. */
export function diffPositions(previous, current) {
  const before = previous ?? []
  const now = current ?? []
  if (before.length > 0 && now.length === 0) return { upsert: [], remove: [], clear: true }
  const was = new Map(before.map((p) => [p.id, stamp(p)]))
  const ids = new Set(now.map((p) => p.id))
  const upsert = now.filter((p) => p?.id && was.get(p.id) !== stamp(p))
  const remove = before.filter((p) => !ids.has(p.id)).map((p) => p.id)
  return upsert.length || remove.length ? { upsert, remove, clear: false } : null
}

const sameList = (a, b) => a.length === b.length && a.every((p, i) => stamp(p) === stamp(b[i]))

/** `list` with `change` (as diffPositions makes it) applied: cleared, then the removed ids dropped, then each upsert
 *  replacing its position or added. */
export function applyChange(list, change) {
  if (!change) return list ?? []
  let next = change.clear ? [] : (list ?? []).filter((p) => !change.remove.includes(p.id))
  for (const p of change.upsert) {
    const i = next.findIndex((q) => q.id === p.id)
    next = i < 0 ? [...next, p] : next.map((q, k) => (k === i ? p : q))
  }
  return next
}

/** The page's positions after a server answer: the server's (`server` - with another browser's changes in it), with
 *  what the page changed since `base` (what that answer is compared with: the positions just sent, or the server's
 *  previous answer) on top - so a change made while another was on its way is never undone on screen, and never lost. */
export function rebasePositions(server, base, current) {
  return applyChange(server ?? [], diffPositions(base ?? [], current ?? []))
}

/**
 * Keeps `positions` (the page's state, set with `setPositions`) in step with the server for `dateKey` while `enabled`
 * (today, live). Returns `serverPositions(dateKey)` - the server's last known positions for that day, or null - for a
 * reload of the page to start from instead of the localStorage copy.
 *
 * One change is on its way at a time; what changes meanwhile is sent when it is answered. A change the server did not
 * take (no connection, a server error) stays to be sent - with the next change, or again after RETRY_MS.
 */
export function usePaperPositionsSync({ enabled, dateKey, positions, setPositions }) {
  // { dateKey, version, positions } as the server last answered (GET or POST); null until the first answer.
  const syncedRef = useRef(null)
  // A POST on its way (the positions it carries), else null.
  const inFlightRef = useRef(null)
  // Bumped when a server answer arrives (or a retry is due), so the send effect looks again (the refs alone would not).
  const [answers, setAnswers] = useState(0)

  const positionsRef = useRef(positions)
  useEffect(() => { positionsRef.current = positions }, [positions])
  const retryRef = useRef(null)
  useEffect(() => () => clearTimeout(retryRef.current), [])

  // A server answer becomes what the server holds; the page keeps what it changed since `base` on top of it.
  const adopt = useCallback((day, snap, base) => {
    syncedRef.current = { dateKey: day, version: snap.version, positions: snap.positions ?? [] }
    const next = rebasePositions(snap.positions, base, positionsRef.current)
    if (!sameList(next, positionsRef.current ?? [])) setPositions(next)
    setAnswers((n) => n + 1)
  }, [setPositions])

  // Take what the server holds - at once, then every POLL_MS (another browser's punch, exit or clear).
  useEffect(() => {
    if (!enabled || !dateKey) return undefined
    let cancelled = false
    const pull = async () => {
      try {
        const r = await fetch(`/api/paper-positions?date=${dateKey}`)
        if (!r.ok || cancelled) return
        const snap = await r.json()
        if (cancelled) return
        const synced = syncedRef.current?.dateKey === dateKey ? syncedRef.current : null
        if (!snap.exists) {
          // Nothing kept for today yet: the page's own positions (from before they were kept here) are sent once.
          if (!synced) { syncedRef.current = { dateKey, version: 0, positions: [] }; setAnswers((n) => n + 1) }
          return
        }
        if (synced && synced.version === snap.version) return
        // The first answer of the day is taken as it is (the server's copy over the page's older local one).
        adopt(dateKey, snap, synced ? synced.positions : positionsRef.current)
      } catch { /* the next poll tries again */ }
    }
    pull()
    const id = setInterval(pull, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled, dateKey, adopt])

  // Send the page's change (only once the server's positions are known - never an old copy over newer ones).
  useEffect(() => {
    const synced = syncedRef.current
    if (!enabled || !synced || synced.dateKey !== dateKey || inFlightRef.current) return
    const change = diffPositions(synced.positions, positions)
    if (!change) return
    inFlightRef.current = positions
    fetch(`/api/paper-positions?date=${dateKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
      .then((r) => (r.ok ? r.json() : Promise.reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }))))
      .then((snap) => {
        inFlightRef.current = null
        if (syncedRef.current?.dateKey === dateKey) adopt(dateKey, snap, positions)
      })
      .catch((err) => {
        inFlightRef.current = null
        // Still to be sent. Not a refusal (4xx) - the same change would only be refused again.
        if (err?.status >= 400 && err.status < 500) return
        clearTimeout(retryRef.current)
        retryRef.current = setTimeout(() => setAnswers((n) => n + 1), RETRY_MS)
      })
  }, [enabled, dateKey, positions, answers, adopt])

  return useCallback((day) => (syncedRef.current?.dateKey === day && syncedRef.current.version > 0 ? syncedRef.current.positions : null), [])
}
