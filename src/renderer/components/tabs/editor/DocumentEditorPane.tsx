/**
 * DocumentEditorPane — the one document editor every markdown file opens in
 * (CLAUDE.md, SKILL.md, agent prompts, memory). DESIGN_SPEC §3 (claude-config).
 *
 * Chrome:
 *   - Title bar: file icon, mono file name, save-state dot (sage saved / honey
 *     dirty / accent new), full path when full screen, `Outline` toggle,
 *     `Document | Markdown` segmented switch, `Full screen` (full screen shows
 *     `← Exit full screen  Esc`; Escape exits).
 *   - Body: ONE mode at a time, never side by side. Document = WYSIWYG
 *     (TiptapBody) — or the rendered preview for a read-only file, which Tiptap
 *     cannot lock; Markdown = raw source (Monaco) under the markdown toolbar.
 *   - Status bar: save state, words · ~tokens, position, Revert, Save Ctrl S.
 *
 * It is **controlled**: the caller owns the text, the dirty flag and the save /
 * revert paths, so this pane never reads or writes a file itself. Mode, outline
 * visibility and full screen are local per-mount UI state — ways of *looking*
 * at one document, not anything persisted about it. The save-state chrome is
 * opt-in: a host that passes neither `dirty` nor `isNew` keeps its own save bar.
 *
 * Deliberately NOT included here: the Document Experience selection popover and
 * Assistant rail. Those hang off `useDocEdit`, which spawns a background claude
 * session against the file — a cost EditorView opts into explicitly and a
 * config-editing screen should not inherit implicitly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { isMarkdown, extOf, type ViewMode } from '../../../state/editor'
import { useEditorPrefs } from '../../../state/editorPrefs'
import { Z } from '../../../lib/zLayers'
import { CodeEditorPane } from './CodeEditorPane'
import { MarkdownPreview, type Heading } from './MarkdownPreview'
import { MarkdownToolbar } from './MarkdownToolbar'
import { TiptapBody } from './TiptapBody'
import { DocOutline } from './DocOutline'
import { EditorStatusBar, SaveDot, type SaveState } from './EditorStatusBar'
import { basename } from '../../../lib/basename'
import { changedLines, changedBlocks } from './changedLines'

interface CursorInfo { line: number; col: number; selected: number }

/** The two ways of looking at a markdown document. */
export type DocMode = 'document' | 'markdown'

const MODES: { key: DocMode; label: string }[] = [
  { key: 'document', label: 'Document' },
  { key: 'markdown', label: 'Markdown' },
]

/** Legacy ViewMode values from older hosts map onto the two-mode switch. */
function toDocMode(m: ViewMode | DocMode | undefined): DocMode {
  return m === 'edit' || m === 'markdown' ? 'markdown' : 'document'
}

/** 1-based source line of the `index`-th ATX heading, skipping fenced code. */
function headingLine(src: string, index: number): number | null {
  const lines = src.split('\n')
  let fence: string | null = null
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (fm) {
      if (fence === null) fence = fm[1][0]
      else if (fm[1][0] === fence) fence = null
      continue
    }
    if (fence === null && /^\s{0,3}#{1,6}(\s|$)/.test(lines[i])) {
      if (n === index) return i + 1
      n++
    }
  }
  return null
}

interface Props {
  /** Absolute path of the document — drives language, Monaco model identity, and whether modes apply. */
  path: string
  value: string
  onChange: (text: string) => void
  /** Ctrl/Cmd-S and the status bar's Save. Omit for a read-only pane. */
  onSave?: () => void
  /** Status bar Revert. */
  onRevert?: () => void
  /** Buffer differs from disk. Passing it (or `isNew`) turns on the save-state chrome. */
  dirty?: boolean
  /** The file does not exist on disk yet — created on first save. */
  isNew?: boolean
  /** Read-only documents render (Document) or show locked source (Markdown). */
  readOnly?: boolean
  /** Initial mode. Legacy `edit` → Markdown; every other value → Document (the default). */
  defaultMode?: ViewMode | DocMode
  /** Extra chrome for the title bar, right-aligned before the Outline toggle. */
  headerRight?: React.ReactNode
  /** Hide the status strip (a host that already shows metrics). */
  hideStatusBar?: boolean
  /**
   * Baseline text to show changes against (e.g. the file before Claude edited
   * it). Markdown mode marks changed lines with a honey left rule; Document
   * mode highlights the changed blocks. Omit for no marks.
   */
  changedFrom?: string
}

