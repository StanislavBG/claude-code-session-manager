interface Props {
  dirty: boolean
  busy: boolean
  parseError?: string | null
  lastSavedAt?: number | null
  onSave: () => void
  onRevert: () => void
  /** Shown left of the buttons — usually the path. */
  leading?: React.ReactNode
}

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return ''
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 60_000) return `saved ${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `saved ${Math.round(delta / 60_000)}m ago`
  return `saved ${Math.round(delta / 3_600_000)}h ago`
}

export function SaveBar({ dirty, busy, parseError, lastSavedAt, onSave, onRevert, leading }: Props) {
  const canSave = dirty && !busy && !parseError
  return (
    <div className="px-3 py-1.5 flex items-center gap-2 text-xs">
      <div className="flex-1 min-w-0 truncate text-fg-faint">{leading}</div>
      {parseError && (
        <span className="text-red-400 truncate max-w-xs" title={parseError}>
          {parseError}
        </span>
      )}
      {!dirty && !parseError && lastSavedAt && (
        <span className="text-fg-faint">{timeAgo(lastSavedAt)}</span>
      )}
      {dirty && !parseError && <span className="text-accent">unsaved</span>}
      <button
        onClick={onRevert}
        disabled={!dirty || busy}
        className="px-2 py-0.5 border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Revert
      </button>
      <button
        onClick={onSave}
        disabled={!canSave}
        className={`px-2.5 py-0.5 rounded border ${
          canSave
            ? 'border-accent bg-accent/15 text-accent hover:bg-accent/25'
            : 'border-line text-fg-faint opacity-50 cursor-not-allowed'
        }`}
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}
