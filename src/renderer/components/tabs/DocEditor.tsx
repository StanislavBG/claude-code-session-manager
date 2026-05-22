import { Suspense, lazy, useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { EmptyState } from '../ui/EmptyState'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { useDocEditor, type DocBuffer } from '../../state/docEditor'
import { getLanguageForPath } from '../../lib/docEditorLanguage'

// Lazy-loaded so Tiptap (~150 KB gz) is not bundled for users who never open
// a .md file in WYSIWYG mode.
const TiptapBody = lazy(() =>
  import('../doc-editor/TiptapBody').then((m) => ({ default: m.TiptapBody }))
)

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

function isMarkdown(p: string): boolean {
  return p.endsWith('.md') || p.endsWith('.markdown')
}

function DocTabStrip({
  docs,
  activePath,
  onSetActive,
  onClose,
}: {
  docs: Record<string, DocBuffer>
  activePath: string | null
  onSetActive: (p: string) => void
  onClose: (p: string) => void
}) {
  const paths = Object.keys(docs)
  return (
    <div
      className="h-9 bg-bg-elev border-b border-line flex items-center overflow-x-auto shrink-0 px-2 gap-1"
      data-testid="doc-tab-strip"
    >
      {paths.map((p) => {
        const doc = docs[p]
        const isDirty = doc.bufferText !== doc.diskText
        const name = basename(p)
        const active = p === activePath
        return (
          <div
            key={p}
            className={`group px-3 py-1 flex items-center gap-1 rounded-t text-xs shrink-0 cursor-pointer transition-colors ${
              active
                ? 'bg-bg-hi text-fg font-semibold border border-b-0 border-accent border-t-2 -mb-px relative z-10'
                : 'bg-bg-elev text-fg-dim border border-line hover:text-fg hover:bg-bg'
            }`}
            onClick={() => onSetActive(p)}
            title={p}
            data-testid={`doc-tab-${name}`}
          >
            {isDirty && (
              <span className="text-amber-400" aria-label="unsaved changes" data-testid="doc-tab-dirty">
                ●
              </span>
            )}
            <span>{name}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(p) }}
              className="text-fg-faint opacity-0 group-hover:opacity-100 hover:text-fg ml-1"
              title={`Close ${name}`}
              aria-label={`Close ${name}`}
              data-testid={`doc-x-${name}`}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

function MonacoBody({ path, value, onChange, language }: {
  path: string; value: string; onChange: (v: string) => void; language: string
}) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  const onMount: OnMount = async (ed) => {
    editorRef.current = ed
    const monaco = await import('monaco-editor')
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      useDocEditor.getState().save(pathRef.current)
    })
  }

  return (
    <Editor
      path={`file://${path}`}
      language={language}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 12,
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        tabSize: 2,
        formatOnPaste: true,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        wordWrap: 'on',
      }}
    />
  )
}

function DocEditorBody({ path, value, onChange }: {
  path: string; value: string; onChange: (v: string) => void
}) {
  const lang = getLanguageForPath(path)
  if (!lang) {
    const base = path.split('/').pop() ?? path
    return (
      <textarea
        key={path}
        className="w-full h-full resize-none bg-bg text-fg font-mono text-sm p-3 focus:outline-none leading-relaxed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        data-testid="doc-textarea"
        aria-label={`Edit ${base}`}
      />
    )
  }
  return <MonacoBody path={path} value={value} onChange={onChange} language={lang} />
}

