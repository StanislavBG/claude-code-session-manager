/**
 * EditorView — the in-app Editor scene (main-space, NavKey 'editor').
 *
 * Launched from the Files sidebar and from terminal file links. Owns: the
 * open-files tab strip, per-file buffer loading, the Edit/Wysiwyg/Preview/Split
 * toggle, autosave, the document outline + status bar (Google-Docs chrome),
 * focus mode, scene-level Cmd/Ctrl-S, and the unsaved-changes close guard.
 * Panes are dumb renderers of the active file's buffer (held in the editor store).
 *
 * File dispatch: images → ImagePane, PDFs → PdfPane, binary/oversize → BinaryPane
 * (files.cjs flags these), CSV/TSV → TablePane, JSONL → JsonlPane (record CRUD),
 * markdown/html → preview, markdown Wysiwyg → TiptapBody (rich-text editing,
 * lazy-loaded), else Monaco. Wide-file support rides the smfile:// scheme +
 * binary sniff; the Docs feel rides marked + the .markdown-body page canvas.
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import {
  useEditor,
  isImage,
  isPdf,
  isMarkdown,
  isHtml,
  isTabular,
  isJsonl,
  isRenderable,
  supportsSplit,
  defaultViewMode,
  extOf,
  type ViewMode,
} from '../../state/editor'
import { useEditorPrefs } from '../../state/editorPrefs'
import { toast } from '../../state/toast'
import { usePanelFocusRef } from '../../lib/panelFocus'
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
import { JsonlPane } from './editor/JsonlPane'
import { BinaryPane } from './editor/BinaryPane'
import { useDocEdit } from './editor/useDocEdit'
import { SelectionPopover } from './editor/SelectionPopover'
import { AssistantRail } from './editor/AssistantRail'
import { DocumentMenu } from './editor/DocumentMenu'
import { DisplayPopover } from './editor/DisplayPopover'

// Lazy-loaded so Tiptap (~150 KB gz) is not bundled for users who never
// switch a markdown file into Wysiwyg mode.
const TiptapBody = lazy(() =>
  import('./editor/TiptapBody').then((m) => ({ default: m.TiptapBody }))
)

interface BinaryInfo { binary: true; size: number; mime: string; reason: string }
type LoadState = 'loading' | 'ready' | { error: string } | BinaryInfo
interface CursorInfo { line: number; col: number; selected: number }

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

function omitKeys<T>(obj: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.length) return obj
  const drop = new Set(keys)
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!drop.has(k)) out[k] = v
  }
  return out
}

/** A file whose bytes the renderer never reads as text (own pane handles it). */
function isMediaPath(p: string): boolean {
  return isImage(p) || isPdf(p)
}

