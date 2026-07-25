import { describe, it, expect } from 'vitest'
import { measureValue, buildHeadline, buildProjectRows, type Measure } from '../analyticsViewModel'
import type { FacetResult } from '../historyFacet'

function totals(over: Partial<Record<string, number>> = {}) {
  return {
    promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, toolCallCount: 0, sessionCount: 0, errorCount: 0,
    activeMinutes: 0, estimatedCostUsd: 0, ...over,
  }
}

describe('measureValue', () => {
  it('defines In = input + cacheRead + cacheCreation; Out = output; Total = In + Out', () => {
    const t = totals({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 5 })
    expect(measureValue(t, 'in')).toBe(125)
    expect(measureValue(t, 'out')).toBe(50)
    expect(measureValue(t, 'total')).toBe(175)
  })

  it('maps the remaining measures straight through', () => {
    const t = totals({ promptCount: 3, sessionCount: 2, activeMinutes: 40, estimatedCostUsd: 1.25 })
    const cases: [Measure, number][] = [['prompts', 3], ['sessions', 2], ['time', 40], ['spend', 1.25]]
    for (const [m, expected] of cases) expect(measureValue(t, m)).toBe(expected)
  })
})

describe('buildHeadline', () => {
  const facet: FacetResult = {
    days: [
      { date: '2026-07-01', totals: totals({ estimatedCostUsd: 10 }) },
      { date: '2026-07-02', totals: totals({ estimatedCostUsd: 20 }) },
    ],
    totals: totals({ estimatedCostUsd: 30 }),
    prevTotals: totals({ estimatedCostUsd: 20 }),
    prevAvailable: true,
    byModelTotals: {},
    activeDays: 2,
  }

  it('computes value, delta, and a per-day series for the active measure', () => {
    const h = buildHeadline(facet, 'spend')
    expect(h.value).toBe(30)
    expect(h.delta?.pct).toBeCloseTo(50, 5) // (30-20)/20 * 100
    expect(h.series).toEqual([10, 20])
  })

  it('hides delta when the facet has no prior-window data', () => {
    const h = buildHeadline({ ...facet, prevAvailable: false }, 'spend')
    expect(h.delta).toBeNull()
  })
})

describe('buildProjectRows', () => {
  it('splits the range into first/second half per project and ranks by the active measure', () => {
    const days = [
      { date: '2026-07-01', byProject: { a: rowFor('a', 10), b: rowFor('b', 40) } },
      { date: '2026-07-02', byProject: { a: rowFor('a', 90) } },
    ]
    const rows = buildProjectRows(days as any, 'spend')
    expect(rows[0].projectDir).toBe('a') // 100 total > b's 40
    expect(rows[0].value).toBe(100)
    expect(rows[1].projectDir).toBe('b')
    expect(rows[0].sharePct).toBeCloseTo((100 / 140) * 100, 5)
  })
})

function rowFor(projectDir: string, costUsd: number) {
  return {
    date: '2026-07-01', projectDir,
    promptCount: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 1, toolBreakdown: { Read: 1 }, sessionCount: 1, errorCount: 0, activeMinutes: 5,
    estimatedCostUsd: costUsd, byModel: {},
  }
}
