/**
 * EditorView — the in-app Editor scene (main-space, NavKey 'editor').
 *
 * Launched from the Files sidebar and from terminal file links. Owns: the
 * open-files tab strip, per-file buffer loading, the Edit/Preview/Split toggle,
 * autosave, the document outline + status bar (Google-Docs chrome), focus mode,
 * scene-level Cmd/Ctrl-S, and the unsaved-changes close guard. Panes are dumb
 * renderers of the active file's buffer (held in the editor store).
 *
 * File dispatch: images → ImagePane, PDFs → PdfPane, binary/oversize → BinaryPane
 * (files.cjs flags these), CSV/TSV → TablePane, markdown/html → preview, else
 * Monaco. Wide-file support rides the smfile:// scheme + binary sniff; the Docs
 * feel rides marked + the .markdown-body page canvas. Zero new npm deps.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import {
  useEditor,
  isImage,
  isPdf,
  isMarkdown,
  isHtml,
  isTabular,
  isRenderable,
  supportsSplit,
  defaultViewMode,
  extOf,
  type ViewMode,
} from '../../state/editor'
import { useEditorPrefs } from '../../state/editorPrefs'
import { toast } from '../../state/toast'
import { FileTabBar } from '../layout/FileTabBar'
import { CodeEditorPane } from './editor/CodeEditorPane'
import { MarkdownPreview } from './editor/MarkdownPreview'
import { MarkdownToolbar } from './editor/MarkdownToolbar'
import { DocOutline } from './editor/DocOutline'
import { EditorStatusBar } from './editor/EditorStatusBar'
import { HtmlPreview } from './editor/HtmlPreview'
import { ImagePane } from './editor/ImagePane'
import { PdfPane } from './editor/PdfPane'
import { TablePane } from './editor/TablePane'
import { BinaryPane } from './editor/BinaryPane'

interface BinaryInfo { binary: true; size: number; mime: string; reason: string }
type LoadState = 'loading' | 'ready' | { error: string } | BinaryInfo
interface CursorInfo { line: number; col: number; selected: number }

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

/** A file whose bytes the renderer never reads as text (own pane handles it). */
function isMediaPath(p: string): boolean {
  return isImage(p) || isPdf(p)
}

