// @vitest-environment jsdom
/**
 * Regression guard for "Epic shows 1 step after its plan completed": a finished 6-step DAG
 * (rows gone from queue.json, PRDs archived) plus one follow-up must stay 2 plans / 7 steps.
 * Runs the same path SchedulePanel uses: merge archived → buildBacklogTree → buildPlans.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { mergeArchivedPlanRows } from '../../../../lib/archivedPlanRows'
import { buildBacklogTree } from '../../../../lib/backlogTree'
import { buildPlans } from '../../../../lib/schedulerStages'
import { PlanBand } from '../PlanBand'
import type { PrdListItem, ScheduleJob } from '../../../../../preload/api'

const job = (slug: string, over: Partial<ScheduleJob> = {}): ScheduleJob => ({
  slug, title: slug, status: 'pending', cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '',
  runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'E', ...over,
} as ScheduleJob)
const prd = (slug: string, over: Partial<PrdListItem> = {}): PrdListItem => ({
  slug, title: slug, parallelGroup: 1, cwd: '/p', estimateMinutes: null, mtimeMs: 0,
  epicId: 'E', sourcePromptId: 'E', archived: true, ...over,
} as PrdListItem)

const archivedChain = (over: (n: number) => Partial<PrdListItem> = () => ({})) =>
  [1, 2, 3, 4, 5, 6].map((n) => prd(`0${n}-a${n}`, { dependsOn: n > 1 ? [`0${n - 1}-a${n - 1}`] : undefined, ...over(n) }))

function pipeline(live: ScheduleJob[], prds: PrdListItem[]) {
  const merged = mergeArchivedPlanRows(live, prds, '/p')
  buildBacklogTree(merged, {}) // same call SchedulePanel makes; must accept the merged rows
  return buildPlans(merged, { sessions: {} })
}

describe('tracker step parity', () => {
  it('completed 6-step DAG + independent follow-up → 2 plans, 7 steps', () => {
    const plans = pipeline([job('10-b1')], archivedChain())
    expect(plans).toHaveLength(2)
    expect(plans.reduce((n, p) => n + p.prdCount, 0)).toBe(7)
    // Newest-first: the 10-b1 follow-up (higher PRD number) sorts before the archived 01-06 chain.
    expect(plans[0].prdCount).toBe(1)
    expect(plans[0].stages[0].n).toBe(1)
    expect(plans[0].stages[0].rows[0].status).toBe('pending')
    expect(plans[1].prdCount).toBe(6)
    expect(plans[1].doneCount).toBe(6)
    expect(plans[1].status).toBe('done')
    // pre-fix shape: a single 1-step band
    expect(plans.some((p) => p.prdCount === 1 && plans.length === 1)).toBe(false)
  })

  it('append (B1 dependsOn A6) → 1 plan of 7 rows', () => {
    const plans = pipeline([job('10-b1', { dependsOn: ['06-a6'] })], archivedChain())
    expect(plans).toHaveLength(1)
    expect(plans[0].prdCount).toBe(7)
  })

  it('archived FAILED PRD renders in its attention state, not done', () => {
    const plans = pipeline([job('10-b1')], archivedChain((n) => (n === 3 ? { archivedStatus: 'failed' } : {})))
    const row = plans.flatMap((p) => p.stages.flatMap((s) => s.rows)).find((r) => r.slug === '03-a3')!
    expect(row.status).toBe('failed')
    // Newest-first: plans[0] is the 10-b1 follow-up; the archived chain (with the failure) is plans[1].
    expect(plans[1].doneCount).toBe(5)
  })
})

describe('plan band header', () => {
  let root: Root | null = null
  let el: HTMLDivElement | null = null
  afterEach(() => { act(() => root?.unmount()); el?.remove(); root = null; el = null })

  it('states step total and done count including archived steps', () => {
    const plans = pipeline([job('10-b1')], archivedChain())
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    act(() => root!.render(
      // Newest-first: plans[1] is the archived 6-step chain (plans[0] is the 10-b1 follow-up).
      <PlanBand plan={plans[1]} now={0} hidden={new Set()} indexBySlug={new Map()} headChoicesBySlug={new Map()} onRowFocused={() => {}} />,
    ))
    expect(el.querySelector('[data-testid="plan-step-count"]')!.textContent).toBe('6 steps · 6 done')
  })
})
