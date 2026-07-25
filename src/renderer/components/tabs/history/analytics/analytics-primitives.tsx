// Shared visual language for the History analytics dashboard (Almanac paper
// palette). Single source for the card shell + serif/mono typographic
// hierarchy so no panel improvises its own scale or hex literals.
import type { ReactNode } from 'react'

export const CARD = 'rounded-card bg-bg-hi border border-line'

// Mirrors tailwind.config.js `colors.muteband` / `colors.sage` — SVG
// `fill`/`stroke` attrs take a raw color value, not a Tailwind class, so
// these are the one place those hexes are allowed to live outside the
// config.
export const MUTEBAND_HEX = '#ded2bd'
export const SAGE_HEX = '#6f7d52'

interface SectionHeadProps {
  kicker: string
  title: string
  right?: ReactNode
}

export function SectionHead({ kicker, title, right }: SectionHeadProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <div>
        <div className="text-[10.5px] uppercase tracking-wider text-accent font-mono">{kicker}</div>
        <h2 className="font-serif text-[25px] leading-tight tracking-tight text-fg">{title}</h2>
      </div>
      {right}
    </div>
  )
}
