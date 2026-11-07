/**
 * Shared list markup for the Knowledge Pages / Video Pages playlists. Callers
 * pass already-ordered rows (newest first) and own the selection. When `cwd`
 * and `kind` are given, rows also get Rename (inline title edit) and Delete
 * (confirm step) actions; failures surface as an error toast.
 *
 * `layout`: `classic` (default) puts the actions under every row. `v2` is the
 * Project Home v2 list (DESIGN_SPEC §1 "List rows" / "Row actions"): 10/12
 * padded rows, radius 9, structural border, and `Rename` · `Delete` under the
 * selected row only, asking `Delete this page?|video?`.
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
const V2_ACTION_CLASS = 'text-[11.5px] font-semibold text-fg-faint hover:text-fg cursor-pointer'

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function rowClass(v2: boolean, selected: boolean): string {
  if (v2) {
    return `w-full rounded-[9px] border px-3 py-2.5 text-left cursor-pointer transition-colors ${
      selected ? 'border-accent bg-bg-hi text-fg' : 'border-rule-structural text-fg-dim hover:border-fg-faint'
    }`
  }
  return `w-full rounded-lg border px-2.5 py-2 text-left text-xs cursor-pointer ${
    selected ? 'border-accent bg-bg-hi text-fg' : 'border-line text-fg-faint hover:text-fg'
  }`
}

export function ProjectLibraryList({
  rows,
  selectedId,
  onSelect,
  itemTestId,
  label,
  cwd,
  kind,
  layout = 'classic',
}: {
  rows: LibraryRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  itemTestId: string
  label: string
  cwd?: string | null
  kind?: 'knowledge' | 'video'
  layout?: 'classic' | 'v2'
}) {
  const showToast = useToast((s) => s.show)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const actions = Boolean(cwd && kind)
  const v2 = layout === 'v2'
  const noun = v2 ? (kind === 'video' ? 'video' : 'page') : 'entry'
  const actionClass = v2 ? V2_ACTION_CLASS : ACTION_CLASS

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
    <ul aria-label={label} className={`m-0 flex list-none flex-col p-0 ${v2 ? 'gap-1.5' : 'gap-1'}`}>
      {rows.map((row) => {
        const selected = row.id === selectedId
        return (
          <li key={row.id} className={v2 ? 'flex flex-col gap-[5px]' : undefined}>
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
                className={
                  v2
                    ? 'h-10 w-full rounded-[9px] border border-accent bg-bg-hi px-[11px] text-[13px] text-fg outline-none'
                    : 'w-full rounded-lg border border-accent bg-bg-hi px-2.5 py-2 text-xs text-fg'
                }
              />
            ) : (
              <button
                type="button"
                data-testid={itemTestId}
                data-id={row.id}
                aria-current={selected ? 'true' : undefined}
                onClick={() => {
                  // v2 shows actions under the selected row only: a pending delete question goes with the old pick.
                  if (v2) setConfirmId(null)
                  onSelect(row.id)
                }}
                className={rowClass(v2, selected)}
              >
                {row.content}
              </button>
            )}
            {actions && renamingId !== row.id && (!v2 || selected) && (
              <span className={v2 ? 'flex items-center gap-3 px-1' : 'mt-0.5 flex items-center gap-2 px-1'}>
                {confirmId === row.id ? (
                  <>
                    <span className={v2 ? 'text-[11.5px] text-fg-faint' : 'text-[10.5px] text-fg-faint'}>
                      Delete this {noun}?
                    </span>
                    <button
                      type="button"
                      data-testid="entry-delete-confirm"
                      disabled={busy}
                      onClick={() => void doDelete(row.id)}
                      className={
                        v2
                          ? 'text-[11.5px] font-bold text-accent-dark cursor-pointer'
                          : 'text-[10.5px] font-semibold text-red-400 cursor-pointer'
                      }
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      data-testid="entry-delete-cancel"
                      onClick={() => setConfirmId(null)}
                      className={actionClass}
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
                      className={actionClass}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      data-testid="entry-delete"
                      onClick={() => setConfirmId(row.id)}
                      className={actionClass}
                    >
                      Delete
                    </button>
                  </>
                )}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
