/**
 * useEditorPrefs — global, persisted UI preferences for the Editor scene.
 *
 * These are app-wide (not per-file): font size, word-wrap, minimap, theme.
 * Live-applied to Monaco via `ed.updateOptions` so toggling never remounts the
 * editor. Persisted to `~/.claude/session-manager/ui-settings-prefs.json`'s
 * `editor` field via `lib/uiSettingsPrefs.ts` (shared with the raw-session
 * model and terminal appearance prefs — read-modify-write, one field's write
 * never clobbers another's).
 *
 * The store's initial state is the hard-coded DEFAULTS below (paints
 * immediately, no flash of an empty scene) and is asynchronously overwritten
 * once the disk read resolves — mirrors `lib/rawSessionModel.ts`'s
 * hydrate-on-import pattern. `userSet` guards that hydration from clobbering
 * a change the user already made while the read was still in flight.
 */

import { create } from 'zustand'
import { readUiSettingsPrefs, writeUiSettingsPrefs } from '../lib/uiSettingsPrefs'
import { toast } from './toast'

export type EditorTheme = 'paper' | 'dark'

export interface EditorPrefs {
  fontSize: number
  wordWrap: boolean
  minimap: boolean
  theme: EditorTheme
  autosave: boolean
  /** Markdown preview page canvas: widen the reading measure ~55%. */
  wideMeasure: boolean
  /** Collapsible Assistant rail (Document Experience) — markdown preview/split only. */
  assistantRail: boolean
}

const DEFAULTS: EditorPrefs = { fontSize: 13, wordWrap: false, minimap: false, theme: 'paper', autosave: true, wideMeasure: false, assistantRail: true }
const MIN_FONT = 9
const MAX_FONT = 28

function sanitize(parsed: Partial<EditorPrefs> | undefined): EditorPrefs {
  if (!parsed || typeof parsed !== 'object') return DEFAULTS
  return {
    fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= MIN_FONT && parsed.fontSize <= MAX_FONT ? parsed.fontSize : DEFAULTS.fontSize,
    wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : DEFAULTS.wordWrap,
    minimap: typeof parsed.minimap === 'boolean' ? parsed.minimap : DEFAULTS.minimap,
    theme: parsed.theme === 'dark' || parsed.theme === 'paper' ? parsed.theme : DEFAULTS.theme,
    autosave: typeof parsed.autosave === 'boolean' ? parsed.autosave : DEFAULTS.autosave,
    wideMeasure: typeof parsed.wideMeasure === 'boolean' ? parsed.wideMeasure : DEFAULTS.wideMeasure,
    assistantRail: typeof parsed.assistantRail === 'boolean' ? parsed.assistantRail : DEFAULTS.assistantRail,
  }
}

interface PrefsState extends EditorPrefs {
  setFontSize: (n: number) => void
  bumpFontSize: (delta: number) => void
  resetFontSize: () => void
  toggleWordWrap: () => void
  toggleMinimap: () => void
  setTheme: (t: EditorTheme) => void
  toggleAutosave: () => void
  toggleWideMeasure: () => void
  toggleAssistantRail: () => void
}

// True once a user action has set a value — guards `hydrate()`'s disk read
// (fired at module load) from overwriting a choice the user already made
// while that read was still in flight.
let userSet = false

export const useEditorPrefs = create<PrefsState>((set, get) => {
  const save = (patch: Partial<EditorPrefs>) => {
    userSet = true
    const previous: EditorPrefs = {
      fontSize: get().fontSize,
      wordWrap: get().wordWrap,
      minimap: get().minimap,
      theme: get().theme,
      autosave: get().autosave,
      wideMeasure: get().wideMeasure,
      assistantRail: get().assistantRail,
    }
    const next: EditorPrefs = { ...previous, ...patch }
    set(patch)
    writeUiSettingsPrefs({ editor: next }).catch(() => {
      // Revert so the UI doesn't show a choice that never reached disk, and
      // tell the user (CLAUDE.md: never swallow errors).
      set(previous)
      toast.error("Couldn't save editor preferences — reverted.")
    })
  }
  return {
    ...DEFAULTS,
    setFontSize: (n) => save({ fontSize: Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(n))) }),
    bumpFontSize: (delta) => save({ fontSize: Math.max(MIN_FONT, Math.min(MAX_FONT, get().fontSize + delta)) }),
    resetFontSize: () => save({ fontSize: DEFAULTS.fontSize }),
    toggleWordWrap: () => save({ wordWrap: !get().wordWrap }),
    toggleMinimap: () => save({ minimap: !get().minimap }),
    setTheme: (t) => save({ theme: t }),
    toggleAutosave: () => save({ autosave: !get().autosave }),
    toggleWideMeasure: () => save({ wideMeasure: !get().wideMeasure }),
    toggleAssistantRail: () => save({ assistantRail: !get().assistantRail }),
  }
})

async function hydrate(): Promise<void> {
  try {
    const prefs = await readUiSettingsPrefs()
    if (userSet) return
    if (prefs.editor) useEditorPrefs.setState(sanitize(prefs.editor as Partial<EditorPrefs>))
  } catch {
    /* ignore — stays at DEFAULTS */
  }
}

void hydrate()
