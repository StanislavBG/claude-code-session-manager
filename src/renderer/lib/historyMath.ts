// Pure math helpers for HistoryDashboard's prior-period delta chips and
// monthly budget projection card. Kept colocated but framework-free so they
// can be unit-tested without mounting the component.

import type { HistoryDashboardProjectRow, HistoryDashboardTotals } from '../../preload/api'

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

export type DayModelBucket = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export type SummedDayTotals = HistoryDashboardTotals & { byModel: Record<string, DayModelBucket> }

const TOTAL_KEYS = [
  'promptCount', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
  'toolCallCount', 'sessionCount', 'errorCount', 'activeMinutes', 'estimatedCostUsd',
] as const
const MODEL_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'] as const

// O(rows * models). Sums the ten totals fields and merges byModel buckets by
// model id across day rows. Missing/non-finite fields count as 0, never NaN.
export function sumDayTotals(
  days: ReadonlyArray<Partial<Omit<HistoryDashboardProjectRow, 'byModel'>> & { byModel?: Record<string, Partial<DayModelBucket>> }>,
): SummedDayTotals {
  const out: SummedDayTotals = {
    promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 0, sessionCount: 0, errorCount: 0, activeMinutes: 0, estimatedCostUsd: 0,
    byModel: {},
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  for (const day of days) {
    for (const k of TOTAL_KEYS) out[k] += num(day[k])
    for (const [modelId, mb] of Object.entries(day.byModel ?? {})) {
      const dst = out.byModel[modelId] ?? (out.byModel[modelId] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 })
      for (const k of MODEL_KEYS) dst[k] += num(mb?.[k])
    }
  }
  return out
}
