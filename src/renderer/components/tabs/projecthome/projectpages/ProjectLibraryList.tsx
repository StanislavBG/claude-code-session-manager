/**
 * Shared list markup for the Knowledge Pages / Video Pages playlists. Purely
 * presentational: callers pass already-ordered rows (newest first) and own
 * the selection.
 */
import type { ReactNode } from 'react'

export interface LibraryRow {
  id: string
  /** Row content; for an entry with unreadable meta, render its error line. */
  content: ReactNode
}

export function ProjectLibraryList({
  rows,
  selectedId,
  onSelect,
  itemTestId,
  label,
}: {
  rows: LibraryRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  itemTestId: string
  label: string
}) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            data-testid={itemTestId}
            data-id={row.id}
            aria-current={row.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(row.id)}
            className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs cursor-pointer ${
              row.id === selectedId ? 'border-accent bg-bg-hi text-fg' : 'border-line text-fg-faint hover:text-fg'
            }`}
          >
            {row.content}
          </button>
        </li>
      ))}
    </ul>
  )
}
