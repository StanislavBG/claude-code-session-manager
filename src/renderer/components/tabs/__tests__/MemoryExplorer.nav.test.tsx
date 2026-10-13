// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ExplorerNav } from '../memory/explorer/ExplorerNav'
import type { ClusterInfo, ExplorerScope } from '../memory/explorer/model'
import type { MemoryAgent, MemoryIndexHealth } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

const agents: MemoryAgent[] = [
  { name: 'dev-lead', origin: 'project', memoryScope: 'project', agentFile: '/a/dev-lead.md' },
  { name: 'architect', origin: 'user', memoryScope: null, agentFile: '/a/architect.md' },
]
const clusters: ClusterInfo[] = [
  { id: 'c1', name: 'Scheduler', summary: '', memberSlugs: [], linkCount: 0, staleCount: 0, dotClass: 'bg-accent' },
]
const index: IndexHealth = {
  lines: 210, bytes: 2048, maxLines: 200, maxBytes: 25600,
  overBudget: true, nearBudget: true, orphans: [], dangling: ['x.md'],
}
type IndexHealth = MemoryIndexHealth

function props(over: Record<string, unknown> = {}) {
  return {
    scope: { kind: 'workspace' } as ExplorerScope,
    agents,
    agentCounts: { 'dev-lead': 4, architect: 0 },
    workspaceName: 'session-manager',
    workspacePath: '/home/x/session-manager',
    workspaceCount: 12,
    onScope: vi.fn(),
    view: 'all',
    onView: vi.fn(),
    counts: { all: 12, stale: 3, broken: 0, recent: 2, unindexed: 1 },
    clusters,
    clusterCounts: { c1: 5 },
    unclusteredCount: 7,
    archivedCount: 0,
    index,
    ...over,
  }
}

async function mount(p: ReturnType<typeof props>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(ExplorerNav, p as never))
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

describe('ExplorerNav', () => {
  it('renders counts and a check for zero review counts', async () => {
    await mount(props())
    expect(q('mx-nav-all')!.textContent).toContain('12')
    expect(q('mx-nav-stale')!.textContent).toContain('3')
    expect(q('mx-nav-broken')!.textContent).toContain('✓')
    expect(q('mx-nav-cluster:c1')!.textContent).toContain('5')
    expect(q('mx-nav-cluster:unclustered')!.textContent).toContain('7')
  })

  it('calls onView on row click and marks the active row', async () => {
    const p = props()
    await mount(p)
    act(() => q('mx-nav-stale')!.click())
    expect(p.onView).toHaveBeenCalledWith('stale')
    expect(q('mx-nav-all')!.className).toContain('bg-bg font-semibold')
  })

  it('opens the scope menu, picks an agent, and closes', async () => {
    const p = props()
    await mount(p)
    expect(q('mx-scope-menu')).toBeNull()
    act(() => q('mx-scope-card')!.click())
    const menu = q('mx-scope-menu')!
    expect(menu.textContent).toContain('off')
    expect(menu.textContent).toContain('✓')
    const item = Array.from(menu.querySelectorAll('button')).find((b) => b.textContent!.includes('dev-lead'))!
    act(() => item.click())
    expect(p.onScope).toHaveBeenCalledWith({ kind: 'agent', agent: agents[0] })
    expect(q('mx-scope-menu')).toBeNull()
  })

  it('hides CLUSTERS in agent scope', async () => {
    await mount(props({ scope: { kind: 'agent', agent: agents[0] } }))
    expect(q('mx-nav-cluster:c1')).toBeNull()
    expect(container!.textContent).not.toContain('Unclustered')
  })

  it('hides Archived at 0 and shows it above 0', async () => {
    await mount(props())
    expect(q('mx-nav-archived')).toBeNull()
    act(() => root!.render(createElement(ExplorerNav, props({ archivedCount: 2 }) as never)))
    expect(q('mx-nav-archived')).not.toBeNull()
  })

  it('tints the over-budget meter and lists dangling lines', async () => {
    await mount(props())
    const footer = q('mx-index-footer')!
    expect(footer.innerHTML).toContain('bg-accent')
    expect(footer.textContent).toContain('1 index lines point at missing files')
    expect(footer.textContent).toContain('lines 210/200')
  })
})
