import { useEffect, useState } from 'react'
import { Modal } from './ui/Modal'
import { useToast } from '../state/toast'
import { openOrStartProject, openProjectAt, startNewProject } from '../lib/createPickedSession'

/**
 * "Open / Start Project" dialog: open an existing folder via the native picker,
 * or START a new project by name in a parent dir (the Linux picker has no
 * New Folder button).
 */
export interface StartProjectDialogProps {
  open: boolean
  onClose: () => void
  /** A project tab was opened/activated — the caller closes and lands. */
  onOpened: () => void
  defaultParentDir: string
}

interface DialogError {
  message: string
  existingPath?: string
}

export function StartProjectDialog({ open, onClose, onOpened, defaultParentDir }: StartProjectDialogProps) {
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState(defaultParentDir)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<DialogError | null>(null)

  // Reset the form each time the dialog (re)opens.
  useEffect(() => {
    if (!open) return
    setName('')
    setParentDir(defaultParentDir)
    setError(null)
    setBusy(false)
  }, [open, defaultParentDir])

  const trimmed = name.trim()
  const canCreate = trimmed.length > 0 && !busy
  const sep = parentDir.includes('\\') && !parentDir.includes('/') ? '\\' : '/'
  const preview = `${parentDir.replace(/[\\/]+$/, '')}${sep}${trimmed}`

  const openExisting = async () => {
    try {
      const id = await openOrStartProject()
      if (id) onOpened()
    } catch (e) {
      useToast.getState().show('error', e instanceof Error ? e.message : String(e))
    }
  }

  const changeParent = async () => {
    try {
      const dir = await window.api.app.pickDirectory()
      if (dir) setParentDir(dir)
    } catch (e) {
      useToast.getState().show('error', e instanceof Error ? e.message : String(e))
    }
  }

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const result = await startNewProject(parentDir, trimmed)
      if (result.ok) {
        onOpened()
      } else if (result.code === 'exists') {
        setError({ message: result.error, existingPath: result.path ?? preview })
      } else {
        setError({ message: result.error })
      }
    } catch (e) {
      useToast.getState().show('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const btn =
    'px-3 py-1.5 rounded-md bg-bg-hi border border-line text-fg text-[12.5px] font-medium hover:bg-bg-hi/80 hover:border-accent/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <Modal open={open} onClose={onClose} title="Open / Start Project">
      <div data-testid="start-project-dialog" className="flex flex-col gap-3">
        <button type="button" data-testid="start-project-open-existing" className={btn} onClick={() => void openExisting()}>
          Open existing folder…
        </button>
        <div className="border-t border-line" />
        <h3 className="text-sm font-medium text-fg">Start new project</h3>
        <input
          data-testid="start-project-name"
          autoFocus
          value={name}
          placeholder="Project name"
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void create()
            }
          }}
          className="w-full px-2 py-1.5 rounded-md bg-bg-hi border border-line text-fg text-[12.5px] focus:outline-none focus:border-accent/60"
        />
        <div className="flex items-center gap-2 text-xs text-fg-faint">
          <span>in</span>
          <span data-testid="start-project-parent" className="font-mono truncate flex-1" title={parentDir}>
            {parentDir}
          </span>
          <button type="button" data-testid="start-project-change-parent" className={btn} onClick={() => void changeParent()}>
            Change…
          </button>
        </div>
        {trimmed && <div className="text-xs text-fg-faint font-mono break-all">{preview}</div>}
        {error && (
          <div data-testid="start-project-error" className="text-xs text-fg flex items-center gap-2">
            <span className="flex-1">{error.message}</span>
            {error.existingPath && (
              <button
                type="button"
                className={btn}
                onClick={() => {
                  openProjectAt(error.existingPath as string)
                  onOpened()
                }}
              >
                Open it
              </button>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" data-testid="start-project-create" className={btn} disabled={!canCreate} onClick={() => void create()}>
            Create
          </button>
        </div>
      </div>
    </Modal>
  )
}
