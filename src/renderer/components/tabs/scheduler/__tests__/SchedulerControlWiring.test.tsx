// @vitest-environment jsdom
/**
 * 2A gate: every Scheduler control that CONTROL_MAP.md promises is present AND fires its
 * window.api call, asserted through the whole shell (Scheduler.tsx → top bands → SchedulePanel →
 * plan bands → PrdRow detail → footer → SupervisorPanel) with a mocked window.api.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Scheduler } from '../../Scheduler'
import { useScheduleState } from '../../../../state/scheduleState'
import { useSessions } from '../../../../state/sessions'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../../../../preload/api'

const ok = () => vi.fn(async () => ({ ok: true }))
const api = {
  schedule: {
    health: vi.fn(async () => ({ consecutiveFailures: 0, lastPollAt: Date.now(), lastPollOk: true, bootedAt: Date.now(), backoffNextAt: null, nextResetCached: null, runningJobs: [] })),
    onState: () => () => {},
    queueHealth: vi.fn(async () => ({
      unknown: false,
      verdict: { kind: 'running', runningCount: 1, pending: 2, dispatchable: 1, needsReviewCount: 0, blockedChains: [] },
      slots: { inUse: 1, total: 5, free: 4, source: 'pool' },
      oldestRunningAgeMs: 1000, lastRunAt: null, lastDispatchAttemptAt: null,
    })),
    lintQueue: vi.fn(async () => ({ reports: [] })),
    pause: ok(), resume: ok(), forceTick: ok(), rescan: ok(), setConfig: ok(), setSessionSlots: ok(), clearQueue: ok(),
    resetJob: ok(), adoptPrd: ok(), setPrdDisposition: ok(), openFolder: vi.fn(async () => {}),
    readLog: vi.fn(() => new Promise(() => {})),
    listPrds: vi.fn(async () => []),
  },
  supervisor: { getLog: vi.fn(async () => []) },
  history: { dashboard: vi.fn(async () => null) },
}

function job(over: Partial<ScheduleJob> & { slug: string }): ScheduleJob {
  return {
    title: over.slug, status: 'pending', cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '',
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'e1', ...over,
  } as ScheduleJob
}

const JOBS = [
  job({ slug: '1-run', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(), runId: 'run-1' }),
  job({ slug: '2-pend', status: 'pending', disposition: 'append', dependsOn: ['1-run'] } as never),
  job({ slug: '3-fail', status: 'failed', runId: 'run-3', dependsOn: ['1-run'] }),
  job({ slug: '4-quar', status: 'quarantined', dependsOn: ['1-run'] }),
]

function snapshot(paused: unknown = null): ScheduleStateSnapshot {
  return {
    config: { firePolicy: 'when-available', utilizationThreshold: 90, supervisor: { enabled: false, intervalMinutes: 15, maxConcurrentProbes: 2, probeStaleThresholdMinutes: 10 } },
    jobs: JOBS, lastTick: null, scheduledFor: null, lastRunAt: null, nextReset: null, paused,
    utilization: 10, effectiveConcurrency: { cap: 3, free: 2, source: 'config' },
  } as unknown as ScheduleStateSnapshot
}

let container: HTMLDivElement
let root: Root

async function mount(paused: unknown = null) {
  useScheduleState.setState({ snapshot: snapshot(paused), loaded: true })
  useSessions.setState({ tabs: [{ id: 't1', cwd: '/p' } as never], activeTabId: 't1' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Scheduler />)
    await Promise.resolve(); await Promise.resolve()
  })
}
const tid = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const btn = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)!
const click = async (el: HTMLElement) => { expect(el).toBeTruthy(); await act(async () => { el.click(); await Promise.resolve() }) }
const openRow = async (slug: string) => {
  const row = container.querySelector<HTMLElement>(`[data-testid="prd-row"][data-slug="${slug}"] button[data-job-row]`)
  await click(row!)
}
function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  return act(async () => { set.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  localStorage.clear()
  ;(globalThis as any).window.api = api
  window.confirm = vi.fn(() => true)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('Scheduler 2A — control → API wiring', () => {
  it('title band: Pause, Fire next batch, Refresh; queueHealth + health poll on mount', async () => {
    await mount()
    expect(api.schedule.queueHealth).toHaveBeenCalled()
    expect(api.schedule.health).toHaveBeenCalled()
    await click(btn('Pause')); expect(api.schedule.pause).toHaveBeenCalledTimes(1)
    await click(btn('Fire next batch')); expect(api.schedule.forceTick).toHaveBeenCalledTimes(1)
    await click(btn('Refresh')); expect(api.schedule.rescan).toHaveBeenCalledTimes(1)
  })

  it('pause banner: Resume', async () => {
    await mount({ reason: 'manual', at: new Date().toISOString() })
    await click(btn('Resume')); expect(api.schedule.resume).toHaveBeenCalledTimes(1)
  })

  it('CONCURRENCY cell: firePolicy, utilizationThreshold, session slots', async () => {
    await mount()
    await change(tid('kpi-fire-policy') as HTMLSelectElement, 'manual')
    expect(api.schedule.setConfig).toHaveBeenCalledWith({ firePolicy: 'manual' })
    await change(tid('kpi-threshold') as HTMLInputElement, '80')
    expect(api.schedule.setConfig).toHaveBeenCalledWith({ utilizationThreshold: 80 })
    await click(tid('kpi-concurrency-inc')); expect(api.schedule.setSessionSlots).toHaveBeenCalledWith(4)
  })

  it('counts strip: Archive & clear queue…', async () => {
    await mount()
    await click(btn('Archive & clear queue…'))
    expect(window.confirm).toHaveBeenCalled()
    expect(api.schedule.clearQueue).toHaveBeenCalledTimes(1)
  })

  it('PRD row detail: resetJob, readLog, adoptPrd, setPrdDisposition', async () => {
    await mount()
    await openRow('3-fail')
    await click(btn('view log →')); expect(api.schedule.readLog).toHaveBeenCalledWith('run-3', '3-fail')
    await click(btn('reset to pending →')); expect(api.schedule.resetJob).toHaveBeenCalledWith('3-fail')
    await openRow('4-quar')
    await click(btn('adopt PRD →')); expect(api.schedule.adoptPrd).toHaveBeenCalledWith('4-quar')
    await openRow('2-pend')
    const ctl = tid('job-row-disposition-control')
    const sel = (ctl instanceof HTMLSelectElement ? ctl : ctl.querySelector('select'))!
    await change(sel, '__new-head__')
    expect(api.schedule.setPrdDisposition).toHaveBeenCalledWith(expect.objectContaining({ slug: '2-pend', disposition: 'new-head' }))
  })

  it('footer: lintQueue rerun, openFolder, supervisor panel → getLog + setConfig({supervisor})', async () => {
    await mount()
    await click(tid('footer-info'))
    await click(tid('footer-rerun-lint'))
    expect(api.schedule.lintQueue).toHaveBeenCalled()
    await click(tid('footer-folder')); expect(api.schedule.openFolder).toHaveBeenCalledTimes(1)
    await click(tid('footer-supervisor'))
    expect(api.supervisor.getLog).toHaveBeenCalled()
    const enabled = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await click(enabled)
    expect(api.schedule.setConfig).toHaveBeenCalledWith({ supervisor: expect.objectContaining({ enabled: true }) })
  })
})
