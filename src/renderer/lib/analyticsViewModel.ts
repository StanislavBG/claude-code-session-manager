// Maps the raw `history:dashboard` payload (post-facet) into the values each
// analytics panel renders: the active measure, the headline band, and the
// per-project ranking rows.
import type { HistoryDashboardDay, HistoryDashboardProjectRow, HistoryDashboardTotals } from '../../preload/api'
import { computeDelta, type Delta } from './historyMath'
import type { FacetResult } from './historyFacet'

export type Measure = 'in' | 'out' | 'total' | 'prompts' | 'sessions' | 'time' | 'spend'

export const MEASURE_LABELS: Record<Measure, string> = {
  in: 'In tokens',
  out: 'Out tokens',
  total: 'Total tokens',
  prompts: 'Prompts',
  sessions: 'Sessions',
  time: 'Time',
  spend: 'Spend',
}

/**
 * Token-measure definitions — single source of truth for every panel:
 *   In    = inputTokens + cacheReadTokens + cacheCreationTokens (all tokens submitted)
 *   Out   = outputTokens
 *   Total = In + Out
 */
export function measureValue(t: HistoryDashboardTotals, measure: Measure): number {
  const inTokens = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens
  switch (measure) {
    case 'in': return inTokens
    case 'out': return t.outputTokens
    case 'total': return inTokens + t.outputTokens
    case 'prompts': return t.promptCount
    case 'sessions': return t.sessionCount
    case 'time': return t.activeMinutes
    case 'spend': return t.estimatedCostUsd
  }
}

export interface Headline {
  value: number
  delta: Delta | null
  series: number[]
}

export function buildHeadline(facet: FacetResult, measure: Measure): Headline {
  const value = measureValue(facet.totals, measure)
  const delta = facet.prevAvailable ? computeDelta(value, measureValue(facet.prevTotals, measure)) : null
  const series = facet.days.map((d) => measureValue(d.totals, measure))
  return { value, delta, series }
}

export interface ProjectRankRow {
  projectDir: string
  value: number
  sharePct: number
  trend: Delta
  sessions: number
  topTool: string
}

/** First-half vs second-half of the range stands in for a per-project prior-period delta (the IPC has no per-project prevTotals). */
export function buildProjectRows(days: HistoryDashboardDay[], measure: Measure): ProjectRankRow[] {
  const byProject = new Map<string, { totals: HistoryDashboardTotals; toolBreakdown: Record<string, number>; firstHalf: number; secondHalf: number }>()
  const mid = Math.ceil(days.length / 2)

  days.forEach((day, i) => {
    for (const [projectDir, row] of Object.entries(day.byProject) as [string, HistoryDashboardProjectRow][]) {
      let agg = byProject.get(projectDir)
      if (!agg) {
        agg = {
          totals: {
            promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            toolCallCount: 0, sessionCount: 0, errorCount: 0, activeMinutes: 0, estimatedCostUsd: 0,
          },
          toolBreakdown: {},
          firstHalf: 0,
          secondHalf: 0,
        }
        byProject.set(projectDir, agg)
      }
      agg.totals.promptCount += row.promptCount
      agg.totals.inputTokens += row.inputTokens
      agg.totals.outputTokens += row.outputTokens
      agg.totals.cacheReadTokens += row.cacheReadTokens
      agg.totals.cacheCreationTokens += row.cacheCreationTokens
      agg.totals.toolCallCount += row.toolCallCount
      agg.totals.sessionCount += row.sessionCount
      agg.totals.errorCount += row.errorCount
      agg.totals.activeMinutes += row.activeMinutes
      agg.totals.estimatedCostUsd += row.estimatedCostUsd
      for (const [tool, cnt] of Object.entries(row.toolBreakdown)) {
        agg.toolBreakdown[tool] = (agg.toolBreakdown[tool] ?? 0) + cnt
      }
      const v = measureValue(row, measure)
      if (i < mid) agg.firstHalf += v
      else agg.secondHalf += v
    }
  })

  const rows: ProjectRankRow[] = Array.from(byProject.entries()).map(([projectDir, agg]) => {
    let topTool = ''
    let topCnt = -1
    for (const [tool, cnt] of Object.entries(agg.toolBreakdown)) {
      if (cnt > topCnt) { topCnt = cnt; topTool = tool }
    }
    return {
      projectDir,
      value: measureValue(agg.totals, measure),
      sharePct: 0,
      trend: computeDelta(agg.secondHalf, agg.firstHalf),
      sessions: agg.totals.sessionCount,
      topTool,
    }
  })

  const grandTotal = rows.reduce((sum, r) => sum + r.value, 0)
  for (const r of rows) r.sharePct = grandTotal > 0 ? (r.value / grandTotal) * 100 : 0

  return rows.sort((a, b) => b.value - a.value)
}
