// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryListPane } from '../memory/explorer/MemoryListPane'
import type { MemoryRow } from '../memory/explorer/model'

let container: HTMLDivElement | null = null
let root: Root | null = null

function row(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    name: 'a.md', slug: 'a', path: '/m/a.md', description: 'desc a', bytes: 2048, mtimeMs: 0,
    ageDays: 3, stale: false, staleReasons: [], ageOnlyStale: false, deadRefs: [], broken: false,
    danglingLinks: [], outLinks: [], inLinks: [], notIndexed: false, clusterId: null, type: null,
    originSessionId: null, ...over,
  }
}

function props(over: Record<string, unknown> = {}) {
  return {
    title: 'All memories',
    rows: [row()],
    clusterDot: () => 'bg-accent',
    selected: null as string | null,
    onSelect: vi.fn(),
    query: '',
    onQuery: vi.fn(),
    sort: 'recent' as const,
    onSort: vi.fn(),
    onNew: vi.fn(),
    empty: null,
    ...over,
  }
}

function mount(p: ReturnType<typeof props>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(createElement(MemoryListPane, p)) })
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

describe('MemoryListPane', () => {
  it('renders title, count, meta and just now', () => {
    mount(props({ rows: [row(), row({ name: 'b.md', slug: 'b', ageDays: 0, bytes: 10 })] }))
    expect(q('mx-list')!.textContent).toContain('All memories')
    expect(q('mx-list-row-a.md')!.textContent).toContain('2.0 KB · 3d ago')
    expect(q('mx-list-row-b.md')!.textContent).toContain('10 B · just now')
  })

  it('badge rules', () => {
    mount(props({
      rows: [
        row({ name: 's.md', slug: 's', stale: true, broken: true }),
        row({ name: 'b.md', slug: 'b', broken: true }),
        row({ name: 'n.md', slug: 'n', notIndexed: true }),
        row({ name: 'p.md', slug: 'p' }),
      ],
    }))
    const t = (n: string) => q(`mx-list-row-${n}`)!.textContent!
    expect(t('s.md')).toContain('STALE')
    expect(t('s.md')).not.toContain('BROKEN')
    expect(t('b.md')).toContain('BROKEN')
    expect(t('n.md')).toContain('NOT INDEXED')
    expect(t('p.md')).not.toMatch(/STALE|BROKEN|NOT INDEXED/)
  })

  it('sort chip cycles recent → name → size → recent', () => {
    const cases: Array<[string, string, string]> = [
      ['recent', 'Recent ⇅', 'name'],
      ['name', 'Name ⇅', 'size'],
      ['size', 'Size ⇅', 'recent'],
    ]
    for (const [sort, label, next] of cases) {
      const p = props({ sort })
      mount(p)
      expect(q('mx-list-sort')!.textContent).toBe(label)
      act(() => { q('mx-list-sort')!.click() })
      expect(p.onSort).toHaveBeenCalledWith(next)
      act(() => { root!.unmount() })
      container!.remove()
    }
  })

  it('onSelect and selected class', () => {
    const p = props({ selected: 'a.md', rows: [row(), row({ name: 'b.md', slug: 'b' })] })
    mount(p)
    expect(q('mx-list-row-a.md')!.className).toContain('bg-muteband')
    expect(q('mx-list-row-b.md')!.className).not.toContain('bg-muteband')
    act(() => { q('mx-list-row-b.md')!.click() })
    expect(p.onSelect).toHaveBeenCalledWith('b.md')
  })

  it('onQuery and onNew', () => {
    const p = props()
    mount(p)
    const input = q('mx-list-filter') as HTMLInputElement
    expect(input.placeholder).toBe('Filter by name or content…')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'foo')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(p.onQuery).toHaveBeenCalledWith('foo')
    act(() => { q('mx-list-new')!.click() })
    expect(p.onNew).toHaveBeenCalled()
  })

  it('empty state with action', () => {
    const onAction = vi.fn()
    mount(props({ rows: [], empty: { title: 'Nothing', body: 'No memories.', action: 'Clear', onAction } }))
    expect(q('mx-list-empty')!.textContent).toContain('Nothing')
    expect(q('mx-list-empty')!.textContent).toContain('No memories.')
    act(() => { (q('mx-list-empty')!.querySelector('button') as HTMLElement).click() })
    expect(onAction).toHaveBeenCalled()
  })

  it('does not render empty block when rows exist', () => {
    mount(props({ empty: { title: 'Nothing', body: 'x', action: 'Go', onAction: vi.fn() } }))
    expect(q('mx-list-empty')).toBeNull()
  })
})