export function EditorView() {
  const openFiles = useEditor((s) => s.openFiles)
  const activeFilePath = useEditor((s) => s.activeFilePath)
  const dirty = useEditor((s) => s.dirty)
  const viewMode = useEditor((s) => s.viewMode)
  const buffers = useEditor((s) => s.buffers)
  const setActive = useEditor((s) => s.setActive)
  const closeFile = useEditor((s) => s.closeFile)
  const closeOthers = useEditor((s) => s.closeOthers)
  const closeAll = useEditor((s) => s.closeAll)
  const loadBuffer = useEditor((s) => s.loadBuffer)
  const setBuffer = useEditor((s) => s.setBuffer)
  const markSaved = useEditor((s) => s.markSaved)
  const setViewMode = useEditor((s) => s.setViewMode)

  const prefs = useEditorPrefs()

  const [loadState, setLoadState] = useState<Record<string, LoadState>>({})
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({})
  const [confirmClose, setConfirmClose] = useState<{ kind: 'one' | 'others' | 'all'; path: string } | null>(null)
  const [cursor, setCursor] = useState<CursorInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [showOutline, setShowOutline] = useState(true)

  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  // Lazily read the active file into the buffer store (text files only; images
  // and PDFs are served straight to their pane over smfile://). Depends ONLY on
  // the active path: depending on buffers/loadState would re-run this effect when
  // it sets 'loading', whose cleanup would cancel its own in-flight read.
  useEffect(() => {
    const path = activeFilePath
    if (!path || isMediaPath(path)) return
    if (useEditor.getState().hasBuffer(path)) {
      setLoadState((s) => (s[path] === 'ready' ? s : { ...s, [path]: 'ready' }))
      return
    }
    let cancelled = false
    setLoadState((s) => ({ ...s, [path]: 'loading' }))
    window.api.files.read(path).then((r) => {
      if (cancelled) return
      if (r.binary) {
        setLoadState((s) => ({ ...s, [path]: { binary: true, size: r.size ?? 0, mime: r.mime ?? 'application/octet-stream', reason: r.error ?? 'Binary file' } }))
      } else if (!r.ok) {
        setLoadState((s) => ({ ...s, [path]: { error: r.error ?? 'failed to read' } }))
      } else {
        loadBuffer(path, r.text)
        setLoadState((s) => ({ ...s, [path]: 'ready' }))
      }
    })
    return () => { cancelled = true }
  }, [activeFilePath, loadBuffer])

  // Reset transient per-file UI when the active file changes.
  useEffect(() => { setCursor(null) }, [activeFilePath])

  const save = useCallback(async (path: string, silent = false) => {
    const text = useEditor.getState().buffers[path]
    if (text == null) return
    if (silent) setSaving(true)
    const r = await window.api.files.write(path, text)
    if (r.ok) {
      markSaved(path)
      setReloadTokens((t) => ({ ...t, [path]: (t[path] ?? 0) + 1 }))
      if (!silent) toast.info(`Saved ${basename(path)}`)
    } else {
      toast.error(r.error ?? `Couldn't save ${basename(path)}`)
    }
    if (silent) setSaving(false)
  }, [markSaved])

  // Autosave — debounced ~1.2 s after the last keystroke. Re-runs on every
  // buffer change (debounce reset); silent so it doesn't spam the save toast.
  useEffect(() => {
    if (!prefs.autosave) return
    const path = activeFilePath
    if (!path || isMediaPath(path) || !dirty[path]) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void save(path, true) }, 1200)
    return () => window.clearTimeout(saveTimer.current)
  }, [prefs.autosave, activeFilePath, dirty, buffers, save])

  // Scene-level Cmd/Ctrl-S + focus-mode toggle/exit. EditorView only mounts while
  // the editor scene is active, so these listeners are naturally scoped to it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        const path = useEditor.getState().activeFilePath
        if (path && !isMediaPath(path)) {
          e.preventDefault()
          void save(path)
        }
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setFocusMode((v) => !v)
      } else if (e.key === 'Escape' && focusMode) {
        setFocusMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, focusMode])

  // Close guards — confirm before discarding unsaved edits.
  const requestClose = useCallback((path: string) => {
    if (dirty[path]) setConfirmClose({ kind: 'one', path })
    else closeFile(path)
  }, [dirty, closeFile])

  const requestCloseOthers = useCallback((path: string) => {
    const anyOtherDirty = openFiles.some((f) => f.path !== path && dirty[f.path])
    if (anyOtherDirty) setConfirmClose({ kind: 'others', path })
    else closeOthers(path)
  }, [openFiles, dirty, closeOthers])

  const requestCloseAll = useCallback(() => {
    const anyDirty = openFiles.some((f) => dirty[f.path])
    if (anyDirty) setConfirmClose({ kind: 'all', path: '' })
    else closeAll()
  }, [openFiles, dirty, closeAll])

  const doConfirmedClose = () => {
    if (!confirmClose) return
    if (confirmClose.kind === 'one') closeFile(confirmClose.path)
    else if (confirmClose.kind === 'others') closeOthers(confirmClose.path)
    else closeAll()
    setConfirmClose(null)
  }

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-fg-faint text-xs">
        <div className="text-center">
          <div className="mb-2">no file open</div>
          <div>switch the sidebar to <span className="text-fg-dim">Files</span> and click a file to open it here</div>
        </div>
      </div>
    )
  }

  const path = activeFilePath
  const name = path ? basename(path) : ''
  const ls = path ? loadState[path] : undefined
  const renderable = path ? isRenderable(path) : false
  const canSplit = path ? supportsSplit(path) : false
  const effMode: ViewMode = path && renderable ? (viewMode[path] ?? defaultViewMode(path)) : 'edit'
  const isTextFile = !!path && !isMediaPath(path) && ls === 'ready'
  const showStatusBar = isTextFile

  const modes: ViewMode[] = canSplit ? ['edit', 'preview', 'split'] : renderable ? ['edit', 'preview'] : []

  const registerEditor = useCallback((ed: editor.IStandaloneCodeEditor | null) => { monacoRef.current = ed }, [])
  const getEditor = useCallback(() => monacoRef.current, [])

  // The Monaco editor pane for the active file, reused by edit + split modes.
  const codePane = path && (
    <CodeEditorPane
      path={path}
      name={name}
      value={buffers[path] ?? ''}
      onChange={(text) => setBuffer(path, text)}
      onSave={() => void save(path)}
      onReady={registerEditor}
      onCursor={setCursor}
    />
  )

  const savedLabel = saving ? 'Saving…' : path && dirty[path] ? (prefs.autosave ? 'Editing…' : 'Unsaved') : 'All changes saved'

  return (
    <div className="relative flex flex-col h-full bg-bg">
      {!focusMode && (
        <FileTabBar
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          dirty={dirty}
          onSelectFile={setActive}
          onCloseFile={requestClose}
          onCloseOthers={requestCloseOthers}
          onCloseAll={requestCloseAll}
        />
      )}

      {/* Header: name + path, save indicator, view toggle, prefs, escape hatches */}
      {path && !focusMode && (
        <div className="flex items-center px-3 h-8 border-b border-line shrink-0 bg-bg-elev">
          <span className="text-xs font-medium text-fg truncate">{name}</span>
          <span className="ml-3 text-[10px] text-fg-faint truncate">{path}</span>
          {isTextFile && (
            <span className="ml-3 text-[10px] text-fg-faint shrink-0">· {savedLabel}</span>
          )}
          <div className="flex-1" />

          {/* Outline toggle (markdown preview/split only) */}
          {isMarkdown(path) && effMode !== 'edit' && (
            <button
              onClick={() => setShowOutline((v) => !v)}
              className={`px-2 py-0.5 text-[10px] border border-line rounded mr-1 ${showOutline ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
              title="Toggle document outline"
            >
              Outline
            </button>
          )}

          {/* Editor prefs — font zoom / wrap / minimap / theme (text files) */}
          {isTextFile && (
            <div className="flex items-center mr-2 rounded border border-line overflow-hidden">
              <button onClick={() => prefs.bumpFontSize(-1)} className="px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg" title="Zoom out">A−</button>
              <button onClick={() => prefs.bumpFontSize(1)} className="px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg" title="Zoom in">A+</button>
              <button onClick={prefs.toggleWordWrap} className={`px-1.5 py-0.5 text-[10px] ${prefs.wordWrap ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`} title="Word wrap">Wrap</button>
              <button onClick={prefs.toggleMinimap} className={`px-1.5 py-0.5 text-[10px] ${prefs.minimap ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`} title="Minimap">Map</button>
              <button onClick={() => prefs.setTheme(prefs.theme === 'dark' ? 'paper' : 'dark')} className="px-1.5 py-0.5 text-[10px] text-fg-faint hover:text-fg" title="Toggle editor theme">{prefs.theme === 'dark' ? 'Dark' : 'Paper'}</button>
              <button onClick={prefs.toggleAutosave} className={`px-1.5 py-0.5 text-[10px] ${prefs.autosave ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`} title="Autosave">Auto</button>
            </div>
          )}

          {/* View mode toggle (renderable types) */}
          {modes.length > 0 && (
            <div className="flex items-center mr-2 rounded border border-line overflow-hidden">
              {modes.map((m) => (
                <button
                  key={m}
                  onClick={() => setViewMode(path, m)}
                  className={`px-2 py-0.5 text-[10px] capitalize transition-colors ${
                    effMode === m ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          <button onClick={() => setFocusMode(true)} className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded mr-1" title="Focus mode (Cmd/Ctrl-Shift-F)">Focus</button>
          <button onClick={() => window.api.files.openExternal(path)} className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded mr-1" title="Open in default app">Open</button>
          <button onClick={() => window.api.files.showInFinder(path)} className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded" title="Reveal in OS">Reveal</button>
        </div>
      )}

      {focusMode && (
        <button onClick={() => setFocusMode(false)} className="absolute top-2 right-3 z-10 px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded bg-bg-elev/80" title="Exit focus mode (Esc)">Exit focus</button>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0">
        {!path ? null
          : isImage(path) ? (
            <ImagePane path={path} name={name} />
          ) : isPdf(path) ? (
            <PdfPane path={path} />
          ) : ls && typeof ls === 'object' && 'binary' in ls ? (
            <BinaryPane path={path} name={name} size={ls.size} mime={ls.mime} reason={ls.reason} />
          ) : ls && typeof ls === 'object' && 'error' in ls ? (
            <div className="p-6 text-xs text-red-400">{ls.error}</div>
          ) : ls !== 'ready' ? (
            <div className="p-6 text-xs text-fg-faint">loading…</div>
          ) : effMode === 'split' && isMarkdown(path) ? (
            <div className="flex h-full">
              {showOutline && <DocOutline text={buffers[path] ?? ''} scrollRef={previewScrollRef} />}
              <div className="flex-1 min-w-0 flex flex-col border-r border-line">
                <MarkdownToolbar getEditor={getEditor} />
                <div className="flex-1 min-h-0">{codePane}</div>
              </div>
              <div className="flex-1 min-w-0">
                <MarkdownPreview ref={previewScrollRef} text={buffers[path] ?? ''} flush />
              </div>
            </div>
          ) : effMode === 'preview' && isMarkdown(path) ? (
            <div className="flex h-full">
              {showOutline && <DocOutline text={buffers[path] ?? ''} scrollRef={previewScrollRef} />}
              <div className="flex-1 min-w-0">
                <MarkdownPreview ref={previewScrollRef} text={buffers[path] ?? ''} />
              </div>
            </div>
          ) : effMode === 'preview' && isHtml(path) ? (
            <HtmlPreview path={path} dirty={!!dirty[path]} reloadToken={reloadTokens[path] ?? 0} />
          ) : effMode === 'preview' && isTabular(path) ? (
            <TablePane path={path} text={buffers[path] ?? ''} />
          ) : isMarkdown(path) ? (
            <div className="flex flex-col h-full">
              <MarkdownToolbar getEditor={getEditor} />
              <div className="flex-1 min-h-0">{codePane}</div>
            </div>
          ) : (
            codePane
          )}
      </div>

      {showStatusBar && (
        <EditorStatusBar text={buffers[path] ?? ''} cursor={cursor} language={extOf(path) || undefined} />
      )}

      {confirmClose && (
        <CloseConfirm
          message={
            confirmClose.kind === 'one'
              ? `Discard unsaved changes to ${basename(confirmClose.path)}?`
              : confirmClose.kind === 'others'
              ? 'Discard unsaved changes in the other open files?'
              : 'Discard unsaved changes in all open files?'
          }
          onCancel={() => setConfirmClose(null)}
          onConfirm={doConfirmedClose}
        />
      )}
    </div>
  )
}

function CloseConfirm({ message, onCancel, onConfirm }: { message: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-96 rounded-lg border border-line bg-bg-elev p-4 shadow-2xl">
        <h3 className="text-sm font-medium text-fg mb-3">{message}</h3>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1 text-xs text-fg-dim hover:text-fg border border-line rounded">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-3 py-1 text-xs text-white rounded bg-red-600 hover:bg-red-500">
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}
