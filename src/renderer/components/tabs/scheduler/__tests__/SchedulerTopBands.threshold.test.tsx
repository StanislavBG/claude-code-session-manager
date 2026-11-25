// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulerTopBands, type SchedulerTopBandsProps } from '../SchedulerTopBands'
import { __resetSessionSlotsForTests } from '../../../../lib/useSessionSlots'
import { useScheduleState } from '../../../../state/scheduleState'
import { usePromptSessions } from '../../../../state/promptSessions'
import type { ScheduleStateSnapshot } from '../../../../../preload/api'

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

function setSnapshot(effective: number | null | undefined) {
  useScheduleState.setState({
    snapshot: {
      config: { enabled: true, offsetMinutes: 0, defaultCwd: '/p', firePolicy: 'when-available', utilizationThreshold: 90, schemaVersion: 1 },
      jobs: [], lastRunAt: null, nextReset: null, paused: null, utilization: 92, pollHealth: undefined,
      effectiveConcurrency: { cap: 3, free: 3, source: 'pool' },
      effectiveUtilizationThreshold: effective,
    } as unknown as ScheduleStateSnapshot,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api.schedule.queueHealth.mockResolvedValue({ unknown: true })
  api.schedule.sessionSlots.mockResolvedValue({ total: 3, inUse: 0, holders: [], min: 0, max: 10, default: 5, envOverride: false })
  api.history.dashboard.mockResolvedValue({ totals: {}, days: [] })
  ;(window as unknown as { api: unknown }).api = api
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

async function render() {
  await act(async () => {
    root.render(createElement(SchedulerTopBands, props))
    await Promise.resolve(); await Promise.resolve()
  })
}

const effective = () => container.querySelector('[data-testid="kpi-threshold-effective"]')

describe('SchedulerTopBands — pro-rated pause above', () => {
  it('shows the cap in force when it differs from the editable base', async () => {
    setSnapshot(99)
    await render()
    expect(effective()?.textContent).toContain('now 99%')
    expect(container.querySelector('[data-testid="kpi-threshold-text"]')?.getAttribute('title')).toContain('rises from this value toward 99%')
  })

  it('rounds the cap in force to one decimal', async () => {
    setSnapshot(94.2857)
    await render()
    expect(effective()?.textContent).toContain('now 94.3%')
  })

  it('compares the rounded cap: 90.03 beside a base of 90 shows nothing extra', async () => {
    setSnapshot(90.03)
    await render()
    expect(effective()).toBeNull()
  })

  it('shows the rounded cap when it differs from the base after rounding', async () => {
    setSnapshot(90.06)
    await render()
    expect(effective()?.textContent).toContain('now 90.1%')
  })

  it('shows nothing extra when the cap equals the base', async () => {
    setSnapshot(90)
    await render()
    expect(effective()).toBeNull()
  })

  it('shows nothing extra when the cap is unknown', async () => {
    setSnapshot(null)
    await render()
    expect(effective()).toBeNull()
  })
})
