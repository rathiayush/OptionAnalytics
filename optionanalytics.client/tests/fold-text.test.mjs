// The pages' text blocks that fold to one line (foldText.js, FoldText.jsx): each remembers its own click, "Fold all" /
// "Open all" reach every block - on the page or not - and a block's own default applies until either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOLD_PREFIX, STORED_FOLD_ALL, foldKey, isFoldOpen, setAllFolds, setFoldOpen } from '../src/foldText.js'
import { isPreferenceKey } from '../src/prefsSync.js'

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries))
  return {
    get length() { return map.size },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    dump: () => Object.fromEntries(map),
  }
}

test('a block follows its own default until it is clicked', () => {
  const storage = fakeStorage()
  assert.equal(isFoldOpen(storage.getItem, 'straddle.read', true), true)     // a read: open
  assert.equal(isFoldOpen(storage.getItem, 'oiHeatmap.note', false), false)  // an explanation: folded
  setFoldOpen(storage, 'oiHeatmap.note', true)
  assert.equal(isFoldOpen(storage.getItem, 'oiHeatmap.note', false), true)
  assert.equal(storage.getItem(foldKey('oiHeatmap.note')), 'true')
})

test('Fold all / Open all reach every block, and drop each one\'s own click', () => {
  const storage = fakeStorage({ 'optionanalytics.oiReplay.gridLayout': '[1]' })
  setFoldOpen(storage, 'gex.read', true)
  setFoldOpen(storage, 'gex.basis', true)
  setAllFolds(storage, false)
  for (const [id, own] of [['gex.read', true], ['gex.basis', false], ['never.shown.yet', true]]) {
    assert.equal(isFoldOpen(storage.getItem, id, own), false, id)
  }
  // Only the folds were touched - not the page's other preferences.
  assert.deepEqual(storage.dump(), { 'optionanalytics.oiReplay.gridLayout': '[1]', [STORED_FOLD_ALL]: '"folded"' })
  setFoldOpen(storage, 'gex.read', true)                                       // a click after it still counts
  assert.equal(isFoldOpen(storage.getItem, 'gex.read', true), true)
  setAllFolds(storage, true)
  assert.equal(isFoldOpen(storage.getItem, 'gex.basis', false), true)
  assert.equal(isFoldOpen(storage.getItem, 'gex.read', true), true)
})

test('a damaged value reads as no choice', () => {
  const storage = fakeStorage({ [foldKey('a')]: 'not json', [STORED_FOLD_ALL]: '{' })
  assert.equal(isFoldOpen(storage.getItem, 'a', false), false)
  assert.equal(isFoldOpen(storage.getItem, 'a', true), true)
})

test('the folds are kept for the account like every page preference', () => {
  assert.equal(isPreferenceKey(foldKey('entryChecklist.reasons')), true)
  assert.equal(isPreferenceKey(STORED_FOLD_ALL), true)
  assert.equal(STORED_FOLD_ALL.startsWith(FOLD_PREFIX), false)                 // "Fold all" never drops itself
})
