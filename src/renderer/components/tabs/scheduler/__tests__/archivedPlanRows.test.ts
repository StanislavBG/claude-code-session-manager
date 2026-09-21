import { describe, it, expect } from 'vitest'
import { mergeArchivedPlanRows } from '../../../../lib/archivedPlanRows'
import { buildPlans } from '../../../../lib/schedulerStages'
import type { PrdListItem, ScheduleJob } from '../../../../../preload/api'

function job(over: Partial<ScheduleJob> & { slug: string }): ScheduleJob {
  return {
    title: over.slug, status: 'pending', cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '',
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'e1', ...over,
  } as ScheduleJob
}
function prd(over: Partial<PrdListItem> & { slug: string }): PrdListItem {
  return {
    title: over.slug, parallelGroup: 1, cwd: '/p', estimateMinutes: null, mtimeMs: 0,
    epicId: 'e1', sourcePromptId: 'e1', archived: true, ...over,
  } as PrdListItem
}

describe('mergeArchivedPlanRows', () => {
  it('live-only: returns the live rows untouched', () => {
    const live = [job({ slug: '10-a' })]
    expect(mergeArchivedPlanRows(live, [], null)).toBe(live)
    expect(mergeArchivedPlanRows(live, [prd({ slug: '9-x', archived: false })], null)).toBe(live)
  })

  it('live + archived: adds synthetic rows with archivedStatus (default completed)', () => {
    const live = [job({ slug: '10-a', status: 'running' })]
    const out = mergeArchivedPlanRows(live, [
      prd({ slug: '01-x' }),
      prd({ slug: '02-y', archivedStatus: 'failed', dependsOn: ['01-x'] }),
    ], null)
    expect(out.map((j) => j.slug)).toEqual(['10-a', '01-x', '02-y'])
    expect(out[1]).toMatchObject({ status: 'completed', synthetic: true })
    expect(out[2]).toMatchObject({ status: 'failed', synthetic: true, dependsOn: ['01-x'] })
  })

  it('dup-slug: the live row wins', () => {
    const live = [job({ slug: '01-x', status: 'running' })]
    const out = mergeArchivedPlanRows(live, [prd({ slug: '01-x' })], null)
    expect(out).toEqual(live)
  })

  it('cross-Epic isolation: archived rows of an Epic with no live rows are not resurrected', () => {
    const live = [job({ slug: '10-a' })]
    const out = mergeArchivedPlanRows(live, [prd({ slug: '01-z', epicId: 'e2', sourcePromptId: 'e2' })], null)
    expect(out).toBe(live)
  })

  it('scopeCwd: other-project archived rows never leak in', () => {
    const live = [job({ slug: '10-a' })]
    const out = mergeArchivedPlanRows(live, [prd({ slug: '01-x', cwd: '/other' })], '/p')
    expect(out).toBe(live)
  })

  it('5 archived + 1 running renders one plan with prdCount 6', () => {
    const live = [job({ slug: '06-f', status: 'running', dependsOn: ['05-e'] })]
    const prds = [1, 2, 3, 4, 5].map((n) => prd({ slug: `0${n}-s`, dependsOn: n > 1 ? [`0${n - 1}-s`] : undefined }))
    prds[4] = { ...prds[4], slug: '05-e', dependsOn: ['04-s'] }
    const plans = buildPlans(mergeArchivedPlanRows(live, prds, null), { sessions: {} })
    expect(plans).toHaveLength(1)
    expect(plans[0].prdCount).toBe(6)
    expect(plans[0].doneCount).toBe(5)
  })
})
