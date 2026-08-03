/**
 * HomeSessionDrawer — right-side slide-in detail panel for an Active or
 * Recent session row on the Home dashboard (Home Screen A design's `ADrawer`
 * pattern, variants/home-a.jsx). Generic host: callers pass real KeyVals +
 * an optional live-tail + footer actions; this component owns only the
 * slide-in shell (backdrop, header, scroll body, footer), matching this
 * app's existing Modal.tsx conventions (portal, ESC closes, backdrop-click
 * closes) rather than inventing a new dialog primitive from scratch.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface DrawerKeyVal {
  label: string
  value: ReactNode
}

export interface DrawerTailLine {
  id: string
  role: string
  text: string
}

export interface HomeSessionDrawerProps {
  open: boolean
  onClose: () => void
  title: string
  sub?: string | null
  keyVals: DrawerKeyVal[]
  tail?: DrawerTailLine[]
  footer?: ReactNode
  /** Arbitrary body content rendered above keyVals — e.g. the New-epic
   *  project picker's radio list. Callers with no keyVals (an empty array)
   *  simply render nothing from the `<dl>` below. */
  children?: ReactNode
}

export function HomeSessionDrawer({ open, onClose, title, sub, keyVals, tail, footer, children }: HomeSessionDrawerProps) {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (!open) {
      setEntered(false)
      return
    }
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const node = (
    <div className="fixed inset-0 z-50" data-testid="home-drawer-root">
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-[220ms] ${entered ? 'opacity-100' : 'opacity-0'}`}
        onClick={onBackdropClick}
        data-testid="home-drawer-backdrop"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`absolute top-0 right-0 h-full w-full max-w-[420px] bg-bg-hi border-l border-line shadow-xl flex flex-col transition-transform duration-[220ms] ${
          entered ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(.32,.72,.28,1)' }}
        data-testid="home-drawer"
      >
        <header className="px-5 py-4 border-b border-line flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="m-0 font-serif text-[18px] font-semibold text-fg truncate">{title}</h2>
            {sub && <div className="text-[12px] text-fg-faint truncate mt-0.5">{sub}</div>}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md border border-line bg-bg px-2.5 py-1 text-[12px] font-semibold text-fg-dim hover:bg-bg-elev"
            aria-label="Close"
          >
            Close
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 grid gap-4 content-start">
          {children}
          {keyVals.length > 0 && (
            <dl className="m-0 grid gap-2" style={{ gridTemplateColumns: 'minmax(0,100px) minmax(0,1fr)' }}>
              {keyVals.map((kv) => (
                <div key={kv.label} className="contents">
                  <dt className="m-0 font-mono text-[11px] uppercase tracking-[0.05em] text-fg-faint">{kv.label}</dt>
                  <dd className="m-0 text-[12.5px] text-fg break-words">{kv.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {tail && tail.length > 0 && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-2">Live tail</div>
              <div className="grid gap-2">
                {tail.map((line) => (
                  <div key={line.id} className="bg-bg border border-line rounded-lg px-3 py-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-fg-faint mb-1">{line.role}</div>
                    <div className="text-[12px] text-fg-dim leading-[1.5] whitespace-pre-wrap break-words line-clamp-6">
                      {line.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {footer && (
          <footer className="px-5 py-3.5 border-t border-line flex gap-2 justify-end shrink-0">{footer}</footer>
        )}
      </aside>
    </div>
  )

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
