// Where the Order Flow scanner keeps its settings in the browser (StrategyScanner), and how a strategy's tuned
// trade filters are applied to them - in this browser and in the server scanner's config.
import { filtersFromTuning } from './strategyTuning.js'

export const SCANNER_SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'

/** Saves strategy `id`'s tuned trade filters (`params`) into the scanner settings: this browser's (the Order
 *  Flow page picks them up, even in another tab) and the server scanner's. Returns the new filters. */
export async function applyTunedFilters(id, params, { option = false } = {}) {
  let local = {}
  try { local = JSON.parse(localStorage.getItem(SCANNER_SETTINGS_KEY) ?? '{}') ?? {} } catch { /* none yet */ }
  const filters = filtersFromTuning(local.filters?.[id], params, { option })
  localStorage.setItem(SCANNER_SETTINGS_KEY, JSON.stringify({ ...local, filters: { ...(local.filters ?? {}), [id]: filters } }))
  const config = await fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const serverSettings = config?.settings ?? local
  const saved = filtersFromTuning(serverSettings.filters?.[id], params, { option })
  const res = await fetch('/api/scanner-runner/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { ...serverSettings, filters: { ...(serverSettings.filters ?? {}), [id]: saved } } }),
  })
  if (!res.ok) throw new Error(`saved in this browser, but the server scanner was not updated (HTTP ${res.status})`)
  // Read it back: an apply that the server did not keep is worse than one that failed loudly.
  const after = await fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const got = after?.settings?.filters?.[id]
  if (got && JSON.stringify(got) !== JSON.stringify(saved)) {
    throw new Error('the server scanner saved something different - check the Strategy scanner\'s Filters for this strategy')
  }
  return filters
}

/** Sets ONE filter of one strategy (e.g. a learning suggestion: tradeTape 'with') on this browser's scanner and the
 *  server scanner, keeping every other filter it has. */
export async function applyFilterValue(id, key, value) {
  let local = {}
  try { local = JSON.parse(localStorage.getItem(SCANNER_SETTINGS_KEY) ?? '{}') ?? {} } catch { /* none yet */ }
  const merged = (cur) => ({ ...(cur ?? {}), [key]: value })
  localStorage.setItem(SCANNER_SETTINGS_KEY, JSON.stringify({ ...local, filters: { ...(local.filters ?? {}), [id]: merged(local.filters?.[id]) } }))
  const config = await fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const serverSettings = config?.settings ?? local
  const saved = merged(serverSettings.filters?.[id])
  const res = await fetch('/api/scanner-runner/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { ...serverSettings, filters: { ...(serverSettings.filters ?? {}), [id]: saved } } }),
  })
  if (!res.ok) throw new Error(`saved in this browser, but the server scanner was not updated (HTTP ${res.status})`)
  return saved
}
