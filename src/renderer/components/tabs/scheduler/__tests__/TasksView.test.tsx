// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TasksView } from '../TasksView'
import { useToast } from '../../../../state/toast'
import type { TaskSummary } from '../../../../../preload/api'

const rows: TaskSummary[] = [
  { taskId: 't1', status: 'ok', source: 'sm', agent: 'writer', model: 'sonnet', startedAt: '2026-11-20T10:00:00.000Z', durationMs: 65_000, costUsd: 0.5, exitCode: 0, caller: { pipeline: 'burrow', runId: 'r1', step: 'draft' } },
  { taskId: 't2', status: 'error', source: 'direct', agent: 'editor', model: 'opus', startedAt: '2026-11-21T10:00:00.000Z', durationMs: 2_000, costUsd: 1.25, exitCode: 1, caller: { pipeline: 'burrow', runId: 'r2', step: 'edit' } },
  { taskId: 't3', status: 'rate_limited', source: 'sm', agent: 'writer', model: 'sonnet', startedAt: '2026-11-19T10:00:00.000Z', quota: { rateLimited: true, resetsAt: null } },
]

const api = {
  tasks: {
    list: vi.fn(),
    get: vi.fn(),
    getSwitch: vi.fn(),
    setSwitch: vi.fn(),
  },
}

let host: HTMLDivElement
let root: Root

async function render(scopeCwd: string | null, onOpen?: (id: string) => void) {
  await act(async () => {
    root.render(createElement(TasksView, { scopeCwd, onOpen }))
  })
  await act(async () => { await Promise.resolve() })
}

const q = (sel: string) => host.querySelector(sel)
const qa = (sel: string) => Array.from(host.querySelectorAll(sel))

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = api
  api.tasks.list.mockReset().mockResolvedValue({ ok: true, tasks: rows, total: 3, hasMore: false, skippedLines: 0 })
  api.tasks.getSwitch.mockReset().mockResolvedValue({ ok: true, enabled: false })
  api.tasks.setSwitch.mockReset().mockResolvedValue({ ok: true, enabled: true, changedAt: '2026-11-22T00:00:00Z' })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('TasksView', () => {
  it('shows the no-project empty state without calling the API', async () => {
    await render(null)
    expect(host.textContent).toContain('Open a project to see its Tasks')
    expect(api.tasks.list).not.toHaveBeenCalled()
  })

  it('loads with cwd + limit 200 and groups by pipeline then run, newest first', async () => {
    await render('/p')
    expect(api.tasks.list).toHaveBeenCalledWith({ cwd: '/p', limit: 200 })
    expect(q('[data-testid="tasks-view"]')).not.toBeNull()
    const groups = qa('[data-testid^="tasks-group-"]').map((g) => g.getAttribute('data-testid'))
    expect(groups).toEqual(['tasks-group-burrow', 'tasks-group-Ungrouped'])
    const ids = qa('[data-testid^="tasks-row-"]').map((r) => r.getAttribute('data-testid'))
    // burrow: run r2 (newest) before r1; then Ungrouped t3
    expect(ids).toEqual(['tasks-row-t2', 'tasks-row-t1', 'tasks-row-t3'])
  })

  it('shows the direct badge only on imported rows, with cost, zone and status chip', async () => {
    const onOpen = vi.fn()
    await render('/p', onOpen)
    const badges = qa('[data-testid="tasks-badge-direct"]')
    expect(badges).toHaveLength(1)
    expect(q('[data-testid="tasks-row-t2"]')!.contains(badges[0])).toBe(true)
    expect(badges[0].textContent).toBe('ran without SM')
    const t2 = q('[data-testid="tasks-row-t2"]')!.textContent!
    expect(t2).toContain('$1.25')
    expect(t2).toContain('editor')
    expect(t2).toContain('opus')
    expect(t2).toContain('exit 1')
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date('2026-11-21T10:00:00.000Z')).find((p) => p.type === 'timeZoneName')!.value
    expect(t2).toContain(zone)
    expect(q('[data-testid="tasks-row-t3"]')!.textContent).toContain('quota')
    act(() => { (q('[data-testid="tasks-row-t1"]') as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  it('builds filter options from the rows and refetches on filter change', async () => {
    await render('/p')
    const agentSel = q('[data-testid="tasks-filter-agent"]') as HTMLSelectElement
    const opts = Array.from(agentSel.options).map((o) => o.value)
    expect(opts).toEqual(['', 'editor', 'writer'])
    await act(async () => {
      agentSel.value = 'writer'
      agentSel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
    expect(api.tasks.list).toHaveBeenLastCalledWith({ cwd: '/p', agent: 'writer', limit: 200 })
    const ids = qa('[data-testid^="tasks-row-"]').map((r) => r.getAttribute('data-testid'))
    expect(ids).toEqual(['tasks-row-t1', 'tasks-row-t3'])
    const pipeOpts = Array.from((q('[data-testid="tasks-filter-pipeline"]') as HTMLSelectElement).options).map((o) => o.value)
    expect(pipeOpts).toContain('burrow')
  })

  it('shows an empty state when there are no tasks', async () => {
    api.tasks.list.mockResolvedValue({ ok: true, tasks: [], total: 0, hasMore: false, skippedLines: 0 })
    await render('/p')
    expect(host.textContent).toContain('No Tasks yet')
  })

  it('reports a list failure as an error toast', async () => {
    api.tasks.list.mockResolvedValue({ ok: false, error: 'boom' })
    await render('/p')
    const errs = useToast.getState().history.filter((t) => t.kind === 'error')
    expect(errs.some((t) => t.message.includes('boom'))).toBe(true)
  })

  it('polls every 15 s and stops on unmount', async () => {
    vi.useFakeTimers()
    await render('/p')
    const n = api.tasks.list.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(15_000) })
    expect(api.tasks.list.mock.calls.length).toBe(n + 1)
    act(() => root.unmount())
    vi.advanceTimersByTime(30_000)
    expect(api.tasks.list.mock.calls.length).toBe(n + 1)
    root = createRoot(host)
  })

  it('reads the switch and writes setSwitch on toggle', async () => {
    await render('/p')
    expect(api.tasks.getSwitch).toHaveBeenCalledWith({ cwd: '/p' })
    const sw = q('[data-testid="tasks-switch"]') as HTMLInputElement
    expect(sw.checked).toBe(false)
    expect(host.textContent).toContain('403')
    await act(async () => { sw.click() })
    expect(api.tasks.setSwitch).toHaveBeenCalledWith({ cwd: '/p', enabled: true })
    expect((q('[data-testid="tasks-switch"]') as HTMLInputElement).checked).toBe(true)
  })
})
