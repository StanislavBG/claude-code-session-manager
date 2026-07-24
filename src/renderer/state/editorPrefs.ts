/**
 * useEditorPrefs — global, persisted UI preferences for the Editor scene.
 *
 * These are app-wide (not per-file): font size, word-wrap, minimap, theme.
 * Live-applied to Monaco via `ed.updateOptions` so toggling never remounts the
 * editor. Persisted to localStorage by hand (one small flat object) — no need
 * for zustand persist middleware for a single key.
 */

import { create } from 'zustand'

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
const KEY = 'sm.editorPrefs.v1'
const MIN_FONT = 9
const MAX_FONT = 28

function load(): EditorPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<EditorPrefs>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

function persist(prefs: EditorPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* quota / private mode — ignore */ }
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

export const useEditorPrefs = create<PrefsState>((set, get) => {
  const save = (patch: Partial<EditorPrefs>) => {
    const next: EditorPrefs = {
      fontSize: get().fontSize,
      wordWrap: get().wordWrap,
      minimap: get().minimap,
      theme: get().theme,
      autosave: get().autosave,
      wideMeasure: get().wideMeasure,
      assistantRail: get().assistantRail,
      ...patch,
    }
    persist(next)
    set(patch)
  }
  return {
    ...load(),
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
