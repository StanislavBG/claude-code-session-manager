import { useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { QuickOpenModal } from './QuickOpenModal'
import { GlobalSearchModal } from './GlobalSearchModal'

/**
 * SearchModal — single search surface with two modes:
 *   • Files   — ⌘P fuzzy filename picker (QuickOpenModal)
 *   • Content — ⌘⇧F ripgrep content search (GlobalSearchModal)
 *
 * Consolidates the two former nav destinations (Quick Open + Global Search):
 * both scope to the active tab's cwd, both write the chosen path into the
 * active PTY, both share the same z-[55] shell. One surface, mode toggle.
 *
 * `initialMode` seeds the toggle so ⌘P lands on Files and ⌘⇧F on Content; the
 * keybinding bumps it even when the search screen is already active.
 */

export type SearchMode = 'files' | 'content'

interface SearchModalProps {
  open: boolean
  onClose: () => void
  variant?: 'overlay' | 'page'
  initialMode?: SearchMode
}

const MODE_OPTIONS = [
  { key: 'files' as const, label: 'Files' },
  { key: 'content' as const, label: 'Content' },
]

export function SearchModal({ open, onClose, variant = 'page', initialMode = 'files' }: SearchModalProps) {
  const [mode, setMode] = useState<SearchMode>(initialMode)

  // Re-sync when the entry point changes the requested mode (e.g. ⌘⇧F pressed
  // while the search screen is already showing Files).
  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  if (!open) return null

  return (
    <div className="h-full w-full flex flex-col bg-bg">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line">
        <ViewTabs options={MODE_OPTIONS} active={mode} onChange={setMode} />
        <span className="text-[11px] text-fg-faint">
          {mode === 'files' ? '⌘P · fuzzy-find a file in the active project' : '⌘⇧F · ripgrep across the active project'}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        {mode === 'files' ? (
          <QuickOpenModal open onClose={onClose} variant="page" />
        ) : (
          <GlobalSearchModal open onClose={onClose} variant="page" />
        )}
      </div>
    </div>
  )
}
