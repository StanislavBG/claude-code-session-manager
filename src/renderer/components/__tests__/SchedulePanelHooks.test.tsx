// @vitest-environment jsdom
/**
 * Regression: React error #300 ("Rendered fewer hooks than expected") when the
 * Scheduler tab's queue panel goes from "has jobs" to "no jobs for this scope".
 *
 * SchedulePanel bails out early three times — `!snap`, `panelView ===
 * 'supervisor'`, and `jobs.length === 0` (FirstRunGuide) — and one `useMemo`
 * (`holdBySlug`) used to sit BELOW all three. Any render that took an early
 * exit therefore ran one hook fewer than the render before it, which React
 * detects at commit and throws #300. The file's own comment above
 * `handleJobListKeyDown` already stated the rule; `holdBySlug` violated it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulePanel } from '../SchedulePanel'
import { useScheduleState } from '../../state/scheduleState'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

function job(over: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug: '001-thing',
    title: 'Thing',
    status: 'pending',
    cwd: '/home/u/proj',
    ...over,
  } as ScheduleJob
}

function snapshot(jobs: ScheduleJob[]): ScheduleStateSnapshot {
  return {
    config: { firePolicy: 'when-available', supervisor: { enabled: false } },
    jobs,
    lastTick: null,
    scheduledFor: null,
    lastRunAt: null,
    nextReset: null,
    paused: null,
    utilization: null,
    effectiveConcurrency: { cap: 3, source: 'config' },
  } as unknown as ScheduleStateSnapshot
}

beforeEach(() => {
  ;(globalThis as any).window.api = {
    schedule: {
      health: () => new Promise(() => {}),
      onState: () => () => {},
      setConfig: async () => ({ ok: true }),
      forceTick: async () => ({ ok: true }),
    },
  }
  useScheduleState.setState({ snapshot: null, loaded: false })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('SchedulePanel hook ordering', () => {
  it('survives a snapshot going from jobs to no-jobs without a hook-count error', () => {
    const errors: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a[0]) })

    useScheduleState.setState({ snapshot: snapshot([job()]), loaded: true })
    mount(<SchedulePanel scopeCwd="/home/u/proj" />)

    // Same scope, queue drains to empty -> FirstRunGuide early return.
    expect(() => {
      act(() => {
        useScheduleState.setState({ snapshot: snapshot([]), loaded: true })
      })
    }).not.toThrow()

    // ...and back again.
    expect(() => {
      act(() => {
        useScheduleState.setState({ snapshot: snapshot([job()]), loaded: true })
      })
    }).not.toThrow()

    expect(errors.map(String).join('\n')).not.toMatch(/Rendered fewer hooks|Rendered more hooks|#300|#310/)
  })

  it('survives scope switching to a project with no jobs', () => {
    useScheduleState.setState({ snapshot: snapshot([job()]), loaded: true })
    const c = mount(<SchedulePanel scopeCwd="/home/u/proj" />)
    expect(c.textContent).toBeTruthy()

    expect(() => {
      act(() => { root!.render(<SchedulePanel scopeCwd="/home/u/other" />) })
    }).not.toThrow()
  })

  it('survives the snapshot dropping back to null', () => {
    useScheduleState.setState({ snapshot: snapshot([job()]), loaded: true })
    mount(<SchedulePanel scopeCwd="/home/u/proj" />)

    expect(() => {
      act(() => { useScheduleState.setState({ snapshot: null, loaded: false }) })
    }).not.toThrow()
  })
})
