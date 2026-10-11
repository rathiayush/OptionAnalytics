// Where the Order Flow scanner keeps its settings in the browser (StrategyScanner), and how a strategy's tuned
// trade filters are applied to them - in this browser and in the server scanner's config.
import { filtersFromTuning } from './strategyTuning.js'
import { filtersForIndex } from './strategyEngine.js'

export const SCANNER_SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'

/** Where this browser keeps its copy of the settings applied per index (the server's config.filtersByIndex is the
 *  one that counts - the page reads it back from there). */
export const BY_INDEX_KEY = 'optionanalytics.strategyScanner.filtersByIndex'

export function readFiltersByIndex() {
  try { return JSON.parse(localStorage.getItem(BY_INDEX_KEY) ?? '{}') ?? {} } catch { return {} }
}
const writeFiltersByIndex = (v) => { try { localStorage.setItem(BY_INDEX_KEY, JSON.stringify(v ?? {})) } catch { /* private mode */ } }
const readSettings = () => { try { return JSON.parse(localStorage.getItem(SCANNER_SETTINGS_KEY) ?? '{}') ?? {} } catch { return {} } }
const getConfig = () => fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).catch(() => null)

/** The server's settings applied per index, copied into this browser (admins); else this browser's copy. */
export async function loadFiltersByIndex() {
  const config = await getConfig()
  if (!config) return readFiltersByIndex()
  writeFiltersByIndex(config.filtersByIndex ?? {})
  return config.filtersByIndex ?? {}
}

/** Strategy `id`'s filters on ONE index (null = back to its all-index filters) - on the server (which the server
 *  scanner runs with) and in this browser. Read back: an apply the server did not keep must fail loudly. */
export async function saveIndexFilters(index, id, filters) {
  const res = await fetch(`/api/scanner-runner/applied/${encodeURIComponent(index)}/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: filters ?? null }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`the server scanner was not updated: ${body?.error ?? `HTTP ${res.status}`}`)
  const got = body?.filtersByIndex?.[index]?.[id] ?? null
  if (JSON.stringify(got) !== JSON.stringify(filters ?? null)) throw new Error('the server scanner saved something different - check the Strategy scanner\'s Filters for this strategy')
  writeFiltersByIndex(body.filtersByIndex ?? {})
  return got
}

/** Saves strategy `id`'s tuned trade filters (`params`). With `index` (the index the setting was tuned on - always,
 *  from the tuning pages) it is stored for THAT index only (saveIndexFilters; the scanner reads it through
 *  filtersForIndex), so NIFTY's best never overwrites BANKNIFTY's and a page saving its settings never wipes it.
 *  Without, for every index, in the scanner settings (this browser's and the server scanner's). Returns the filters. */
export async function applyTunedFilters(id, params, { option = false, index = null, tuned = null, lots } = {}) {
  if (index) {
    const config = await getConfig()
    const base = filtersForIndex({ filters: config?.settings?.filters ?? readSettings().filters, filtersByIndex: config?.filtersByIndex ?? readFiltersByIndex() }, index)[id]
    const next = filtersFromTuning(base, params, { option })
    // Which tuned setting this is (settingSignature) - the live list judges the strategy by that setting's own record
    // on unseen days. The scanner ignores the key (strategyFilters keeps only real filters).
    delete next._tuned
    if (tuned) next._tuned = tuned
    // The strategy's own lot size on this index (lotsFor): a number sets it, null goes back to the index's lots, left out
    // keeps what it had.
    if (lots !== undefined) setLots(next, lots)
    return saveIndexFilters(index, id, next)
  }
  const local = readSettings()
  const filters = filtersFromTuning(local.filters?.[id], params, { option })
  localStorage.setItem(SCANNER_SETTINGS_KEY, JSON.stringify({ ...local, filters: { ...(local.filters ?? {}), [id]: filters } }))
  const config = await getConfig()
  const serverSettings = config?.settings ?? local
  const saved = filtersFromTuning(serverSettings.filters?.[id], params, { option })
  const res = await fetch('/api/scanner-runner/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { ...serverSettings, filters: { ...(serverSettings.filters ?? {}), [id]: saved } } }),
  })
  if (!res.ok) throw new Error(`saved in this browser, but the server scanner was not updated (HTTP ${res.status})`)
  const after = await getConfig()
  const got = after?.settings?.filters?.[id]
  if (got && JSON.stringify(got) !== JSON.stringify(saved)) {
    throw new Error('the server scanner saved something different - check the Strategy scanner\'s Filters for this strategy')
  }
  return filters
}

/** A strategy's own lot size in its per-index filters: 1 - 500 whole lots, else none (the index's lots). */
function setLots(filters, lots) {
  const n = Number(lots)
  if (Number.isInteger(n) && n >= 1 && n <= 500) filters._lots = n
  else delete filters._lots
  return filters
}

/** Changes ONE strategy's own lot size on one index (null = back to the index's lots), keeping its applied setting. */
export async function saveIndexLots(index, id, lots) {
  const config = await getConfig()
  const current = config?.filtersByIndex?.[index]?.[id] ?? filtersForIndex({ filters: config?.settings?.filters ?? readSettings().filters, filtersByIndex: config?.filtersByIndex ?? readFiltersByIndex() }, index)[id] ?? {}
  return saveIndexFilters(index, id, setLots({ ...current }, lots))
}

/** Puts strategy `id` on `index`'s live list by hand (LiveListService "include"), so the server scanner places real
 *  orders for it when that index is switched to Live today - the server still checks every other limit. */
export async function putOnLiveList(index, id) {
  const res = await fetch('/api/scanner-runner/live-list', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ underlying: index, strategyId: id, mode: 'include' }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(`the setting is applied, but ${index}'s live list was not changed: ${body?.error ?? `HTTP ${res.status}`}`)
  }
}

/** Sets ONE filter of one strategy (e.g. a learning suggestion: tradeTape 'with') on this browser's scanner and the
 *  server scanner, keeping every other filter it has - on every index: the all-index filters, and each index this
 *  strategy has a fine-tuned setting applied for (that one replaces the all-index filters there). */
export async function applyFilterValue(id, key, value) {
  const local = readSettings()
  const merged = (cur) => ({ ...(cur ?? {}), [key]: value })
  localStorage.setItem(SCANNER_SETTINGS_KEY, JSON.stringify({ ...local, filters: { ...(local.filters ?? {}), [id]: merged(local.filters?.[id]) } }))
  const config = await getConfig()
  const serverSettings = config?.settings ?? local
  const saved = merged(serverSettings.filters?.[id])
  const res = await fetch('/api/scanner-runner/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { ...serverSettings, filters: { ...(serverSettings.filters ?? {}), [id]: saved } } }),
  })
  if (!res.ok) throw new Error(`saved in this browser, but the server scanner was not updated (HTTP ${res.status})`)
  for (const [u, f] of Object.entries(config?.filtersByIndex ?? {})) if (f?.[id]) await saveIndexFilters(u, id, merged(f[id]))
  return saved
}
