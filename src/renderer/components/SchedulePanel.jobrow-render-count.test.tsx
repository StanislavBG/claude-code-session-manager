// @vitest-environment jsdom
import { createElement, memo } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { JobRow } from './SchedulePanel'
import { usePromptSessions } from '../state/promptSessions'
import type { ScheduleJob } from '../../preload/api'

/**
 * perf-memo-list-rows (Round 2): JobRow (SchedulePanel.tsx) is rendered once
 * per queued job inside a map driven by a 1s ticker (`now`). Round 1 only
 * memoized the 17 top-level screens; the rows rendered INSIDE those screens
 * were still unmemoized. This file proves the fix: JobRow is React.memo, and
 * SchedulePanel now passes it a quantized `elapsedMs` (null for every
 * non-running row, so that prop — like every other JobRow prop — stays
 * value-stable across a tick that doesn't change what the row displays)
 * instead of the raw, always-changing `now`.
 */

const renderCounts = vi.hoisted(() => ({ counts: {} as Record<string, number> }))

// Wraps the REAL (already memo-wrapped) JobRow with an outer counting memo —
// `real.type` reaches through JobRow's own memo to the underlying render
// function, so the real component body still runs on every genuine
// re-render; this layer only counts how many times that happens per key.
function countedJobRow(real: { type: (props: unknown) => unknown }) {
  return memo((props: { job: ScheduleJob } & Record<string, unknown>) => {
    renderCounts.counts[props.job.slug] = (renderCounts.counts[props.job.slug] ?? 0) + 1
    return real.type(props) as never
  })
}

const CountedJobRow = countedJobRow(JobRow as unknown as { type: (props: unknown) => unknown })

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug: 'job',
    title: 'A job',
    cwd: '/proj',
    parallelGroup: 1,
    estimateMinutes: null,
    bodyPreview: '',
    status: 'pending',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    ...overrides,
  } as ScheduleJob
}

const stableOnFocused = vi.fn()

// 19 pending rows (a stable "~2m" ETA, matching what computeEtaMap would
// hand back across ticks where the estimate hasn't crossed a formatted-label
// boundary) + 1 running row (a live elapsed-time counter).
const JOBS: ScheduleJob[] = [
  ...Array.from({ length: 19 }, (_, i) => job({ slug: `pending-${i}`, title: `Pending ${i}` })),
  job({ slug: 'running-0', title: 'Running one', status: 'running', startedAt: new Date(0).toISOString() }),
]

function Harness({ elapsedMsForRunning }: { elapsedMsForRunning: number }) {
  return createElement(
    'div',
    null,
    ...JOBS.map((j, idx) =>
      createElement(CountedJobRow, {
        key: j.slug,
        job: j,
        // Every pending row gets the SAME eta string across renders — the
        // scenario this test targets (only the tick advances, nothing about
        // what the row shows has changed).
        eta: j.status === 'pending' ? '~2m' : null,
        elapsedMs: j.status === 'running' ? elapsedMsForRunning : null,
        avgDurationMs: 60_000,
        listIndex: idx,
        onFocused: stableOnFocused,
      }),
    ),
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('JobRow stays memoized across a 1s tick that changes nothing on screen', () => {
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    renderCounts.counts = {}
    usePromptSessions.setState({ sessions: {} })
  })

  it('mounts 20 rows, then a tick with an unchanged eta/elapsed re-renders only the running row', () => {
    mount(createElement(Harness, { elapsedMsForRunning: 1_000 }))

    const beforeCounts = { ...renderCounts.counts }
    expect(Object.keys(beforeCounts)).toHaveLength(20)
    expect(beforeCounts['pending-0']).toBe(1)
    expect(beforeCounts['running-0']).toBe(1)

    // Simulate the next 1s tick: SchedulePanel re-renders with a new `now`,
    // but for every pending row the freshly-computed `eta` string comes out
    // the same, and the running row's elapsedMs advances by ~1000ms.
    act(() => {
      root!.render(createElement(Harness, { elapsedMsForRunning: 2_000 }))
    })

    const afterCounts = renderCounts.counts
    for (let i = 0; i < 19; i++) {
      expect(afterCounts[`pending-${i}`]).toBe(beforeCounts[`pending-${i}`])
    }
    // The running row DOES re-render — its displayed "elapsed" text changed.
    expect(afterCounts['running-0']).toBe(beforeCounts['running-0'] + 1)
  })

  it('a running job keeps counting down on screen across ticks', () => {
    const el = mount(createElement(Harness, { elapsedMsForRunning: 1_000 }))
    expect(el.textContent).toContain('1s elapsed')

    act(() => {
      root!.render(createElement(Harness, { elapsedMsForRunning: 65_000 }))
    })
    expect(el.textContent).toContain('1m05s elapsed')
  })
})
