import { useEffect, useRef, useState } from 'react'
import { useToast, type NotificationRecord, type ToastKind } from '../../state/toast'
import { Tooltip } from '../ui/Tooltip'

/**
 * Notification Center — bell icon + dropdown panel of past toasts.
 *
 * Drinks from `useToast`'s history (every `toast.info/warn/error` is
 * appended automatically). Toasts are ephemeral (auto-dismiss in 5s);
 * the history persists so the user can review what they missed.
 *
 * No animation beyond default tailwind transitions. Closes on click
 * outside or Escape. The bell mirrors the Header's IconButton style so
 * it fits inline with VoiceButton / SchedulerButton.
 */

const KIND_META: Record<ToastKind, { glyph: string; label: string; tone: string }> = {
  info: { glyph: 'ℹ', label: 'Info', tone: 'text-fg-dim' },
  warn: { glyph: '⚠', label: 'Warn', tone: 'text-amber-300' },
  error: { glyph: '✖', label: 'Error', tone: 'text-red-300' },
}

function formatRelative(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(ts).toLocaleDateString()
}

export function NotificationCenter() {
  const history = useToast((s) => s.history)
  const unreadCount = useToast((s) => s.unreadCount)
  const markAllRead = useToast((s) => s.markAllRead)
  const clearHistory = useToast((s) => s.clearHistory)
  const dismissEntry = useToast((s) => s.dismissHistoryEntry)

  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Refresh relative timestamps once per minute while panel is open.
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [open])

  // Outside click + Escape.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const tooltip =
    unreadCount > 0
      ? `Notifications — ${unreadCount} unread`
      : history.length > 0
        ? 'Notifications'
        : 'Notifications — none yet'

  return (
    <div className="relative" ref={rootRef}>
      <Tooltip content={tooltip}>
        <button
          type="button"
          aria-label={tooltip}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => {
            setOpen((v) => !v)
            if (!open) setNow(Date.now())
          }}
          className={`relative px-2 self-center h-7 rounded text-sm flex items-center justify-center transition-colors ${
            open ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi/60'
          }`}
        >
          <span aria-hidden="true">🔔</span>
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 leading-none px-1 rounded bg-accent text-bg text-[8px] font-mono"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </Tooltip>

      {open && (
        <div
          role="dialog"
          aria-label="Notification center"
          className="absolute top-full right-0 mt-1 z-50 w-[360px] max-h-[480px] bg-bg-elev border border-line rounded shadow-lg flex flex-col"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-line">
            <div className="text-xs font-mono uppercase tracking-wider text-fg-dim">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-2 px-1 rounded bg-accent/20 text-accent text-[9px]">
                  {unreadCount} new
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close notifications"
              className="text-fg-faint hover:text-fg text-xs leading-none"
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-fg-faint">
                No notifications yet.
              </div>
            ) : (
              <ul role="list" className="divide-y divide-line">
                {history.map((r) => (
                  <NotificationRow
                    key={r.id}
                    record={r}
                    now={now}
                    onDismiss={() => dismissEntry(r.id)}
                  />
                ))}
              </ul>
            )}
          </div>

          {history.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-line text-xs">
              <button
                type="button"
                onClick={markAllRead}
                disabled={unreadCount === 0}
                className="text-fg-dim hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Mark all read
              </button>
              <button
                type="button"
                onClick={clearHistory}
                className="text-fg-dim hover:text-red-300"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NotificationRow({
  record,
  now,
  onDismiss,
}: {
  record: NotificationRecord
  now: number
  onDismiss: () => void
}) {
  const meta = KIND_META[record.kind]
  return (
    <li
      data-kind={record.kind}
      data-read={record.read}
      className={`px-3 py-2 flex items-start gap-2 text-xs ${record.read ? 'opacity-70' : ''}`}
    >
      <span className={`font-mono text-[10px] uppercase tracking-wider shrink-0 ${meta.tone}`}>
        {meta.glyph}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-fg-dim break-words">{record.message}</div>
        <div className="mt-0.5 text-[10px] text-fg-faint font-mono">
          {meta.label} · {formatRelative(record.createdAt, now)} ago
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 text-fg-faint hover:text-fg leading-none"
      >
        ×
      </button>
    </li>
  )
}
