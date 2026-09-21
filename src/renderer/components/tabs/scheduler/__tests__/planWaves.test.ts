import { describe, it, expect } from 'vitest'
import { buildPlans } from '../../../../lib/schedulerStages'
import type { ScheduleJob } from '../../../../../preload/api'

function job(slug: string, over: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug, title: slug, status: 'pending', cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '',
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'e1', ...over,
  } as ScheduleJob
}
const chain = (from: number, n: number, over: Partial<ScheduleJob> = {}) =>
  Array.from({ length: n }, (_, i) =>
    job(`${from + i}-s${i}`, { ...over, dependsOn: i === 0 ? [] : [`${from + i - 1}-s${i - 1}`] }))
const opts = { sessions: {} }

describe('buildPlans waves', () => {
  it('single-wave Epic: one plan, unchanged label, waveIndex 1', () => {
    const plans = buildPlans(chain(10, 3), opts)
    expect(plans).toHaveLength(1)
    expect(plans[0].waveIndex).toBe(1)
    expect(plans[0].stageCount).toBe(3)
    expect(plans[0].label).not.toMatch(/plan \d/)
  })

  it('completed 6-step chain + independent follow-up root → 2 bands (6 rows + 1)', () => {
    const plans = buildPlans([...chain(10, 6, { status: 'completed' }), job('20-follow')], opts)
    expect(plans.map((p) => p.prdCount)).toEqual([6, 1])
    expect(plans.map((p) => p.waveIndex)).toEqual([1, 2])
    expect(plans.map((p) => p.index)).toEqual([1, 2])
    expect(plans[0].stageCount).toBe(6)
    expect(plans[1].stageCount).toBe(1)
    expect(plans[1].stages[0].n).toBe(1)
    expect(plans[0].label).toMatch(/plan 1\/2$/)
    expect(plans[1].label).toMatch(/plan 2\/2$/)
  })

  it('append wave (dependsOn into wave 1) stays one band', () => {
    const plans = buildPlans([...chain(10, 3, { status: 'completed' }), job('20-app', { dependsOn: ['12-s2'] })], opts)
    expect(plans).toHaveLength(1)
    expect(plans[0].stageCount).toBe(4)
  })

  it('cross-Epic dep does not merge Epics nor add a wave', () => {
    const a = chain(10, 2)
    const b = [job('30-b', { epicId: 'e2', dependsOn: ['11-s1'] })]
    const plans = buildPlans([...a, ...b], opts)
    expect(plans).toHaveLength(2)
    expect(plans.map((p) => p.epicId)).toEqual(['e1', 'e2'])
    expect(plans.every((p) => p.waveIndex === 1)).toBe(true)
  })

  it('independent rows each form their own plan (3 rows → 3 bands)', () => {
    const plans = buildPlans([job('10-a'), job('11-b'), job('12-c')], opts)
    expect(plans).toHaveLength(3)
    expect(plans.map((p) => p.waveIndex)).toEqual([1, 2, 3])
  })

  it('cycle becomes its own plan and does not hang', () => {
    const plans = buildPlans(
      [job('10-a', { dependsOn: ['11-b'] }), job('11-b', { dependsOn: ['10-a'] }), job('20-c')],
      opts,
    )
    expect(plans).toHaveLength(2)
    expect(plans[0].stages.flatMap((s) => s.rows).every((r) => r.cycle)).toBe(true)
  })
})
