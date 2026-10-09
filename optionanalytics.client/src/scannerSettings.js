// Where the Order Flow scanner keeps its settings in the browser (StrategyScanner), and how a strategy's tuned
// trade filters are applied to them - in this browser and in the server scanner's config.
import { filtersFromTuning } from './strategyTuning.js'

export const SCANNER_SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'

/** Saves strategy `id`'s tuned trade filters (`params`) into the scanner settings: this browser's (the Order
 *  Flow page picks them up, even in another tab) and the server scanner's. Returns the new filters. */
export async function applyTunedFilters(id, params) {
  let local = {}
  try { local = JSON.parse(localStorage.getItem(SCANNER_SETTINGS_KEY) ?? '{}') ?? {} } catch { /* none yet */ }
  const filters = filtersFromTuning(local.filters?.[id], params)
  localStorage.setItem(SCANNER_SETTINGS_KEY, JSON.stringify({ ...local, filters: { ...(local.filters ?? {}), [id]: filters } }))
  const config = await fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const serverSettings = config?.settings ?? local
  const res = await fetch('/api/scanner-runner/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { ...serverSettings, filters: { ...(serverSettings.filters ?? {}), [id]: filtersFromTuning(serverSettings.filters?.[id], params) } } }),
  })
  if (!res.ok) throw new Error(`saved in this browser, but the server scanner was not updated (HTTP ${res.status})`)
  return filters
}
