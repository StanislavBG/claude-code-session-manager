import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { scrollWithin } from '../../lib/scrollWithin'

/**
 * PageShell — the one shell every sub-menu page renders into.
 *
 * Layout contract:
 *   root (h-full w-full flex flex-col, overflow-clip)
 *   ├─ header   (shrink-0, overflow-clip)            — optional, neutral styling
 *   ├─ body row (flex-1 flex, overflow-clip)
 *   │   ├─ subnav  (overflow-y-auto, overscroll-contain) — optional
 *   │   └─ content (flex-1, overflow-y-auto, overscroll-contain) — the ONE content scroller
 *   └─ footer   (shrink-0, overflow-clip)            — optional
 *
 * WHY `overflow-clip` on the frame boxes (not `overflow-hidden`): a `hidden`
 * box is still a scroll container, so `scrollIntoView`, focus and programmatic
 * scrolls can shift it and leave the frame stuck with no way back. A `clip`
 * box is not a scroll container — nothing can move it. `overscroll-contain` on
 * both scrollers keeps a wheel at the end from chaining out to the page.
 *
 * Implementers jump to a section with `usePageShell().scrollToAnchor(id)`,
 * which scrolls ONLY the content scroller (via `scrollWithin`).
 */

export interface PageShellApi {
  scrollToAnchor(id: string, opts?: { behavior?: ScrollBehavior }): void
  contentRef: RefObject<HTMLDivElement>
}

const PageShellContext = createContext<PageShellApi | null>(null)

export function usePageShell(): PageShellApi {
  const ctx = useContext(PageShellContext)
  if (!ctx) throw new Error('usePageShell() must be used inside a <PageShell>.')
  return ctx
}

interface PageShellProps {
  header?: ReactNode
  subnav?: ReactNode
  footer?: ReactNode
  children: ReactNode
  /** Subnav rail width in px (default 220). Applied inline — never an interpolated class. */
  subnavWidth?: number
}

export function PageShell({ header, subnav, footer, children, subnavWidth = 220 }: PageShellProps) {
  const contentRef = useRef<HTMLDivElement>(null)

  const scrollToAnchor = useCallback((id: string, opts?: { behavior?: ScrollBehavior }) => {
    const content = contentRef.current
    if (!content) return
    // Match by id property (no selector escaping needed); only inside the content scroller.
    let target: HTMLElement | null = null
    for (const el of Array.from(content.querySelectorAll<HTMLElement>('[id]'))) {
      if (el.id === id) { target = el; break }
    }
    if (!target) return
    scrollWithin(content, target, { block: 'start', behavior: opts?.behavior })
  }, [])

  const api = useMemo<PageShellApi>(() => ({ scrollToAnchor, contentRef }), [scrollToAnchor])

  return (
    <PageShellContext.Provider value={api}>
      <div data-testid="page-shell" className="h-full w-full min-h-0 min-w-0 flex flex-col overflow-clip">
        {header != null && (
          <div data-testid="page-shell-header" className="shrink-0 min-w-0 overflow-clip">
            {header}
          </div>
        )}
        <div data-testid="page-shell-body" className="flex-1 min-h-0 min-w-0 flex flex-row overflow-clip">
          {subnav != null && (
            <nav
              data-testid="page-shell-subnav"
              className="shrink-0 min-h-0 overflow-y-auto overscroll-contain"
              style={{ width: subnavWidth }}
            >
              {subnav}
            </nav>
          )}
          <div
            ref={contentRef}
            data-testid="page-shell-content"
            className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain"
          >
            {children}
          </div>
        </div>
        {footer != null && (
          <div data-testid="page-shell-footer" className="shrink-0 min-w-0 overflow-clip">
            {footer}
          </div>
        )}
      </div>
    </PageShellContext.Provider>
  )
}
