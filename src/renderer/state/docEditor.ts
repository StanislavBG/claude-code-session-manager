import { create } from 'zustand'
import { toast } from './toast'

const CFG_PATH = '~/.config/session-manager/doc-editor.json'
const MAX_RECENTS = 20

export type DocBuffer = {
  path: string
  diskText: string
  bufferText: string
  mtimeMs: number
  loadedAt: number
}

export interface DocEditorStore {
  docs: Record<string, DocBuffer>
  activePath: string | null
  recents: string[]
  /** Per-path view mode for .md/.markdown files. Persisted. */
  viewModes: Record<string, 'wysiwyg' | 'source'>
  hydrated: boolean

  open: (path: string) => Promise<void>
  close: (path: string) => void
  setActive: (path: string) => void
  edit: (path: string, text: string) => void
  setViewMode: (path: string, mode: 'wysiwyg' | 'source') => void
  save: (path: string) => Promise<void>
  saveAll: () => Promise<void>
  hydrate: () => Promise<void>
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWrite(getState: () => DocEditorStore) {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(async () => {
    const s = getState()
    try {
      const cfg = await window.api.config.readJson(CFG_PATH).catch(() => null)
      const existing = (cfg?.data as Record<string, unknown>) ?? {}
      await window.api.config.writeJson(CFG_PATH, {
        ...existing,
        recents: s.recents,
        openPaths: Object.keys(s.docs),
        viewModes: s.viewModes,
      })
    } catch (e) {
      console.warn('[docEditor] persist failed:', e)
    }
  }, 500)
}

function addToRecents(recents: string[], path: string): string[] {
  return [path, ...recents.filter((r) => r !== path)].slice(0, MAX_RECENTS)
}

export const useDocEditor = create<DocEditorStore>((set, get) => ({
  docs: {},
  activePath: null,
  recents: [],
  viewModes: {},
  hydrated: false,

  open: async (path) => {
    const existing = get().docs[path]
    if (existing) {
      set({ activePath: path })
      return
    }
    const result = await window.api.docEditor.readFile(path)
    if (!result.ok) {
      toast.warn(`Could not open ${path.split('/').pop()}: ${result.error ?? 'unknown error'}`)
      set((s) => ({ recents: s.recents.filter((r) => r !== path) }))
      scheduleWrite(get)
      return
    }
    const buf: DocBuffer = {
      path,
      diskText: result.text ?? '',
      bufferText: result.text ?? '',
      mtimeMs: result.mtimeMs ?? 0,
      loadedAt: Date.now(),
    }
    set((s) => ({
      docs: { ...s.docs, [path]: buf },
      activePath: path,
      recents: addToRecents(s.recents, path),
    }))
    scheduleWrite(get)
  },

  close: (path) => {
    const s = get()
    const doc = s.docs[path]
    if (!doc) return
    if (doc.bufferText !== doc.diskText) {
      const basename = path.split('/').pop() ?? path
      if (!window.confirm(`"${basename}" has unsaved changes. Close without saving?`)) return
    }
    const newDocs = { ...s.docs }
    delete newDocs[path]
    let newActive: string | null = s.activePath
    if (s.activePath === path) {
      const remaining = Object.values(newDocs).sort((a, b) => b.loadedAt - a.loadedAt)
      newActive = remaining[0]?.path ?? null
    }
    set({ docs: newDocs, activePath: newActive })
    scheduleWrite(get)
  },

  setActive: (path) => {
    set({ activePath: path })
  },

  setViewMode: (path, mode) => {
    set((s) => ({ viewModes: { ...s.viewModes, [path]: mode } }))
    scheduleWrite(get)
  },

  edit: (path, text) => {
    const doc = get().docs[path]
    if (!doc) return
    set((s) => ({
      docs: { ...s.docs, [path]: { ...doc, bufferText: text } },
    }))
  },

  save: async (path) => {
    const doc = get().docs[path]
    if (!doc) return
    const textToSave = doc.bufferText
    const result = await window.api.docEditor.writeFile(path, textToSave)
    if (!result.ok) {
      toast.error(`Save failed for ${path.split('/').pop()}: ${result.error ?? 'unknown'}`)
      return
    }
    set((s) => {
      const cur = s.docs[path]
      if (!cur) return {}
      return {
        docs: { ...s.docs, [path]: { ...cur, diskText: textToSave, mtimeMs: result.mtimeMs ?? cur.mtimeMs } },
        recents: addToRecents(s.recents, path),
      }
    })
    scheduleWrite(get)
  },

  saveAll: async () => {
    const dirtyPaths = Object.values(get().docs)
      .filter((d) => d.bufferText !== d.diskText)
      .map((d) => d.path)
    await Promise.all(dirtyPaths.map((p) => get().save(p)))
  },

  hydrate: async () => {
    if (get().hydrated) return
    set({ hydrated: true })
    try {
      const cfg = await window.api.config.readJson(CFG_PATH)
      const data = (cfg.data ?? {}) as Record<string, unknown>
      const recents = Array.isArray(data.recents) ? (data.recents as string[]) : []
      const openPaths = Array.isArray(data.openPaths) ? (data.openPaths as string[]) : []
      const rawModes = (data.viewModes ?? {}) as Record<string, unknown>
      const viewModes: Record<string, 'wysiwyg' | 'source'> = {}
      for (const [k, v] of Object.entries(rawModes)) {
        if (v === 'wysiwyg' || v === 'source') viewModes[k] = v
      }
      set({ recents, viewModes })
      for (const p of openPaths) {
        await get().open(p)
      }
    } catch (e) {
      console.warn('[docEditor] hydrate failed:', e)
    }
  },
}))

// Test hook — expose store on window for e2e page.evaluate access.
;(window as unknown as Record<string, unknown>).__docEditor = useDocEditor
