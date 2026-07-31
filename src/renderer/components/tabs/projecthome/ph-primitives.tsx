/**
 * Shared block chrome for ProjectHome ("The Brief") sections — mono uppercase
 * accent kicker + serif h2 + faint note line, translated from the mock's
 * `PhBlock` (project-home-mock.jsx) to Tailwind Almanac tokens. Status pills
 * reuse `components/epics/epic-primitives.tsx` rather than the mock's own
 * hex `PH_ST` map.
 */
import type { ReactNode } from 'react'

interface PhBlockProps {
  kicker: string
  title: string
  note?: string
  children: ReactNode
}

export function PhBlock({ kicker, title, note, children }: PhBlockProps) {
  return (
    <section className="mb-7">
      <div className="mb-3">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-accent mb-1">{kicker}</div>
        <h2 className="font-serif text-xl font-semibold text-fg leading-tight">{title}</h2>
        {note && <p className="mt-1 text-xs text-fg-faint leading-relaxed">{note}</p>}
      </div>
      {children}
    </section>
  )
}

export function PhCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-bg-hi ${className}`}>{children}</div>
}
