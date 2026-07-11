// Pure math helpers for HistoryDashboard's prior-period delta chips and
// monthly budget projection card. Kept colocated but framework-free so they
// can be unit-tested without mounting the component.

export type DeltaDirection = 'up' | 'down' | 'flat'

export interface Delta {
  /** Percentage change vs. the previous period, or null if previous was 0 (undefined %). */
  pct: number | null
  direction: DeltaDirection
}

// O(1). previous === 0 is treated as "no baseline" (division by zero) rather
// than an infinite/undefined percentage — callers render "—" for this case.
export function computeDelta(current: number, previous: number): Delta {
  if (!previous) return { pct: null, direction: 'flat' }
  const pct = ((current - previous) / previous) * 100
  const direction: DeltaDirection = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
  return { pct, direction }
}

// O(1). Straight-line run-rate: spend-per-day-so-far extrapolated across the
// full month. daysElapsed <= 0 has no rate to extrapolate from.
export function computeBudgetProjection(mtdSpend: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return 0
  return (mtdSpend / daysElapsed) * daysInMonth
}
