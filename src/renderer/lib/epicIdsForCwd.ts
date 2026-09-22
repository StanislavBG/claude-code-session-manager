import { promptSessionActiveIndexPath } from '../state/promptSessions'

/**
 * Every Epic id known for one project — active-index.json's `sessions` map
 * plus every archived `<id>.json` file sitting beside it in prompt-sessions/.
 * Used only by the one-shot legacy-global-file -> per-project ui-prefs
 * migrations (epicsPrefs.ts pins, chatPrefs.ts perEpic) to decide which
 * epicId-keyed entries actually belong to the active cwd.
 */
export async function knownEpicIdsForCwd(cwd: string): Promise<Set<string>> {
  const ids = new Set<string>()
  if (typeof window === 'undefined' || !window.api?.config) return ids

  if (window.api.config.readJson) {
    try {
      const r = await window.api.config.readJson(promptSessionActiveIndexPath(cwd))
      if (r.exists && r.data && typeof r.data === 'object') {
        const sessions = (r.data as { sessions?: Record<string, unknown> }).sessions ?? {}
        for (const id of Object.keys(sessions)) ids.add(id)
      }
    } catch { /* best-effort — an unreadable index just yields no ids from it */ }
  }

  if (window.api.config.listDir) {
    try {
      const dir = `${cwd.replace(/\/+$/, '')}/session-manager-operations/prompt-sessions`
      const result = await window.api.config.listDir(dir, { filesOnly: true })
      if (result.ok) {
        for (const entry of result.entries) {
          if (!entry.name.endsWith('.json') || entry.name === 'active-index.json') continue
          ids.add(entry.name.slice(0, -'.json'.length))
        }
      }
    } catch { /* best-effort — an unreadable dir just yields no ids from it */ }
  }

  return ids
}
