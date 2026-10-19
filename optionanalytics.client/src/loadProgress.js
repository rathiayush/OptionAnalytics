import { useEffect, useRef, useState } from 'react'

const POLL_MS = 700

/** A fresh id for one day load - the server records that load's progress under it (GET /api/oi-replay/progress/{id}). */
export function newLoadProgressId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID() } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Polls a day load's progress while `active` (and once more after, for the last entries): the server's counts and its
 *  running log, entries appended as they come. Null until the server has started recording. */
export function useLoadProgress(id, active) {
  const [progress, setProgress] = useState(null)
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])

  useEffect(() => {
    if (!id) return undefined
    let cancelled = false
    let lastRound = false
    let timer = null
    let cursor = 0
    let entries = []
    const tick = async () => {
      let finished = false
      try {
        const r = await fetch(`/api/oi-replay/progress/${encodeURIComponent(id)}?since=${cursor}`)
        if (r.ok) {
          const snap = await r.json()
          entries = [...entries, ...(snap.entries ?? [])].slice(-400)
          cursor = snap.next ?? cursor
          finished = !!snap.finished
          if (!cancelled) setProgress({ ...snap, entries })
        }
      } catch { /* the next poll tries again */ }
      // Stops once the server says the load finished, or one read after the page stopped waiting (its last entries).
      if (cancelled || finished || lastRound) return
      if (!activeRef.current) lastRound = true
      timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [id])

  // A previous load's progress is never shown as this one's.
  return progress?.id === id ? progress : null
}

