/**
 * CodeEditorPane — Monaco editor for one text file, controlled by EditorView.
 *
 * The buffer + save + dirty all live in the editor store / EditorView; this
 * component is a thin Monaco wrapper: language-by-extension, controlled value,
 * an in-editor Cmd/Ctrl-S binding that calls back to the scene save, and
 * terminal deep-link line reveal on mount. Only the active file's pane mounts,
 * so at most one Monaco instance is live.
 */

import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useEditor } from '../../../state/editor'

interface Props {
  path: string
  name: string
  value: string
  onChange: (text: string) => void
  onSave: () => void
}

// Extension → Monaco language id. Anything unlisted falls back to plaintext.
const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', py: 'python', go: 'go',
  rs: 'rust', rb: 'ruby', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  java: 'java', sh: 'shell', bash: 'shell', zsh: 'shell', css: 'css',
  scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
  sql: 'sql', md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  graphql: 'graphql', dockerfile: 'dockerfile',
}
const PROSE = new Set(['md', 'mdx', 'markdown', 'txt', 'log'])

function extOf(name: string): string {
  return name.toLowerCase().split('.').pop() || ''
}

export function CodeEditorPane({ path, name, value, onChange, onSave }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const consumeReveal = useEditor((s) => s.consumeReveal)

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current())
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

  return (
    <Editor
      path={`file://${path}`}
      language={LANG[extOf(name)] || 'plaintext'}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      theme="vs"
      options={{
        minimap: { enabled: false },
        fontSize: 12,
        fontFamily: '"IBM Plex Mono", JetBrains Mono, ui-monospace, Menlo, monospace',
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        tabSize: 2,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        wordWrap: PROSE.has(extOf(name)) ? 'on' : 'off',
      }}
    />
  )
}
