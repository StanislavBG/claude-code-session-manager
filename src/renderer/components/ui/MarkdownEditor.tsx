import Editor from '@monaco-editor/react'

interface Props {
  value: string
  onChange: (v: string) => void
  path: string
  readOnly?: boolean
}

export function MarkdownEditor({ value, onChange, path, readOnly }: Props) {
  return (
    <Editor
      path={`file://${path}`}
      defaultLanguage="markdown"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      theme="vs-dark"
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
