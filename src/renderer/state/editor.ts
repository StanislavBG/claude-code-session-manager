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
import { useSessions } from './sessions'
import { readUiPrefs, writeUiPrefsPatch, type EditorSessionPrefs } from '../lib/uiPrefs'

export interface OpenFile {
  path: string
  name: string
}

export type ViewMode = 'edit' | 'preview' | 'split' | 'wysiwyg'

function isViewMode(v: string): v is ViewMode {
  return v === 'edit' || v === 'preview' || v === 'split' || v === 'wysiwyg'
}

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
  /** True once hydrateEditorSession() has resolved (restore attempted, whether
   *  or not anything was actually restored) — gates the autosave subscription
   *  below so it never overwrites a not-yet-restored on-disk session with the
   *  store's empty initial state. */
  hydrated: boolean

  openFile: (path: string, opts?: { line?: number; col?: number }) => void
  closeFile: (path: string) => void
  closeOthers: (path: string) => void
  closeToTheRight: (path: string) => void
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
  /** Remap an open file from oldPath to newPath (Document menu → Rename), keeping
   *  its buffer/baseline/dirty/viewMode and tab position instead of a close+reopen. */
  renameOpenFile: (oldPath: string, newPath: string) => void
  /** Replace openFiles/activeFilePath/viewMode from a persisted session — never
   *  touches buffers/baselines/dirty (restored files are re-read from disk by
   *  hydrateEditorSession, not seeded from any persisted buffer). */
  restoreSession: (session: { openFiles: string[]; activeFilePath: string | null; viewModeByPath: Record<string, string> }) => void
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

