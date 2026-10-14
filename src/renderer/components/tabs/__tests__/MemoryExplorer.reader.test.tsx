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
const IDLE = { state: 'idle', diff: [], summary: '', action: 'update', reason: '', fold: null }
const CONTENT = '---\nname: x\n---\n\nBody text.\n\n**Why:** because.\n\n**How to apply:** do it.\n'

function props(over: Record<string, unknown> = {}) {
  return {
    row, content: CONTENT, clusterName: 'Scheduler', clusterDot: 'bg-accent', archived: false,
    mode: 'read', onMode: vi.fn(), onEdit: vi.fn(), onCopyPath: vi.fn(), onReveal: vi.fn(),
    onArchive: vi.fn(), onRestore: vi.fn(), onAskDelete: vi.fn(),
    fix: IDLE,
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
    mount({ row: stale, fix: { ...IDLE, state: 'checking' } })
    expect(q('mx-reader')!.textContent).toContain('Assistant is checking')
    act(() => root!.unmount()); container!.remove()
    const p2 = mount({
      row: stale,
      fix: { ...IDLE, state: 'proposed', diff: [{ sign: '−', text: 'old' }, { sign: '+', text: 'new' }], summary: 's' },
    })
    expect(q('mx-reader')!.textContent).toContain('Suggested update')
    expect(q('mx-reader')!.textContent).toContain('Writes the file')
    click(q('mx-reader-apply'))
    click(q('mx-reader-discard'))
    expect(p2.onApplyFix).toHaveBeenCalled()
    expect(p2.onDiscardFix).toHaveBeenCalled()
  })

  it.each([
    ['update', 'Suggested update', 'Apply', 'Writes the file'],
    ['delete', 'Suggested: archive this memory', 'Archive', 'Moves to .archive — undoable'],
    ['keep', 'Looks accurate — keep', 'Mark verified', 'Touches the file, clears age staleness'],
    ['fold', 'Suggested: move into CLAUDE.md', 'Copy for an Epic', 'Memory stays until the doc change lands'],
  ])('proposed %s: header, label, hint', (action, header, label, hint) => {
    const fold = action === 'fold' ? { target: 'CLAUDE.md', anchor: '', insert: 'line one\nline two' } : null
    mount({ fix: { ...IDLE, state: 'proposed', action, summary: 'sum', reason: 'because', fold,
      diff: action === 'update' ? [{ sign: '+', text: 'new' }] : [] } })
    const t = q('mx-reader')!.textContent!
    expect(t).toContain(header)
    expect(t).toContain('sum')
    expect(t).toContain('because')
    expect(t).toContain(hint)
    expect(q('mx-reader-apply')!.textContent).toBe(label)
  })

  it('fold shows + rows under target and append anchor; non-update hides diff', () => {
    mount({ fix: { ...IDLE, state: 'proposed', action: 'fold', diff: [{ sign: '−', text: 'gone' }],
      fold: { target: 'src/CLAUDE.md', anchor: '', insert: 'line one\nline two' } } })
    const t = q('mx-reader')!.textContent!
    expect(t).toContain('src/CLAUDE.md')
    expect(t).toContain('append at end')
    expect(t).toContain('+line one')
    expect(t).toContain('+line two')
    expect(t).not.toContain('gone')
  })

  it('shows Applied — still flagged when appliedStill', () => {
    mount({ row: { ...row, stale: true, staleReasons: ['dead path'] }, appliedStill: true })
    expect(q('mx-reader-stale')!.textContent).toContain('Applied — still flagged: dead path')
  })

  it('Review with assistant on a non-stale row', () => {
    const p = mount()
    expect(q('mx-reader-fix')!.textContent).toBe('Review with assistant')
    click(q('mx-reader-fix'))
    expect(p.onFix).toHaveBeenCalled()
  })

  it('proposed panel shows on a non-stale row', () => {
    mount({ fix: { ...IDLE, state: 'proposed', action: 'keep', summary: 's' } })
    expect(q('mx-reader-apply')).not.toBeNull()
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
