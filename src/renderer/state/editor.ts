/**
 * useEditor — open-files state for the in-app Editor scene (main-space).
 *
 * The Editor is launched from the Files sidebar and from terminal file links.
 * It is a `NavKey = 'editor'` scene rendered in MainPane (no left-nav tab).
 *
 * Hot path note: per-keystroke we only ever flip a single boolean in `dirty`.
 * The editor buffer itself lives in the Monaco model / a pane-local ref, not in
 * this store, so typing doesn't churn the open-files list.
 */

import { create } from 'zustand'

export interface OpenFile {
  path: string
  name: string
}

export type ViewMode = 'edit' | 'preview' | 'split'

/** A pending request to reveal a line after a file opens (terminal links). */
interface PendingReveal {
  path: string
  line?: number
  col?: number
}

interface EditorState {
  openFiles: OpenFile[]
  activeFilePath: string | null
  /** path → current editor text. The single source of truth for edit + preview. */
  buffers: Record<string, string>
  /** path → last-saved text. dirty == buffers[path] !== baselines[path]. */
  baselines: Record<string, string>
  /** path → has-unsaved-changes (kept in lockstep with buffers/baselines). */
  dirty: Record<string, boolean>
  /** path → explicit user view-mode choice (overrides the per-extension default). */
  viewMode: Record<string, ViewMode>
  /** Set when a file is opened with a target line (terminal `foo.ts:42`). */
  pendingReveal: PendingReveal | null

  openFile: (path: string, opts?: { line?: number; col?: number }) => void
  closeFile: (path: string) => void
  closeOthers: (path: string) => void
  closeAll: () => void
  setActive: (path: string) => void
  /** Seed both buffer + baseline from disk (on load); clears dirty. */
  loadBuffer: (path: string, text: string) => void
  /** Update the live buffer from an edit; recomputes dirty against the baseline. */
  setBuffer: (path: string, text: string) => void
  /** Mark the current buffer as saved (baseline := buffer); clears dirty. */
  markSaved: (path: string) => void
  hasBuffer: (path: string) => boolean
  setViewMode: (path: string, mode: ViewMode) => void
  consumeReveal: (path: string) => PendingReveal | null
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

/** Neighbor to activate after closing `path` (right, else left, else null). */
function neighbor(files: OpenFile[], path: string): string | null {
  const i = files.findIndex((f) => f.path === path)
  if (i === -1) return files[0]?.path ?? null
  const rest = files.filter((f) => f.path !== path)
  if (rest.length === 0) return null
  return (rest[i] ?? rest[i - 1] ?? rest[0]).path
}

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj
  const next = { ...obj }
  delete next[key]
  return next
}

