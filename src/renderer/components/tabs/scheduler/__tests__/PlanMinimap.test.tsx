// @vitest-environment jsdom
/** 2A: WHOLE GRAPH minimap, FURTHER STAGES tail, Critical path mode, footer band. */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulePanel } from '../../../SchedulePanel'
import { useScheduleState } from '../../../../state/scheduleState'
import { usePromptSessions } from '../../../../state/promptSessions'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null
const api = {
  supervisor: { getLog: async () => [] },
  schedule: {
    health: async () => ({ consecutiveFailures: 2, bootedAt: 0, lastPollAt: 0, lastPollOk: true, backoffNextAt: null, nextResetCached: null, runningJobs: [] }),
    onState: () => () => {},
    setConfig: async () => ({ ok: true }),
    forceTick: vi.fn(async () => ({ ok: true })),
    pause: vi.fn(async () => ({ ok: true })),
    resetJob: vi.fn(async () => ({ ok: true })),
    readLog: vi.fn(() => new Promise(() => {})),
    rescan: async () => ({ ok: true }),
    openFolder: vi.fn(async () => {}),
    setPrdDisposition: vi.fn(async () => ({ ok: true })),
    lintQueue: vi.fn(async () => ({ reports: [{ slug: 'x', findings: [{ severity: 'error', line: 3, snippet: 'bad' }, { severity: 'warn', line: 4, snippet: 'meh' }] }] })),
  },
}

function job(over: Partial<ScheduleJob> & { slug: string }): ScheduleJob {
  return {
    title: over.slug, status: 'pending', cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '',
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'e1', ...over,
  } as ScheduleJob
}
function snapshot(jobs: ScheduleJob[]): ScheduleStateSnapshot {
  return {
    config: { firePolicy: 'when-available', supervisor: { enabled: false } },
    jobs, lastTick: null, scheduledFor: null, lastRunAt: null, nextReset: null, paused: null,
    utilization: null, effectiveConcurrency: { cap: 3, source: 'config' },
  } as unknown as ScheduleStateSnapshot
}
async function mount(jobs: ScheduleJob[], props: Record<string, unknown> = {}) {
  useScheduleState.setState({ snapshot: snapshot(jobs), loaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<SchedulePanel scopeCwd="/p" {...props} />) })
  return container
}
const one = (el: ParentNode, sel: string) => el.querySelector<HTMLElement>(sel)!
const all = (el: ParentNode, sel: string) => Array.from(el.querySelectorAll<HTMLElement>(sel))

/** 10-stage chain: 01 running, 02..10 each depend on the previous; 05 failed (so blockers exist at stage 5). */
function chain(n = 10): ScheduleJob[] {
  const out: ScheduleJob[] = []
  for (let i = 1; i <= n; i++) {
    const slug = `${100 + i}-s${i}`
    out.push(job({
      slug,
      status: i === 1 ? 'running' : i === 5 ? 'failed' : 'pending',
      startedAt: i === 1 ? new Date().toISOString() : null,
      dependsOn: i > 1 ? [`${100 + i - 1}-s${i - 1}`] : undefined,
      estimateMinutes: 10,
    }))
  }
  return out
}

beforeEach(() => { vi.clearAllMocks(); ;(globalThis as any).window.api = api })
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  useScheduleState.setState({ snapshot: null, loaded: false })
  usePromptSessions.setState({ sessions: {} })
  localStorage.clear()
})

