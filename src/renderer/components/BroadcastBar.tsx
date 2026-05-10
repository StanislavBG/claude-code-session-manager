import { useEffect, useRef, useState } from 'react'
import { useSessions } from '../state/sessions'

interface Props {
  onClose: () => void
  onSent: (count: number) => void
}

export function BroadcastBar({ onClose, onSent }: Props) {
  const tabs = useSessions((s) => s.tabs)
  const [prompt, setPrompt] = useState('')
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(tabs.map((t) => [t.id, true])),
  )
  const [sending, setSending] = useState(false)
  const [rowStatus, setRowStatus] = useState<Record<string, 'sent' | 'skipped'>>({})
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Stable ref so the auto-close timer always calls the latest onSent prop.
  const onSentRef = useRef(onSent)
  useEffect(() => { onSentRef.current = onSent }, [onSent])

  // Reconcile the checklist when tabs change while the bar is open: keep
  // explicit user toggles, default newly-appeared tabs to checked.
  useEffect(() => {
    setChecked((prev) => {
      const next: Record<string, boolean> = {}
      for (const t of tabs) next[t.id] = prev[t.id] ?? true
      return next
    })
  }, [tabs])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Main process emits 'pty:write-error' when a write to a dead PTY is
  // attempted. Update the affected row to 'skipped' so the user sees it.
  useEffect(() => {
    const off = window.api.pty.onWriteError((ev) => {
      setRowStatus((prev) => {
        if (!(ev.tabId in prev)) return prev
        return { ...prev, [ev.tabId]: 'skipped' }
      })
    })
    return off
  }, [])

  // Auto-close 1.5 s after send completes. The timer restarts on each
  // rowStatus update so write-error events that arrive within the window are
  // reflected in the per-row indicators before the bar dismisses.
  useEffect(() => {
    if (Object.keys(rowStatus).length === 0) return
    const sentCount = Object.values(rowStatus).filter((v) => v === 'sent').length
    const t = window.setTimeout(() => onSentRef.current(sentCount), 1500)
    return () => window.clearTimeout(t)
  }, [rowStatus])

  const checkedIds = tabs.filter((t) => checked[t.id]).map((t) => t.id)
  const checkedCount = checkedIds.length
  const hasSent = Object.keys(rowStatus).length > 0
  const canSend = prompt.length > 0 && checkedCount > 0 && !sending && !hasSent

  const send = () => {
    if (!canSend) return
    setSending(true)
    // Re-read tabs at send time: a tab may have been removed between when the
    // checklist was rendered and when Send was clicked.
    const liveTabs = useSessions.getState().tabs
    const liveIdSet = new Set(liveTabs.map((t) => t.id))
    const status: Record<string, 'sent' | 'skipped'> = {}
    for (const id of checkedIds) {
      if (liveIdSet.has(id)) {
        // '\r' is the correct PTY line-terminator (maps to Enter in the TTY
        // discipline). Embedded '\n' in multi-line prompts are sent as-is.
        window.api.pty.write({ tabId: id, data: prompt + '\r' })
        status[id] = 'sent'
      } else {
        status[id] = 'skipped'
      }
    }
    setRowStatus(status)
    setSending(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  const allChecked = tabs.length > 0 && tabs.every((t) => checked[t.id])
  const toggleAll = () => {
    const next = !allChecked
    setChecked(Object.fromEntries(tabs.map((t) => [t.id, next])))
  }

  const hasSkipped = Object.values(rowStatus).some((v) => v === 'skipped')
  const sendLabel = hasSent
    ? hasSkipped ? 'Sent (some skipped)' : 'Sent'
    : `Send to ${checkedCount} tab${checkedCount === 1 ? '' : 's'}`

  return (
    <div
      className="border-b border-line bg-bg-elev px-4 py-3 flex flex-col gap-2 shrink-0"
      onKeyDown={onKeyDown}
      data-testid="broadcast-bar"
    >
      <div className="flex items-center justify-between">
        <div className="text-xs text-fg-dim uppercase tracking-wider">Broadcast</div>
        <div className="text-[10px] text-fg-faint">
          Esc to close · Cmd/Ctrl+Enter to send
        </div>
      </div>
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="Prompt to broadcast…"
        className="w-full bg-bg border border-line rounded px-2 py-1.5 text-xs text-fg font-mono resize-y focus:outline-none focus:border-fg-faint"
      />
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-[11px] text-fg-dim cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
            className="accent-accent"
          />
          <span>
            All tabs ({checkedCount}/{tabs.length})
          </span>
        </label>
        <div className="flex flex-wrap gap-x-3 gap-y-1 max-h-24 overflow-y-auto pl-4">
          {tabs.map((t) => (
            <label
              key={t.id}
              className="flex items-center gap-1.5 text-[11px] text-fg-dim cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={!!checked[t.id]}
                onChange={(e) =>
                  setChecked((prev) => ({ ...prev, [t.id]: e.target.checked }))
                }
                className="accent-accent"
              />
              <span className="truncate max-w-[12rem]">{t.label}</span>
              {rowStatus[t.id] === 'sent' && (
                <span data-testid="broadcast-row-sent" className="text-[10px] text-green-500">✓</span>
              )}
              {rowStatus[t.id] === 'skipped' && (
                <span data-testid="broadcast-row-skipped" className="text-[10px] text-red-400">×</span>
              )}
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={send}
          disabled={!canSend}
          className="px-2 py-0.5 text-[10px] text-fg border border-accent-muted hover:border-accent rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sendLabel}
        </button>
      </div>
    </div>
  )
}
