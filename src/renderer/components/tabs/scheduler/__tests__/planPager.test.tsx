// @vitest-environment jsdom
/**
 * Graph-mode plan-band pagination: SchedulePanel windows `plans` to PLAN_PAGE_SIZE (10) per
 * page with a Prev/Next pager, while the PLANS toolbar counts (plan-tools-counts) keep
 * describing the whole set regardless of which page is shown.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulePanel } from '../../../SchedulePanel'
import { useScheduleState } from '../../../../state/scheduleState'
import { usePromptSessions } from '../../../../state/promptSessions'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null
let slot: HTMLElement | null = null
const configStore = new Map<string, unknown>()
const api = {
  schedule: {
    listPrds: async () => [],
    health: () => new Promise(() => {}),
    onState: () => () => {},
    setConfig: async () => ({ ok: true }),
    forceTick: vi.fn(async () => ({ ok: true })),
    pause: vi.fn(async () => ({ ok: true })),
    resetJob: vi.fn(async () => ({ ok: true })),
    adoptPrd: vi.fn(async () => ({ ok: true })),
    readLog: vi.fn(() => new Promise(() => {})),
    rescan: async () => ({ ok: true }),
    openFolder: async () => {},
    setPrdDisposition: vi.fn(async () => ({ ok: true })),
  },
  config: {
    readJson: vi.fn(async (path: string) => {
      const data = configStore.get(path)
      return data ? { exists: true, data } : { exists: false, data: null }
    }),
    writeJson: vi.fn(async (path: string, data: unknown) => {
      configStore.set(path, data)
      return { ok: true, mtimeMs: Date.now() }
    }),
  },
}

function job(over: Partial<ScheduleJob> & { slug: string }): ScheduleJob {
  return {
    title: over.slug, status: 'pending', cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '',
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: over.slug, ...over,
  } as ScheduleJob
}

/** N independent single-row plans, each its own Epic, so N jobs → N bands. */
function jobs(n: number): ScheduleJob[] {
  return Array.from({ length: n }, (_, i) => job({ slug: `${1000 + i}-a`, epicId: `epic-${i}` }))
}

function snapshot(jobsIn: ScheduleJob[]): ScheduleStateSnapshot {
  return {
    config: { firePolicy: 'when-available', supervisor: { enabled: false } },
    jobs: jobsIn, lastTick: null, scheduledFor: null, lastRunAt: null, nextReset: null, paused: null,
    utilization: null, effectiveConcurrency: { cap: 3, source: 'config' },
  } as unknown as ScheduleStateSnapshot
}

function mount(jobsIn: ScheduleJob[], props: Record<string, unknown> = {}) {
  useScheduleState.setState({ snapshot: snapshot(jobsIn), loaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  slot = document.createElement('div')
  document.body.appendChild(slot)
  act(() => root!.render(<SchedulePanel scopeCwd="/p" planToolsEl={slot} {...props} />))
  return container
}

const q = (el: ParentNode, sel: string) => Array.from(el.querySelectorAll<HTMLElement>(sel))

beforeEach(() => {
  vi.clearAllMocks()
  configStore.clear()
  ;(globalThis as any).window.api = api
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  slot?.remove()
  slot = null
  container = null
  root = null
  useScheduleState.setState({ snapshot: null, loaded: false })
  usePromptSessions.setState({ sessions: {} })
})

describe('SchedulePanel — plan band pagination', () => {
  it('25 plans render 10 bands on page 1, pager shows 1–10 of 25, Next enabled, Prev disabled', () => {
    const el = mount(jobs(25))
    expect(q(el, '[data-testid="plan-band"]')).toHaveLength(10)
    expect(el.querySelector('[data-testid="plan-pager-range"]')!.textContent).toBe('1–10 of 25')
    expect(el.querySelector<HTMLButtonElement>('[data-testid="plan-pager-prev"]')!.disabled).toBe(true)
    expect(el.querySelector<HTMLButtonElement>('[data-testid="plan-pager-next"]')!.disabled).toBe(false)
  })

  it('page 3 of 25 renders the remaining 5 bands, pager shows 21–25 of 25, Next disabled', () => {
    const el = mount(jobs(25))
    const next = () => act(() => el.querySelector<HTMLButtonElement>('[data-testid="plan-pager-next"]')!.click())
    next() // page 2
    next() // page 3
    expect(q(el, '[data-testid="plan-band"]')).toHaveLength(5)
    expect(el.querySelector('[data-testid="plan-pager-range"]')!.textContent).toBe('21–25 of 25')
    expect(el.querySelector<HTMLButtonElement>('[data-testid="plan-pager-next"]')!.disabled).toBe(true)
    expect(el.querySelector<HTMLButtonElement>('[data-testid="plan-pager-prev"]')!.disabled).toBe(false)
  })

  it('no pager for 7 plans (fits on one page)', () => {
    const el = mount(jobs(7))
    expect(q(el, '[data-testid="plan-band"]')).toHaveLength(7)
    expect(el.querySelector('[data-testid="plan-pager"]')).toBeNull()
  })

  it('PLANS toolbar counts describe the whole set, identical on page 1 and page 3', () => {
    const el = mount(jobs(25))
    const countsOnPage1 = slot!.querySelector('[data-testid="plan-tools-counts"]')!.textContent
    const next = () => act(() => el.querySelector<HTMLButtonElement>('[data-testid="plan-pager-next"]')!.click())
    next()
    next()
    const countsOnPage3 = slot!.querySelector('[data-testid="plan-tools-counts"]')!.textContent
    expect(countsOnPage1).toBe(countsOnPage3)
    expect(countsOnPage1).toContain('25 jobs')
  })

  it('changing the plan count (new job arrives) resets the page back to 1', () => {
    const el = mount(jobs(25))
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="plan-pager-next"]')!.click())
    expect(el.querySelector('[data-testid="plan-pager-range"]')!.textContent).toBe('11–20 of 25')
    act(() => useScheduleState.setState({ snapshot: snapshot(jobs(26)) }))
    expect(el.querySelector('[data-testid="plan-pager-range"]')!.textContent).toBe('1–10 of 26')
  })
})
