// @vitest-environment jsdom
/**
 * PRD: restructure the Scheduler backlog so the visible hierarchy is the
 * real one — Epic → dependency chain → PRD — instead of sorting/grouping by
 * `parallelGroup` (a display hint, never a barrier; CLAUDE.md's Avoid list).
 * These mount the full SchedulePanel (rather than lib/backlogTree.test.ts's
 * pure-function coverage) to prove the grouping/nesting/blocker/cycle
 * behavior actually reaches the DOM.
 *
 * 2A redesign: the Epic tree is now the panel's 'list' mode (Graph — plan bands of
 * stage columns — is the default), so every mount below passes planMode="list".
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulePanel } from './SchedulePanel'
import { useScheduleState } from '../state/scheduleState'
import { usePromptSessions } from '../state/promptSessions'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

function job(over: Partial<ScheduleJob> & { slug: string }): ScheduleJob {
  return {
    title: over.slug,
    status: 'pending',
    cwd: '/p',
    parallelGroup: 1,
    estimateMinutes: null,
    bodyPreview: '',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
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
      listPrds: async () => [],
      health: () => new Promise(() => {}),
      onState: () => () => {},
      setConfig: async () => ({ ok: true }),
      forceTick: async () => ({ ok: true }),
      rescan: async () => ({ ok: true }),
      openFolder: async () => {},
    },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useScheduleState.setState({ snapshot: null, loaded: false })
  usePromptSessions.setState({ sessions: {} })
  vi.restoreAllMocks()
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('SchedulePanel — Epic/dependency backlog tree', () => {
  it('renders two Epics as two distinct sections', () => {
    useScheduleState.setState({
      snapshot: snapshot([
        job({ slug: 'a1', epicId: 'epic-a' }),
        job({ slug: 'b1', epicId: 'epic-b' }),
      ]),
      loaded: true,
    })
    const el = mount(<SchedulePanel scopeCwd="/p" planMode="list" />)
    const sections = el.querySelectorAll('[data-testid="backlog-epic-section"]')
    expect(sections).toHaveLength(2)
  })

  it('nests a 3-deep dependency chain with increasing indentation', () => {
    useScheduleState.setState({
      snapshot: snapshot([
        job({ slug: 'base', epicId: 'e' }),
        job({ slug: 'mid', epicId: 'e', dependsOn: ['base'] }),
        job({ slug: 'top', epicId: 'e', dependsOn: ['mid'] }),
      ]),
      loaded: true,
    })
    const el = mount(<SchedulePanel scopeCwd="/p" planMode="list" />)
    const rows = Array.from(el.querySelectorAll('[data-job-row]')) as HTMLElement[]
    expect(rows).toHaveLength(3)
    const depths = rows.map((r) => Number(r.getAttribute('data-depth')))
    expect(depths).toEqual([0, 1, 2])
  })

  it('shows a blocked row its blocker and current status', () => {
    useScheduleState.setState({
      snapshot: snapshot([
        job({ slug: 'base', epicId: 'e', status: 'running' }),
        job({ slug: 'dependent', epicId: 'e', status: 'pending', dependsOn: ['base'] }),
      ]),
      loaded: true,
    })
    const el = mount(<SchedulePanel scopeCwd="/p" planMode="list" />)
    const blockerLines = el.querySelectorAll('[data-testid="job-row-blockers"]')
    expect(blockerLines).toHaveLength(1)
    expect(blockerLines[0].textContent).toContain('base')
    expect(blockerLines[0].textContent).toContain('running')
    expect(blockerLines[0].textContent).toContain('blocked by')
  })

  it('distinctly marks a needs_review blocker', () => {
    useScheduleState.setState({
      snapshot: snapshot([
        job({ slug: 'base', epicId: 'e', status: 'needs_review' }),
        job({ slug: 'dependent', epicId: 'e', status: 'pending', dependsOn: ['base'] }),
      ]),
      loaded: true,
    })
    const el = mount(<SchedulePanel scopeCwd="/p" planMode="list" />)
    const blockerLine = el.querySelector('[data-testid="job-row-blockers"]') as HTMLElement
    expect(blockerLine.textContent).toContain('needs review')
  })

  it('renders a cyclic dependsOn as an explicit warning instead of hanging the pane', () => {
    useScheduleState.setState({
      snapshot: snapshot([
        job({ slug: 'a', epicId: 'e', dependsOn: ['b'] }),
        job({ slug: 'b', epicId: 'e', dependsOn: ['a'] }),
      ]),
      loaded: true,
    })
    const el = mount(<SchedulePanel scopeCwd="/p" planMode="list" />)
    const warnings = el.querySelectorAll('[data-testid="job-row-cycle-warning"]')
    expect(warnings).toHaveLength(2)
  })

  it('marks a row with no dependsOn and no dependents as parallel-eligible', () => {
    useScheduleState.setState({
      snapshot: snapshot([
        job({ slug: 'lonely', epicId: 'e' }),
        job({ slug: 'base', epicId: 'e' }),
        job({ slug: 'child', epicId: 'e', dependsOn: ['base'] }),
      ]),
      loaded: true,
    })
    const el = mount(<SchedulePanel scopeCwd="/p" planMode="list" />)
    expect(el.querySelectorAll('[data-testid="job-row-parallel-eligible"]')).toHaveLength(1)
  })
})
