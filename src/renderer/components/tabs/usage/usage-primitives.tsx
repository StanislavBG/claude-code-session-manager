// Shared Almanac tone helper for Usage tab (meters + burn-rate projection).
// Single source of truth for the 70/90 thresholds and tone→class mapping.

export type TierTone = {
  dot: string   // bg-* class for the status dot
  bar: string   // bg-* class for the progress bar fill
  track: string // bg-* class for the bar track
  text: string  // text-* class for the percentage label
}

// ok (calm sage) → caution honey (≥70%) → alert accent/terracotta (≥90%)
export function tierTone(util: number): TierTone {
  if (util >= 90)
    return { dot: 'bg-accent', bar: 'bg-accent', track: 'bg-accent/15', text: 'text-accent' }
  if (util >= 70)
    return { dot: 'bg-honey', bar: 'bg-honey', track: 'bg-honey/15', text: 'text-honey-dark' }
  return { dot: 'bg-sage', bar: 'bg-sage', track: 'bg-sage/15', text: 'text-sage' }
}

// Compact token-count formatting (1.2M / 340k / 12) — shared by TopologyHeader
// and SessionMatrix so the two Usage-tab surfaces never drift apart.
export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}
