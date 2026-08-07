import { describe, it, expect } from 'vitest'
import { foldHistoryDaysByCwd, hasExclusions, describeExclusions } from '../historyProjectFold'
import type { HistoryDashboardDay, HistoryDashboardProjectRow } from '../../../preload/api'

function row(projectDir: string, over: Partial<HistoryDashboardProjectRow> = {}): HistoryDashboardProjectRow {
  return {
    date: '2026-08-01',
    projectDir,
    promptCount: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 2,
    sessionCount: 1,
    errorCount: 0,
    activeMinutes: 5,
    estimatedCostUsd: 0.5,
    toolBreakdown: { Bash: 2 },
    byModel: { opus: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 } },
    ...over,
  }
}

function day(date: string, byProject: Record<string, HistoryDashboardProjectRow>): HistoryDashboardDay {
  return { date, byProject }
}

describe('foldHistoryDaysByCwd', () => {
  it('re-keys every project row from encoded transcript folder to resolved cwd', () => {
    const days = [day('2026-08-01', { '-home-bilko-Projects-foo': row('-home-bilko-Projects-foo') })]
    const { days: out } = foldHistoryDaysByCwd(days, { '-home-bilko-Projects-foo': '/home/bilko/Projects/foo' })
    expect(Object.keys(out[0].byProject)).toEqual(['/home/bilko/Projects/foo'])
    expect(out[0].byProject['/home/bilko/Projects/foo'].projectDir).toBe('/home/bilko/Projects/foo')
  })

  it('merges two transcript folders that resolve to the same cwd', () => {
    const days = [day('2026-08-01', {
      old: row('old', { promptCount: 2, sessionCount: 3, estimatedCostUsd: 1 }),
      new: row('new', { promptCount: 5, sessionCount: 4, estimatedCostUsd: 2, toolBreakdown: { Bash: 1, Read: 7 } }),
    })]
    const { days: out } = foldHistoryDaysByCwd(days, { old: '/p/foo', new: '/p/foo' })
    const merged = out[0].byProject['/p/foo']
    expect(Object.keys(out[0].byProject)).toHaveLength(1)
    expect(merged.promptCount).toBe(7)
    expect(merged.sessionCount).toBe(7)
    expect(merged.estimatedCostUsd).toBe(3)
    expect(merged.toolBreakdown).toEqual({ Bash: 3, Read: 7 })
    // byModel feeds the model-mix panel — it must merge, not be clobbered.
    expect(merged.byModel.opus.outputTokens).toBe(40)
    expect(merged.byModel.opus.costUsd).toBe(1)
  })

  it('drops folders with no resolvable cwd from the project axis', () => {
    // The real shape here: thousands of -tmp-sm-*-test-* fixture folders.
    const days = [day('2026-08-01', {
      '-tmp-sm-paged-test-08mRjd': row('-tmp-sm-paged-test-08mRjd', { promptCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, sessionCount: 2 }),
      '-home-bilko-Projects-foo': row('-home-bilko-Projects-foo'),
    })]
    const { days: out, excluded } = foldHistoryDaysByCwd(days, { '-home-bilko-Projects-foo': '/p/foo' })
    expect(Object.keys(out[0].byProject)).toEqual(['/p/foo'])
    expect(excluded.folderCount).toBe(1)
    expect(excluded.sessionCount).toBe(2)
  })

  it('accounts for every excluded folder rather than dropping its numbers silently', () => {
    const days = [
      day('2026-08-01', { ghost: row('ghost', { promptCount: 3, estimatedCostUsd: 1.25, inputTokens: 100, outputTokens: 50, sessionCount: 1 }) }),
      day('2026-08-02', { ghost: row('ghost', { promptCount: 4, estimatedCostUsd: 0.75, inputTokens: 10, outputTokens: 5, sessionCount: 2 }) }),
    ]
    const { excluded } = foldHistoryDaysByCwd(days, {})
    // Counted once as a folder, but its totals summed across every day.
    expect(excluded.folderCount).toBe(1)
    expect(excluded.promptCount).toBe(7)
    expect(excluded.estimatedCostUsd).toBeCloseTo(2)
    expect(excluded.sessionCount).toBe(3)
    expect(excluded.totalTokens).toBe(165)
    expect(hasExclusions(excluded)).toBe(true)
    const text = describeExclusions(excluded)
    expect(text).toContain('1 transcript folder')
    expect(text).toContain('$2.00')
  })

  it('reports no exclusions when every folder resolves', () => {
    const days = [day('2026-08-01', { a: row('a') })]
    const { excluded } = foldHistoryDaysByCwd(days, { a: '/p/a' })
    expect(hasExclusions(excluded)).toBe(false)
    expect(excluded.folderCount).toBe(0)
  })

  it('does not mutate the input rows', () => {
    const source = row('a', { promptCount: 1 })
    const days = [day('2026-08-01', { a: source, b: row('b', { promptCount: 4 }) })]
    foldHistoryDaysByCwd(days, { a: '/p/foo', b: '/p/foo' })
    expect(source.promptCount).toBe(1)
    expect(source.toolBreakdown).toEqual({ Bash: 2 })
    expect(source.byModel.opus.outputTokens).toBe(20)
  })

  it('preserves each day and its date, including days that fold to nothing', () => {
    const days = [day('2026-08-01', { ghost: row('ghost') }), day('2026-08-02', { a: row('a') })]
    const { days: out } = foldHistoryDaysByCwd(days, { a: '/p/a' })
    expect(out.map((d) => d.date)).toEqual(['2026-08-01', '2026-08-02'])
    expect(out[0].byProject).toEqual({})
  })

  it('handles an empty payload', () => {
    const { days, excluded } = foldHistoryDaysByCwd([], {})
    expect(days).toEqual([])
    expect(hasExclusions(excluded)).toBe(false)
  })
})