export function DocEditor() {
  const docs = useDocEditor((s) => s.docs)
  const activePath = useDocEditor((s) => s.activePath)
  const viewModes = useDocEditor((s) => s.viewModes)
  const open = useDocEditor((s) => s.open)
  const close = useDocEditor((s) => s.close)
  const setActive = useDocEditor((s) => s.setActive)
  const edit = useDocEditor((s) => s.edit)
  const save = useDocEditor((s) => s.save)
  const saveAll = useDocEditor((s) => s.saveAll)
  const setViewMode = useDocEditor((s) => s.setViewMode)
  const hydrate = useDocEditor((s) => s.hydrate)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const activeDoc = activePath ? docs[activePath] ?? null : null
  const anyDirty = Object.values(docs).some((d) => d.bufferText !== d.diskText)

  const viewMode = activePath ? (viewModes[activePath] ?? 'wysiwyg') : 'wysiwyg'
  const mdFile = activePath ? isMarkdown(activePath) : false

  const handleOpenFile = async () => {
    const lastDir = activePath ? activePath.split('/').slice(0, -1).join('/') : undefined
    const result = await window.api.docEditor.pickFile(lastDir ? { lastDir } : undefined)
    if (result.path) await open(result.path)
  }

  if (activePath === null) {
    return (
      <EmptyState
        title="No document open"
        hint={
          <span>
            Click <strong>Open…</strong> or use{' '}
            <kbd className="px-1 py-0.5 border border-line rounded font-mono text-[10px]">Cmd-K</kbd>{' '}
            and type <code>doc:open</code>
          </span>
        }
      />
    )
  }

  return (
    <div
      className="h-full flex flex-col"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
          e.preventDefault()
          if (activePath) save(activePath)
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && !e.shiftKey) {
          e.preventDefault()
          if (activePath) close(activePath)
        }
      }}
      data-testid="doc-editor-panel"
    >
      <DocTabStrip
        docs={docs}
        activePath={activePath}
        onSetActive={setActive}
        onClose={close}
      />

      {/* Toolbar */}
      <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={handleOpenFile}
          className="px-2 py-1 border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi transition-colors"
          data-testid="doc-open-btn"
        >
          Open…
        </button>
        <button
          type="button"
          onClick={() => activePath && save(activePath)}
          disabled={!activeDoc || activeDoc.bufferText === activeDoc.diskText}
          className="px-2 py-1 border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="doc-save-btn"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => saveAll()}
          disabled={!anyDirty}
          className="px-2 py-1 border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="doc-save-all-btn"
        >
          Save All
        </button>

        {/* Mode toggle — only for .md / .markdown files */}
        {mdFile && activePath && (
          <div
            className="flex items-center border border-line rounded overflow-hidden text-[11px]"
            data-testid="view-mode-toggle"
          >
            <button
              type="button"
              onClick={() => setViewMode(activePath, 'wysiwyg')}
              className={`px-2 py-0.5 transition-colors ${
                viewMode === 'wysiwyg'
                  ? 'bg-accent text-bg font-semibold'
                  : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
              }`}
              data-testid="view-mode-wysiwyg"
            >
              WYSIWYG
            </button>
            <button
              type="button"
              onClick={() => setViewMode(activePath, 'source')}
              className={`px-2 py-0.5 transition-colors ${
                viewMode === 'source'
                  ? 'bg-accent text-bg font-semibold'
                  : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
              }`}
              data-testid="view-mode-source"
            >
              Source
            </button>
          </div>
        )}

        {activePath && (
          <span className="ml-2 text-fg-faint truncate flex-1 font-mono text-[11px]" title={activePath}>
            {activePath}
          </span>
        )}
      </div>

      {/* Editor area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {mdFile && viewMode === 'wysiwyg' && activePath && activeDoc ? (
          <Suspense fallback={<div className="p-4 text-fg-faint text-sm">Loading editor…</div>}>
            {/* Keyed by path so switching paths remounts with fresh content */}
            <TiptapBody
              key={activePath}
              value={activeDoc.bufferText}
              onChange={(v) => edit(activePath, v)}
            />
          </Suspense>
        ) : mdFile && activePath && activeDoc ? (
          <MarkdownEditor
            key={activePath}
            path={activePath}
            value={activeDoc.bufferText}
            onChange={(v) => edit(activePath, v)}
          />
        ) : activePath && activeDoc ? (
          <DocEditorBody
            path={activePath}
            value={activeDoc.bufferText}
            onChange={(v) => edit(activePath, v)}
          />
        ) : null}
      </div>
    </div>
  )
}
