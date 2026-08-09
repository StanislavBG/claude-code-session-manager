/**
 * CodeEditorPane — Monaco editor for one text file, controlled by EditorView.
 *
 * The buffer + save + dirty all live in the editor store / EditorView; this
 * component is a thin Monaco wrapper: language-by-extension, controlled value,
 * an in-editor Cmd/Ctrl-S binding that calls back to the scene save, and
 * terminal deep-link line reveal on mount. Only the active file's pane mounts,
 * so at most one Monaco instance is live.
 *
 * Preferences (font size, wrap, minimap, theme) come from useEditorPrefs and are
 * live-applied via ed.updateOptions — toggling never remounts the editor. The
 * mounted editor instance + cursor position are surfaced to EditorView (via
 * onReady / onCursor) so the markdown toolbar and status bar can drive it.
 */

import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useEditor, extOf } from '../../../state/editor'
import { useEditorPrefs } from '../../../state/editorPrefs'

interface Props {
  path: string
  name: string
  value: string
  onChange: (text: string) => void
  onSave: () => void
  /** Hand the live Monaco instance to the parent (markdown toolbar). null on unmount. */
  onReady?: (ed: editor.IStandaloneCodeEditor | null) => void
  /** Cursor position + selected-char count, for the status bar. */
  onCursor?: (info: { line: number; col: number; selected: number }) => void
  /** Render the buffer but refuse edits (a file the host screen only peeks at). */
  readOnly?: boolean
}

// Extension → Monaco language id. Anything unlisted falls back to plaintext.
const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', jsonl: 'json', ndjson: 'json', py: 'python', go: 'go',
  rs: 'rust', rb: 'ruby', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  java: 'java', sh: 'shell', bash: 'shell', zsh: 'shell', css: 'css',
  scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
  sql: 'sql', md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  graphql: 'graphql', dockerfile: 'dockerfile',
}
const PROSE = new Set(['md', 'mdx', 'markdown', 'txt', 'log'])

// Custom Monaco themes matching the app's paper-warm / dark palettes. Defined
// once on first mount (guarded) so toggling theme is just setTheme.
let themesDefined = false
function defineThemes(monaco: typeof import('monaco-editor')) {
  if (themesDefined) return
  themesDefined = true
  monaco.editor.defineTheme('sm-paper', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#f6efe1',
      'editor.foreground': '#2a221a',
      'editorLineNumber.foreground': '#b8a98a',
      'editorLineNumber.activeForeground': '#7a6a4f',
      'editor.lineHighlightBackground': '#efe6d3',
      'editor.selectionBackground': '#e0d3b8',
      'editorCursor.foreground': '#b85c34',
      'editorIndentGuide.background1': '#e6dcc4',
      'editor.findMatchHighlightBackground': '#e8d7a8',
    },
  })
  monaco.editor.defineTheme('sm-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1c1814',
      'editor.foreground': '#e8dcc6',
      'editorLineNumber.foreground': '#5b5040',
      'editor.lineHighlightBackground': '#262017',
      'editorCursor.foreground': '#d97a4a',
    },
  })
}

export function CodeEditorPane({ path, name, value, onChange, onSave, onReady, onCursor, readOnly }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const consumeReveal = useEditor((s) => s.consumeReveal)
  const fontSize = useEditorPrefs((s) => s.fontSize)
  const wordWrap = useEditorPrefs((s) => s.wordWrap)
  const minimap = useEditorPrefs((s) => s.minimap)
  const theme = useEditorPrefs((s) => s.theme)
  const isProse = PROSE.has(extOf(name))

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed
    monacoRef.current = monaco
    defineThemes(monaco)
    monaco.editor.setTheme(theme === 'dark' ? 'sm-dark' : 'sm-paper')
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current())
    onReady?.(ed)
    const emit = () => {
      const pos = ed.getPosition()
      const sel = ed.getSelection()
      const model = ed.getModel()
      const selected = sel && model ? model.getValueLengthInRange(sel) : 0
      if (pos) onCursor?.({ line: pos.lineNumber, col: pos.column, selected })
    }
    ed.onDidChangeCursorPosition(emit)
    ed.onDidChangeCursorSelection(emit)
    emit()
    revealPending(ed)
  }

  const revealPending = (ed: editor.IStandaloneCodeEditor) => {
    const reveal = consumeReveal(path)
    if (reveal?.line) {
      ed.revealLineInCenter(reveal.line)
      ed.setPosition({ lineNumber: reveal.line, column: reveal.col ?? 1 })
      ed.focus()
    }
  }

  // A deep-link that arrives while the pane is already mounted (re-open of the
  // active file with a new line) still reveals.
  useEffect(() => {
    if (editorRef.current) revealPending(editorRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // Live-apply theme changes without remount.
  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme === 'dark' ? 'sm-dark' : 'sm-paper')
  }, [theme])

  // Release the editor ref to the parent on unmount.
  useEffect(() => () => { onReady?.(null) }, [onReady])

  return (
    <Editor
      path={`file://${path}`}
      language={LANG[extOf(name)] || 'plaintext'}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      theme={theme === 'dark' ? 'sm-dark' : 'sm-paper'}
      options={{
        readOnly: !!readOnly,
        minimap: { enabled: minimap },
        fontSize: isProse ? fontSize + 2 : fontSize,
        fontFamily: isProse
          ? 'Newsreader, Georgia, serif'
          : '"IBM Plex Mono", JetBrains Mono, ui-monospace, Menlo, monospace',
        lineNumbers: isProse ? 'off' : 'on',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        tabSize: 2,
        detectIndentation: true,
        stickyScroll: { enabled: true },
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        padding: isProse ? { top: 16, bottom: 16 } : undefined,
        lineHeight: isProse ? 26 : undefined,
        wordWrap: isProse || wordWrap ? 'on' : 'off',
      }}
    />
  )
}
