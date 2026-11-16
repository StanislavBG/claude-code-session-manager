// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LinksRail } from '../memory/explorer/LinksRail'
import type { MemoryRow } from '../memory/explorer/model'

let container: HTMLDivElement | null = null
let root: Root | null = null

function row(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    name: 'a.md', slug: 'a', path: '/m/a.md', description: 'desc a', bytes: 2048, mtimeMs: 0,
    ageDays: 3, stale: false, staleReasons: [], ageOnlyStale: false, deadRefs: [], movedRefs: [], broken: false,
    danglingLinks: [], outLinks: [], inLinks: [], notIndexed: false, clusterId: null, type: null,
    originSessionId: null, ...over,
  }
}

function mount(r: MemoryRow | null) {
  const fns = { onOpen: vi.fn(), onRemoveLink: vi.fn(), onAskAbout: vi.fn(), onUpdatePath: vi.fn(), onReviewPath: vi.fn() }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(LinksRail, { row: r, known: new Set(['b']), ...fns }))
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

describe('LinksRail', () => {
  it('renders an empty aside when row is null', () => {
    mount(null)
    expect(q('mx-links')).not.toBeNull()
    expect(q('mx-links')!.children.length).toBe(0)
  })

  it('shows counts for both sections', () => {
    mount(row({ outLinks: ['b', 'gone'], danglingLinks: ['gone'], inLinks: ['c'] }))
    expect(q('mx-links')!.textContent).toContain('LINKS TO · 2')
    expect(q('mx-links')!.textContent).toContain('LINKED FROM · 1')
  })

  it('dangling click removes the link, styled red', () => {
    const f = mount(row({ outLinks: ['b', 'gone'], danglingLinks: ['gone'] }))
    const el = q('mx-link-out-gone')!
    expect(el.className).toContain('border-accent-muted')
    expect(el.textContent).toContain('missing · click to remove link')
    expect(el.querySelector('.text-accent')).not.toBeNull()
    click(el)
    expect(f.onRemoveLink).toHaveBeenCalledWith('gone')
    expect(f.onOpen).not.toHaveBeenCalled()
  })

  it('normal out and in links open', () => {
    const f = mount(row({ outLinks: ['b'], inLinks: ['c'] }))
    expect(q('mx-link-out-b')!.textContent).toContain('wikilink')
    click(q('mx-link-out-b')!)
    expect(f.onOpen).toHaveBeenLastCalledWith('b')
    expect(q('mx-link-in-c')!.textContent).toContain('wikilink')
    click(q('mx-link-in-c')!)
    expect(f.onOpen).toHaveBeenLastCalledWith('c')
    expect(f.onRemoveLink).not.toHaveBeenCalled()
  })

  it('shows both empty lines', () => {
    mount(row())
    const t = q('mx-links')!.textContent
    expect(t).toContain('No outgoing links.')
    expect(t).toContain('Nothing links here yet.')
  })

  it('ask box fires onAskAbout', () => {
    const f = mount(row())
    const ask = q('mx-links-ask')!
    expect(ask.textContent).toContain('Ask about this memory')
    expect(ask.textContent).toContain('Is this still accurate?')
    click(ask)
    expect(f.onAskAbout).toHaveBeenCalledTimes(1)
  })

  it('renders moved and dead path cards; moved click updates, dead click reviews', () => {
    const f = mount(row({
      movedRefs: [{ from: 'src/old.ts', to: 'src/new.ts' }],
      deadRefs: ['src/gone.ts'],
      broken: true,
    }))
    expect(q('mx-links')!.textContent).toContain('PATHS · 2')
    const moved = q('mx-path-moved-0')!
    expect(moved.textContent).toContain('src/new.ts')
    expect(moved.textContent).toContain('click to update')
    expect(moved.className).toContain('border-rule-inner')
    const dead = q('mx-path-dead-0')!
    expect(dead.textContent).toContain('src/gone.ts')
    expect(dead.textContent).toContain('not found anywhere')
    expect(dead.className).toContain('border-accent-muted')
    click(moved)
    expect(f.onUpdatePath).toHaveBeenCalledWith({ from: 'src/old.ts', to: 'src/new.ts' })
    expect(f.onReviewPath).not.toHaveBeenCalled()
    click(dead)
    expect(f.onReviewPath).toHaveBeenCalledTimes(1)
  })

  it('hides the PATHS section when there are no path problems', () => {
    mount(row())
    expect(q('mx-links')!.textContent).not.toContain('PATHS')
  })
})
