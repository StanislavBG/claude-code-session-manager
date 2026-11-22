// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryReader } from '../memory/explorer/MemoryReader'
import { MemoryExplorer } from '../memory/explorer/MemoryExplorer'
import type { MemoryRow } from '../memory/explorer/model'

// The shared document editor is heavy (Monaco); record the props the Memory tab hands it.
const editorProps: { value?: string; changedFrom?: string }[] = []
vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: any) => {
    editorProps.push({ value: p.value, changedFrom: p.changedFrom })
    return createElement('div', { 'data-testid': 'doc-editor' }, [
      createElement('button', { key: 'r', 'data-testid': 'doc-editor-revert', onClick: () => p.onRevert?.() }, 'Revert'),
      createElement('button', { key: 's', 'data-testid': 'doc-editor-save', onClick: () => p.onSave?.() }, 'Save'),
    ])
  },
}))
vi.mock('../../VoiceButton', () => ({ VoiceButton: () => null }))
vi.mock('../../../state/toast', () => ({ toast: { error: vi.fn(), show: vi.fn(), success: vi.fn() } }))

let container: HTMLDivElement | null = null
let root: Root | null = null

const row: MemoryRow = {
  name: 'feedback_x.md', slug: 'feedback_x', path: '/m/feedback_x.md', description: 'Lead desc',
  bytes: 2048, mtimeMs: 0, ageDays: 3, stale: false, staleReasons: [], ageOnlyStale: false,
  deadRefs: [], movedRefs: [], broken: false, danglingLinks: [], outLinks: [], inLinks: [], notIndexed: false,
  clusterId: null, type: 'project', originSessionId: 'de0e5dbe-1234',
}
const IDLE = { state: 'idle', diff: [], summary: '', action: 'update', reason: '', fold: null }
const CONTENT = '---\nname: x\n---\n\nBody text.\n\n**Why:** because.\n\n**How to apply:** do it.\n'