/** Move `oldKey`'s value to `newKey` if present; otherwise return `obj` unchanged. */
function rekey<T>(obj: Record<string, T>, oldKey: string, newKey: string): Record<string, T> {
  if (!(oldKey in obj)) return obj
  const next = { ...obj }
  next[newKey] = next[oldKey]
  delete next[oldKey]
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
  hydrated: false,

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

  closeToTheRight: (path) => {
    const { openFiles, activeFilePath } = get()
    const i = openFiles.findIndex((f) => f.path === path)
    if (i === -1) return
    const keep = openFiles.slice(0, i + 1)
    const keepPaths = new Set(keep.map((f) => f.path))
    const pick = <T,>(m: Record<string, T>) =>
      Object.fromEntries(Object.entries(m).filter(([p]) => keepPaths.has(p)))
    set({
      openFiles: keep,
      activeFilePath: activeFilePath && keepPaths.has(activeFilePath) ? activeFilePath : path,
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

  renameOpenFile: (oldPath, newPath) => {
    const { openFiles, activeFilePath } = get()
    const i = openFiles.findIndex((f) => f.path === oldPath)
    if (i === -1) return
    const nextOpenFiles = [...openFiles]
    nextOpenFiles[i] = { path: newPath, name: basename(newPath) }
    set({
      openFiles: nextOpenFiles,
      activeFilePath: activeFilePath === oldPath ? newPath : activeFilePath,
      buffers: rekey(get().buffers, oldPath, newPath),
      baselines: rekey(get().baselines, oldPath, newPath),
      dirty: rekey(get().dirty, oldPath, newPath),
      viewMode: rekey(get().viewMode, oldPath, newPath),
    })
  },

  restoreSession: ({ openFiles, activeFilePath, viewModeByPath }) => {
    const files: OpenFile[] = openFiles.map((path) => ({ path, name: basename(path) }))
    const pathSet = new Set(openFiles)
    const viewMode: Record<string, ViewMode> = {}
    for (const [path, mode] of Object.entries(viewModeByPath)) {
      if (pathSet.has(path) && isViewMode(mode)) viewMode[path] = mode
    }
    set({
      openFiles: files,
      activeFilePath: activeFilePath && pathSet.has(activeFilePath) ? activeFilePath : (files[0]?.path ?? null),
      viewMode,
      hydrated: true,
    })
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
/** Markdown is the only type that gets the full edit/wysiwyg/preview/split set. */
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

// -------------------------------------------------------------------------
// Persistence — structural session only (open paths, active path, per-path
// view mode). Buffers/baselines/dirty are never written or read back here;
// see uiPrefs.ts's EditorSessionPrefs doc comment for why.
// -------------------------------------------------------------------------

/**
 * The Editor scene is intentionally NOT tied to the active session tab (it
 * can hold files opened from several projects' FileTrees/terminal links at
 * once — see App.tsx's "'editor' owns independent tab-id state" comment), so
 * there is no single correct project to persist a multi-project open-files
 * list against. The active session tab's cwd is used as a deliberate
 * simplification: it is the only "current project" notion available before
 * any file is open (needed to know which prefs.json to hydrate from), and
 * cross-project editor state is explicitly out of scope.
 */
function activeProjectCwd(): string | null {
  const { tabs, activeTabId } = useSessions.getState()
  return tabs.find((t) => t.id === activeTabId)?.cwd ?? null
}

function persistedSessionOf(state: EditorState): EditorSessionPrefs {
  return {
    openFiles: state.openFiles.map((f) => f.path),
    activeFilePath: state.activeFilePath,
    viewModeByPath: state.viewMode,
  }
}

function flushEditorSession(): void {
  const cwd = activeProjectCwd()
  if (!cwd) return
  writeUiPrefsPatch(cwd, { editorSession: persistedSessionOf(useEditor.getState()) }).catch((e) => {
    console.warn('[editor] persist failed:', e)
  })
}

// Wired from doHydrateEditorSession, once, AFTER the restore below has
// already applied — mirrors sessions.ts's hydrateSessions(), which wires its
// own autosave subscription only once restoreTabs has run. Wiring it any
// earlier (e.g. at module load) would make restoreSession's own state change
// trip the debounce and echo a redundant write right back.
let saveTimer: number | null = null
let autosaveWired = false
function wireAutosave(): void {
  if (autosaveWired) return
  autosaveWired = true
  useEditor.subscribe((state, prev) => {
    if (state.openFiles === prev.openFiles && state.activeFilePath === prev.activeFilePath && state.viewMode === prev.viewMode) return
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(flushEditorSession, 200)
  })
}

let hydratePromise: Promise<void> | null = null

/**
 * Hydrate once, on EditorView's first mount: restore the structural session
 * from the active project's ui-prefs/prefs.json, then re-open each surviving
 * path's CURRENT on-disk content — never a persisted buffer, since none is
 * ever written. A persisted path that no longer exists on disk is silently
 * dropped. Safe to call from multiple concurrently-mounted EditorView
 * instances: the in-flight promise is shared, and a call after hydration has
 * already completed is a no-op.
 */
export function hydrateEditorSession(): Promise<void> {
  if (useEditor.getState().hydrated) return Promise.resolve()
  if (!hydratePromise) {
    hydratePromise = doHydrateEditorSession().finally(() => { hydratePromise = null })
  }
  return hydratePromise
}

async function doHydrateEditorSession(): Promise<void> {
  const cwd = activeProjectCwd()
  let persisted: EditorSessionPrefs | undefined
  if (cwd) {
    const prefs = await readUiPrefs(cwd)
    persisted = prefs.editorSession
  }
  const candidatePaths = Array.isArray(persisted?.openFiles)
    ? persisted.openFiles.filter((p): p is string => typeof p === 'string')
    : []

  const canRead = typeof window !== 'undefined' && !!window.api?.files?.read
  const reads = await Promise.all(candidatePaths.map(async (path) => {
    if (!canRead) return null
    try {
      const r = await window.api.files.read(path)
      if (r.ok) return { path, text: r.text as string | null }
      if (r.binary) return { path, text: null as string | null }
      return null
    } catch {
      return null
    }
  }))
  const existing = reads.filter((r): r is { path: string; text: string | null } => r !== null)

  useEditor.getState().restoreSession({
    openFiles: existing.map((r) => r.path),
    activeFilePath: persisted?.activeFilePath ?? null,
    viewModeByPath: persisted?.viewModeByPath ?? {},
  })
  for (const r of existing) {
    if (r.text !== null) useEditor.getState().loadBuffer(r.path, r.text)
  }

  wireAutosave()
  // Immediately (not debounced) re-persist the just-restored, existence-
  // filtered session — mirrors sessions.ts's "Initial flush" so a dropped
  // stale path doesn't linger in prefs.json until the next edit happens to
  // trigger a save.
  flushEditorSession()
}

// Test handle so e2e specs can drive the Editor scene without a live Claude session.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__editor = useEditor
}
