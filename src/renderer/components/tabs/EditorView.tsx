/**
 * EditorView — the in-app Editor scene (main-space, NavKey 'editor').
 *
 * Launched from the Files sidebar and from terminal file links. Owns: the
 * open-files tab strip, per-file buffer loading, the Edit↔Preview toggle, the
 * scene-level Cmd/Ctrl-S, and the unsaved-changes close guard. Panes are dumb
 * renderers of the active file's buffer (held in the editor store).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useEditor,
  isImage,
  isMarkdown,
  isHtml,
  isRenderable,
  defaultViewMode,
  type ViewMode,
} from '../../state/editor'
import { toast } from '../../state/toast'
import { FileTabBar } from '../layout/FileTabBar'
import { CodeEditorPane } from './editor/CodeEditorPane'
import { MarkdownPreview } from './editor/MarkdownPreview'
import { HtmlPreview } from './editor/HtmlPreview'
import { ImagePane } from './editor/ImagePane'

type LoadState = 'loading' | 'ready' | { error: string }

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
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

  const [loadState, setLoadState] = useState<Record<string, LoadState>>({})
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({})
  const [confirmClose, setConfirmClose] = useState<{ kind: 'one' | 'others' | 'all'; path: string } | null>(null)

  // Lazily read the active file into the buffer store (text files only; images
  // are read by ImagePane). Depends ONLY on the active path: depending on
  // buffers/loadState would re-run this effect when it sets 'loading', whose
  // cleanup would cancel its own in-flight read. Each file loads once; switching
  // tabs is instant (already-buffered files short-circuit to 'ready').
  useEffect(() => {
    const path = activeFilePath
    if (!path || isImage(path)) return
    if (useEditor.getState().hasBuffer(path)) {
      setLoadState((s) => (s[path] === 'ready' ? s : { ...s, [path]: 'ready' }))
      return
    }
    let cancelled = false
    setLoadState((s) => ({ ...s, [path]: 'loading' }))
    window.api.files.read(path).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setLoadState((s) => ({ ...s, [path]: { error: r.error ?? 'failed to read' } }))
      } else {
        loadBuffer(path, r.text)
        setLoadState((s) => ({ ...s, [path]: 'ready' }))
      }
    })
    return () => { cancelled = true }
  }, [activeFilePath, loadBuffer])

  const save = useCallback(async (path: string) => {
    const text = useEditor.getState().buffers[path]
    if (text == null) return
    const r = await window.api.files.write(path, text)
    if (r.ok) {
      markSaved(path)
      setReloadTokens((t) => ({ ...t, [path]: (t[path] ?? 0) + 1 }))
      toast.info(`Saved ${basename(path)}`)
    } else {
      toast.error(r.error ?? `Couldn't save ${basename(path)}`)
    }
  }, [markSaved])

  // Scene-level Cmd/Ctrl-S. EditorView only mounts while the editor scene is
  // active, so this listener is naturally scoped to it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        const path = useEditor.getState().activeFilePath
        if (path && !isImage(path)) {
          e.preventDefault()
          void save(path)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

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
  const effMode: ViewMode = path && renderable ? (viewMode[path] ?? defaultViewMode(path)) : 'edit'

  return (
    <div className="flex flex-col h-full bg-bg">
      <FileTabBar
        openFiles={openFiles}
        activeFilePath={activeFilePath}
        dirty={dirty}
        onSelectFile={setActive}
        onCloseFile={requestClose}
        onCloseOthers={requestCloseOthers}
        onCloseAll={requestCloseAll}
      />

      {/* Header: name + path, Edit/Preview toggle (renderable only), escape hatches */}
      {path && (
        <div className="flex items-center px-3 h-8 border-b border-line shrink-0 bg-bg-elev">
          <span className="text-xs font-medium text-fg truncate">{name}</span>
          <span className="ml-3 text-[10px] text-fg-faint truncate">{path}</span>
          <div className="flex-1" />
          {renderable && (
            <div className="flex items-center mr-2 rounded border border-line overflow-hidden">
              {(['edit', 'preview'] as ViewMode[]).map((m) => (
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
          <button
            onClick={() => window.api.files.openExternal(path)}
            className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded mr-1"
            title="Open in default app"
          >
            Open
          </button>
          <button
            onClick={() => window.api.files.showInFinder(path)}
            className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded"
            title="Reveal in OS"
          >
            Reveal
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0">
        {!path ? null
          : isImage(path) ? (
            <ImagePane path={path} name={name} />
          ) : ls && typeof ls === 'object' ? (
            <div className="p-6 text-xs text-red-400">{ls.error}</div>
          ) : ls !== 'ready' ? (
            <div className="p-6 text-xs text-fg-faint">loading…</div>
          ) : effMode === 'preview' && isMarkdown(path) ? (
            <MarkdownPreview text={buffers[path] ?? ''} />
          ) : effMode === 'preview' && isHtml(path) ? (
            <HtmlPreview path={path} dirty={!!dirty[path]} reloadToken={reloadTokens[path] ?? 0} />
          ) : (
            <CodeEditorPane
              path={path}
              name={name}
              value={buffers[path] ?? ''}
              onChange={(text) => setBuffer(path, text)}
              onSave={() => void save(path)}
            />
          )}
      </div>

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
