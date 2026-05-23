import { type ReactNode } from 'react'
import { Modal } from '../ui/Modal'
import { ErrorBoundary } from '../ui/ErrorBoundary'

/**
 * TabModal — hosts a former-tab component inside a large modal overlay.
 * Wraps the body in our existing ErrorBoundary so a broken tab doesn't take
 * down the rest of the app shell. The Header bar inside the dialog repeats
 * the title and offers a close button (✕) so the modal feels distinct from
 * the screen-level pages reachable via Header tabs.
 */
export function TabModal({
  open,
  onClose,
  title,
  children,
  variant = 'overlay',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** 'overlay' (default) — fixed-position dialog. 'page' — render inline at
   *  full width with no overlay; the host route owns visibility. */
  variant?: 'overlay' | 'page'
}) {
  return (
    <Modal open={open} onClose={onClose} size="xl" fillHeight noPadding title={undefined} variant={variant}>
      {variant === 'overlay' && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-line shrink-0">
          <h2 className="text-xs uppercase tracking-wider text-fg-dim">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="px-2 py-0.5 text-fg-dim hover:text-fg hover:bg-bg-hi rounded text-base leading-none"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        <ErrorBoundary>{children}</ErrorBoundary>
      </div>
    </Modal>
  )
}