export const useEditor = create<EditorState>((set, get) => ({
  openFiles: [],
  activeFilePath: null,
  buffers: {},
  baselines: {},
  dirty: {},
  viewMode: {},
  pendingReveal: null,

  openFile: (path, opts) => {
    const { openFiles } = get()
    const exists = openFiles.some((f) => f.path === path)
    set({
      openFiles: exists ? openFiles : [...openFiles, { path, name: basename(path) }],
      activeFilePath: path,
      pendingReveal: opts?.line != null ? { path, line: opts.line, col: opts.col } : get().pendingReveal,
    })
  },

  closeFile: (path) => {
    const { openFiles, activeFilePath } = get()
    const nextActive = activeFilePath === path ? neighbor(openFiles, path) : activeFilePath
    set({
      openFiles: openFiles.filter((f) => f.path !== path),
      activeFilePath: nextActive,
      dirty: omit(get().dirty, path),
      viewMode: omit(get().viewMode, path),
      buffers: omit(get().buffers, path),
      baselines: omit(get().baselines, path),
    })
  },

  closeOthers: (path) => {
    const keep = get().openFiles.find((f) => f.path === path)
    const pick = <T,>(m: Record<string, T>) => (keep && path in m ? { [path]: m[path] } : {})
    set({
      openFiles: keep ? [keep] : [],
      activeFilePath: keep ? path : null,
      dirty: pick(get().dirty),
      viewMode: pick(get().viewMode),
      buffers: pick(get().buffers),
      baselines: pick(get().baselines),
    })
  },

  closeAll: () => set({ openFiles: [], activeFilePath: null, dirty: {}, viewMode: {}, buffers: {}, baselines: {} }),

  setActive: (path) => set({ activeFilePath: path }),

  loadBuffer: (path, text) =>
    set((s) => ({
      buffers: { ...s.buffers, [path]: text },
      baselines: { ...s.baselines, [path]: text },
      dirty: s.dirty[path] ? omit(s.dirty, path) : s.dirty,
    })),

  setBuffer: (path, text) =>
    set((s) => {
      const isDirty = text !== (s.baselines[path] ?? text)
      return {
        buffers: { ...s.buffers, [path]: text },
        dirty: s.dirty[path] === isDirty ? s.dirty : { ...s.dirty, [path]: isDirty },
      }
    }),

  markSaved: (path) =>
    set((s) => ({
      baselines: { ...s.baselines, [path]: s.buffers[path] ?? '' },
      dirty: omit(s.dirty, path),
    })),

  hasBuffer: (path) => path in get().buffers,

  setViewMode: (path, mode) => set((s) => ({ viewMode: { ...s.viewMode, [path]: mode } })),

  consumeReveal: (path) => {
    const pr = get().pendingReveal
    if (pr && pr.path === path) {
      set({ pendingReveal: null })
      return pr
    }
    return null
  },
}))

// -------------------------------------------------------------------------
// Helpers shared by the Editor panes.
// -------------------------------------------------------------------------

const RENDERABLE_MD = new Set(['md', 'mdx', 'markdown'])
const RENDERABLE_HTML = new Set(['html', 'htm'])
const TABULAR_EXTS = new Set(['csv', 'tsv'])
const JSONL_EXTS = new Set(['jsonl', 'ndjson'])
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif', 'bmp'])

export function extOf(p: string): string {
  return p.toLowerCase().split('.').pop() || ''
}

export function isMarkdown(p: string): boolean {
  return RENDERABLE_MD.has(extOf(p))
}
export function isHtml(p: string): boolean {
  return RENDERABLE_HTML.has(extOf(p))
}
export function isImage(p: string): boolean {
  return IMAGE_EXTS.has(extOf(p))
}
export function isPdf(p: string): boolean {
  return extOf(p) === 'pdf'
}
export function isTabular(p: string): boolean {
  return TABULAR_EXTS.has(extOf(p))
}
/** JSON Lines / newline-delimited JSON — record-oriented CRUD pane. */
export function isJsonl(p: string): boolean {
  return JSONL_EXTS.has(extOf(p))
}
/** Types that expose an Edit↔Preview(↔Split) toggle: markdown, HTML, CSV/TSV, JSONL. */
export function isRenderable(p: string): boolean {
  return isMarkdown(p) || isHtml(p) || isTabular(p) || isJsonl(p)
}
/** Markdown is the only type that gets the full three-way edit/preview/split. */
export function supportsSplit(p: string): boolean {
  return isMarkdown(p)
}

/** Per-extension default view mode: prose/markup/tabular defaults to preview. */
export function defaultViewMode(p: string): ViewMode {
  return isRenderable(p) ? 'preview' : 'edit'
}

/** Build the smfile:// URL the HTML preview iframe loads. Encodes per segment
 *  so spaces / unicode survive; the main handler decodeURIComponent's it back. */
export function smfileUrl(absPath: string): string {
  const encoded = absPath.split('/').map(encodeURIComponent).join('/')
  return `smfile://local${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

// Test handle — mirrors state/docEditor.ts's window.__docEditor convention so
// e2e specs can drive the Editor scene without a live Claude session.
;(window as unknown as Record<string, unknown>).__editor = useEditor
