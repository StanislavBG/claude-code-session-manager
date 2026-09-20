// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulerTopBands, type SchedulerTopBandsProps } from '../SchedulerTopBands'
import { useScheduleState } from '../../../../state/scheduleState'
import { usePromptSessions } from '../../../../state/promptSessions'
import type { ScheduleStateSnapshot } from '../../../../../preload/api'

const NOW = Date.now()
const job = (slug: string, status: string, extra: Record<string, unknown> = {}) => ({
  slug, title: slug, status, cwd: '/p', parallelGroup: 1, dependsOn: [], ...extra,
})

function fixture(over: Partial<ScheduleStateSnapshot> = {}): ScheduleStateSnapshot {
  const fin = new Date(NOW - 60_000).toISOString()
  const st = new Date(NOW - 60_000 - 18 * 60_000).toISOString()
  return {
    config: { enabled: true, offsetMinutes: 0, defaultCwd: '/p', firePolicy: 'when-available', utilizationThreshold: 90, schemaVersion: 1 },
    jobs: [
      job('1-ready-a', 'pending'),
      job('2-ready-b', 'pending'),
      job('3-held', 'pending', { dependsOn: ['5-failed'] }),
      job('4-running', 'running', { startedAt: st }),
      job('5-failed', 'failed'),
      job('6-review', 'needs_review'),
      job('7-done', 'completed', { startedAt: st, finishedAt: fin }),
    ],
    scheduledFor: null,
    lastRunAt: new Date(NOW - 5 * 60_000).toISOString(),
    nextReset: new Date(NOW + 4 * 86_400_000 + 3_600_000).toISOString(),
    paused: null,
    utilization: 92,
    pollHealth: undefined,
    effectiveConcurrency: { cap: 5, free: 3, source: 'pool' as const },
    ...over,
  } as unknown as ScheduleStateSnapshot
}

const api = {
  schedule: {
    queueHealth: vi.fn(),
    rescan: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    forceTick: vi.fn(),
    setSessionSlots: vi.fn(),
    setConfig: vi.fn(),
  },
  history: { dashboard: vi.fn() },
}

let container: HTMLDivElement
let root: Root
const props: SchedulerTopBandsProps = {
  scopeCwd: null, subView: 'queue', onSubView: vi.fn(), filterText: '', onFilterText: vi.fn(), planMode: 'graph', onPlanMode: vi.fn(),
}

