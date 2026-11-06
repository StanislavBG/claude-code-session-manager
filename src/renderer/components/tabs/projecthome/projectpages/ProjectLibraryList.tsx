/**
 * Shared list markup for the Knowledge Pages / Video Pages playlists. Callers
 * pass already-ordered rows (newest first) and own the selection. When `cwd`
 * and `kind` are given, each row also gets Rename (inline title edit) and
 * Delete (confirm step) actions; failures surface as an error toast.
 */
import { useState, type ReactNode } from 'react'
import { useToast } from '../../../../state/toast'

export interface LibraryRow {
  id: string
  /** Row content; for an entry with unreadable meta, render its error line. */
  content: ReactNode
  /** Current title, used to seed the inline rename input. */
  title?: string
}

const ACTION_CLASS = 'text-[10.5px] font-semibold text-fg-faint hover:text-fg cursor-pointer'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function ProjectLibraryList({
  rows,
  selectedId,
  onSelect,
  itemTestId,
  label,
  cwd,
  kind,
}: {
  rows: LibraryRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  itemTestId: string
  label: string
  cwd?: string | null
  kind?: 'knowledge' | 'video'
}) {
  const showToast = useToast((s) => s.show)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const actions = Boolean(cwd && kind)

  const saveRename = async (id: string) => {
    const title = draft.trim()
    if (!cwd || !kind || !title || busy) return
    setBusy(true)
    try {
      await window.api.projectPages.rename(cwd, kind, id, title)
      setRenamingId(null)
    } catch (e) {
      showToast('error', `Rename failed: ${errMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (id: string) => {
    if (!cwd || !kind || busy) return
    setBusy(true)
    try {
      await window.api.projectPages.delete(cwd, kind, id)
      setConfirmId(null)
    } catch (e) {
      showToast('error', `Delete failed: ${errMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((row) => (
        <li key={row.id}>
          {renamingId === row.id ? (
            <input
              data-testid="entry-rename-input"
              aria-label="Entry title"
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveRename(row.id)
                else if (e.key === 'Escape') setRenamingId(null)
              }}
              className="w-full rounded-lg border border-accent bg-bg-hi px-2.5 py-2 text-xs text-fg"
            />
          ) : (
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
          )}
          {actions && renamingId !== row.id && (
            <span className="mt-0.5 flex items-center gap-2 px-1">
              {confirmId === row.id ? (
                <>
                  <span className="text-[10.5px] text-fg-faint">Delete this entry?</span>
                  <button
                    type="button"
                    data-testid="entry-delete-confirm"
                    disabled={busy}
                    onClick={() => void doDelete(row.id)}
                    className="text-[10.5px] font-semibold text-red-400 cursor-pointer"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    data-testid="entry-delete-cancel"
                    onClick={() => setConfirmId(null)}
                    className={ACTION_CLASS}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="entry-rename"
                    onClick={() => {
                      setDraft(row.title ?? '')
                      setRenamingId(row.id)
                      setConfirmId(null)
                    }}
                    className={ACTION_CLASS}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    data-testid="entry-delete"
                    onClick={() => setConfirmId(row.id)}
                    className={ACTION_CLASS}
                  >
                    Delete
                  </button>
                </>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
