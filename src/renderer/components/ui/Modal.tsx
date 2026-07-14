import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Generic modal primitive for F7 (and any future dialog).
 *
 * - Renders via React portal to document.body when available, else inline.
 * - Click on the backdrop (not the dialog) closes.
 * - ESC closes.
 * - Focus trap: focuses the first focusable child on mount, restores focus
 *   to the previously-active element on unmount, and wraps Tab/Shift-Tab
 *   between the first and last focusable elements inside the dialog so
 *   keyboard navigation can't escape into the inert background.
 */
export interface ModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: string
  /** Width preset. Defaults to `sm` (max-w-md, original behavior). */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  /** When true, the dialog fills available vertical space (max-h ~90vh) and
   *  scrolls inside. Use for tab-as-modal hosting where the inner panel
   *  already has its own scroll regions. */
  fillHeight?: boolean
  /** Skip the internal padding. Useful when the child renders its own
   *  header / scope switcher / save bar that should reach the dialog edges. */
  noPadding?: boolean
  /**
   * Render style. Defaults to `overlay` (fixed-position, backdrop, ESC closes,
   * focus trap — the original modal behavior). `page` renders inline at full
   * width with no overlay/backdrop/portal — for using a former-modal as a
   * full-page screen in MainPane (post-v0.13 "no pop-ups" goal).
   */
  variant?: 'overlay' | 'page'
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[min(96vw,1400px)]',
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  children,
  title,
  size = 'sm',
  fillHeight = false,
  noPadding = false,
  variant = 'overlay',
}: ModalProps) {
  // Page variant — render inline (no overlay, no portal, no focus trap, no
  // ESC handler). The host route (MainPane) owns visibility and navigation.
  if (variant === 'page') {
    if (!open) return null
    return (
      <div className="h-full w-full flex flex-col bg-bg">
        {title && (
          <h2 className={`text-base font-medium text-fg ${noPadding ? 'px-6 pt-6 pb-3' : 'px-6 pt-4 pb-2'}`}>
            {title}
          </h2>
        )}
        <div className={`flex-1 min-h-0 flex flex-col ${noPadding ? '' : 'p-6 pt-0'}`}>
          {children}
        </div>
      </div>
    )
  }
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocusedRef = useRef<Element | null>(null)
  // Stable ref to the latest onClose so the keydown effect's deps stay `[open]`.
  // Without this, parents that recreate `onClose` on every render (e.g. wrapping
  // it in a step-dependent useCallback) cause the focus snapshot/restore cycle
  // to thrash on every step transition, restoring focus to a stale element.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return

    // Snapshot the active element so we can restore focus when the modal closes.
    previouslyFocusedRef.current = typeof document !== 'undefined' ? document.activeElement : null

    // Focus the first focusable child after mount. Defer one tick so portaled
    // children are in the DOM before we query.
    const focusFirst = () => {
      const root = dialogRef.current
      if (!root) return
      const first = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      if (first) {
        first.focus()
      } else {
        // Fall back to focusing the dialog itself (tabindex=-1) so ESC works.
        root.focus()
      }
    }
    const t = setTimeout(focusFirst, 0)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      // Focus trap: cycle focus between the first and last focusable
      // elements inside the dialog. Without this, Tab past the last button
      // moves focus to the host page (LeftNav, terminal, etc.), which is
      // confusing in a modal context. Querying live each time keeps the
      // trap correct when buttons appear/disappear between steps.
      if (e.key === 'Tab') {
        const root = dialogRef.current
        if (!root) return
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
        if (focusables.length === 0) {
          // Nothing focusable — pin focus to the dialog itself.
          e.preventDefault()
          root.focus()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (active === last || !root.contains(active)) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('keydown', onKey)

    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      const prev = previouslyFocusedRef.current
      if (prev && prev instanceof HTMLElement) {
        try { prev.focus() } catch { /* element may have unmounted */ }
      }
      previouslyFocusedRef.current = null
    }
  }, [open])

  if (!open) return null

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const node = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onBackdropClick}
      data-testid="modal-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Dialog'}
        tabIndex={-1}
        className={`bg-bg-elev border border-line rounded-lg shadow-xl w-full mx-4 outline-none flex flex-col break-words ${SIZE_CLASS[size]} ${
          fillHeight ? 'max-h-[90vh] h-[90vh]' : ''
        } ${noPadding ? '' : 'p-6'}`}
        data-testid="modal-dialog"
      >
        {title ? <h2 className={`text-base font-medium text-fg break-words ${noPadding ? 'px-6 pt-6 pb-3' : 'mb-3'}`}>{title}</h2> : null}
        {/* When fillHeight is on, the dialog is a vertical flex container and
         *  children are expected to manage their own scroll. When off, no
         *  layout wrapper is added so existing small-dialog callers
         *  (MicWizard, BootBadDialog) keep behaving exactly as before. */}
        {fillHeight ? (
          <div className="flex-1 min-h-0 flex flex-col">{children}</div>
        ) : (
          children
        )}
      </div>
    </div>
  )

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
