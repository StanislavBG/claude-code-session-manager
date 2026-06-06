import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { selectHistoryJobs } = require('../../src/main/scheduler.cjs')

const job = (over: Record<string, unknown>) => ({
  slug: 's', title: 't', cwd: '/c', status: 'completed',
  exitCode: 0, startedAt: null, finishedAt: null, runId: null, ...over,
})

describe('selectHistoryJobs', () => {
  it('returns only completed/failed jobs', () => {
    const out = selectHistoryJobs([
      job({ slug: 'a', status: 'completed', finishedAt: '2026-06-01T00:00:00Z' }),
      job({ slug: 'b', status: 'pending' }),
      job({ slug: 'c', status: 'running' }),
      job({ slug: 'd', status: 'failed', finishedAt: '2026-06-02T00:00:00Z' }),
    ], 50)
    expect(out.map((j: any) => j.slug)).toEqual(['d', 'a'])
  })

  it('sorts newest-finished first', () => {
    const out = selectHistoryJobs([
      job({ slug: 'old', finishedAt: '2026-01-01T00:00:00Z' }),
      job({ slug: 'new', finishedAt: '2026-06-01T00:00:00Z' }),
    ], 50)
    expect(out.map((j: any) => j.slug)).toEqual(['new', 'old'])
  })

  it('caps at the requested limit', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      job({ slug: `j${i}`, finishedAt: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
    expect(selectHistoryJobs(many, 3)).toHaveLength(3)
  })

  it('clamps limit to [1, 500] and defaults to 50 for bad input', () => {
    const many = Array.from({ length: 600 }, (_, i) => job({ slug: `j${i}`, finishedAt: '2026-06-01T00:00:00Z' }))
    expect(selectHistoryJobs(many, 0)).toHaveLength(1)
    expect(selectHistoryJobs(many, 9999)).toHaveLength(500)
    expect(selectHistoryJobs(many, undefined)).toHaveLength(50)
  })

  it('tolerates non-array / empty input without throwing', () => {
    expect(selectHistoryJobs(null, 50)).toEqual([])
    expect(selectHistoryJobs([], 50)).toEqual([])
  })
})
