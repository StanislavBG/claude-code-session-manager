import { useEffect, useState } from 'react'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { toast } from '../../state/toast'
import type { ImportRef } from '../../../preload/api'

interface Props {
  /** The CLAUDE.md-like file whose `@`-imports this panel lists; null = nothing to show. */
  activePath: string | null
}

interface ExpandedFile {
  loading: boolean
  text: string | null
  error: string | null
}

function basename(path: string): string {
  return path.split('/').pop() || path
}

/**
 * Lists the flattened `@path` import chain of `activePath` (via PRD 800's
 * config:parse-imports IPC) above the CLAUDE.md editor, and lets any entry be
 * expanded inline to a read-only peek at that file's content. Renders nothing
 * when there are zero imports, so unaffected files look exactly as before.
 */
export function ReferencedFilesPanel({ activePath }: Props) {
  const [imports, setImports] = useState<ImportRef[]>([])
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [expandedFiles, setExpandedFiles] = useState<Record<string, ExpandedFile>>({})

  useEffect(() => {
    setExpandedPath(null)
    setExpandedFiles({})
    if (!activePath) {
      setImports([])
      return
    }
    let cancelled = false
    window.api.config.parseImports(activePath).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setImports(res.imports)
      } else {
        setImports([])
        toast.error(res.error || 'failed to parse @-imports')
      }
    })
    return () => {
      cancelled = true
    }
  }, [activePath])

  if (imports.length === 0) return null

  function toggle(path: string) {
    if (expandedPath === path) {
      setExpandedPath(null)
      return
    }
    setExpandedPath(path)
    if (!expandedFiles[path]) {
      setExpandedFiles((prev) => ({ ...prev, [path]: { loading: true, text: null, error: null } }))
      window.api.config.readText(path).then((res) => {
        setExpandedFiles((prev) => ({
          ...prev,
          [path]: { loading: false, text: res.text, error: res.error },
        }))
      })
    }
  }

  return (
    <div className="shrink-0 border-b border-line bg-bg-elev text-xs max-h-64 overflow-auto">
      {imports.map((ref) => {
        const broken = !ref.ok || !ref.exists
        const expanded = expandedPath === ref.path
        const state = expandedFiles[ref.path]
        return (
          <div key={ref.path} className="border-b border-line last:border-b-0" data-testid="referenced-file-row">
            <button
              type="button"
              onClick={() => toggle(ref.path)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-bg"
            >
              <span className={`shrink-0 text-fg-faint transition-transform ${expanded ? 'rotate-90' : ''}`}>
                ›
              </span>
              <span className="shrink-0 font-medium">{basename(ref.path)}</span>
              <span className="text-fg-faint truncate flex-1" title={ref.path}>
                {ref.path}
              </span>
              <span className="text-fg-faint shrink-0">
                {ref.sizeBytes.toLocaleString()} bytes · ~{ref.tokenEstimate.toLocaleString()} tokens
              </span>
              {broken ? (
                <span
                  className="shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide text-amber-400/90 border border-amber-400/30"
                  data-testid="referenced-file-missing"
                >
                  missing
                </span>
              ) : null}
            </button>
            {expanded ? (
              <div className="h-64 border-t border-line">
                {!state || state.loading ? (
                  <div className="px-3 py-2 text-fg-faint">loading…</div>
                ) : (
                  <MarkdownEditor path={ref.path} value={state.text ?? ''} onChange={() => {}} readOnly />
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
