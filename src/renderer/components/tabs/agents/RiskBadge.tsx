import type { ReactNode } from 'react'

/** The one risk-mark badge: a non-honey danger tone (honey = needs a decision). */
export function RiskBadge({ children, mark, className = '' }: { children: ReactNode; mark?: string; className?: string }) {
  return (
    <span data-badge="risky" data-mark={mark} className={`shrink-0 px-1 rounded text-[9.5px] uppercase tracking-wide bg-delta-bad/15 text-delta-bad ${className}`.trim()}>
      {children}
    </span>
  )
}
