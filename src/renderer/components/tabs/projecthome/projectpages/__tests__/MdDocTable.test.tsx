// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdDocTable, filterDocs, sortDocs, type MdDocTableProps } from '../MdDocTable'
import type { MdCensus, MdDoc, MdRecordCollection } from '../../../../../../preload/api'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function doc(path: string, over: Partial<MdDoc> = {}): MdDoc {
  return {
    path, role: 'doc', depth: 1, lines: 10, bytes: 100, lastCommitMs: NOW - DAY, commits: 1,
    linkedFrom: 1, codeRefs: 0, codeRefFiles: [], deadRefs: [], changedSince: [], collection: null, ...over,
  }
}

function census(docs: MdDoc[], collections: MdRecordCollection[] = []): MdCensus {
  return {
    docs, collections,
    counts: { tracked: docs.length, network: docs.length, records: 0, unlinked: 0, byRole: { map: 0, scoped: 0, agent: 0, record: 0, doc: 0 } },
    gitWindow: { commits: 10, oldestMs: null }, warnings: [],
  }
}

const DOCS: MdDoc[] = [
  doc('CLAUDE.md', { role: 'map', depth: 0, lines: 200, linkedFrom: 0, codeRefs: 5, lastCommitMs: NOW - 2 * DAY }),
  doc('src/CLAUDE.md', { role: 'scoped', lines: 40, linkedFrom: 3, codeRefs: 1, lastCommitMs: NOW - 10 * DAY }),
  doc('.claude/agents/a.md', { role: 'agent', lines: null, linkedFrom: 0, codeRefs: 2, lastCommitMs: null }),
  doc('docs/Guide.md', { lines: 80, linkedFrom: 7, codeRefs: 0, lastCommitMs: NOW - 400 * DAY }),
  doc('docs/orphan.md', { depth: null, lines: 5, linkedFrom: 0, codeRefs: 0, lastCommitMs: NOW - 3 * DAY }),
  doc('records/r1.md', { role: 'record', depth: null, lines: 12, linkedFrom: 0, collection: 'records/', lastCommitMs: NOW - 3 * DAY }),
]

const COLLECTIONS: MdRecordCollection[] = [
  { folder: 'records/', docs: 1, linked: 0, lastCommitMs: NOW - 3 * DAY, source: 'heuristic' },
  { folder: 'notes/', docs: 4, linked: 1, lastCommitMs: null, source: 'override' },
]

const paths = (d: MdDoc[]) => d.map((x) => x.path)

describe('filterDocs', () => {
  it('filters by role, unlinked and path search', () => {
    expect(paths(filterDocs(DOCS, 'all', ''))).toHaveLength(6)
    expect(paths(filterDocs(DOCS, 'map', ''))).toEqual(['CLAUDE.md'])
    expect(paths(filterDocs(DOCS, 'scoped', ''))).toEqual(['src/CLAUDE.md'])
    expect(paths(filterDocs(DOCS, 'agent', ''))).toEqual(['.claude/agents/a.md'])
    expect(paths(filterDocs(DOCS, 'doc', ''))).toEqual(['docs/Guide.md', 'docs/orphan.md'])
    expect(paths(filterDocs(DOCS, 'record', ''))).toEqual(['records/r1.md'])
    expect(paths(filterDocs(DOCS, 'unlinked', ''))).toEqual(['docs/orphan.md'])
    expect(paths(filterDocs(DOCS, 'all', 'GUIDE'))).toEqual(['docs/Guide.md'])
    expect(paths(filterDocs(DOCS, 'doc', 'claude'))).toEqual([])
  })
})