async function mount(p: Partial<SchedulerTopBandsProps> = {}) {
  await act(async () => {
    root.render(createElement(SchedulerTopBands, { ...props, ...p }))
    await Promise.resolve(); await Promise.resolve()
  })
}
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const btn = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)!
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await Promise.resolve() }) }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api.schedule.queueHealth.mockResolvedValue({
    unknown: false,
    verdict: { kind: 'running', runningCount: 1, pending: 3, dispatchable: 2, needsReviewCount: 1, blockedChains: [] },
    slots: { inUse: 2, total: 5, free: 3, source: 'pool' },
    oldestRunningAgeMs: 60_000,
    lastRunAt: null,
    lastDispatchAttemptAt: null,
  })
  api.schedule.rescan.mockResolvedValue({ ok: true })
  api.schedule.forceTick.mockResolvedValue({ ok: true })
  api.schedule.pause.mockResolvedValue({ ok: true })
  api.schedule.resume.mockResolvedValue({ ok: true })
  api.schedule.setSessionSlots.mockResolvedValue({})
  api.schedule.setConfig.mockResolvedValue({ ok: true })
  api.history.dashboard.mockResolvedValue({
    totals: { estimatedCostUsd: 8.4, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 4_000_000, cacheCreationTokens: 0 },
  })
  ;(window as unknown as { api: unknown }).api = api
  useScheduleState.setState({ snapshot: fixture() })
  usePromptSessions.setState({ sessions: {}, events: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('SchedulerTopBands — KPI cells', () => {
  it('renders each of the six cells from the fixture snapshot', async () => {
    await mount()
    expect(q('kpi-window').textContent).toContain('92%')
    expect(q('kpi-window').textContent).toContain('resets in 4d')
    expect(q('kpi-slots').textContent).toContain('2/5')
    expect(q('kpi-slots').textContent).toContain('in use')
    expect(container.querySelectorAll('[data-testid="kpi-slot-pills"] > span')).toHaveLength(5)
    expect(q('kpi-ready').textContent).toContain('2')
    expect(q('kpi-ready').textContent).toContain('of 3 queued')
    expect(q('kpi-ready').textContent).toContain('1 held by deps')
    expect(q('kpi-needs-you').textContent).toContain('2')
    expect(q('kpi-needs-you').textContent).toContain('blocking stage')
    expect(q('kpi-needs-you').textContent).toContain('1 failed · 1 needs review')
    expect(q('kpi-done').textContent).toContain('1')
    expect(q('kpi-done').textContent).toContain('avg 18m')
    expect(q('kpi-concurrency-value').textContent).toBe('5')
    expect(q('kpi-concurrency').textContent).toContain('at once')
    expect(q('kpi-concurrency').textContent).toContain('pause above')
  })

  it('DONE TODAY spend renders "—" first, then fills from a single history.dashboard call', async () => {
    let resolve!: (v: unknown) => void
    api.history.dashboard.mockReturnValue(new Promise((r) => { resolve = r }))
    await mount()
    expect(q('kpi-done-spend').textContent).toBe('—')
    await act(async () => {
      resolve({ totals: { estimatedCostUsd: 8.4, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 4_000_000, cacheCreationTokens: 0 } })
      await Promise.resolve(); await Promise.resolve()
    })
    expect(q('kpi-done-spend').textContent).toBe('$8.40 · 5.1M tok')
    useScheduleState.setState({ snapshot: fixture() })
    await mount()
    expect(api.history.dashboard).toHaveBeenCalledTimes(1)
    expect(api.history.dashboard).toHaveBeenCalledWith({ rangeDays: 30 })
  })

  it('dashboard failure is swallowed to "—"', async () => {
    api.history.dashboard.mockRejectedValue(new Error('boom'))
    await mount()
    expect(q('kpi-done-spend').textContent).toBe('—')
  })

  it('NEEDS YOU shows a sage "all clear" with no button when nothing needs attention', async () => {
    useScheduleState.setState({ snapshot: fixture({ jobs: [job('1-a', 'pending')] as never }) })
    await mount()
    expect(q('kpi-needs-you').textContent).toContain('all clear')
    expect(container.querySelector('[data-testid="kpi-needs-you-jump"]')).toBeNull()
  })
})

describe('SchedulerTopBands — title band wiring', () => {
  it('keeps the queue-health-header testid, verdict state word and meta', async () => {
    await mount()
    expect(q('queue-health-header')).toBeTruthy()
    expect(q('scheduler-state-word').dataset.state).toBe('running')
    expect(q('scheduler-meta').textContent).toContain('1 in flight · 1 held · last batch 5m ago')
    expect(q('scheduler-verdict-info').title).toContain('running: 1 in flight')
  })

  it('Refresh / Pause / Fire next batch call rescan / pause / forceTick', async () => {
    await mount()
    await click(btn('Refresh')); expect(api.schedule.rescan).toHaveBeenCalledTimes(1)
    await click(btn('Pause')); expect(api.schedule.pause).toHaveBeenCalledTimes(1)
    await click(btn('Fire next batch')); expect(api.schedule.forceTick).toHaveBeenCalledTimes(1)
  })

  it('Pause swaps to Resume when paused; Fire is disabled with nothing pending or running', async () => {
    useScheduleState.setState({ snapshot: fixture({ paused: { reason: 'manual', resumeAt: null } as never, jobs: [job('1-x', 'completed')] as never }) })
    await mount()
    expect(container.querySelector('button[title^="Stop NEW"]')).toBeNull()
    await click(container.querySelector<HTMLElement>('button[title^="Clear the pause"]')!)
    expect(api.schedule.resume).toHaveBeenCalledTimes(1)
    expect((btn('Fire next batch') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SchedulerTopBands — concurrency + policy', () => {
  it('stepper calls setSessionSlots clamped to [0,10]', async () => {
    await mount()
    await click(q('kpi-concurrency-inc')); expect(api.schedule.setSessionSlots).toHaveBeenLastCalledWith(6)
    await click(q('kpi-concurrency-dec')); expect(api.schedule.setSessionSlots).toHaveBeenLastCalledWith(4)
    useScheduleState.setState({ snapshot: fixture({ effectiveConcurrency: { cap: 10, free: 0, source: 'pool' } as never }) })
    await mount()
    expect((q('kpi-concurrency-inc') as HTMLButtonElement).disabled).toBe(true)
  })

  it('stepper is disabled with an env badge when pinned by SM_SESSION_SLOTS', async () => {
    useScheduleState.setState({ snapshot: fixture({ effectiveConcurrency: { cap: 5, free: 0, source: 'env' } as never }) })
    await mount()
    expect((q('kpi-concurrency-inc') as HTMLButtonElement).disabled).toBe(true)
    expect((q('kpi-concurrency-dec') as HTMLButtonElement).disabled).toBe(true)
    expect(q('kpi-concurrency').textContent).toContain('env')
  })

  it('fire-policy select still reaches setConfig({ firePolicy }); threshold hides off when-available', async () => {
    await mount()
    const sel = q('kpi-fire-policy') as HTMLSelectElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(sel, 'manual')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(api.schedule.setConfig).toHaveBeenCalledWith({ firePolicy: 'manual' })
    useScheduleState.setState({ snapshot: fixture({ config: { enabled: true, offsetMinutes: 0, defaultCwd: '/p', firePolicy: 'manual', schemaVersion: 1 } as never }) })
    await mount()
    expect(container.querySelector('[data-testid="kpi-threshold"]')).toBeNull()
  })

  it('threshold input calls setConfig({ utilizationThreshold })', async () => {
    await mount()
    const input = q('kpi-threshold') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '80')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(api.schedule.setConfig).toHaveBeenCalledWith({ utilizationThreshold: 80 })
  })
})

describe('SchedulerTopBands — PLANS toolbar', () => {
  it('shows counts and routes PRDs / History / Machine + mode buttons', async () => {
    await mount()
    expect(q('scheduler-plans-meta').textContent).toContain('7 PRDs')
    const onSubView = vi.fn(); const onPlanMode = vi.fn()
    await mount({ onSubView, onPlanMode })
    await click(btn('History')); expect(onSubView).toHaveBeenLastCalledWith('history')
    await click(btn('Machine')); expect(onSubView).toHaveBeenLastCalledWith('machine')
    await click(btn('PRDs')); expect(onSubView).toHaveBeenLastCalledWith('prds')
    await click(btn('Critical path')); expect(onPlanMode).toHaveBeenLastCalledWith('critical')
  })

  it('filter input drives onFilterText', async () => {
    const onFilterText = vi.fn()
    await mount({ onFilterText })
    const input = q('scheduler-filter-input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'abc')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onFilterText).toHaveBeenCalledWith('abc')
  })
})
