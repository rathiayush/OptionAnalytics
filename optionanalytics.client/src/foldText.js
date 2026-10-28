// Which of the pages' text blocks are folded (FoldText.jsx): the explanations under the charts, the checklist's reasons,
// the straddle / GEX reads. Each block remembers its own choice once it is clicked (optionanalytics.fold.<id> - kept for
// the account like every page preference, prefsSync.js); until then it follows "Fold all" / "Open all"
// (optionanalytics.foldAll), and without that its own default: folded to one line - the charts are the cards' main
// part, the text is there when wanted.

export const FOLD_PREFIX = 'optionanalytics.fold.'
export const STORED_FOLD_ALL = 'optionanalytics.foldAll'
// Told to every mounted block when a fold changes in this page (another tab's change comes as a 'storage' event).
export const FOLD_EVENT = 'optionanalytics:fold'

export const foldKey = (id) => `${FOLD_PREFIX}${id}`

const parse = (text) => {
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Whether block `id` is open: its own choice, else "Fold all" / "Open all", else `defaultOpen`. `read(key)` -> text. */
export function isFoldOpen(read, id, defaultOpen = false) {
  const own = parse(read(foldKey(id)))
  if (typeof own === 'boolean') return own
  const all = parse(read(STORED_FOLD_ALL))
  if (all === 'open') return true
  if (all === 'folded') return false
  return defaultOpen
}

/** Block `id` opened / folded by hand - kept for it alone. */
export function setFoldOpen(storage, id, open) {
  storage.setItem(foldKey(id), JSON.stringify(!!open))
}

/** "Fold all" / "Open all": every block, also the ones not on the page now - each one's own choice is dropped. */
export function setAllFolds(storage, open) {
  const keys = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key?.startsWith(FOLD_PREFIX)) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
  storage.setItem(STORED_FOLD_ALL, JSON.stringify(open ? 'open' : 'folded'))
}
