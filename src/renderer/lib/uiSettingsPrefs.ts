/**
 * Shared disk-backed file for small, unrelated-but-machine-wide UI settings —
 * the terminal
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
import { appSettingsFile } from './appSettingsFile'

export interface UiSettingsPrefs {
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
  projectsSplitPct?: number
  projectsFileTreeCollapsed?: boolean
}

export const UI_SETTINGS_PREFS_FILE = '~/.claude/session-manager/ui-settings-prefs.json'

const file = appSettingsFile<UiSettingsPrefs>(UI_SETTINGS_PREFS_FILE)

export const readUiSettingsPrefs = (): Promise<UiSettingsPrefs> => file.read()

// Serialized through the shared per-file queue in appSettingsFile.
export const writeUiSettingsPrefs = (patch: UiSettingsPrefs): Promise<void> => file.patch(patch)