describe('sortDocs', () => {
  it('newest change first, nulls last', () => {
    expect(paths(sortDocs(DOCS, 'newest'))).toEqual([
      'CLAUDE.md', 'docs/orphan.md', 'records/r1.md', 'src/CLAUDE.md', 'docs/Guide.md', '.claude/agents/a.md',
    ])
  })
  it('oldest change first, nulls last', () => {
    expect(paths(sortDocs(DOCS, 'oldest'))).toEqual([
      'docs/Guide.md', 'src/CLAUDE.md', 'docs/orphan.md', 'records/r1.md', 'CLAUDE.md', '.claude/agents/a.md',
    ])
  })
  it('most lines, nulls last', () => {
    expect(paths(sortDocs(DOCS, 'lines'))).toEqual([
      'CLAUDE.md', 'docs/Guide.md', 'src/CLAUDE.md', 'records/r1.md', 'docs/orphan.md', '.claude/agents/a.md',
    ])
  })
  it('most linked-from, ties by path', () => {
    expect(paths(sortDocs(DOCS, 'linkedFrom'))).toEqual([
      'docs/Guide.md', 'src/CLAUDE.md', '.claude/agents/a.md', 'CLAUDE.md', 'docs/orphan.md', 'records/r1.md',
    ])
  })
  it('most code refs, ties by path', () => {
    expect(paths(sortDocs(DOCS, 'codeRefs'))).toEqual([
      'CLAUDE.md', '.claude/agents/a.md', 'src/CLAUDE.md', 'docs/Guide.md', 'docs/orphan.md', 'records/r1.md',
    ])
  })
  it('does not mutate its input', () => {
    const copy = [...DOCS]
    sortDocs(DOCS, 'lines')
    expect(DOCS).toEqual(copy)
  })
})

