import { useEffect, useRef, useState } from 'react'
import { toast } from '../../state/toast'
import type { ImportRef } from '../../../preload/api'

interface Props {
  /** The CLAUDE.md-like file whose `@`-imports this rail lists; null = nothing to show. */
  activePath: string | null
  /** Which document the host screen is currently showing (the root file, or one import). */
  selectedPath: string | null
  /** A row was picked. `null` means the root document (`activePath`) itself. */
  onSelect: (ref: ImportRef | null) => void
}

function basename(path: string): string {
  return path.split('/').pop() || path
}

/**
 * The document rail beside the CLAUDE.md editor: the root file itself, then
 * every file it pulls in through the flattened `@path` import chain (via PRD
 * 800's `config:parse-imports` IPC).
 *
 * It used to be a horizontal accordion stacked *above* the editor, where each
 * row expanded into its own second Monaco instance squeezed into 16rem of
 * height. That read as a list of attachments rather than what it is — the set
 * of documents that together make up the system prompt — and it stole vertical
 * space from the editor that was the point of the screen. Now it is a rail:
 * one row per document, selection only, and the chosen document opens in the
 * host's single shared `DocumentEditorPane` at full height with the same
 * preview / outline / metrics chrome the Editor tab gives any other file.
 *
 * Renders nothing when there are zero imports, so a CLAUDE.md that imports
 * nothing gets the whole width for its own text instead of a one-item rail.
 */
export function ReferencedFilesPanel({ activePath, selectedPath, onSelect }: Props) {
  const [imports, setImports] = useState<ImportRef[]>([])
  // Monotonic generation counter, bumped every time activePath changes.
  // In-flight fetches capture the generation they were issued under and
  // compare against the current one on resolve — unlike comparing raw
  // activePath values, this can't false-positive on an A->B->A round trip (a
  // stale A-fetch resolving after the user has navigated back to A would
  // otherwise pass a same-path check and resurrect stale content).
  const generationRef = useRef(0)
  // Held in a ref so re-parsing is driven by activePath alone; a caller that
  // passes an inline arrow for onSelect must not retrigger the IPC.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    generationRef.current += 1
    // The previously-selected import belongs to the previous root file; drop
    // back to the root document rather than leaving the host pointed at a
    // document that may not be in the new chain at all.
    onSelectRef.current(null)
    if (!activePath) {
      setImports([])
      return
    }
    const generation = generationRef.current
    let cancelled = false
    window.api.config.parseImports(activePath).then((res) => {
      if (cancelled || generationRef.current !== generation) return
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

  if (imports.length === 0 || !activePath) return null

  const rootSelected = selectedPath === activePath || selectedPath === null

  return (
    <div
      className="w-64 shrink-0 border-r border-line bg-bg-elev overflow-auto"
      data-testid="referenced-files-rail"
    >
      <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-fg-faint border-b border-line">
        Documents · {imports.length + 1}
      </div>

      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-current={rootSelected}
        data-testid="referenced-file-root"
        className={`w-full text-left px-3 py-2 border-b border-line ${
          rootSelected ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:bg-bg'
        }`}
      >
        <div className="text-[11.5px] font-medium truncate">{basename(activePath)}</div>
        <div className="text-[10px] text-fg-faint truncate" title={activePath}>
          this system prompt
        </div>
      </button>

      {imports.map((ref) => {
        const broken = !ref.ok || !ref.exists
        const selected = selectedPath === ref.path
        return (
          <button
            key={ref.path}
            type="button"
            onClick={() => onSelect(ref)}
            aria-current={selected}
            data-testid="referenced-file-row"
            className={`w-full text-left px-3 py-2 border-b border-line last:border-b-0 ${
              selected ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:bg-bg'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[11.5px] font-medium truncate flex-1">{basename(ref.path)}</span>
              {broken && (
                <span
                  className="shrink-0 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide text-amber-400/90 border border-amber-400/30"
                  data-testid="referenced-file-missing"
                >
                  missing
                </span>
              )}
            </div>
            <div className="text-[10px] text-fg-faint truncate" title={ref.path}>
              {ref.path}
            </div>
            <div className="text-[10px] text-fg-faint">
              {ref.sizeBytes.toLocaleString()} bytes · ~{ref.tokenEstimate.toLocaleString()} tokens
            </div>
          </button>
        )
      })}
    </div>
  )
}
