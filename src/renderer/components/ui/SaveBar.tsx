import { useEffect } from 'react'
import { formatTimeSince } from '../../lib/formatTime'

interface Props {
  dirty: boolean
  busy: boolean
  parseError?: string | null
  lastSavedAt?: number | null
  onSave: () => void
  onRevert: () => void
  /** Shown left of the buttons — usually the path. */
  leading?: React.ReactNode
  /**
   * Opt-in. While there is nothing to save, a sage dot plus this text (e.g.
   * "Saved — matches the file on disk") leads the bar instead of "saved Ns ago".
   */
  cleanLabel?: string
  /** Opt-in. Shows the save shortcut on the Save button: "⌘S" on macOS, "Ctrl S" elsewhere. */
  shortcutHint?: boolean
  /**
   * The caller's pane. With `shortcutHint`, Ctrl/Cmd+S saves while focus is inside it;
   * without a scope the hint is display-only.
   */
  scopeRef?: React.RefObject<HTMLElement | null>
}

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
}

export function SaveBar({
  dirty,
  busy,
  parseError,
  lastSavedAt,
  onSave,
  onRevert,
  leading,
  cleanLabel,
  shortcutHint,
  scopeRef,
}: Props) {
  const canSave = dirty && !busy && !parseError

  useEffect(() => {
    if (!shortcutHint || !scopeRef) return
    const onKeyDown = (e: KeyboardEvent) => {
      // An inner editor that already handled the chord owns it — never save twice.
      if (!canSave || e.defaultPrevented) return
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      if (e.key !== 's' && e.key !== 'S') return
      const scope = scopeRef.current
      const focused = document.activeElement
      if (!scope || !focused || !scope.contains(focused)) return
      e.preventDefault()
      onSave()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcutHint, scopeRef, canSave, onSave])

  const mac = shortcutHint ? isMacPlatform() : false
  const showClean = !dirty && !parseError && !!cleanLabel
  return (
    <div className="px-3 py-1.5 flex items-center gap-2 text-xs">
      {showClean && (
        <span data-testid="savebar-clean" className="min-w-0 flex items-center gap-[7px] text-fg-faint">
          <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full bg-sage" />
          <span className="truncate">{cleanLabel}</span>
        </span>
      )}
      <div className="flex-1 min-w-0 truncate text-fg-faint">{leading}</div>
      {parseError && (
        <span className="text-red-400 truncate max-w-xs" title={parseError}>
          {parseError}
        </span>
      )}
      {!dirty && !parseError && !cleanLabel && lastSavedAt && (
        <span className="text-fg-faint">{formatTimeSince(lastSavedAt)}</span>
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
        aria-keyshortcuts={shortcutHint && scopeRef ? (mac ? 'Meta+S' : 'Control+S') : undefined}
        className={`px-2.5 py-0.5 rounded border ${
          canSave
            ? 'border-accent bg-accent/15 text-accent hover:bg-accent/25'
            : 'border-line text-fg-faint opacity-50 cursor-not-allowed'
        }`}
      >
        {busy ? 'Saving…' : 'Save'}
        {shortcutHint && (
          <kbd aria-hidden="true" className="ml-2 font-mono text-[10.5px]">
            {mac ? '⌘S' : 'Ctrl S'}
          </kbd>
        )}
      </button>
    </div>
  )
}
