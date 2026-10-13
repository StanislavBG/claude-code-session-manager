// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryReader } from '../memory/explorer/MemoryReader'
import type { MemoryRow } from '../memory/explorer/model'

let container: HTMLDivElement | null = null
let root: Root | null = null

const row: MemoryRow = {
  name: 'feedback_x.md', slug: 'feedback_x', path: '/m/feedback_x.md', description: 'Lead desc',
  bytes: 2048, mtimeMs: 0, ageDays: 3, stale: false, staleReasons: [], ageOnlyStale: false,
  deadRefs: [], broken: false, danglingLinks: [], outLinks: [], inLinks: [], notIndexed: false,
  clusterId: null, type: 'project', originSessionId: 'de0e5dbe-1234',
}
const CONTENT = '---\nname: x\n---\n\nBody text.\n\n**Why:** because.\n\n**How to apply:** do it.\n'

function props(over: Record<string, unknown> = {}) {
  return {
    row, content: CONTENT, clusterName: 'Scheduler', clusterDot: 'bg-accent', archived: false,
    mode: 'read', onMode: vi.fn(), onEdit: vi.fn(), onCopyPath: vi.fn(), onReveal: vi.fn(),
    onArchive: vi.fn(), onRestore: vi.fn(), onAskDelete: vi.fn(),
    fix: { state: 'idle', diff: [], summary: '' },
    onFix: vi.fn(), onApplyFix: vi.fn(), onDiscardFix: vi.fn(), onVerify: vi.fn(),
    ...over,
  }
}

function mount(over: Record<string, unknown> = {}) {
  const p = props(over)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(createElement(MemoryReader, p as never)) })
  return p
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (el: HTMLElement | null) => act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = root = null
})

describe('MemoryReader', () => {
  it('renders chips conditional on type and session', () => {
    mount()
    const t = q('mx-reader')!.textContent!
    expect(t).toContain('type · project')
    expect(t).toContain('session de0e5dbe')
    act(() => root!.unmount())
    container!.remove()
    mount({ row: { ...row, type: null, originSessionId: null } })
    const t2 = q('mx-reader')!.textContent!
    expect(t2).not.toContain('type ·')
    expect(t2).not.toContain('session ')
  })

  it('hides Mark verified for dead-ref stale, shows for age-only', () => {
    const dead = { ...row, stale: true, staleReasons: ['dead path'], deadRefs: ['a.ts', 'b.ts'] }
    mount({ row: dead })
    expect(q('mx-reader-stale')!.textContent).toContain('Stale — dead path')
    expect(q('mx-reader-stale')!.textContent).toContain('a.ts · b.ts')
    expect(q('mx-reader-verify')).toBeNull()
    act(() => root!.unmount())
    container!.remove()
    const p = mount({ row: { ...dead, deadRefs: [], ageOnlyStale: true } })
    click(q('mx-reader-verify'))
    expect(p.onVerify).toHaveBeenCalled()
  })

  it('fix states idle / checking / proposed', () => {
    const stale = { ...row, stale: true, staleReasons: ['old'], ageOnlyStale: true }
    const p = mount({ row: stale })
    click(q('mx-reader-fix'))
    expect(p.onFix).toHaveBeenCalled()
    act(() => root!.unmount()); container!.remove()
    mount({ row: stale, fix: { state: 'checking', diff: [], summary: '' } })
    expect(q('mx-reader')!.textContent).toContain('Assistant is checking')
    act(() => root!.unmount()); container!.remove()
    const p2 = mount({
      row: stale,
      fix: { state: 'proposed', diff: [{ sign: '−', text: 'old' }, { sign: '+', text: 'new' }], summary: 's' },
    })
    expect(q('mx-reader')!.textContent).toContain('Suggested update')
    expect(q('mx-reader')!.textContent).toContain('Writes the file, clears stale')
    click(q('mx-reader-apply'))
    click(q('mx-reader-discard'))
    expect(p2.onApplyFix).toHaveBeenCalled()
    expect(p2.onDiscardFix).toHaveBeenCalled()
  })

  it('⋯ menu items call handlers; Edit and mode toggle work', () => {
    const p = mount()
    click(q('mx-reader-edit'))
    expect(p.onEdit).toHaveBeenCalled()
    click(q('mx-reader-mode-source'))
    expect(p.onMode).toHaveBeenCalledWith('source')
    const items: [string, string][] = [
      ['Copy path', 'onCopyPath'], ['Reveal in folder', 'onReveal'], ['Archive', 'onArchive'], ['Delete…', 'onAskDelete'],
    ]
    for (const [label, fn] of items) {
      click(q('mx-reader-more'))
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
      click(btn!)
      expect((p as Record<string, unknown>)[fn]).toHaveBeenCalled()
    }
  })

  it('Source shows raw text', () => {
    mount({ mode: 'source' })
    expect(q('mx-reader')!.querySelector('pre')!.textContent).toBe(CONTENT)
  })

  it('archived shows Restore only', () => {
    const p = mount({ archived: true })
    expect(q('mx-reader-edit')).toBeNull()
    expect(q('mx-reader-more')).toBeNull()
    click(q('mx-reader-restore'))
    expect(p.onRestore).toHaveBeenCalled()
  })

  it('renders WHY heading and lead description, strips frontmatter', () => {
    mount()
    const h = [...q('mx-reader')!.querySelectorAll('h4')].map((e) => e.textContent)
    expect(h).toEqual(['WHY', 'HOW TO APPLY'])
    expect(q('mx-reader')!.textContent).toContain('Lead desc')
    expect(q('mx-reader')!.textContent).not.toContain('name: x')
  })

  it('broken-only and not-indexed banners', () => {
    mount({ row: { ...row, broken: true, notIndexed: true } })
    expect(q('mx-reader')!.textContent).toContain('Broken reference')
    expect(q('mx-reader')!.textContent).toContain("Claude won't load this — it has no line in MEMORY.md.")
  })
})
