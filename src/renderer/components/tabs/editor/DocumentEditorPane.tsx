/**
 * DocumentEditorPane — the Editor scene's document view, extracted so screens
 * other than EditorView can render a file with the same chrome.
 *
 * EditorView owns a whole *scene*: an open-files tab strip, the editor store's
 * buffers, autosave, close guards. Everything below that — the Edit / Preview /
 * Split toggle, the markdown formatting toolbar, the document outline, the
 * word-count status bar, Monaco itself — is per-document and has no business
 * being duplicated by every screen that happens to edit a markdown file. That
 * duplication is exactly what System Prompt had: a bare `MarkdownEditor` Monaco
 * wrapper with no preview, no outline, no metrics, while the Editor tab three
 * clicks away rendered the same file properly.
 *
 * This component is the shared middle layer. It is **controlled**: the caller
 * owns the text and the save path (System Prompt keeps its buffer in the config
 * store's dirty-tracked FileState; EditorView keeps its own in the editor
 * store), so this pane never reads or writes a file itself. View mode / outline
 * visibility are local per-mount UI state, since they are a way of *looking* at
 * one document rather than anything persisted about it.
 *
 * Deliberately NOT included here: the Document Experience selection popover and
 * Assistant rail. Those hang off `useDocEdit`, which spawns a background claude
 * session against the file — a cost EditorView opts into explicitly and a
 * config-editing screen should not inherit implicitly.
 */

import { useCallback, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { isMarkdown, isRenderable, supportsSplit, defaultViewMode, extOf, type ViewMode } from '../../../state/editor'
import { useEditorPrefs } from '../../../state/editorPrefs'
import { CodeEditorPane } from './CodeEditorPane'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownToolbar } from './MarkdownToolbar'
import { DocOutline } from './DocOutline'
import { EditorStatusBar } from './EditorStatusBar'

interface CursorInfo { line: number; col: number; selected: number }

interface Props {
  /** Absolute path of the document — drives language, Monaco model identity, and the mode set. */
  path: string
  value: string
  onChange: (text: string) => void
  /** Cmd/Ctrl-S inside Monaco. Omit for a read-only pane. */
  onSave?: () => void
  /** Read-only documents open in Preview and cannot be edited. */
  readOnly?: boolean
  /** Initial view mode. Defaults to Preview for read-only docs, else the file type's own default. */
  defaultMode?: ViewMode
  /** Extra chrome for the pane's own header row, right-aligned before the mode toggle. */
  headerRight?: React.ReactNode
  /** Hide the word/char/cursor status strip (a host that already shows metrics). */
  hideStatusBar?: boolean
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

export function DocumentEditorPane({
  path,
  value,
  onChange,
  onSave,
  readOnly,
  defaultMode,
  headerRight,
  hideStatusBar,
}: Props) {
  const prefs = useEditorPrefs()
  const markdown = isMarkdown(path)
  const renderable = isRenderable(path)
  const canSplit = supportsSplit(path)

  // Read-only documents have no useful Edit mode, so they open rendered.
  const [mode, setMode] = useState<ViewMode>(() =>
    // A read-only doc has no Split/Wysiwyg half to be useful, so it opens
    // rendered regardless of what the host asked for.
    readOnly && renderable ? 'preview' : defaultMode ?? defaultViewMode(path),
  )
  const [showOutline, setShowOutline] = useState(true)
  const [cursor, setCursor] = useState<CursorInfo | null>(null)

  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const registerEditor = useCallback((ed: editor.IStandaloneCodeEditor | null) => { monacoRef.current = ed }, [])
  const getEditor = useCallback(() => monacoRef.current, [])

  // 'wysiwyg' is EditorView's Tiptap mode; it is a rich-text surface over the
  // same buffer and is left out here to keep this pane's bundle free of Tiptap.
  const modes: ViewMode[] = readOnly
    ? renderable ? ['preview', 'edit'] : []
    : canSplit ? ['edit', 'preview', 'split']
    : renderable ? ['edit', 'preview']
    : []
  const effMode: ViewMode = renderable ? mode : 'edit'

  const codePane = (
    <CodeEditorPane
      path={path}
      name={basename(path)}
      value={value}
      onChange={onChange}
      onSave={() => onSave?.()}
      onReady={registerEditor}
      onCursor={setCursor}
      readOnly={readOnly}
    />
  )

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="document-editor-pane">
      <div className="flex items-center gap-1 px-2 h-7 shrink-0 border-b border-line bg-bg-elev">
        <span className="text-[11px] font-medium text-fg truncate">{basename(path)}</span>
        {readOnly && (
          <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide text-fg-faint border border-line">
            read-only
          </span>
        )}
        <div className="flex-1" />
        {headerRight}
        {markdown && (effMode === 'preview' || effMode === 'split') && (
          <button
            onClick={() => setShowOutline((v) => !v)}
            data-testid="document-outline-toggle"
            className={`px-2 py-0.5 text-[10px] border border-line rounded ${showOutline ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
            title="Toggle document outline"
          >
            Outline
          </button>
        )}
        {modes.length > 0 && (
          <div className="flex items-center ml-1 rounded border border-line overflow-hidden" data-testid="document-mode-toggle">
            {modes.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 text-[10px] capitalize transition-colors ${
                  effMode === m ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {effMode === 'split' && markdown ? (
          <div className="flex h-full">
            {showOutline && <DocOutline text={value} scrollRef={previewScrollRef} />}
            <div className="flex-1 min-w-0 flex flex-col border-r border-line">
              {!readOnly && <MarkdownToolbar getEditor={getEditor} />}
              <div className="flex-1 min-h-0">{codePane}</div>
            </div>
            <div className="flex-1 min-w-0">
              <MarkdownPreview ref={previewScrollRef} text={value} flush wideMeasure={prefs.wideMeasure} />
            </div>
          </div>
        ) : effMode === 'preview' && markdown ? (
          <div className="flex h-full">
            {showOutline && <DocOutline text={value} scrollRef={previewScrollRef} />}
            <div className="flex-1 min-w-0">
              <MarkdownPreview ref={previewScrollRef} text={value} wideMeasure={prefs.wideMeasure} />
            </div>
          </div>
        ) : markdown ? (
          <div className="flex flex-col h-full">
            {!readOnly && <MarkdownToolbar getEditor={getEditor} />}
            <div className="flex-1 min-h-0">{codePane}</div>
          </div>
        ) : (
          codePane
        )}
      </div>

      {!hideStatusBar && (
        <EditorStatusBar text={value} cursor={cursor} language={extOf(path) || undefined} />
      )}
    </div>
  )
}