export function EditorView() {
  const focusedRef = usePanelFocusRef()
  const openFiles = useEditor((s) => s.openFiles)
  const activeFilePath = useEditor((s) => s.activeFilePath)
  const dirty = useEditor((s) => s.dirty)
  const viewMode = useEditor((s) => s.viewMode)
  const buffers = useEditor((s) => s.buffers)
  const setActive = useEditor((s) => s.setActive)
  const closeFile = useEditor((s) => s.closeFile)
  const closeOthers = useEditor((s) => s.closeOthers)
  const closeToTheRight = useEditor((s) => s.closeToTheRight)
  const closeAll = useEditor((s) => s.closeAll)
  const loadBuffer = useEditor((s) => s.loadBuffer)
  const setBuffer = useEditor((s) => s.setBuffer)
  const markSaved = useEditor((s) => s.markSaved)
  const setViewMode = useEditor((s) => s.setViewMode)

  const prefs = useEditorPrefs()

  const [loadState, setLoadState] = useState<Record<string, LoadState>>({})
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({})
  const [confirmClose, setConfirmClose] = useState<{ kind: 'one' | 'others' | 'right' | 'all'; path: string } | null>(null)
  const [cursor, setCursor] = useState<CursorInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [showOutline, setShowOutline] = useState(true)

  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const previewWrapRef = useRef<HTMLDivElement>(null)
  const docEditPopoverRef = useRef<HTMLDivElement>(null)

  // Document Experience (PRD 639): select-to-rewrite over the markdown
  // preview. One hook instance per EditorView — keyed loosely to the active
  // path since only the active markdown file's preview can capture a
  // selection at a time.
  const docEdit = useDocEdit(activeFilePath ?? '', buffers[activeFilePath ?? ''] ?? '')

  const registerEditor = useCallback((ed: editor.IStandaloneCodeEditor | null) => { monacoRef.current = ed }, [])
  const getEditor = useCallback(() => monacoRef.current, [])

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

  // Drop per-file UI state (load status, HtmlPreview reload token) for closed
  // paths — otherwise these two maps grow for every file ever opened in the
  // session, since closeFile/closeOthers/closeToTheRight/closeAll only prune
  // the editor store's own buffers/dirty/viewMode.
  const pruneClosed = useCallback((paths: string[]) => {
    if (!paths.length) return
    setLoadState((s) => omitKeys(s, paths))
    setReloadTokens((t) => omitKeys(t, paths))
  }, [])

  // Document menu → Rename moves a file's per-path UI state (load status,
  // HtmlPreview reload token) to the new path, mirroring the editor store's
  // own renameOpenFile — otherwise the renamed path would re-enter 'loading'.
  const renameLoadState = useCallback((oldPath: string, newPath: string) => {
    setLoadState((s) => (oldPath in s ? { ...omitKeys(s, [oldPath]), [newPath]: s[oldPath] } : s))
    setReloadTokens((t) => (oldPath in t ? { ...omitKeys(t, [oldPath]), [newPath]: t[oldPath] } : t))
  }, [])

  // Close guards — confirm before discarding unsaved edits.
  const requestClose = useCallback((path: string) => {
    if (dirty[path]) setConfirmClose({ kind: 'one', path })
    else { closeFile(path); pruneClosed([path]) }
  }, [dirty, closeFile, pruneClosed])

  const requestCloseOthers = useCallback((path: string) => {
    const anyOtherDirty = openFiles.some((f) => f.path !== path && dirty[f.path])
    if (anyOtherDirty) setConfirmClose({ kind: 'others', path })
    else { closeOthers(path); pruneClosed(openFiles.filter((f) => f.path !== path).map((f) => f.path)) }
  }, [openFiles, dirty, closeOthers, pruneClosed])

  const requestCloseToTheRight = useCallback((path: string) => {
    const i = openFiles.findIndex((f) => f.path === path)
    const anyRightDirty = i !== -1 && openFiles.slice(i + 1).some((f) => dirty[f.path])
    if (anyRightDirty) setConfirmClose({ kind: 'right', path })
    else { closeToTheRight(path); pruneClosed(i !== -1 ? openFiles.slice(i + 1).map((f) => f.path) : []) }
  }, [openFiles, dirty, closeToTheRight, pruneClosed])

  // Scene-level Cmd/Ctrl-S + focus-mode toggle/exit + close-others shortcut.
  // Dockview can keep an EditorView panel mounted in the background (split
  // alongside another panel, or simply not the active tab), so these are
  // gated on `usePanelFocus` rather than relying on mount lifetime alone.
  // Ctrl/Cmd+Shift+W is not suppressed for Monaco focus (unlike App.tsx's
  // Cmd-K family) — it mirrors the existing Cmd/Ctrl-S handler above, which
  // also fires while typing, since tab-management shortcuts aren't typing
  // input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!focusedRef.current) return
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        const path = useEditor.getState().activeFilePath
        if (path && !isMediaPath(path)) {
          e.preventDefault()
          void save(path)
        }
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setFocusMode((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        const active = useEditor.getState().activeFilePath
        if (active && useEditor.getState().openFiles.length > 1) {
          e.preventDefault()
          requestCloseOthers(active)
        }
      } else if (e.key === 'Escape' && docEdit.state.phase !== 'idle') {
        docEdit.cancel()
      } else if (e.key === 'Escape' && focusMode) {
        setFocusMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, focusMode, requestCloseOthers, docEdit.state.phase, docEdit.cancel])

  // Clicking anywhere outside the preview pane or the popover itself cancels
  // the in-progress Document Experience flow — clicks *inside* the preview
  // are handled by MarkdownPreview's own mouseup (re-select or dismiss).
  useEffect(() => {
    if (docEdit.state.phase === 'idle') return
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (docEditPopoverRef.current?.contains(t)) return
      if (previewWrapRef.current?.contains(t)) return
      docEdit.cancel()
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [docEdit.state.phase, docEdit.cancel])

  // Switching the active file abandons any in-progress selection/edit for
  // the file being left.
  useEffect(() => { docEdit.cancel() }, [activeFilePath, docEdit.cancel])

  const requestCloseAll = useCallback(() => {
    const anyDirty = openFiles.some((f) => dirty[f.path])
    if (anyDirty) setConfirmClose({ kind: 'all', path: '' })
    else { closeAll(); setLoadState({}); setReloadTokens({}) }
  }, [openFiles, dirty, closeAll])

  const doConfirmedClose = () => {
    if (!confirmClose) return
    if (confirmClose.kind === 'one') {
      closeFile(confirmClose.path)
      pruneClosed([confirmClose.path])
    } else if (confirmClose.kind === 'others') {
      const closed = openFiles.filter((f) => f.path !== confirmClose.path).map((f) => f.path)
      closeOthers(confirmClose.path)
      pruneClosed(closed)
    } else if (confirmClose.kind === 'right') {
      const i = openFiles.findIndex((f) => f.path === confirmClose.path)
      const closed = i !== -1 ? openFiles.slice(i + 1).map((f) => f.path) : []
      closeToTheRight(confirmClose.path)
      pruneClosed(closed)
    } else {
      closeAll()
      setLoadState({})
      setReloadTokens({})
    }
    setConfirmClose(null)
  }

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-fg-faint text-xs">
        <div className="text-center">
          <div className="mb-2">no file open</div>
          <div>open the <span className="text-fg-dim">File Explorer</span> tab and click a file to edit it here</div>
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

  const modes: ViewMode[] = canSplit ? ['edit', 'wysiwyg', 'preview', 'split'] : renderable ? ['edit', 'preview'] : []

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
          onCloseToTheRight={requestCloseToTheRight}
          onCloseAll={requestCloseAll}
        />
      )}

      {/* Header: name + path, save indicator, view toggle, Document/Display menus, escape hatches */}
      {path && !focusMode && (
        <div className="flex items-center px-3 h-8 border-b border-line shrink-0 bg-bg-elev">
          <span className="text-xs font-medium text-fg truncate">{name}</span>
          <span className="ml-3 text-[10px] text-fg-faint truncate">{path}</span>
          {isTextFile && (
            <span className="ml-3 text-[10px] text-fg-faint shrink-0">· {savedLabel}</span>
          )}

          {/* Outline toggle (markdown preview/split only) */}
          {isMarkdown(path) && (effMode === 'preview' || effMode === 'split') && (
            <button
              onClick={() => setShowOutline((v) => !v)}
              className={`ml-3 px-2 py-0.5 text-[10px] border border-line rounded ${showOutline ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
              title="Toggle document outline"
            >
              Outline
            </button>
          )}

          {/* Assistant rail toggle (markdown preview/split only) */}
          {isMarkdown(path) && (effMode === 'preview' || effMode === 'split') && (
            <button
              onClick={prefs.toggleAssistantRail}
              className={`ml-1 px-2 py-0.5 text-[10px] border border-line rounded ${prefs.assistantRail ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
              title="Toggle Assistant rail"
            >
              Assistant
            </button>
          )}

          {/* View mode toggle (renderable types) */}
          {modes.length > 0 && (
            <div className="flex items-center ml-2 rounded border border-line overflow-hidden">
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

          <div className="flex-1" />

          <DocumentMenu path={path} onRenamed={renameLoadState} onDeleted={(p) => pruneClosed([p])} />
          {isTextFile && <DisplayPopover />}
          <button onClick={() => setFocusMode(true)} className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded" title="Focus mode (Cmd/Ctrl-Shift-F)">Focus</button>
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
          ) : effMode === 'wysiwyg' && isMarkdown(path) ? (
            <Suspense fallback={<div className="p-6 text-xs text-fg-faint">Loading editor…</div>}>
              <TiptapBody key={path} value={buffers[path] ?? ''} onChange={(text) => setBuffer(path, text)} />
            </Suspense>
          ) : effMode === 'split' && isMarkdown(path) ? (
            <div className="flex h-full">
              {showOutline && <DocOutline text={buffers[path] ?? ''} scrollRef={previewScrollRef} />}
              <div className="flex-1 min-w-0 flex flex-col border-r border-line">
                <MarkdownToolbar getEditor={getEditor} />
                <div className="flex-1 min-h-0">{codePane}</div>
              </div>
              <div ref={previewWrapRef} className="flex-1 min-w-0">
                <MarkdownPreview
                  ref={previewScrollRef}
                  text={buffers[path] ?? ''}
                  flush
                  wideMeasure={prefs.wideMeasure}
                  onSelect={docEdit.select}
                  onDismissSelection={docEdit.cancel}
                />
              </div>
              {!focusMode && prefs.assistantRail && (
                <AssistantRail
                  phase={docEdit.state.phase}
                  transcript={docEdit.state.transcript}
                  diff={docEdit.state.diff}
                  editCount={docEdit.state.editCount}
                  modelStatus={docEdit.state.modelStatus}
                  onListen={docEdit.listen}
                  onSendHeard={docEdit.sendHeard}
                  onCancel={docEdit.cancel}
                  onAccept={() => {
                    const result = docEdit.accept(buffers[path] ?? '')
                    if (result.ok) setBuffer(path, result.next)
                  }}
                  onReject={docEdit.cancel}
                  onRetry={docEdit.retry}
                />
              )}
            </div>
          ) : effMode === 'preview' && isMarkdown(path) ? (
            <div className="flex h-full">
              {showOutline && <DocOutline text={buffers[path] ?? ''} scrollRef={previewScrollRef} />}
              <div ref={previewWrapRef} className="flex-1 min-w-0">
                <MarkdownPreview
                  ref={previewScrollRef}
                  text={buffers[path] ?? ''}
                  wideMeasure={prefs.wideMeasure}
                  onSelect={docEdit.select}
                  onDismissSelection={docEdit.cancel}
                />
              </div>
              {!focusMode && prefs.assistantRail && (
                <AssistantRail
                  phase={docEdit.state.phase}
                  transcript={docEdit.state.transcript}
                  diff={docEdit.state.diff}
                  editCount={docEdit.state.editCount}
                  modelStatus={docEdit.state.modelStatus}
                  onListen={docEdit.listen}
                  onSendHeard={docEdit.sendHeard}
                  onCancel={docEdit.cancel}
                  onAccept={() => {
                    const result = docEdit.accept(buffers[path] ?? '')
                    if (result.ok) setBuffer(path, result.next)
                  }}
                  onReject={docEdit.cancel}
                  onRetry={docEdit.retry}
                />
              )}
            </div>
          ) : effMode === 'preview' && isHtml(path) ? (
            <HtmlPreview path={path} dirty={!!dirty[path]} reloadToken={reloadTokens[path] ?? 0} />
          ) : effMode === 'preview' && isTabular(path) ? (
            <TablePane path={path} text={buffers[path] ?? ''} />
          ) : effMode === 'preview' && isJsonl(path) ? (
            <JsonlPane path={path} text={buffers[path] ?? ''} />
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

      {path && isMarkdown(path) && (effMode === 'preview' || effMode === 'split') &&
        docEdit.state.phase !== 'idle' && docEdit.state.selection && (
        <div ref={docEditPopoverRef}>
          <SelectionPopover
            phase={docEdit.state.phase}
            rect={docEdit.state.selection.rect}
            diff={docEdit.state.diff}
            transcript={docEdit.state.transcript}
            modelStatus={docEdit.state.modelStatus}
            onQuickAction={docEdit.run}
            onRunCustom={docEdit.run}
            onListen={docEdit.listen}
            onSendHeard={docEdit.sendHeard}
            onCancel={docEdit.cancel}
            onReject={docEdit.cancel}
            onRetry={docEdit.retry}
            onAccept={() => {
              const result = docEdit.accept(buffers[path] ?? '')
              if (result.ok) setBuffer(path, result.next)
            }}
          />
        </div>
      )}

      {confirmClose && (
        <CloseConfirm
          message={
            confirmClose.kind === 'one'
              ? `Discard unsaved changes to ${basename(confirmClose.path)}?`
              : confirmClose.kind === 'others'
              ? 'Discard unsaved changes in the other open files?'
              : confirmClose.kind === 'right'
              ? 'Discard unsaved changes in the files to the right?'
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
