// @vitest-environment jsdom
import { createElement, memo } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PrdRow } from './tabs/scheduler/PrdRow'
import { buildPlans, type PlanRow } from '../lib/schedulerStages'
import type { ScheduleJob } from '../../preload/api'

/**
 * Mirrors SchedulePanel.jobrow-render-count for the 2A Graph row: PrdRow is
 * React.memo and only RUNNING rows receive a per-second changing prop
 * (`elapsedMs`); a clock tick must not re-render any non-running row.
 */

const renderCounts = vi.hoisted(() => ({ counts: {} as Record<string, number> }))

const CountedPrdRow = memo((props: { row: PlanRow } & Record<string, unknown>) => {
  renderCounts.counts[props.row.slug] = (renderCounts.counts[props.row.slug] ?? 0) + 1
  return (PrdRow as unknown as { type: (p: unknown) => never }).type(props)
})

function job(slug: string, over: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug, title: slug, cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '', status: 'pending',
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'e', ...over,
  } as ScheduleJob
}

const JOBS: ScheduleJob[] = [
  ...Array.from({ length: 19 }, (_, i) => job(`${100 + i}-pending`)),
  job('1-running', { status: 'running', startedAt: new Date(0).toISOString() }),
]
// Built ONCE — exactly what SchedulePanel's useMemo gives the rows between ticks.
const ROWS = buildPlans(JOBS, { sessions: {}, now: 0 })[0].stages.flatMap((s) => s.rows)
const stableOnFocused = vi.fn()

function Harness({ elapsed }: { elapsed: number }) {
  return createElement('div', null, ...ROWS.map((row, i) =>
    createElement(CountedPrdRow, {
      key: row.slug,
      row,
      elapsedMs: row.status === 'running' ? elapsed : null,
      listIndex: i,
      onFocused: stableOnFocused,
    })))
}

let container: HTMLDivElement | null = null
let root: Root | null = null

describe('PrdRow stays memoized across a 1s tick', () => {
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    renderCounts.counts = {}
  })

  it('re-renders only the running row when the clock advances', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(createElement(Harness, { elapsed: 1_000 })))
    const before = { ...renderCounts.counts }
    expect(Object.keys(before)).toHaveLength(20)

    act(() => root!.render(createElement(Harness, { elapsed: 2_000 })))
    for (const r of ROWS) {
      if (r.status === 'running') expect(renderCounts.counts[r.slug]).toBe(before[r.slug] + 1)
      else expect(renderCounts.counts[r.slug]).toBe(before[r.slug])
    }
    expect(container.textContent).toContain('2s')
  })
})
