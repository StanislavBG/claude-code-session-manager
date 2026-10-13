import type { MemoryIndexHealth as IndexHealth } from '../../../../preload/api'

interface Props {
  index: IndexHealth | undefined
  autoMemoryEnabled: boolean
}

/** Compact MEMORY.md index-health strip + auto-memory-off banner. Presentational. */
export function MemoryIndexHealth({ index, autoMemoryEnabled }: Props) {
  const tone = index?.overBudget
    ? 'text-red-400 border-red-400/40 bg-red-400/10'
    : index?.nearBudget
      ? 'text-amber-400 border-amber-400/40 bg-amber-400/10'
      : 'text-fg-faint border-line'
  return (
    <>
      {!autoMemoryEnabled && (
        <div
          data-testid="memory-auto-off-banner"
          className="shrink-0 px-3 py-1.5 text-xs text-amber-400 border-b border-amber-400/40 bg-amber-400/10"
        >
          Auto memory is off — Claude Code will not read or write these memories
        </div>
      )}
      {index && (
        <div
          data-testid="memory-index-strip"
          className={`shrink-0 flex items-center gap-3 px-3 py-1 text-[11px] border-b ${tone}`}
        >
          <span>
            MEMORY.md {index.lines}/{index.maxLines} lines · {(index.bytes / 1024).toFixed(1)}/
            {Math.round(index.maxBytes / 1024)} KB
          </span>
          {index.orphans.length > 0 && <span>{index.orphans.length} not in index</span>}
          {index.dangling.length > 0 && <span>{index.dangling.length} dangling index lines</span>}
        </div>
      )}
    </>
  )
}
