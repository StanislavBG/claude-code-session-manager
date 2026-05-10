import { useEffect, useRef, useState } from 'react'
import { useWatchers } from '../state/watchers'

interface Props {
  tabId: string
  cwd: string
  onClose: () => void
}

export function WatchersPopover({ tabId, cwd, onClose }: Props) {
  const watchers = useWatchers((s) => s.watchersForTab(tabId))
  const add = useWatchers((s) => s.add)
  const remove = useWatchers((s) => s.remove)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const [label, setLabel] = useState('')
  const [command, setCommand] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  const submit = async () => {
    const cmd = command.trim()
    if (!cmd || submitting) return
    setSubmitting(true)
    const w = await add({ tabId, label: label.trim(), command: cmd, cwd })
    setSubmitting(false)
    if (w) {
      setLabel('')
      setCommand('')
    }
  }

  return (
    <div
      ref={rootRef}
      className="absolute right-2 top-full mt-1 z-30 w-[420px] max-w-[calc(100vw-1rem)] bg-bg-elev border border-line rounded shadow-lg p-3 text-xs"
      role="dialog"
      aria-label="Watchers"
      data-testid="watchers-popover"
    >
      <div className="flex items-center mb-2">
        <span className="text-fg-dim uppercase tracking-wider">Watchers</span>
        <span className="text-fg-faint ml-2">{watchers.length} active</span>
        <div className="flex-1" />
        <button onClick={onClose} className="text-fg-faint hover:text-fg" title="Close">×</button>
      </div>

      <div className="flex flex-col gap-1.5 mb-3">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="label (optional)"
          className="bg-bg border border-line rounded px-2 py-1 text-fg placeholder:text-fg-faint focus:outline-none focus:border-fg-faint"
        />
        <div className="flex gap-1.5">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder="shell command — e.g. npm test --watch"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 text-fg placeholder:text-fg-faint focus:outline-none focus:border-fg-faint font-mono"
            data-testid="watcher-command-input"
          />
          <button
            onClick={submit}
            disabled={!command.trim() || submitting}
            className="px-2 py-1 border border-line rounded text-fg-dim hover:text-fg hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="watcher-add"
          >
            Add
          </button>
        </div>
        <span className="text-fg-faint">cwd: <span className="font-mono">{cwd}</span></span>
      </div>

      {watchers.length === 0 ? (
        <div className="text-fg-faint italic py-2">no watchers — add one above</div>
      ) : (
        <ul className="flex flex-col gap-2 max-h-64 overflow-y-auto">
          {watchers.map((w) => {
            const last = w.lines[w.lines.length - 1]
            return (
              <li key={w.watcherId} className="border border-line rounded p-2 bg-bg">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg truncate">{w.label}</span>
                  <span className="text-fg-faint">{w.lineCount} line{w.lineCount === 1 ? '' : 's'}</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => remove(w.watcherId)}
                    className="text-fg-faint hover:text-red-400"
                    title="Stop watcher"
                    data-testid={`watcher-remove-${w.watcherId}`}
                  >
                    stop
                  </button>
                </div>
                <div className="text-fg-faint font-mono text-[10px] truncate mt-0.5" title={w.command}>{w.command}</div>
                <div className="text-fg-dim font-mono text-[10px] truncate mt-1" title={last?.line ?? ''}>
                  {last ? last.line : <span className="italic text-fg-faint">waiting for output…</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
