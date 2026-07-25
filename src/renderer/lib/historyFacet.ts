// Client-side project faceting for the History analytics view. Recomputes
// totals/model-mix/active-days from the per-project day buckets already
// loaded from `history:dashboard` — never a new IPC round-trip.
import type { HistoryDashboardDay, HistoryDashboardProjectRow, HistoryDashboardTotals } from '../../preload/api'

export interface ModelBucket {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  estimated?: boolean
}

export interface FacetInput {
  days: HistoryDashboardDay[]
  totals: HistoryDashboardTotals
  prevTotals: HistoryDashboardTotals
}

export interface FacetedDay {
  date: string
  totals: HistoryDashboardTotals
}

export interface FacetResult {
  days: FacetedDay[]
  totals: HistoryDashboardTotals
  /**
   * `history:dashboard` only tracks the prior-period total in aggregate, not
   * broken out per project — so a faceted (non-"all projects") slice has no
   * honest prior-period figure to compare against. `prevAvailable` is false
   * whenever a facet narrower than "all projects" is applied; callers should
   * hide the delta chip rather than show a number computed against the wrong
   * population.
   */
  prevTotals: HistoryDashboardTotals
  prevAvailable: boolean
  byModelTotals: Record<string, ModelBucket>
  activeDays: number
}

function emptyTotals(): HistoryDashboardTotals {
  return {
    promptCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 0,
    sessionCount: 0,
    errorCount: 0,
    activeMinutes: 0,
    estimatedCostUsd: 0,
  }
}

function addRowToTotals(totals: HistoryDashboardTotals, row: HistoryDashboardProjectRow): void {
  totals.promptCount += row.promptCount
  totals.inputTokens += row.inputTokens
  totals.outputTokens += row.outputTokens
  totals.cacheReadTokens += row.cacheReadTokens
  totals.cacheCreationTokens += row.cacheCreationTokens
  totals.toolCallCount += row.toolCallCount
  totals.sessionCount += row.sessionCount
  totals.errorCount += row.errorCount
  totals.activeMinutes += row.activeMinutes
  totals.estimatedCostUsd += row.estimatedCostUsd
}

function rowHasActivity(row: HistoryDashboardProjectRow): boolean {
  return row.promptCount > 0 || row.sessionCount > 0 || row.toolCallCount > 0 ||
    row.inputTokens > 0 || row.outputTokens > 0
}

/** null keep = every project ("show all"); a Set (possibly empty) = only those projectDirs. */
export function facetSlice(data: FacetInput, keep: Set<string> | null): FacetResult {
  const keepAll = keep === null
  const days: FacetedDay[] = []
  const totals = emptyTotals()
  const byModelTotals: Record<string, ModelBucket> = {}
  let activeDays = 0

  for (const day of data.days) {
    const dayTotals = emptyTotals()
    let dayHasData = false
    for (const [projectDir, row] of Object.entries(day.byProject)) {
      if (!keepAll && !keep!.has(projectDir)) continue
      addRowToTotals(dayTotals, row)
      addRowToTotals(totals, row)
      if (rowHasActivity(row)) dayHasData = true
      for (const [modelId, mb] of Object.entries(row.byModel)) {
        const dst = byModelTotals[modelId] ?? (byModelTotals[modelId] = {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
        })
        dst.inputTokens += mb.inputTokens
        dst.outputTokens += mb.outputTokens
        dst.cacheReadTokens += mb.cacheReadTokens
        dst.cacheCreationTokens += mb.cacheCreationTokens
        dst.costUsd += mb.costUsd
        if (mb.estimated) dst.estimated = true
      }
    }
    if (dayHasData) activeDays += 1
    days.push({ date: day.date, totals: dayTotals })
  }

  return {
    days,
    totals,
    prevTotals: keepAll ? data.prevTotals : emptyTotals(),
    prevAvailable: keepAll,
    byModelTotals,
    activeDays,
  }
}
