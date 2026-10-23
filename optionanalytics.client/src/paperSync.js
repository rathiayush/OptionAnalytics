import { useCallback, useEffect, useRef, useState } from 'react'

// OI Replay's paper positions for today, kept on the server per account and day (GET / POST /api/paper-positions -
// PaperPositionStore) so every browser shows the same positions and P&L; the page's localStorage copy is only a fallback.
// The page keeps changing its positions as before (punch, exit, SL / target hits, clear); this sends each change, and
// every POLL_MS takes what another browser changed. The server keeps a closed position as it first closed.

const POLL_MS = 3_000
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

/**
 * Keeps `positions` (the page's state, set with `setPositions`) in step with the server for `dateKey` while `enabled`
 * (today, live). Returns `serverPositions(dateKey)` - the server's last known positions for that day, or null - for a
 * reload of the page to start from instead of the localStorage copy.
 */
export function usePaperPositionsSync({ enabled, dateKey, positions, setPositions }) {
  // { dateKey, version, positions } as the server last said (or as last sent to it); null until the first answer.
  const syncedRef = useRef(null)
  // Bumped when a server answer arrives, so the send effect looks again (the ref alone would not re-run it).
  const [answers, setAnswers] = useState(0)

  const take = useCallback((day, snap, current) => {
    syncedRef.current = { dateKey: day, version: snap.version, positions: snap.positions ?? [] }
    if (!sameList(snap.positions ?? [], current ?? [])) setPositions(snap.positions ?? [])
    setAnswers((n) => n + 1)
  }, [setPositions])

  const positionsRef = useRef(positions)
  useEffect(() => { positionsRef.current = positions }, [positions])

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
        take(dateKey, snap, positionsRef.current)
      } catch { /* the next poll tries again */ }
    }
    pull()
    const id = setInterval(pull, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled, dateKey, take])

  // Send the page's change (only once the server's positions are known - never an old copy over newer ones).
  useEffect(() => {
    const synced = syncedRef.current
    if (!enabled || !synced || synced.dateKey !== dateKey) return
    const change = diffPositions(synced.positions, positions)
    if (!change) return
    syncedRef.current = { ...synced, positions }
    fetch(`/api/paper-positions?date=${dateKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
      .then((r) => (r.ok ? r.json() : null))
      .then((snap) => { if (snap && syncedRef.current?.dateKey === dateKey) take(dateKey, snap, positionsRef.current) })
      .catch(() => { /* kept on the page (and its localStorage copy); the next change sends it again */ })
  }, [enabled, dateKey, positions, answers, take])

  return useCallback((day) => (syncedRef.current?.dateKey === day && syncedRef.current.version > 0 ? syncedRef.current.positions : null), [])
}
