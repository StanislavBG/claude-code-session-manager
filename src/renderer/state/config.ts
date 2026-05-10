import { create } from 'zustand'
import type { ReadJsonResult, ReadTextResult } from '../../preload/api'

/**
 * Per-file config cache. Keyed by absolute path. Tracks the on-disk snapshot
 * + any unsaved edits from the editor. Watcher subscriptions live alongside,
 * refcounted so multiple tabs/components can watch the same file.
 */

export interface FileState {
  path: string
  /** Raw text loaded from disk. */
  diskRaw: string
  /** Raw text currently in the editor (may be dirty). */
  draftRaw: string
  /** Parsed JSON (if applicable) from disk. */
  diskData: unknown
  exists: boolean
  parseError: string | null
  loadError: string | null
  mtimeMs: number
  /** True when draftRaw !== diskRaw. */
  dirty: boolean
  /** True while an async load/save is in flight. */
  busy: boolean
  lastSavedAt: number | null
}

interface ConfigState {
  files: Record<string, FileState>
  watchRefs: Record<string, number>

  loadJson: (path: string) => Promise<void>
  loadText: (path: string) => Promise<void>
  setDraft: (path: string, raw: string) => void
  revert: (path: string) => void
  saveJson: (path: string) => Promise<{ ok: boolean; error?: string }>
  saveText: (path: string) => Promise<{ ok: boolean; error?: string }>
  watchFile: (path: string) => void
  unwatchFile: (path: string) => void
  /** Called when main emits a change event for a path we're watching. */
  onExternalChange: (path: string) => void
}

function blank(path: string): FileState {
  return {
    path,
    diskRaw: '',
    draftRaw: '',
    diskData: null,
    exists: false,
    parseError: null,
    loadError: null,
    mtimeMs: 0,
    dirty: false,
    busy: false,
    lastSavedAt: null,
  }
}

function applyJsonRead(f: FileState, r: ReadJsonResult, keepDirty: boolean): FileState {
  // If the draft is dirty and this is a refresh, keep the draft.
  const next: FileState = {
    ...f,
    diskRaw: r.raw,
    diskData: r.data,
    exists: r.exists,
    parseError: r.parseError,
    loadError: r.error,
    mtimeMs: r.mtimeMs,
    busy: false,
  }
  if (!keepDirty || !f.dirty) {
    next.draftRaw = r.raw
    next.dirty = false
  } else {
    next.dirty = next.draftRaw !== next.diskRaw
  }
  return next
}

function applyTextRead(f: FileState, r: ReadTextResult, keepDirty: boolean): FileState {
  const next: FileState = {
    ...f,
    diskRaw: r.text,
    diskData: null,
    exists: r.exists,
    parseError: null,
    loadError: r.error,
    mtimeMs: r.mtimeMs,
    busy: false,
  }
  if (!keepDirty || !f.dirty) {
    next.draftRaw = r.text
    next.dirty = false
  } else {
    next.dirty = next.draftRaw !== next.diskRaw
  }
  return next
}

export const useConfig = create<ConfigState>((set, get) => ({
  files: {},
  watchRefs: {},

  loadJson: async (path) => {
    const existing = get().files[path]
    set({ files: { ...get().files, [path]: { ...(existing ?? blank(path)), busy: true } } })
    const r = await window.api.config.readJson(path)
    const cur = get().files[path] ?? blank(path)
    set({ files: { ...get().files, [path]: applyJsonRead(cur, r, false) } })
  },

  loadText: async (path) => {
    const existing = get().files[path]
    set({ files: { ...get().files, [path]: { ...(existing ?? blank(path)), busy: true } } })
    const r = await window.api.config.readText(path)
    const cur = get().files[path] ?? blank(path)
    set({ files: { ...get().files, [path]: applyTextRead(cur, r, false) } })
  },

  setDraft: (path, raw) => {
    const cur = get().files[path] ?? blank(path)
    const dirty = raw !== cur.diskRaw
    set({ files: { ...get().files, [path]: { ...cur, draftRaw: raw, dirty } } })
  },

  revert: (path) => {
    const cur = get().files[path]
    if (!cur) return
    set({
      files: { ...get().files, [path]: { ...cur, draftRaw: cur.diskRaw, dirty: false } },
    })
  },

  saveJson: async (path) => {
    const cur = get().files[path]
    if (!cur) return { ok: false, error: 'not loaded' }
    // Validate JSON before writing.
    let parsed: unknown
    try {
      parsed = cur.draftRaw.trim() === '' ? {} : JSON.parse(cur.draftRaw)
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${(e as Error).message}` }
    }
    set({ files: { ...get().files, [path]: { ...cur, busy: true } } })
    const res = await window.api.config.writeJson(path, parsed)
    if (!res.ok) {
      set({ files: { ...get().files, [path]: { ...cur, busy: false } } })
      return { ok: false, error: res.error }
    }
    // Reload from disk to pick up canonical formatting.
    const r = await window.api.config.readJson(path)
    const next = applyJsonRead({ ...cur, busy: false }, r, false)
    set({
      files: { ...get().files, [path]: { ...next, lastSavedAt: Date.now() } },
    })
    return { ok: true }
  },

  saveText: async (path) => {
    const cur = get().files[path]
    if (!cur) return { ok: false, error: 'not loaded' }
    set({ files: { ...get().files, [path]: { ...cur, busy: true } } })
    const res = await window.api.config.writeText(path, cur.draftRaw)
    if (!res.ok) {
      set({ files: { ...get().files, [path]: { ...cur, busy: false } } })
      return { ok: false, error: res.error }
    }
    const r = await window.api.config.readText(path)
    const next = applyTextRead({ ...cur, busy: false }, r, false)
    set({
      files: { ...get().files, [path]: { ...next, lastSavedAt: Date.now() } },
    })
    return { ok: true }
  },

  watchFile: (path) => {
    const refs = { ...get().watchRefs }
    refs[path] = (refs[path] ?? 0) + 1
    set({ watchRefs: refs })
    if (refs[path] === 1) {
      window.api.config.watch([path])
    }
  },

  unwatchFile: (path) => {
    const refs = { ...get().watchRefs }
    if (!refs[path]) return
    refs[path]--
    if (refs[path] <= 0) {
      delete refs[path]
      window.api.config.unwatch([path])
    }
    set({ watchRefs: refs })
  },

  onExternalChange: (path) => {
    const cur = get().files[path]
    if (!cur) return
    // Refresh from disk, preserving dirty draft if user has unsaved edits.
    window.api.config.readJson(path).then((r) => {
      // Heuristic: if the file parses as JSON we treat it as JSON; otherwise
      // we still populate diskRaw for text-based editors.
      const cur2 = get().files[path]
      if (!cur2) return
      set({ files: { ...get().files, [path]: applyJsonRead(cur2, r, true) } })
    })
  },
}))

/**
 * Wire the renderer-side change listener once at app startup.
 */
export function installConfigChangeListener() {
  return window.api.config.onChanged(({ path }) => {
    useConfig.getState().onExternalChange(path)
  })
}
