// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulerTopBands, type SchedulerTopBandsProps } from '../SchedulerTopBands'
import { __resetSessionSlotsForTests, setSessionSlots } from '../../../../lib/useSessionSlots'
import { useScheduleState } from '../../../../state/scheduleState'
import { usePromptSessions } from '../../../../state/promptSessions'
import type { ScheduleStateSnapshot } from '../../../../../preload/api'

const slots = (total: number) => ({ total, inUse: 0, holders: [], min: 0, max: 10, default: 5, envOverride: false })
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
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api.schedule.queueHealth.mockResolvedValue({ unknown: true })
  api.schedule.sessionSlots.mockResolvedValue(slots(3))
  api.history.dashboard.mockResolvedValue({ totals: {}, days: [] })
  ;(window as unknown as { api: unknown }).api = api
  // Scheduler state deliberately disagrees (cap 7): the stepper must ignore it.
  useScheduleState.setState({
    snapshot: {
      config: { enabled: true, offsetMinutes: 0, defaultCwd: '/p', firePolicy: 'when-available', utilizationThreshold: 90, schemaVersion: 1 },
      jobs: [], lastRunAt: null, nextReset: null, paused: null, utilization: 10, pollHealth: undefined,
      effectiveConcurrency: { cap: 7, free: 7, source: 'pool' },
    } as unknown as ScheduleStateSnapshot,
  })
  usePromptSessions.setState({ sessions: {}, events: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  __resetSessionSlotsForTests()
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

const value = () => container.querySelector('[data-testid="kpi-concurrency-value"]')!.textContent

describe('SchedulerTopBands — slots single read channel', () => {
  it('shows the useSessionSlots cap, and follows a cap change', async () => {
    await act(async () => {
      root.render(createElement(SchedulerTopBands, props))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(value()).toBe('3')
    api.schedule.sessionSlots.mockResolvedValue(slots(8))
    await act(async () => { await setSessionSlots(8) })
    expect(api.schedule.setSessionSlots).toHaveBeenLastCalledWith(8)
    expect(value()).toBe('8')
  })
})
