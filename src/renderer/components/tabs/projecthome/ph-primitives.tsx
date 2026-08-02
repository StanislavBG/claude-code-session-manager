/**
 * Shared block chrome for ProjectHome ("The Brief") sections — mono uppercase
 * accent kicker + serif h2 + faint note line, translated from the mock's
 * `PhBlock` (project-home-mock.jsx) to Tailwind Almanac tokens. Status pills
 * reuse `components/epics/epic-primitives.tsx` rather than the mock's own
 * hex `PH_ST` map.
 */
import type { CSSProperties, ReactNode } from 'react'
import { AlmanacIcon } from '../../layout/AlmanacIcon'

interface PhBlockProps {
  kicker: string
  title: string
  note?: string
  children: ReactNode
  /** Pinnable blocks (What this is / Conventions): current pin state + toggle handler. */
  pinned?: boolean
  onPin?: () => void
  /** Optional content flush-right of the kicker/title column (unused today, mirrors the mock's `right` slot). */
  right?: ReactNode
}

export function PhBlock({ kicker, title, note, children, pinned, onPin, right }: PhBlockProps) {
  return (
    <section className="mb-7">
      <div className="mb-3 flex items-end gap-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-accent">{kicker}</span>
            {onPin && (
              <button
                type="button"
                onClick={onPin}
                title={pinned ? 'Pinned — refreshes will not overwrite this' : 'Pin so refreshes leave it alone'}
                className={`inline-flex ${pinned ? 'text-accent' : 'text-fg-faint opacity-45 hover:opacity-70'}`}
              >
                <AlmanacIcon name="star" size={12} />
              </button>
            )}
          </div>
          <h2 className="font-serif text-xl font-semibold text-fg leading-tight">{title}</h2>
          {note && <p className="mt-1 text-xs text-fg-faint leading-relaxed">{note}</p>}
        </div>
        {right && <span className="ml-auto pb-0.5 shrink-0">{right}</span>}
      </div>
      {children}
    </section>
  )
}

export function PhCard({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={`rounded-xl border border-line bg-bg-hi ${className}`} style={style}>
      {children}
    </div>
  )
}
