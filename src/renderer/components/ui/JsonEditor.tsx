import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { ensureMonaco } from '../../lib/monaco'

interface Props {
  value: string
  onChange: (v: string) => void
  /** Unique per-file path (used as the monaco model URI). */
  path: string
  /** Optional JSON-schema URI to associate with this file for validation. */
  schemaUri?: string
  readOnly?: boolean
}

/**
 * Monaco-backed JSON editor. Schema validation is configured globally via
 * `jsonDefaults.setDiagnosticsOptions` in `installMonacoSchemas()` — this
 * component just creates models with the right URIs so fileMatch globs kick in.
 */
export function JsonEditor({ value, onChange, path, readOnly }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const onMount: OnMount = (ed) => {
    editorRef.current = ed
  }

  return (
    <Editor
      path={`file://${path}`}
      defaultLanguage="json"
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
        formatOnPaste: true,
        readOnly,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        wordWrap: 'on',
      }}
    />
  )
}

/**
 * Register JSON schemas globally with Monaco. Call once at app startup
 * (after the editor bundle has loaded).
 */
export interface SchemaRegistration {
  /** URI identifier (any string, but conventionally the schema URL). */
  uri: string
  /** Glob patterns (monaco uses minimatch) matched against editor model URIs. */
  fileMatch: string[]
  /** The schema object, or null to fetch from `uri` at runtime. */
  schema?: unknown
}

let monacoLoaded = false

export async function installMonacoSchemas(regs: SchemaRegistration[]) {
  if (monacoLoaded) return
  const monaco = await ensureMonaco()
  const schemas = await Promise.all(
    regs.map(async (r) => {
      let schema = r.schema
      if (!schema) {
        const ALLOWED_ORIGINS = ['https://json.schemastore.org', 'https://www.schemastore.org', 'https://code.claude.com']
        try {
          const origin = new URL(r.uri).origin
          if (!ALLOWED_ORIGINS.includes(origin)) throw new Error('untrusted origin')
          const res = await fetch(r.uri)
          if (res.ok) schema = await res.json()
        } catch {
          /* offline or untrusted — validation becomes a no-op for this schema */
        }
      }
      return { uri: r.uri, fileMatch: r.fileMatch, schema }
    })
  )
  // monaco-editor 0.55+ marks languages.json as deprecated in its .d.ts but the
  // runtime export `jsonDefaults` is still the public API. Access via `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonDefaults = (monaco.languages as any).json.jsonDefaults
  jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: schemas.filter((s) => s.schema) as {
      uri: string
      fileMatch: string[]
      schema: object
    }[],
    enableSchemaRequest: true,
  })
  monacoLoaded = true
}