export function DocumentEditorPane({
  path,
  value,
  onChange,
  onSave,
  onRevert,
  dirty,
  isNew,
  readOnly,
  defaultMode,
  headerRight,
  hideStatusBar,
  changedFrom,
}: Props) {
  const prefs = useEditorPrefs()
  const markdown = isMarkdown(path)

  const [mode, setMode] = useState<DocMode>(() => toDocMode(defaultMode))
  const [showOutline, setShowOutline] = useState(true)
  const [fullScreen, setFullScreen] = useState(false)
  const [cursor, setCursor] = useState<CursorInfo | null>(null)

  const markedLines = useMemo(
    () => (changedFrom === undefined ? undefined : changedLines(changedFrom, value)),
    [changedFrom, value],
  )
  const markedBlocks = useMemo(
    () => (changedFrom === undefined ? undefined : changedBlocks(changedFrom, value)),
    [changedFrom, value],
  )

  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const docScrollRef = useRef<HTMLDivElement>(null)
  const registerEditor = useCallback((ed: editor.IStandaloneCodeEditor | null) => { monacoRef.current = ed }, [])
  const getEditor = useCallback(() => monacoRef.current, [])

  // Escape leaves full screen. Window-level so it works whichever surface has focus.
  useEffect(() => {
    if (!fullScreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullScreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullScreen])

  // Non-markdown files have no Document view: always the source editor.
  const effMode: DocMode = markdown ? mode : 'markdown'
  const saveState: SaveState | undefined =
    dirty === undefined && !isNew ? undefined : dirty ? 'dirty' : isNew ? 'new' : 'saved'

  // Monaco binds its own Ctrl-S; the Document view needs one at the pane root.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (effMode !== 'document' || readOnly || !onSave) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave()
    }
  }

  // In Markdown mode the outline reveals the heading's source line in Monaco.
  const jumpToSource = useCallback((_h: Heading, index: number) => {
    const ed = monacoRef.current
    const line = headingLine(ed?.getModel()?.getValue() ?? value, index)
    if (!ed || line === null) return
    ed.revealLineNearTop(line)
    ed.setPosition({ lineNumber: line, column: 1 })
    ed.focus()
  }, [value])

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
      markedLines={markedLines}
    />
  )

  const body =
    effMode === 'document' ? (
      readOnly ? (
        <MarkdownPreview ref={docScrollRef} text={value} wideMeasure={prefs.wideMeasure} />
      ) : (
        <div ref={docScrollRef} className="h-full min-h-0">
          <TiptapBody value={value} onChange={onChange} markedBlocks={markedBlocks} />
        </div>
      )
    ) : markdown ? (
      <div className="flex flex-col h-full">
        {!readOnly && <MarkdownToolbar getEditor={getEditor} />}
        <div className="flex-1 min-h-0">{codePane}</div>
      </div>
    ) : (
      codePane
    )

  return (
    <div
      className={
        fullScreen
          ? `fixed inset-0 ${Z.dialog} flex flex-col min-h-0 bg-bg`
          : 'flex flex-col h-full min-h-0'
      }
      data-testid="document-editor-pane"
      data-mode={effMode}
      data-fullscreen={fullScreen ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-2 h-9 shrink-0 border-b border-line bg-bg-elev">
        {fullScreen && (
          <button
            type="button"
            onClick={() => setFullScreen(false)}
            data-testid="document-exit-fullscreen"
            className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium text-fg border border-line rounded hover:bg-bg-hi"
            title="Exit full screen (Esc)"
          >
            ← Exit full screen
            <span className="font-mono text-[9px] text-fg-faint">Esc</span>
          </button>
        )}
        <svg aria-hidden viewBox="0 0 16 16" className="w-3.5 h-3.5 shrink-0 text-fg-faint" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M4 1.5h5.5L13 5v9.5H4z" />
          <path d="M9.5 1.5V5H13" />
        </svg>
        <span className="text-[12px] font-mono font-medium text-fg truncate" data-testid="document-title">
          {basename(path)}
        </span>
        {saveState && <SaveDot state={saveState} />}
        {fullScreen && (
          <span className="text-[10px] font-mono text-fg-faint truncate min-w-0" title={path}>{path}</span>
        )}
        {readOnly && (
          <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide text-fg-faint border border-line">
            read-only
          </span>
        )}
        <div className="flex-1" />
        {headerRight}
        {markdown && (
          <button
            type="button"
            onClick={() => setShowOutline((v) => !v)}
            data-testid="document-outline-toggle"
            aria-pressed={showOutline}
            className={`px-2 py-0.5 text-[11px] rounded ${showOutline ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
            title="Toggle document outline"
          >
            ☰ Outline
          </button>
        )}
        {markdown && (
          <div
            role="group"
            aria-label="Editor mode"
            className="flex items-center p-0.5 rounded bg-bg-hi"
            data-testid="document-mode-toggle"
          >
            {MODES.map((m) => (
              <button
                type="button"
                key={m.key}
                onClick={() => setMode(m.key)}
                aria-pressed={effMode === m.key}
                className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${
                  effMode === m.key ? 'bg-bg text-fg font-medium shadow-sm' : 'text-fg-dim hover:text-fg'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        {!fullScreen && (
          <button
            type="button"
            onClick={() => setFullScreen(true)}
            data-testid="document-fullscreen"
            className="px-2 py-0.5 text-[11px] text-fg-dim border border-line rounded hover:text-fg hover:bg-bg-hi"
            title="Full screen"
          >
            ⤢ Full screen
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {markdown ? (
          <div className="flex h-full overflow-clip">
            {showOutline && (
              <DocOutline
                text={value}
                scrollRef={docScrollRef}
                onJump={effMode === 'markdown' ? jumpToSource : undefined}
                showStats
              />
            )}
            <div className="flex-1 min-w-0">{body}</div>
          </div>
        ) : (
          body
        )}
      </div>

      {!hideStatusBar && (
        <EditorStatusBar
          text={value}
          cursor={effMode === 'markdown' ? cursor : null}
          language={markdown ? 'Markdown' : extOf(path) || undefined}
          positionLabel={effMode === 'document' ? 'Document · saved as Markdown' : undefined}
          saveState={saveState}
          dirty={!!dirty}
          isNew={isNew}
          onSave={readOnly ? undefined : onSave}
          onRevert={readOnly ? undefined : onRevert}
        />
      )}
    </div>
  )
}
