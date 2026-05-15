import { useToast, type ToastKind } from '../../state/toast'

/**
 * Toast host. Mount once at the App root. Stacks in bottom-right at
 * z-[55] — below RecordingStatus (z-[60]) and above Modal/CommandPalette
 * (z-50) so dialog overlays never hide user-facing error messages.
 *
 * Errors get role="alert" (assertive); info/warn get role="status" (polite).
 */

const KIND_STYLE: Record<ToastKind, { border: string; text: string; label: string }> = {
  info: { border: 'border-line', text: 'text-fg', label: 'Notice' },
  warn: { border: 'border-amber-700', text: 'text-amber-200', label: 'Warning' },
  error: { border: 'border-red-700', text: 'text-red-200', label: 'Error' },
}

export function Toast() {
  const toasts = useToast((s) => s.toasts)
  const dismiss = useToast((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div
      data-testid="toast-host"
      className="fixed bottom-3 right-3 z-[55] flex flex-col gap-1.5 pointer-events-none"
    >
      {toasts.map((t) => {
        const s = KIND_STYLE[t.kind]
        return (
          <div
            key={t.id}
            data-testid="toast"
            data-kind={t.kind}
            role={t.kind === 'error' ? 'alert' : 'status'}
            aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
            className={`pointer-events-auto min-w-[240px] max-w-[420px] bg-bg-elev border ${s.border} rounded shadow-lg px-3 py-2 text-xs flex items-start gap-2`}
          >
            <span className={`font-mono text-[10px] uppercase tracking-wider shrink-0 ${s.text}`}>
              {s.label}
            </span>
            <span className="flex-1 text-fg-dim break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="shrink-0 text-fg-faint hover:text-fg text-xs leading-none"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
