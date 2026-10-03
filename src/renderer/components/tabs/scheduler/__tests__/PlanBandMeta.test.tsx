// @vitest-environment jsdom
/**
 * Plan-card meta text: a validate-defined plan shows its epicLabel + width ("how parallel");
 * a plain weak-component plan (no validate PRD, width 1) keeps the old shape with no "wide" text.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PlanBand } from '../PlanBand'
import type { Plan } from '../../../../lib/schedulerStages'
import type { ScheduleJob } from '../../../../../preload/api'

const job = (slug: string): ScheduleJob => ({
  slug, title: slug, status: 'completed', cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '',
  runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'E',
} as ScheduleJob)

function makePlan(over: Partial<Plan>): Plan {
  const row = {
    slug: 'E-001', title: 'E-001', status: 'completed', stage: 1, prdNumber: '001', rowKind: 'prd',
    rowTrailing: '', cycle: false, estimateMinutes: null, deps: [], crossEpicDeps: [], blockers: [], job: job('E-001'),
  } as unknown as Plan['stages'][0]['rows'][0]
  return {
    epicId: 'E', waveIndex: 1, index: 1, label: 'Ship X', epicLabel: 'My Epic', validateSlug: null, width: 1,
    status: 'done', prdCount: 1, stageCount: 1, doneCount: 1, runningCount: 0, heldCount: 0, blockedCount: 0,
    etaMs: 0, stages: [{ n: 1, state: 'done', summary: '', rows: [row], doneCount: 1, runningCount: 0, heldCount: 0, blockedCount: 0 }],
    ...over,
  } as Plan
}

describe('PlanBand meta text', () => {
  let root: Root | null = null
  let el: HTMLDivElement | null = null
  afterEach(() => { act(() => root?.unmount()); el?.remove(); root = null; el = null })

  const render = (plan: Plan) => {
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    act(() => root!.render(
      <PlanBand plan={plan} now={0} hidden={new Set()} indexBySlug={new Map()} headChoicesBySlug={new Map()} onRowFocused={() => {}} />,
    ))
    return el
  }

  it('validate-defined plan shows epicLabel, prdCount, width, stageCount', () => {
    const plan = makePlan({
      label: 'Ship X', epicLabel: 'My Epic', validateSlug: '10-validate', prdCount: 4, width: 3, stageCount: 2,
    })
    const node = render(plan)
    expect(node.querySelector('[data-testid="plan-meta"]')!.textContent).toBe('p · My Epic · 4 PRDs · 3 wide · 2 stages')
    expect(node.querySelector('[data-testid="plan-label"]')!.getAttribute('title')).toBe('Ship X — My Epic')
    expect(node.querySelector('[data-testid="plan-step-count"]')).toBeNull()
  })

  it('non-validate plan with width 1 keeps old shape, no "wide" text', () => {
    const plan = makePlan({
      label: 'My Epic', epicLabel: 'My Epic', validateSlug: null, prdCount: 1, width: 1, stageCount: 1,
    })
    const node = render(plan)
    expect(node.querySelector('[data-testid="plan-meta"]')!.textContent).toBe('p · 1 PRD · 1 stage')
    expect(node.querySelector('[data-testid="plan-meta"]')!.textContent).not.toContain('wide')
    expect(node.querySelector('[data-testid="plan-label"]')!.getAttribute('title')).toBe('My Epic')
  })
})
