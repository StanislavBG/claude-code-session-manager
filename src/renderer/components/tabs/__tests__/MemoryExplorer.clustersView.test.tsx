// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ClustersView } from '../memory/explorer/ClustersView'
import type { ClusterInfo, MemoryRow } from '../memory/explorer/model'

let container: HTMLDivElement | null = null
let root: Root | null = null

function row(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    name: 'a.md', slug: 'a', path: '/m/a.md', description: '', bytes: 1, mtimeMs: 0,
    ageDays: 1, stale: false, staleReasons: [], ageOnlyStale: false, deadRefs: [], broken: false,
    danglingLinks: [], outLinks: [], inLinks: [], notIndexed: false, clusterId: null, type: null,
    originSessionId: null, ...over,
  }
}

const cluster: ClusterInfo = {
  id: 'c1', name: 'Scheduler', summary: 'Queue notes', memberSlugs: ['a', 'b'],
  linkCount: 4, retireCount: 0, staleCount: 1, dotClass: 'bg-accent',
}

function mount(over: Record<string, unknown> = {}) {
  const fns = { onRegenerate: vi.fn(), onOpenCluster: vi.fn(), onOpen: vi.fn() }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(ClustersView, {
      clusters: [cluster], rows: [row({ slug: 'a', stale: true }), row({ slug: 'b', name: 'b.md' })],
      generatedAt: Date.now() - 3_600_000, running: false, unclusteredCount: 0, available: true,
      ...fns, ...over,
    }))
  })
  return fns
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (el: HTMLElement) => act(() => { el.click() })

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

describe('ClustersView', () => {
  it('unavailable shows only the workspace-only message', () => {
    mount({ available: false })
    expect(q('mx-clusters')!.textContent).toBe('Clusters are available for workspace memory.')
    expect(q('mx-clusters-regenerate')).toBeNull()
  })

  it('never generated shows empty state with Generate', () => {
    const f = mount({ generatedAt: null, clusters: [] })
    const t = q('mx-clusters')!.textContent!
    expect(t).toContain('No clusters yet')
    expect(t).toContain('uses Claude · up to 3 min')
    click(q('mx-clusters-regenerate')!)
    expect(q('mx-clusters-regenerate')!.textContent).toBe('Generate')
    expect(f.onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('running disables Regenerate and labels it Generating…', () => {
    const f = mount({ running: true })
    const b = q('mx-clusters-regenerate') as HTMLButtonElement
    expect(b.textContent).toBe('Generating…')
    expect(b.disabled).toBe(true)
    click(b)
    expect(f.onRegenerate).not.toHaveBeenCalled()
  })

  it('renders header and card with stale-tinted chips', () => {
    mount()
    const t = q('mx-clusters')!.textContent!
    expect(t).toContain('Clusters')
    expect(t).toContain('Generated 1h ago from shared references and links')
    expect(t).toContain('uses Claude')
    expect(t).toContain('Scheduler')
    expect(t).toContain('Open 2 →')
    expect(t).toContain('Queue notes')
    expect(t).toContain('4 links')
    expect(t).toContain('0 retires')
    expect(t).toContain('1 stale')
    const chips = Array.from(q('mx-cluster-c1')!.querySelectorAll('button.font-mono')) as HTMLElement[]
    expect(chips.map((c) => c.textContent)).toEqual(['a', 'b'])
    expect(chips[0].className).toContain('bg-butter/40')
    expect(chips[1].className).toContain('bg-bg')
    expect(chips[1].className).not.toContain('bg-butter/40')
    expect(q('mx-cluster-c1')!.querySelector('.bg-accent')).not.toBeNull()
  })

  it('Open N → and member chips fire callbacks', () => {
    const f = mount()
    click(q('mx-cluster-c1')!.querySelector('[data-testid="mx-cluster-open-c1"]') as HTMLElement)
    expect(f.onOpenCluster).toHaveBeenCalledWith('c1')
    click(q('mx-cluster-c1')!.querySelectorAll('button.font-mono')[1] as HTMLElement)
    expect(f.onOpen).toHaveBeenCalledWith('b.md')
  })

  it('shows unclustered pill only when > 0', () => {
    mount({ unclusteredCount: 3 })
    expect(q('mx-clusters')!.textContent).toContain('3 unclustered')
    act(() => { root!.unmount() }); container!.remove(); root = null
    mount({ unclusteredCount: 0 })
    expect(q('mx-clusters')!.textContent).not.toContain('unclustered')
  })
})
