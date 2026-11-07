/**
 * SourceChip — "this screen edits that file" pointer. Shows the home-shortened
 * path, the edited key path, and the file's age (or "created on first save").
 * Click opens the file in the in-app editor, same route as the Files sidebar.
 */
import { useEffect, useState } from 'react'
import { useHomeDir } from '../../lib/useHomeDir'
import { useEditor } from '../../state/editor'
import { formatMtimeMs } from '../../lib/formatTime'

export function shortenHome(path: string, home: string | null): string {
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length)
  return path
}

export function SourceChip({ path, keyPath, note }: { path: string; keyPath?: string[]; note?: string }) {
  const home = useHomeDir()
  // undefined = loading, null = file missing, number = mtime
  const [mtime, setMtime] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const read = () => {
      window.api.config
        .readText(path, { maxBytes: 1 })
        .then((r) => { if (alive) setMtime(r.exists ? r.mtimeMs : null) })
        .catch(() => { if (alive) setMtime(undefined) })
    }
    read()
    const off = window.api.config.onChanged((e) => { if (e.path === path) read() })
    return () => { alive = false; off() }
  }, [path])

  const label = shortenHome(path, home) + (keyPath && keyPath.length ? ` › ${keyPath.join('.')}` : '')
  const age = mtime === undefined ? '' : mtime === null ? 'created on first save' : formatMtimeMs(mtime)

  const open = () => {
    useEditor.getState().openFile(path)
    window.dispatchEvent(new CustomEvent('sm:open-editor'))
  }

  return (
    <button
      type="button"
      data-testid="source-chip"
      title={note ?? `Open ${path} in the editor`}
      onClick={open}
      className="inline-flex items-center gap-1.5 max-w-full text-[11px] px-2 py-0.5 rounded border border-line bg-bg-elev text-fg-dim hover:bg-bg-hi"
    >
      <span className="font-mono truncate" data-testid="source-chip-path">{label}</span>
      {age && <span className="text-fg-dim/70 shrink-0" data-testid="source-chip-age">· {age}</span>}
    </button>
  )
}
