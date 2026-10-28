import { useCallback, useSyncExternalStore } from 'react'
import { FOLD_EVENT, isFoldOpen, setAllFolds, setFoldOpen } from './foldText.js'

// The folds of the pages' text blocks (foldText.js has which and why) as React state: each mounted block follows a
// change made anywhere on the page (or in another tab) at once. FoldText.jsx draws the blocks.

const read = (key) => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (change) => {
  try {
    change(window.localStorage)
  } catch {
    // Storage blocked: nothing to keep the fold in, so it stays as it was - remembering is a convenience here.
  }
  window.dispatchEvent(new Event(FOLD_EVENT))
}

const subscribe = (onChange) => {
  window.addEventListener(FOLD_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(FOLD_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** [open, setOpen] for block `id` - remembered, and follows "Fold all" / "Open all" until clicked. */
export function useFold(id, defaultOpen = true) {
  const open = useSyncExternalStore(subscribe, () => isFoldOpen(read, id, defaultOpen), () => defaultOpen)
  const setOpen = useCallback((next) => write((storage) => setFoldOpen(storage, id, typeof next === 'function' ? next(isFoldOpen(read, id, defaultOpen)) : next)), [id, defaultOpen])
  return [open, setOpen]
}

/** "Fold all" (false) / "Open all" (true) - every block, on this page or not. */
export function foldAllText(open) {
  write((storage) => setAllFolds(storage, open))
}

