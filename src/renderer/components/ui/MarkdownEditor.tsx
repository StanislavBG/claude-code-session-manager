import Editor from '@monaco-editor/react'
import { definePaperTheme, PAPER_THEME } from '../../lib/monacoPaperTheme'

interface Props {
  value: string
  onChange: (v: string) => void
  path: string
  readOnly?: boolean
  /** 'dark' (default) is Monaco's stock vs-dark. 'paper' is the app's light
   *  sm-paper theme, registered in beforeMount so it exists before Monaco
   *  first applies it. */
  theme?: 'dark' | 'paper'
}

export function MarkdownEditor({ value, onChange, path, readOnly, theme = 'dark' }: Props) {
  const paper = theme === 'paper'
  return (
    <Editor
      path={`file://${path}`}
      defaultLanguage="markdown"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      beforeMount={paper ? definePaperTheme : undefined}
      theme={paper ? PAPER_THEME : 'vs-dark'}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: 'on',
        readOnly,
        automaticLayout: true,
      }}
    />
  )
}
