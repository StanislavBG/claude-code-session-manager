import { describe, it, expect } from 'vitest'
import { facetSlice, type FacetInput } from '../historyFacet'

function totals(over: Partial<Record<string, number>> = {}) {
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
    ...over,
  }
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    date: '2026-07-01',
    projectDir: 'proj-a',
    promptCount: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    toolCallCount: 2,
    toolBreakdown: {},
    sessionCount: 1,
    errorCount: 0,
    activeMinutes: 10,
    estimatedCostUsd: 1.5,
    byModel: {
      'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, costUsd: 1.5 },
    },
    ...over,
  } as any
}

const fixture: FacetInput = {
  days: [
    {
      date: '2026-07-01',
      byProject: {
        'proj-a': row({ projectDir: 'proj-a' }),
        'proj-b': row({
          projectDir: 'proj-b',
          promptCount: 3,
          inputTokens: 300,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          sessionCount: 2,
          activeMinutes: 30,
          estimatedCostUsd: 2.0,
          byModel: { 'claude-opus-4-7': { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 2.0 } },
        }),
      },
    },
    {
      date: '2026-07-02',
      byProject: {},
    },
  ],
  totals: totals({ promptCount: 4, inputTokens: 400, outputTokens: 70, cacheReadTokens: 10, cacheCreationTokens: 5, sessionCount: 3, activeMinutes: 40, estimatedCostUsd: 3.5, toolCallCount: 4 }),
  prevTotals: totals({ promptCount: 2, estimatedCostUsd: 1.0 }),
}

describe('facetSlice', () => {
  it('keep-all (null) is identity for totals and passes prevTotals through', () => {
    const result = facetSlice(fixture, null)
    expect(result.totals).toEqual(fixture.totals)
    expect(result.prevTotals).toEqual(fixture.prevTotals)
    expect(result.prevAvailable).toBe(true)
    expect(result.activeDays).toBe(1)
  })

  it('keep-none (empty set) is a zeroed slice', () => {
    const result = facetSlice(fixture, new Set())
    expect(result.totals).toEqual(totals())
    expect(result.prevAvailable).toBe(false)
    expect(result.prevTotals).toEqual(totals())
    expect(result.activeDays).toBe(0)
  })

  it('rescales model mix to only the kept projects', () => {
    const result = facetSlice(fixture, new Set(['proj-a']))
    expect(Object.keys(result.byModelTotals)).toEqual(['claude-sonnet-4-6'])
    expect(result.byModelTotals['claude-sonnet-4-6'].inputTokens).toBe(100)
  })

  it('recounts active days for the facet', () => {
    const result = facetSlice(fixture, new Set(['proj-b']))
    expect(result.activeDays).toBe(1)
    expect(result.totals.sessionCount).toBe(2)
    expect(result.days).toHaveLength(2)
  })
})

describe('facetSlice byLauncherTotals', () => {
  const lb = (costUsd: number, sessionCount: number, inputTokens = 0) => ({
    inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd, sessionCount,
  })
  const launcherFixture: FacetInput = {
    days: [
      {
        date: '2026-07-01',
        byProject: {
          'proj-a': row({ projectDir: 'proj-a', byLauncher: { epic: lb(1, 1, 60), job: lb(0.5, 1, 40) } }),
          'proj-b': row({ projectDir: 'proj-b', byLauncher: { other: lb(2, 2, 300) } }),
          // A raw (unfolded) row carries no byLauncher and adds nothing.
          'proj-c': row({ projectDir: 'proj-c' }),
        },
      },
      {
        date: '2026-07-02',
        byProject: {
          'proj-a': row({ projectDir: 'proj-a', byLauncher: { epic: lb(0.25, 1, 10) } }),
        },
      },
    ],
    totals: totals(),
    prevTotals: totals(),
  }

  it('sums every launcher bucket over all projects and days', () => {
    const r = facetSlice(launcherFixture, null)
    expect(r.byLauncherTotals.epic).toEqual(lb(1.25, 2, 70))
    expect(r.byLauncherTotals.job).toEqual(lb(0.5, 1, 40))
    expect(r.byLauncherTotals.other).toEqual(lb(2, 2, 300))
  })

  it('sums only the kept projects under a project filter', () => {
    const r = facetSlice(launcherFixture, new Set(['proj-a', 'proj-c']))
    expect(r.byLauncherTotals.epic).toEqual(lb(1.25, 2, 70))
    expect(r.byLauncherTotals.job).toEqual(lb(0.5, 1, 40))
    expect(r.byLauncherTotals.other).toBeUndefined()
  })

  it('is empty when no row carries byLauncher', () => {
    expect(facetSlice(fixture, null).byLauncherTotals).toEqual({})
  })
})
