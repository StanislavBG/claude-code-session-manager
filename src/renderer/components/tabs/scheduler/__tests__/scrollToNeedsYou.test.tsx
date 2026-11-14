// @vitest-environment jsdom
/**
 * The KPI "Needs you" jump must scroll ONLY the job list's own scroll
 * container. scrollIntoView scrolls every scrollable ancestor — including the
 * app's overflow:hidden page frames — which drags the frame out of place.
 */
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulerTopBands, type SchedulerTopBandsProps } from '../SchedulerTopBands'
import { __resetSessionSlotsForTests } from '../../../../lib/useSessionSlots'
import { useScheduleState } from '../../../../state/scheduleState'
import { usePromptSessions } from '../../../../state/promptSessions'
import type { ScheduleStateSnapshot } from '../../../../../preload/api'

const job = (slug: string, status: string) => ({ slug, title: slug, status, cwd: '/p', parallelGroup: 1, dependsOn: [] })

function fixture(): ScheduleStateSnapshot {
  return {
    config: { enabled: true, offsetMinutes: 0, defaultCwd: '/p', firePolicy: 'when-available', utilizationThreshold: 90, schemaVersion: 1 },
    jobs: [job('1-ready', 'pending'), job('2-failed', 'failed')],
    lastRunAt: null,
    nextReset: null,
    paused: null,
    utilization: 10,
    pollHealth: undefined,
    effectiveConcurrency: { cap: 5, free: 3, source: 'pool' as const },
  } as unknown as ScheduleStateSnapshot
}

const api = {
  schedule: {
    queueHealth: vi.fn(), rescan: vi.fn(), pause: vi.fn(), resume: vi.fn(), forceTick: vi.fn(),
    setSessionSlots: vi.fn(), sessionSlots: vi.fn(), setConfig: vi.fn(),
  },
  history: { dashboard: vi.fn() },
}

const props: SchedulerTopBandsProps = {
  scopeCwd: null, subView: 'queue', onSubView: vi.fn(), filterText: '', onFilterText: vi.fn(), planMode: 'graph', onPlanMode: vi.fn(),
}

const rect = (top: number, height: number) =>
  ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

let frame: HTMLDivElement
let root: Root
const intoView = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api.schedule.queueHealth.mockResolvedValue({
    unknown: false,
    verdict: { kind: 'running', runningCount: 0, pending: 1, dispatchable: 1, needsReviewCount: 0, blockedChains: [] },
    slots: { inUse: 0, total: 5, free: 5, source: 'pool' },
    oldestRunningAgeMs: null, lastRunAt: null, lastDispatchAttemptAt: null,
  })
  api.schedule.sessionSlots.mockRejectedValue(new Error('no snapshot'))
  api.history.dashboard.mockResolvedValue({ totals: {}, days: [] })
  ;(window as unknown as { api: unknown }).api = api
  ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = intoView
  useScheduleState.setState({ snapshot: fixture() })
  usePromptSessions.setState({ sessions: {}, events: {} })
  frame = document.createElement('div')
  document.body.appendChild(frame)
})

afterEach(() => {
  act(() => root.unmount())
  __resetSessionSlotsForTests()
  frame.remove()
  delete (window as unknown as { api?: unknown }).api
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
})

describe('scrollToNeedsYou', () => {
  it('scrolls the job list container only — never its ancestors, never scrollIntoView', async () => {
    // Outer page frame (overflow hidden, like the app's layout frames) and an
    // outer scroller above the job list's own scroller.
    frame.style.overflow = 'hidden'
    const outer = document.createElement('div')
    outer.style.overflowY = 'auto'
    frame.appendChild(outer)
    const bandsHost = document.createElement('div')
    outer.appendChild(bandsHost)
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    outer.appendChild(list)
    const ok = document.createElement('div')
    ok.setAttribute('data-job-row', '')
    ok.dataset.jobStatus = 'pending'
    const bad = document.createElement('div')
    bad.setAttribute('data-job-row', '')
    bad.dataset.jobStatus = 'failed'
    list.append(ok, bad)

    // The failed row sits below the list's visible box.
    list.getBoundingClientRect = () => rect(100, 200)
    bad.getBoundingClientRect = () => rect(450, 30)
    const scrolls = new Map<HTMLElement, ReturnType<typeof vi.fn>>()
    for (const el of [frame, outer, list, document.body, document.documentElement]) {
      const fn = vi.fn()
      ;(el as unknown as { scrollBy: unknown }).scrollBy = fn
      ;(el as unknown as { scrollTo: unknown }).scrollTo = fn
      scrolls.set(el, fn)
    }

    root = createRoot(bandsHost)
    await act(async () => {
      root.render(createElement(SchedulerTopBands, props))
      await Promise.resolve(); await Promise.resolve()
    })
    const jump = bandsHost.querySelector<HTMLElement>('[data-testid="kpi-needs-you-jump"]')!
    expect(jump).not.toBeNull()
    await act(async () => { jump.click(); await Promise.resolve() })

    expect(intoView).not.toHaveBeenCalled()
    expect(scrolls.get(list)).toHaveBeenCalledTimes(1)
    // 'nearest': reveal the row's bottom (480) against the list's bottom (300).
    expect(scrolls.get(list)!.mock.calls[0][0]).toMatchObject({ top: 180 })
    for (const el of [frame, outer, document.body, document.documentElement]) {
      expect(scrolls.get(el)).not.toHaveBeenCalled()
    }
  })
})