function props(over: Record<string, unknown> = {}) {
  return {
    row, content: CONTENT, clusterName: 'Scheduler', clusterDot: 'bg-accent', archived: false,
    onRead: vi.fn(), onEdit: vi.fn(), onCopyPath: vi.fn(), onReveal: vi.fn(),
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
  it('eyebrow: CLUSTER · TYPE · SIZE · MODIFIED · SESSION, mono title', () => {
    mount()
    expect(q('mx-reader-eyebrow')!.textContent).toBe('SCHEDULER · PROJECT · 2.0 KB · MODIFIED 3D AGO · SESSION DE0E5DBE')
    expect(q('mx-reader-title')!.textContent).toBe('feedback_x')
    expect(q('mx-reader-title')!.className).toContain('font-mono')
    act(() => root!.unmount())
    container!.remove()
    mount({ row: { ...row, type: null, originSessionId: null } })
    expect(q('mx-reader-eyebrow')!.textContent).toBe('SCHEDULER · 2.0 KB · MODIFIED 3D AGO')
  })

  it('Read | Edit switch: Edit calls onEdit; in edit mode shows the editor and Read calls onRead', () => {
    const p = mount()
    expect(q('mx-reader-mode-read')!.getAttribute('aria-pressed')).toBe('true')
    click(q('mx-reader-edit'))
    expect(p.onEdit).toHaveBeenCalled()
    act(() => root!.unmount()); container!.remove()
    const p2 = mount({ editing: true, editor: createElement('div', { 'data-testid': 'fake-editor' }, 'ED') })
    expect(q('mx-reader-edit')!.getAttribute('aria-pressed')).toBe('true')
    expect(q('mx-reader')!.textContent).toContain('Editing')
    expect(q('fake-editor')).not.toBeNull()
    expect(q('mx-reader')!.textContent).not.toContain('Lead desc')
    expect(q('mx-reader-fix')).toBeNull()
    click(q('mx-reader-mode-read'))
    expect(p2.onRead).toHaveBeenCalled()
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
    expect(q('mx-reader')!.textContent).toContain('CLAUDE SUGGESTS · UPDATE')
    expect(q('mx-reader')!.textContent).toContain('Writes the file · undoable')
    click(q('mx-reader-apply'))
    click(q('mx-reader-discard'))
    expect(p2.onApplyFix).toHaveBeenCalled()
    expect(p2.onDiscardFix).toHaveBeenCalled()
  })

  it.each([
    ['update', 'CLAUDE SUGGESTS · UPDATE', 'Apply update', 'Writes the file · undoable'],
    ['delete', 'CLAUDE SUGGESTS · ARCHIVE', 'Archive', 'Moves to .archive · undoable'],
    ['keep', 'CLAUDE SUGGESTS · KEEP', 'Mark verified', 'Touches the file, clears age staleness'],
    ['fold', 'CLAUDE SUGGESTS · FOLD', 'Copy for an Epic', 'Memory stays until the doc change lands'],
  ])('proposed %s: header, label, hint', (action, header, label, hint) => {
    const fold = action === 'fold' ? { target: 'CLAUDE.md', anchor: '', insert: 'line one\nline two' } : null
    mount({ fix: { ...IDLE, state: 'proposed', action, summary: 'sum', reason: 'because', fold,
      diff: action === 'update' ? [{ sign: '+', text: 'new' }] : [] } })
    const t = q('mx-reader')!.textContent!
    expect(t).toContain(header)
    expect(t).toContain('sum')
    expect(t).toContain('because')
    expect(t).toContain(hint)
    expect(t).toContain('one of keep · update · archive · fold')
    expect(q('mx-reader-pill')!.textContent).toBe('Suggestion ready')
    expect(q('mx-reader-apply')!.textContent).toBe(label)
    expect(q('mx-reader-edit-first') !== null).toBe(action === 'update')
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
    expect(q('mx-reader-fix')!.textContent).toBe('+ Review with Claude')
    click(q('mx-reader-fix'))
    expect(p.onFix).toHaveBeenCalled()
  })

  it('proposed panel shows on a non-stale row', () => {
    mount({ fix: { ...IDLE, state: 'proposed', action: 'keep', summary: 's' } })
    expect(q('mx-reader-apply')).not.toBeNull()
  })

  it('⋯ menu items call handlers', () => {
    const p = mount()
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

describe('MemoryExplorer · Claude suggestion', () => {
  const DISK = '---\nname: alpha\ndescription: about alpha\n---\n\nalpha body text\n'
  const PROPOSED = '---\nname: alpha\ndescription: about alpha\n---\n\nalpha body revised\n'
  const memory = {
    list: vi.fn(), read: vi.fn(), write: vi.fn(), delete: vi.fn(), create: vi.fn(), stale: vi.fn(),
    aggregate: vi.fn(), agents: vi.fn(), verify: vi.fn(), archive: vi.fn(), restore: vi.fn(),
    listArchived: vi.fn(), ask: vi.fn(), proposeFix: vi.fn(),
  }
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const press = async (id: string) => { await act(async () => { q(id)!.click() }); await flush() }
  const lastEditor = () => editorProps[editorProps.length - 1]

  beforeEach(() => {
    editorProps.length = 0
    localStorage.clear()
    memory.list.mockResolvedValue({
      entries: [{ name: 'alpha.md', path: '/mem/alpha.md', bytes: 40, mtimeMs: Date.now() }],
      dir: '/mem', autoMemoryEnabled: true, error: null, workspace: 'ws',
    })
    memory.read.mockResolvedValue({ content: DISK, error: null })
    memory.write.mockResolvedValue({ ok: true, error: null })
    memory.stale.mockResolvedValue({
      entries: [{ name: 'alpha.md', description: 'about alpha', stale: false, reasons: [], deadRefs: [], danglingLinks: [], outLinks: [] }],
      workspace: 'ws', error: null,
    })
    memory.aggregate.mockResolvedValue({ workspace: 'ws', generatedAt: null, clusters: [], orphans: [], cached: true })
    memory.agents.mockResolvedValue({ agents: [] })
    memory.listArchived.mockResolvedValue({ names: [], error: null })
    memory.proposeFix.mockResolvedValue({
      ok: true, action: 'update', summary: 'Revise the body', reason: 'the old text drifted', content: PROPOSED, fold: null,
    })
    ;(window as unknown as { api: unknown }).api = {
      memory,
      config: { watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}) },
      clipboard: { writeText: vi.fn(async () => ({ ok: true })) },
      shell: { open: vi.fn() },
    }
  })
  afterEach(() => { vi.clearAllMocks() })

  async function mountExplorer() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(MemoryExplorer, { cwd: '/p' })) })
    await flush(); await flush()
    await press('mx-links-check')
  }

  it('update renders the card with a −/+ diff, the pill and the CHECKED IN rail with evidence', async () => {
    await mountExplorer()
    expect(q('mx-suggestion-head')!.textContent).toBe('CLAUDE SUGGESTS · UPDATE')
    expect(q('mx-reader-summary')!.textContent).toBe('Revise the body')
    expect(q('mx-reader-reason')!.textContent).toBe('the old text drifted')
    const diff = q('mx-suggestion-diff')!.textContent!
    expect(diff).toContain('−alpha body text')
    expect(diff).toContain('+alpha body revised')
    expect(q('mx-reader-pill')!.textContent).toBe('Suggestion ready')
    expect(q('mx-links-checked')!.textContent).toMatch(/CHECKED IN \d+:\d\d/)
    expect(q('mx-links-askclaude')).toBeNull()
    expect(q('mx-links-evidence-list')).toBeNull()
    await press('mx-links-evidence')
    const ev = q('mx-links-evidence-list')!.textContent!
    expect(ev).toContain('Verdict: update')
    expect(ev).toContain('1 line removed · 1 line added')
  })

  it('Discard writes nothing and closes the card', async () => {
    await mountExplorer()
    await press('mx-reader-discard')
    expect(memory.write).not.toHaveBeenCalled()
    expect(q('mx-suggestion')).toBeNull()
    expect(q('mx-reader-pill')).toBeNull()
    expect(q('mx-links-askclaude')).not.toBeNull()
  })

  it('Edit first passes the proposed content + changedFrom (file on disk) to the editor; Revert returns to disk', async () => {
    await mountExplorer()
    await press('mx-reader-edit-first')
    expect(lastEditor()).toEqual({ value: PROPOSED, changedFrom: DISK })
    expect(q('mx-reader-pill')!.textContent).toBe("Editing Claude's update")
    expect(q('mx-links-started')!.textContent).toContain("Started from Claude's update")
    expect(memory.write).not.toHaveBeenCalled()
    await press('doc-editor-revert')
    expect(lastEditor()).toEqual({ value: DISK, changedFrom: undefined })
    expect(q('mx-reader-pill')!.textContent).toBe('Editing')
    expect(q('mx-links-started')).toBeNull()
  })

  it('Edit first then Save writes the edited file once, undoable', async () => {
    await mountExplorer()
    await press('mx-reader-edit-first')
    await press('doc-editor-save')
    expect(memory.write).toHaveBeenCalledTimes(1)
    expect(memory.write).toHaveBeenCalledWith('alpha.md', PROPOSED, expect.anything())
    await press('mx-undo')
    expect(memory.write).toHaveBeenLastCalledWith('alpha.md', DISK, expect.anything())
  })

  it('Apply calls memory.write once with the proposed file, and Undo writes the old body back', async () => {
    await mountExplorer()
    await press('mx-reader-apply')
    expect(memory.write).toHaveBeenCalledTimes(1)
    // Today's update path: the on-disk frontmatter + the proposed body.
    expect(memory.write).toHaveBeenCalledWith('alpha.md', '---\nname: alpha\ndescription: about alpha\n---\nalpha body revised\n', expect.anything())
    expect(q('mx-suggestion')).toBeNull()
    expect(q('mx-undo-bar')).not.toBeNull()
    await press('mx-undo')
    expect(memory.write).toHaveBeenCalledTimes(2)
    expect(memory.write).toHaveBeenLastCalledWith('alpha.md', DISK, expect.anything())
  })
})
