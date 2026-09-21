// @vitest-environment jsdom
/**
 * 2A density gate. jsdom has no layout engine (every getBoundingClientRect is 0), so heights are
 * asserted from the rendered DOM's COMPUTED-CLASS/inline-style set — the `h-[Npx]` Tailwind
 * literal on each row/band, or the BandRow `style.height` — not from a measured box. The real
 * pixel check lives in tests/e2e/scheduler-2a-graph.spec.ts (Electron, real layout).
 *
 * Fixture: 3 plans / 114 PRDs, 1350x866 viewport.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Scheduler } from '../../Scheduler'
import { STAGE_COL_W } from '../StageColumn'
import { FURTHER_STAGES_W } from '../FurtherStagesTail'
import { useScheduleState } from '../../../../state/scheduleState'
import { useSessions } from '../../../../state/sessions'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../../../../preload/api'

const api = {
  schedule: {
    listPrds: async () => [],
    health: vi.fn(() => new Promise(() => {})),
    onState: () => () => {},
    queueHealth: vi.fn(() => new Promise(() => {})),
    lintQueue: vi.fn(() => new Promise(() => {})),
  },
  supervisor: { getLog: vi.fn(async () => []) },
  history: { dashboard: vi.fn(async () => null) },
}

/** `n` PRDs for one Epic, 6 per stage; each PRD depends on the same-column PRD one stage earlier. */
function plan(epicId: string, n: number, status: 'running' | 'pending' | 'completed'): ScheduleJob[] {
  const out: ScheduleJob[] = []
  for (let i = 0; i < n; i++) {
    const stage = Math.floor(i / 6)
    const st = stage === 0 && i === 0 ? status : status === 'running' ? 'pending' : status
    out.push({
      slug: `${epicId}-${String(i).padStart(3, '0')}`, title: `${epicId} PRD ${i}`, status: st, cwd: '/p', parallelGroup: 1,
      estimateMinutes: null, bodyPreview: '', runId: null, epicId, error: null, exitCode: null,
      startedAt: st === 'running' ? new Date(Date.now() - 60_000).toISOString() : st === 'completed' ? '2026-01-01T00:00:00Z' : null,
      finishedAt: st === 'completed' ? '2026-01-01T00:04:00Z' : null,
      dependsOn: stage === 0 ? [] : [`${epicId}-${String(i - 6).padStart(3, '0')}`],
    } as unknown as ScheduleJob)
  }
  return out
}

let container: HTMLDivElement
let root: Root
const STRIP_W = 1350 - 252 - 3 - FURTHER_STAGES_W
const px = (cls: string) => Number(/(?:^|\s)h-\[(\d+)px\]/.exec(cls)?.[1] ?? NaN)
const one = (sel: string) => container.querySelector<HTMLElement>(sel)!

beforeEach(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  ;(globalThis as any).window.api = api
  window.innerWidth = 1350
  window.innerHeight = 866
  // Stage strip = 1350 viewport − 252px LeftNav − 3px spine − FURTHER STAGES tail; PlanBand reads clientWidth to size its window.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => STRIP_W })
  const jobs = [...plan('ea', 60, 'running'), ...plan('eb', 34, 'pending'), ...plan('ec', 20, 'completed')]
  expect(jobs).toHaveLength(114)
  useScheduleState.setState({
    snapshot: {
      config: { firePolicy: 'when-available', utilizationThreshold: 90, supervisor: { enabled: false } },
      jobs, lastTick: null, scheduledFor: null, lastRunAt: null, nextReset: null, paused: null,
      utilization: 10, effectiveConcurrency: { cap: 3, free: 2, source: 'config' },
    } as unknown as ScheduleStateSnapshot,
    loaded: true,
  })
  useSessions.setState({ tabs: [{ id: 't1', cwd: '/p' } as never], activeTabId: 't1' })
  container = document.createElement('div')
  container.style.width = '1350px'
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<Scheduler />); await Promise.resolve() })
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('Scheduler 2A density (class-set approach — jsdom has no layout)', () => {
  it('fixture renders 3 plan bands', () => {
    expect(container.querySelectorAll('[data-testid="plan-band"]')).toHaveLength(3)
  })

  it('a PRD row is ≤ 32px tall', () => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="prd-row"] > button'))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(px(r.className)).toBeLessThanOrEqual(32)
  })

  it('5 stage columns fit the strip at 1350px, with the FURTHER STAGES tail beside them', () => {
    const first = one('[data-testid="plan-band"]')
    expect(Math.ceil(STRIP_W / STAGE_COL_W)).toBe(5) // five columns, not four + a sliver of a fifth
    expect(STRIP_W / STAGE_COL_W).toBeGreaterThan(4.9) // …and the fifth is (all but) whole
    // windowed: visible ceil(strip / col) columns + 1 overscan on the right (opens at stage 1 — it is running)
    const cols = first.querySelectorAll('[data-testid="stage-column"]').length
    expect(cols).toBe(Math.ceil(STRIP_W / STAGE_COL_W) + 1)
    expect(first.querySelector('[data-testid="further-stages"]')).not.toBeNull()
  })

  it('title + KPI + PLANS toolbar + plan header + WHOLE GRAPH strip ≤ 210px above the first PRD row', () => {
    const band = (id: string) => Number(one(`[data-testid="${id}"]`).style.height.replace('px', ''))
    const title = band('queue-health-header')
    const kpi = band('scheduler-kpi-band')
    const toolbar = band('scheduler-plans-toolbar')
    const first = one('[data-testid="plan-band"]')
    const header = px(first.querySelector<HTMLElement>('[data-testid="plan-header"]')!.className)
    const minimap = px(first.querySelector<HTMLElement>('[data-testid="plan-minimap"]')!.className)
    const parts = { title, kpi, toolbar, header, minimap }
    for (const v of Object.values(parts)) expect(Number.isFinite(v)).toBe(true)
    const total = title + kpi + toolbar + header + minimap
    expect(total, JSON.stringify(parts)).toBeLessThanOrEqual(210)

    // The Graph-mode counts/status strip is gone (PLANS is the only toolbar): the plan list is plan-graph's first child.
    expect(one('[data-testid="plan-graph"]').firstElementChild!.getAttribute('role')).toBe('list')
    const stageHeader = px(first.querySelector<HTMLElement>('[data-testid="stage-header"]')!.className)
    expect(total + stageHeader).toBeLessThanOrEqual(234)
  })

  it('Graph mode has no card chrome: no rounded-xl/2xl box, no filter pills, no coach card', () => {
    expect(container.querySelectorAll('.rounded-xl, .rounded-2xl, button.rounded-full:not([aria-haspopup])')).toHaveLength(0)
    expect(container.textContent).not.toContain('Nothing needed from you')
    expect(container.querySelector('[data-testid="scheduler-plans-toolbar"] select[aria-label="Filter by status"]')).not.toBeNull()
  })
})