describe('WHOLE GRAPH minimap', () => {
  it('renders one plain span per PRD in ONE strip, with status tone + title', async () => {
    const jobs = [...chain(3), ...Array.from({ length: 111 }, (_, i) => job({ slug: `${200 + i}-x`, dependsOn: ['101-s1'], status: 'completed' }))]
    const el = await mount(jobs)
    expect(all(el, '[data-testid="plan-minimap"]')).toHaveLength(1)
    const dots = all(el, '[data-testid="plan-minimap-dots"] > span[title]')
    expect(dots).toHaveLength(114)
    // no per-PRD memoized component: dots are bare spans, and none carries a testid of its own
    expect(dots.every((d) => d.tagName === 'SPAN' && !d.dataset.testid)).toBe(true)
    const running = dots.find((d) => d.title.startsWith('#101 '))!
    expect(running.title).toBe('#101 101-s1 — running')
    expect(running.dataset.tone).toBe('running')
    expect(dots.find((d) => d.title.includes('— completed'))!.className).toContain('bg-sage')
    expect(one(el, '[data-testid="plan-minimap"]').className).toContain('h-[28px]')
  })

  it('is only shown for ACTIVE plans', async () => {
    const el = await mount([job({ slug: '1-a' }), job({ slug: '2-b', dependsOn: ['1-a'] })])
    expect(el.querySelector('[data-testid="plan-minimap"]')).toBeNull()
  })

  it('brush <-> scroll stay in sync in both directions', async () => {
    const el = await mount(chain(12))
    const strip = one(el, '[data-testid="plan-stages"]')
    const brush = () => one(el, '[data-testid="plan-minimap-brush"]')
    const range = () => one(el, '[data-testid="plan-minimap-range"]').textContent
    expect(range()).toBe('stages 1–6 of 12')
    const left0 = brush().style.left

    // scroll -> brush
    act(() => { strip.scrollLeft = 4 * 264; strip.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(range()).toBe('stages 5–10 of 12')
    expect(brush().style.left).not.toBe(left0)
    const leftScrolled = brush().style.left

    // brush -> scroll: press far right of the strip, the columns scroll to that stage window
    const dots = one(el, '[data-testid="plan-minimap-dots"]')
    act(() => { dots.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0 })) })
    expect(strip.scrollLeft).toBe(0)
    expect(range()).toBe('stages 1–6 of 12')
    expect(brush().style.left).toBe(left0)
    expect(brush().style.left).not.toBe(leftScrolled)
  })

  it('Running / Blockers jump the stage window locally, and disable when none exist', async () => {
    const el = await mount(chain(12))
    const strip = one(el, '[data-testid="plan-stages"]')
    act(() => one(el, '[data-testid="minimap-blockers"]').click())
    expect(strip.scrollLeft).toBe(4 * 264) // stage 5 failed
    act(() => one(el, '[data-testid="minimap-running"]').click())
    expect(strip.scrollLeft).toBe(0) // stage 1 running
    expect(api.schedule.pause).not.toHaveBeenCalled()
  })

  it('disables Blockers with an explanatory title when nothing is blocked', async () => {
    const jobs = chain(3).map((j) => (j.status === 'failed' ? { ...j, status: 'pending' as const } : j))
    const el = await mount(jobs)
    const b = one(el, '[data-testid="minimap-blockers"]') as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.title).toMatch(/No stage/)
  })
})

describe('FURTHER STAGES tail', () => {
  it('lists hidden stages with progress bars and scrolls the strip on click', async () => {
    const el = await mount(chain(10))
    const tail = one(el, '[data-testid="further-stages"]')
    expect(tail.textContent).toContain('STAGE 7–10'.replace('STAGE', 'Stage'))
    expect(tail.textContent).toContain('Further stages')
    const rows = all(tail, '[data-testid="further-stage-row"]')
    expect(rows.map((r) => r.textContent)).toEqual(['stage 7', 'stage 8', 'stage 9', 'stage 10'])
    act(() => rows[1].click())
    expect(one(el, '[data-testid="plan-stages"]').scrollLeft).toBe(7 * 264)
  })

  it('is absent when every stage is visible', async () => {
    const el = await mount(chain(3))
    expect(el.querySelector('[data-testid="further-stages"]')).toBeNull()
  })
})

describe('Critical path mode', () => {
  it('renders the longest chain as one column with estimate + running total, others collapsed to a count', async () => {
    const jobs = [...chain(3), job({ slug: '150-side', dependsOn: ['101-s1'], estimateMinutes: 5 })]
    const el = await mount(jobs, { planMode: 'critical' })
    expect(el.querySelector('[data-testid="plan-stages"]')).toBeNull()
    const entries = all(el, '[data-testid="critical-entry"]')
    expect(entries.map((e) => e.dataset.slug)).toEqual(['101-s1', '102-s2', '103-s3'])
    expect(all(el, '[data-testid="critical-est"]').map((e) => e.textContent)).toEqual(['10mΣ 10m', '10mΣ 20m', '10mΣ 30m'])
    expect(all(el, '[data-testid="prd-row"]')).toHaveLength(3) // same dense PrdRow, side PRD collapsed
    expect(all(el, '[data-testid="critical-others"]').map((e) => e.textContent)).toEqual(['stage 2 · +1 not on the critical path'])
  })
})

describe('Footer band', () => {
  it('shows poll failures + graph lint, supervisor/folder links, and expands the old diagnostics detail', async () => {
    const el = await mount(chain(2))
    const f = one(el, '[data-testid="scheduler-footer"]')
    expect(one(f, '[data-testid="footer-summary"]').textContent).toBe('2 poll failures since boot · graph lint 1 error, 1 warn')
    expect(el.textContent).not.toContain('Diagnostics')
    act(() => one(f, '[data-testid="footer-folder"]').click())
    expect(api.schedule.openFolder).toHaveBeenCalled()
    expect(f.querySelector('[data-testid="footer-detail"]')).toBeNull()
    act(() => one(f, '[data-testid="footer-info"]').click())
    const d = one(f, '[data-testid="footer-detail"]').textContent!
    expect(d).toContain('booted:')
    expect(d).toContain('last poll:')
    expect(d).toContain('L3: bad')
    const calls = api.schedule.lintQueue.mock.calls.length
    await act(async () => { one(f, '[data-testid="footer-rerun-lint"]').click() })
    expect(api.schedule.lintQueue.mock.calls.length).toBeGreaterThan(calls)
    act(() => one(f, '[data-testid="footer-supervisor"]').click())
    expect(el.querySelector('[data-testid="scheduler-footer"]')).toBeNull() // supervisor panel replaced the queue
  })
})
