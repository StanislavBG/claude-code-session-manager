/**
 * DocumentMenu — "Document ▾" grouped toolbar menu for the EditorView header.
 * Owns everything you can do to the open file itself (Edit / Open / Export
 * groups), replacing the old inline Open/Reveal header buttons.
 *
 * Rename/Delete keep the tab and buffer alive across the fs operation via
 * `useEditor`'s `renameOpenFile`/`closeFile` — see state/editor.ts. The
 * `onRenamed`/`onDeleted` callbacks let EditorView prune its own per-path UI
 * maps (loadState/reloadTokens), which this component has no access to.
 */

import { useState } from 'react'
import { useEditor } from '../../../state/editor'
import { toast } from '../../../state/toast'
import { useActiveTab } from '../../../lib/useActiveTab'

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

interface Props {
  path: string
  onRenamed?: (oldPath: string, newPath: string) => void
  onDeleted?: (path: string) => void
}

export function DocumentMenu({ path, onRenamed, onDeleted }: Props) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState(false)

  const buffer = useEditor((s) => s.buffers[path])
  const openFile = useEditor((s) => s.openFile)
  const renameOpenFile = useEditor((s) => s.renameOpenFile)
  const closeFile = useEditor((s) => s.closeFile)
  const activeTab = useActiveTab()

  const name = basename(path)
  const closeMenu = () => setOpen(false)

  const startRename = () => {
    setRenameValue(name)
    setRenaming(true)
    closeMenu()
  }

  const submitRename = async () => {
    const newName = renameValue.trim()
    if (!newName || newName === name) { setRenaming(false); return }
    try {
      const r = await window.api.files.rename(path, newName)
      if (r.ok) {
        const parent = path.slice(0, path.lastIndexOf('/'))
        const newPath = r.newPath ?? `${parent}/${newName}`
        renameOpenFile(path, newPath)
        onRenamed?.(path, newPath)
        toast.info(`Renamed to ${newName}`)
      } else {
        toast.error(r.error ?? `Couldn't rename ${name}`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Couldn't rename ${name}`)
    }
    setRenaming(false)
  }

  const duplicate = async () => {
    closeMenu()
    try {
      const r = await window.api.files.duplicate(path)
      if (r.ok && r.path) {
        openFile(r.path)
        toast.info(`Duplicated as ${basename(r.path)}`)
      } else {
        toast.error(r.error ?? `Couldn't duplicate ${name}`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Couldn't duplicate ${name}`)
    }
  }

  const confirmDelete = async () => {
    try {
      const r = await window.api.files.delete(path)
      if (r.ok) {
        closeFile(path)
        onDeleted?.(path)
        toast.info(`Deleted ${name}`)
      } else {
        toast.error(r.error ?? `Couldn't delete ${name}`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Couldn't delete ${name}`)
    }
    setDeleting(false)
  }

  const copyAsMarkdown = async () => {
    closeMenu()
    const text = buffer ?? ''
    try {
      await navigator.clipboard.writeText(text)
      toast.info(`Copied ${text.length} chars`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Couldn't copy ${name}`)
    }
  }

  const addToClaudeContext = () => {
    closeMenu()
    if (!activeTab) {
      toast.error('No terminal tab is active')
      return
    }
    window.api.pty.write({ tabId: activeTab.id, data: `@${path} ` })
    toast.info(`Added ${name} to Claude context`)
  }

  const openInDefaultApp = () => {
    closeMenu()
    window.api.shell.open({ as: 'openPath', path })
      .then((r) => { if (!r.ok) toast.error(r.error ?? `Couldn't open ${name}`) })
      .catch((e) => toast.error(e instanceof Error ? e.message : `Couldn't open ${name}`))
  }

  const reveal = () => {
    closeMenu()
    window.api.shell.open({ as: 'revealPath', path })
      .then((r) => { if (!r.ok) toast.error(r.error ?? `Couldn't reveal ${name}`) })
      .catch((e) => toast.error(e instanceof Error ? e.message : `Couldn't reveal ${name}`))
  }

  return (
    <div className="relative inline-block mr-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`px-2 py-0.5 text-[10px] border border-line rounded ${open ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
        title="Document actions"
      >
        Document ▾
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[390]" onMouseDown={closeMenu} />
          <div className="absolute right-0 top-full mt-1 z-[400] w-56 rounded-lg border border-line bg-bg-elev shadow-xl text-xs py-1">
            <GroupLabel>Edit</GroupLabel>
            <MenuItem label="Rename" onClick={startRename} />
            <MenuItem label="Duplicate" onClick={duplicate} />
            <MenuItem label="Delete document" danger onClick={() => { closeMenu(); setDeleting(true) }} />
            <Divider />
            <GroupLabel>Open</GroupLabel>
            <MenuItem label="Open in default app" onClick={openInDefaultApp} />
            <MenuItem label="Reveal in OS" onClick={reveal} />
            <Divider />
            <GroupLabel>Export</GroupLabel>
            <MenuItem label="Copy as Markdown" onClick={copyAsMarkdown} />
            <MenuItem
              label="Add to Claude context"
              onClick={addToClaudeContext}
              disabled={!activeTab}
              title={!activeTab ? 'No terminal tab is active' : undefined}
            />
          </div>
        </>
      )}

      {renaming && (
        <RenameModal
          value={renameValue}
          onChange={setRenameValue}
          onCancel={() => setRenaming(false)}
          onConfirm={() => void submitRename()}
        />
      )}

      {deleting && (
        <DeleteConfirm name={name} onCancel={() => setDeleting(false)} onConfirm={() => void confirmDelete()} />
      )}
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-fg-faint">{children}</div>
}

function MenuItem({ label, onClick, danger, disabled, title }: {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-full text-left px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        danger ? 'text-red-400 hover:bg-bg-hi' : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
      }`}
    >
      {label}
    </button>
  )
}

function Divider() {
  return <div className="my-1 border-t border-line" />
}

function RenameModal({ value, onChange, onCancel, onConfirm }: {
  value: string
  onChange: (v: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-96 rounded-lg border border-line bg-bg-elev p-4 shadow-2xl">
        <h3 className="text-sm font-medium text-fg mb-3">Rename</h3>
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm()
            else if (e.key === 'Escape') onCancel()
          }}
          className="w-full px-2 py-1 text-xs bg-bg border border-line rounded text-fg mb-3"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1 text-xs text-fg-dim hover:text-fg border border-line rounded">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-3 py-1 text-xs text-white rounded bg-accent hover:bg-accent/90">
            Rename
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-96 rounded-lg border border-line bg-bg-elev p-4 shadow-2xl">
        <h3 className="text-sm font-medium text-fg mb-3">Delete {name}? This cannot be undone.</h3>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1 text-xs text-fg-dim hover:text-fg border border-line rounded">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-3 py-1 text-xs text-white rounded bg-red-600 hover:bg-red-500">
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
