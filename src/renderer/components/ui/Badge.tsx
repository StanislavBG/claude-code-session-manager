/**
 * Badge — the shared pill primitive (small uppercase tag with a tinted border).
 * Used for catalog tags, provenance markers, and inline status chips. Keep the
 * tone palette here as the single source of truth so chips never drift.
 */
import type { ReactNode } from 'react'

export type BadgeTone = 'default' | 'accent' | 'warn' | 'dim'

export const BADGE_TONE: Record<BadgeTone, string> = {
  default: 'bg-bg-hi text-fg-dim border-line',
  accent: 'bg-accent/15 text-accent border-accent/30',
  warn: 'bg-yellow-950/30 text-yellow-500/80 border-yellow-900/40',
  dim: 'bg-bg-elev text-fg-faint border-line',
}

export function Badge({
  children,
  tone = 'default',
  className = '',
  title,
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide ${BADGE_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
