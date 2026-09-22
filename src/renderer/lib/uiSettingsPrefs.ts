/**
 * Shared disk-backed file for small, unrelated-but-machine-wide UI settings —
 * the raw-session default model (`lib/rawSessionModel.ts`), the terminal
 * appearance theme/font size (`lib/terminalSettings.ts`), the Editor scene's
 * prefs (`state/editorPrefs.ts`), the History screen's analytics/budget
 * prefs (`lib/historyAnalyticsPrefs.ts`), and the Files sidebar's hidden-file
 * toggle (`components/layout/FileTree.tsx`) — deliberately global rather than
 * per-project, since it's a personal viewing preference, not project data
 * (see `session-manager-operations/ui-prefs/README.md` for the per-project
 * counterpart). One file, five independent owners:
 * `writeUiSettingsPrefs` always re-reads the current contents before writing
 * its patch (mirrors `appPrefs.ts`'s read-modify-write), so one field's write
 * never clobbers another's. Two of those owners (editor, history) are each a
 * nested object with more than one writer inside it — `state/editorPrefs.ts`
 * serializes its own writes internally, and `lib/historyAnalyticsPrefs.ts`
 * does the same for `history` (HistoryDashboard's measure/range vs
 * BudgetStrip's budgetCapUsd), so a sub-field write never clobbers a sibling
 * sub-field the same way this module protects top-level fields from each
 * other.
 */
export interface UiSettingsPrefs {
  rawSessionModel?: string
  terminal?: { theme: string; fontSize: number }
  editor?: {
    fontSize: number
    wordWrap: boolean
    minimap: boolean
    theme: string
    autosave: boolean
    wideMeasure: boolean
    assistantRail: boolean
  }
  history?: {
    measure?: string
    range?: number
    budgetCapUsd?: number
  }
  fileTreeShowHidden?: boolean
}

export const UI_SETTINGS_PREFS_FILE = '~/.claude/session-manager/ui-settings-prefs.json'

export async function readUiSettingsPrefs(): Promise<UiSettingsPrefs> {
  if (typeof window === 'undefined' || !window.api?.config?.readJson) return {}
  try {
    const r = await window.api.config.readJson(UI_SETTINGS_PREFS_FILE)
    if (r?.exists && r.data && typeof r.data === 'object') return r.data as UiSettingsPrefs
  } catch { /* diagnostic surface only */ }
  return {}
}

// Serializes every write through this module so the two independent owners'
// read-modify-write cycles can never interleave (rawSessionModel.ts's and
// terminalSettings.ts's writes both funnel through here): without this, a
// write's own read could complete before an overlapping write's read lands
// its file update, and the later write's `{ ...current, ...patch }` would
// spread a now-stale `current`, silently dropping the other field's change.
let writeQueue: Promise<void> = Promise.resolve()

export function writeUiSettingsPrefs(patch: UiSettingsPrefs): Promise<void> {
  const run = writeQueue.then(async () => {
    if (typeof window === 'undefined' || !window.api?.config?.writeJson) return
    const current = await readUiSettingsPrefs()
    await window.api.config.writeJson(UI_SETTINGS_PREFS_FILE, { ...current, ...patch })
  })
  // Chain the queue through a swallowed copy so one write's rejection never
  // stalls the next caller's turn; `run` itself still rejects for its own caller.
  writeQueue = run.catch(() => {})
  return run
}