describe('MdDocTable', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function render(props: Partial<MdDocTableProps> = {}) {
    const full: MdDocTableProps = { census: census(DOCS, COLLECTIONS), selectedPath: null, onSelect: vi.fn(), nowMs: NOW, ...props }
    act(() => root.render(<MdDocTable {...full} />))
    return full
  }
  const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="md-doc-table-row"]'))
  const rowPaths = () => rows().map((r) => r.dataset.path)
  const chip = (f: string) => host.querySelector<HTMLButtonElement>(`[data-testid="md-doc-table-filter"][data-filter="${f}"]`)!

  it('renders filter chips with counts and filters rows', () => {
    render()
    const filters = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="md-doc-table-filter"]')).map((c) => c.dataset.filter)
    expect(filters).toEqual(['all', 'map', 'scoped', 'agent', 'doc', 'record', 'unlinked'])
    expect(chip('all').textContent).toContain('6')
    expect(chip('doc').textContent).toContain('2')
    expect(chip('unlinked').textContent).toContain('1')
    expect(rowPaths()).toHaveLength(6)
    act(() => chip('unlinked').click())
    expect(rowPaths()).toEqual(['docs/orphan.md'])
    expect(chip('unlinked').getAttribute('aria-pressed')).toBe('true')
  })

  it('search filters by case-insensitive path substring', () => {
    render()
    const input = host.querySelector<HTMLInputElement>('[data-testid="md-doc-table-search"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'CLAUDE')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rowPaths()).toEqual(['CLAUDE.md', 'src/CLAUDE.md', '.claude/agents/a.md'])
  })

  it('sort select defaults to newest and re-orders rows', () => {
    render()
    const sel = host.querySelector<HTMLSelectElement>('[data-testid="md-doc-table-sort"]')!
    expect(sel.value).toBe('newest')
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['newest', 'oldest', 'lines', 'linkedFrom', 'codeRefs'])
    expect(rowPaths()[0]).toBe('CLAUDE.md')
    act(() => {
      sel.value = 'linkedFrom'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(rowPaths()[0]).toBe('docs/Guide.md')
  })

  it('rows show meta, flags and verdict; click selects', () => {
    const p = render({ selectedPath: 'docs/Guide.md', verdicts: { 'docs/Guide.md': 'update' } })
    const guide = rows().find((r) => r.dataset.path === 'docs/Guide.md')!
    expect(guide.textContent).toContain('doc')
    expect(guide.textContent).toContain('1y ago')
    expect(guide.textContent).toContain('80')
    expect(guide.textContent).toContain('no change in 90+ days')
    expect(guide.querySelector('[data-testid="md-doc-table-verdict"]')?.textContent).toBe('update')
    expect(guide.getAttribute('aria-selected')).toBe('true')
    const orphan = rows().find((r) => r.dataset.path === 'docs/orphan.md')!
    expect(orphan.getAttribute('aria-selected')).toBe('false')
    expect(orphan.textContent).toContain('unlinked')
    expect(orphan.querySelector('[data-testid="md-doc-table-verdict"]')).toBeNull()
    act(() => orphan.click())
    expect(p.onSelect).toHaveBeenCalledWith('docs/orphan.md')
  })

  it('reviewedAt suppresses the stale flag', () => {
    render({ reviewedAt: { 'docs/Guide.md': NOW - DAY } })
    const guide = rows().find((r) => r.dataset.path === 'docs/Guide.md')!
    expect(guide.textContent).not.toContain('no change in 90+ days')
  })

  it('caps rendering at 500 rows with a note', () => {
    const many = Array.from({ length: 620 }, (_, i) => doc(`d/${String(i).padStart(4, '0')}.md`))
    render({ census: census(many) })
    expect(rows()).toHaveLength(500)
    expect(host.querySelector('[data-testid="md-doc-table-cap"]')?.textContent).toBe('Showing 500 of 620 — narrow the filter')
  })

  it('no cap note under 500', () => {
    render()
    expect(host.querySelector('[data-testid="md-doc-table-cap"]')).toBeNull()
  })

  it('collections show folder, docs, linked and last change; no toggles without onFolderKind', () => {
    render()
    const cols = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="md-doc-table-collection"]'))
    expect(cols.map((c) => c.dataset.folder)).toEqual(['records/', 'notes/'])
    expect(cols[0].textContent).toContain('records/')
    expect(cols[0].textContent).toContain('3d ago')
    expect(cols[1].textContent).toContain('4 docs')
    expect(cols[1].textContent).toContain('1 linked')
    expect(host.querySelector('[data-testid="md-doc-table-folder-records"]')).toBeNull()
  })

  it('folder toggles reflect recordFolders/docFolders and call onFolderKind', () => {
    const onFolderKind = vi.fn()
    render({ onFolderKind, recordFolders: ['records/'], docFolders: ['notes/'] })
    const cols = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="md-doc-table-collection"]'))
    const rec0 = cols[0].querySelector<HTMLButtonElement>('[data-testid="md-doc-table-folder-records"]')!
    const doc0 = cols[0].querySelector<HTMLButtonElement>('[data-testid="md-doc-table-folder-docs"]')!
    const rec1 = cols[1].querySelector<HTMLButtonElement>('[data-testid="md-doc-table-folder-records"]')!
    const doc1 = cols[1].querySelector<HTMLButtonElement>('[data-testid="md-doc-table-folder-docs"]')!
    expect(rec0.textContent).toBe('Treat as records')
    expect(doc0.textContent).toBe('Count as docs')
    expect(rec0.getAttribute('aria-pressed')).toBe('true')
    expect(doc0.getAttribute('aria-pressed')).toBe('false')
    expect(rec1.getAttribute('aria-pressed')).toBe('false')
    expect(doc1.getAttribute('aria-pressed')).toBe('true')
    act(() => rec0.click())
    expect(onFolderKind).toHaveBeenLastCalledWith('records/', null)
    act(() => doc0.click())
    expect(onFolderKind).toHaveBeenLastCalledWith('records/', 'docs')
    act(() => rec1.click())
    expect(onFolderKind).toHaveBeenLastCalledWith('notes/', 'records')
    act(() => doc1.click())
    expect(onFolderKind).toHaveBeenLastCalledWith('notes/', null)
  })
})
