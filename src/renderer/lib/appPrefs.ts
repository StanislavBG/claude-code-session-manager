/**
 * Cross-project global behavior prefs — small machine-level file distinct
 * from scheduler-machine.json (that one is scheduler fire policy; this one is
 * app UI behavior). Read by layout.ts at boot to pick the initial focused
 * panel, written by SessionManagerConfig.tsx's "Behavior" section.
 */
export interface AppPrefs {
  openToHomeOnLaunch?: boolean
}

export const APP_PREFS_FILE = '~/.claude/session-manager/app-prefs.json'

export async function readAppPrefs(): Promise<AppPrefs> {
  if (typeof window === 'undefined' || !window.api?.config?.readJson) return {}
  try {
    const r = await window.api.config.readJson(APP_PREFS_FILE)
    if (r?.exists && r.data && typeof r.data === 'object') return r.data as AppPrefs
  } catch { /* diagnostic surface only */ }
  return {}
}

export async function writeAppPrefs(patch: AppPrefs): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.config?.writeJson) return
  const current = await readAppPrefs()
  await window.api.config.writeJson(APP_PREFS_FILE, { ...current, ...patch })
}
