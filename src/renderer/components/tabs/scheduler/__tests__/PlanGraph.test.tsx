// @vitest-environment jsdom
/**
 * 2A Graph mode: plan bands → stage columns → PRD rows, mounted through the real
 * SchedulePanel (default planMode) so the wiring from snapshot to DOM is covered.
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
const api = {
  schedule: {
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

function mount(jobs: ScheduleJob[], props: Record<string, unknown> = {}) {
  useScheduleState.setState({ snapshot: snapshot(jobs), loaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Stand-in for the PLANS toolbar's mount point: Graph mode portals its counts / status filter / ⋯ menu into it.
  slot = document.createElement('div')
  document.body.appendChild(slot)
  act(() => root!.render(<SchedulePanel scopeCwd="/p" planToolsEl={slot} {...props} />))
  return container
}
let slot: HTMLElement | null = null

const q = (el: ParentNode, sel: string) => Array.from(el.querySelectorAll<HTMLElement>(sel))

beforeEach(() => {
  vi.clearAllMocks()
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
  localStorage.clear()
})

describe('Graph mode — plan bands', () => {
  it('plan label is the Epic title (goalText before the blank line); raw id only when the store has no such Epic', () => {
    usePromptSessions.setState({ sessions: { e1: { id: 'e1', goalText: 'Blender MCP asset pipeline\n\nLong goal body' } } as any })
    const el = mount([job({ slug: '1-a' }), job({ slug: '2-b', epicId: 'epic-blender-unhydrated' })])
    const labels = q(el, '[data-testid="plan-label"]').map((l) => l.textContent)
    expect(labels).toContain('Blender MCP asset pipeline')
    expect(labels.some((l) => l!.startsWith('Epic epic-blender'))).toBe(true)
  })

  it('renders one band per plan with a status chip, 2-digit index and the Epic label', () => {
    usePromptSessions.setState({ sessions: { e1: { id: 'e1', title: 'Blender pipeline', goalText: 'Blender pipeline' } } as any })
    const el = mount([
      job({ slug: '284-a', status: 'running', startedAt: new Date().toISOString() }),
      job({ slug: '285-b', dependsOn: ['284-a'] }),
    ])
    const bands = q(el, '[data-testid="plan-band"]')
    expect(bands).toHaveLength(1)
    expect(bands[0].dataset.planStatus).toBe('active')
    expect(bands[0].className).toContain('border-l-[3px]')
    expect(bands[0].className).toContain('border-l-accent')
    expect(el.querySelector('[data-testid="plan-chip"]')!.textContent).toBe('ACTIVE')
    expect(el.querySelector('[data-testid="plan-label"]')!.textContent).toBe('Blender pipeline')
    expect(bands[0].textContent).toContain('01')
    expect(el.querySelector('[data-testid="plan-meta"]')!.textContent).toContain('2 PRDs · 2 stages')
    // No List-mode chrome in Graph mode.
    expect(el.querySelector('[data-testid="backlog-epic-section"]')).toBeNull()
  })

  it('wires the status-dependent action to existing APIs and states the real scope', () => {
    const el = mount([
      job({ slug: '1-run', epicId: 'a', status: 'running', startedAt: new Date().toISOString() }),
      job({ slug: '2-q', epicId: 'b' }),
      job({ slug: '3-done', epicId: 'c', status: 'completed', runId: 'r1', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z' }),
      job({ slug: '4-draft', epicId: 'd', status: 'quarantined' }),
    ])
    const byStatus = (s: string) => el.querySelector<HTMLElement>(`[data-plan-status="${s}"] [data-testid="plan-action"]`)!
    expect(byStatus('active').textContent).toBe('Pause plan')
    expect(byStatus('active').title).toMatch(/whole scheduler/i)
    act(() => byStatus('active').click())
    expect(api.schedule.pause).toHaveBeenCalledTimes(1)

    expect(byStatus('queued').textContent).toBe('Run now')
    expect(byStatus('queued').title).toMatch(/machine-wide/i)
    act(() => byStatus('queued').click())
    expect(api.schedule.forceTick).toHaveBeenCalledTimes(1)

    expect(byStatus('done').textContent).toBe('View run')
    act(() => byStatus('done').click())
    expect(api.schedule.readLog).toHaveBeenCalledWith('r1', '3-done')

    const onOpenPrds = vi.fn()
    act(() => root!.render(<SchedulePanel scopeCwd="/p" onOpenPrds={onOpenPrds} />))
    expect(byStatus('draft').textContent).toBe('Schedule…')
    act(() => byStatus('draft').click())
    expect(onOpenPrds).toHaveBeenCalledWith('4-draft')
  })

  it('collapses a done plan by default and toggles with the caret', () => {
    const el = mount([job({ slug: '3-done', status: 'completed' })])
    expect(el.querySelector('[data-testid="stage-column"]')).toBeNull()
    act(() => el.querySelector<HTMLElement>('[data-testid="plan-toggle"]')!.click())
    expect(el.querySelector('[data-testid="stage-column"]')).not.toBeNull()
  })
})

describe('Graph mode — stage columns and rows', () => {
  it('renders stage headers with summaries, and row trailing cells', () => {
    const el = mount([
      job({ slug: '281-a', status: 'completed', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:04:12Z' }),
      job({ slug: '284-b', status: 'running', estimateMinutes: 10, startedAt: new Date(Date.now() - 60_000).toISOString(), dependsOn: ['281-a'] }),
      job({ slug: '287-c', dependsOn: ['281-a'] }),
      job({ slug: '291-d', dependsOn: ['284-b'] }),
    ])
    const cols = q(el, '[data-testid="stage-column"]')
    expect(cols).toHaveLength(3)
    expect(q(cols[0], '[data-testid="stage-summary"]')[0].textContent).toBe('1/1 done')
    expect(cols[0].querySelector('[data-testid="stage-header"]')!.textContent).toContain('Stage 1')
    expect(q(cols[1], '[data-testid="stage-summary"]')[0].textContent).toMatch(/1 running/)
    const rows = q(el, '[data-testid="prd-row"]')
    const trailing = (slug: string) => rows.find((r) => r.dataset.slug === slug)!.querySelector('[data-testid="prd-row-trailing"]')!.textContent
    expect(trailing('281-a')).toBe('4m12s')
    expect(trailing('284-b')).toMatch(/^\d+%$/)
    expect(trailing('287-c')).toBe('next')
    expect(trailing('291-d')).toBe('←284')
    // Dense-row contract: ~31px rows, 13px title, 11.5px mono id.
    const btn = rows[0].querySelector('button')!
    expect(btn.className).toContain('h-[31px]')
    expect(btn.className).toContain('py-1')
    expect(btn.innerHTML).toContain('text-[13px]')
    expect(btn.innerHTML).toContain('text-[11.5px]')
  })

  it('caps a stage at 7 rows with a "+N in stage" footer that expands locally (no API call)', () => {
    const jobs = [job({ slug: '1-root', status: 'completed' }),
      ...Array.from({ length: 11 }, (_, i) => job({ slug: `${10 + i}-x`, dependsOn: ['1-root'] }))]
    const el = mount(jobs)
    const col2 = q(el, '[data-testid="stage-column"]')[1]
    expect(q(col2, '[data-testid="prd-row"]')).toHaveLength(7)
    const footer = col2.querySelector<HTMLElement>('[data-testid="stage-footer"]')!
    expect(footer.textContent).toBe('+4 in stage 2 ▾')
    act(() => footer.click())
    expect(q(col2, '[data-testid="prd-row"]')).toHaveLength(11)
    expect(Object.values(api.schedule).every((f) => !(vi.isMockFunction(f)) || (f as any).mock.calls.length === 0)).toBe(true)
  })

  it('labels a truncated all-done stage "+N done"', () => {
    const el = mount(Array.from({ length: 9 }, (_, i) => job({ slug: `${i + 1}-d`, status: 'completed' })))
    // Done plans start collapsed — expand.
    act(() => el.querySelector<HTMLElement>('[data-testid="plan-toggle"]')!.click())
    expect(el.querySelector('[data-testid="stage-footer"]')!.textContent).toBe('+4 done ▾')
  })

  it('only mounts the current window of stages of a long plan', () => {
    const jobs = Array.from({ length: 20 }, (_, i) => job({ slug: `${i + 1}-s`, dependsOn: i === 0 ? [] : [`${i}-s`] }))
    const el = mount(jobs)
    const n = q(el, '[data-testid="stage-column"]').length
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(20)
  })

  it('puts Retry / Review under the flagged rows, wired to resetJob and the authoring Epic', () => {
    const nav = vi.fn()
    window.addEventListener('sm:navigate', nav)
    const el = mount([
      job({ slug: '402-f', status: 'failed' }),
      job({ slug: '418-r', status: 'needs_review' }),
      job({ slug: '403-b', dependsOn: ['402-f'] }),
    ])
    const pair = el.querySelector('[data-testid="stage-attention-actions"]')!
    expect(pair).not.toBeNull()
    // Directly after the flagged rows, before the blocked row.
    const stage = pair.parentElement!.parentElement!
    const slugs = q(stage, '[data-testid="prd-row"], [data-testid="stage-attention-actions"]').map((n) => n.dataset.slug ?? 'PAIR')
    expect(slugs.indexOf('PAIR')).toBe(slugs.indexOf('418-r') + 1)
    const retry = pair.querySelector<HTMLElement>('[data-testid="stage-retry"]')!
    expect(retry.textContent).toBe('Retry #402')
    act(() => retry.click())
    expect(api.schedule.resetJob).toHaveBeenCalledWith('402-f')
    const review = pair.querySelector<HTMLElement>('[data-testid="stage-review"]')!
    expect(review.textContent).toBe('Review #418')
    act(() => review.click())
    expect(nav).toHaveBeenCalled()
    window.removeEventListener('sm:navigate', nav)
  })

  it('opens a row detail carrying every JobRow action, with its data-testids', () => {
    usePromptSessions.setState({ sessions: { e1: { id: 'e1', title: 'E', goalText: 'goal' } } as any })
    const el = mount([
      job({ slug: '1-q', status: 'quarantined', runId: 'r9', disposition: 'append' as any }),
      job({ slug: '2-f', status: 'failed', runId: 'r8' }),
    ])
    const open = (slug: string) => act(() => el.querySelector<HTMLElement>(`[data-slug="${slug}"] button`)!.click())
    open('1-q')
    const ids = q(el, '[data-testid]').map((n) => n.dataset.testid)
    expect(ids).toContain('job-row-prompt-session-link')
    expect(ids).toContain('job-row-adopt-prd')
    expect(ids).toContain('job-row-disposition-control')
    expect(el.textContent).toContain('view log →')
    // quarantined → no reset action
    expect(el.textContent).not.toContain('reset to pending')
    act(() => el.querySelector<HTMLElement>('[data-testid="job-row-adopt-prd"]')!.click())
    expect(api.schedule.adoptPrd).toHaveBeenCalledWith('1-q')
    open('2-f')
    const reset = q(el, '[data-slug="2-f"] button').find((b) => b.textContent === 'reset to pending →')!
    act(() => reset.click())
    expect(api.schedule.resetJob).toHaveBeenCalledWith('2-f')
    act(() => q(el, '[data-slug="2-f"] button').find((b) => b.textContent === 'view log →')!.click())
    expect(api.schedule.readLog).toHaveBeenCalledWith('r8', '2-f')
  })
})

describe('Graph vs List mode', () => {
  it('List mode renders the pre-2A vertical tree unchanged; Graph is the default', () => {
    const jobs = [job({ slug: 'a1' }), job({ slug: 'b1', epicId: 'e2' })]
    const list = mount(jobs, { planMode: 'list' })
    expect(list.querySelectorAll('[data-testid="backlog-epic-section"]')).toHaveLength(2)
    expect(list.querySelector('[data-testid="plan-band"]')).toBeNull()
    act(() => root!.render(<SchedulePanel scopeCwd="/p" />))
    expect(list.querySelector('[data-testid="backlog-epic-section"]')).toBeNull()
    expect(list.querySelectorAll('[data-testid="plan-band"]')).toHaveLength(2)
  })

  it('keeps Clear completed (hiddenSlugs + localStorage) and keyboard-nav attributes in Graph mode', () => {
    const el = mount([
      job({ slug: '1-a', status: 'completed', finishedAt: new Date().toISOString(), startedAt: new Date().toISOString() }),
      job({ slug: '2-b' }),
    ])
    expect(el.querySelector('[role="list"][aria-label="Job queue"]')).not.toBeNull()
    expect(el.querySelector('[aria-live="polite"]')).not.toBeNull()
    // listIndex is a unique, stable id (the arrow-key handler navigates by live DOM position).
    expect(q(el, '[data-job-row]').map((r) => r.dataset.jobIndex).sort()).toEqual(['0', '1'])
    act(() => slot!.querySelector<HTMLButtonElement>('[data-testid="plan-tools-menu"]')!.click())
    const clear = q(slot!, 'button').find((b) => b.textContent === 'Clear completed')!
    act(() => clear.click())
    expect(JSON.parse(localStorage.getItem('sm.scheduler.hiddenCompletedSlugs')!)).toContain('1-a')
    expect(el.querySelector('[data-slug="1-a"]')).toBeNull()
  })
})
