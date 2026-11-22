// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { buildFixList, chooseKeeper, fixListCount } from '../MdFixList'
import { MdNetworkCards } from '../MdLinkMap'
import type { MdDoc, MdDocRole, MdDuplicatePair, MdNetwork, MdNetworkFinding, MdNetworkNode } from '../../../../../../preload/api'

function censusDoc(path: string, role: MdDocRole, linkedFrom: number): MdDoc {
  return { path, role, depth: 1, lines: 10, bytes: 100, lastCommitMs: null, commits: 1, linkedFrom, codeRefs: 0, codeRefFiles: [], deadRefs: [], ambiguousRefs: [], changedSince: [], collection: null }
}

function node(path: string, depth: number): MdNetworkNode {
  return { id: path, path, depth, type: depth === 0 ? 'hub' : 'doc', linksOut: 0, linkedFrom: 1 }
}

const BROKEN: MdNetworkFinding = {
  type: 'broken-link', file: 'README.md', line: 3, target: 'docs/missing.md', to: 'docs/missing.md',
  where: 'README.md:3 → docs/missing.md', detail: 'The link target doesn’t exist.',
}
const LOCAL: MdNetworkFinding = {
  type: 'broken-link', file: 'README.md', line: 7, target: 'notes/private.md', to: 'notes/private.md',
  where: 'README.md:7 → notes/private.md', detail: 'The link target is not tracked in git.', localOnly: true,
}
const ORPHAN: MdNetworkFinding = {
  type: 'orphan', where: 'notes/', count: 2, paths: ['notes/a.md', 'notes/b.md'], detail: 'No link path reaches these 2 docs.',
}

const DOCS = [
  censusDoc('CLAUDE.md', 'map', 0),
  censusDoc('README.md', 'map', 1),
  censusDoc('docs/topic.md', 'doc', 1),
  censusDoc('docs/other.md', 'doc', 4),
  censusDoc('src/CLAUDE.md', 'scoped', 2),
  censusDoc('.claude/agents/x.md', 'agent', 0),
]

function net(findings: MdNetworkFinding[], duplicates: MdDuplicatePair[]): MdNetwork {
  const nodes = [node('CLAUDE.md', 0), node('README.md', 1), node('docs/topic.md', 1), node('docs/other.md', 1), node('src/CLAUDE.md', 1)]
  return {
    ok: true, root: 'CLAUDE.md', nodes,
    edges: [
      { from: 'CLAUDE.md', to: 'README.md' }, { from: 'CLAUDE.md', to: 'docs/topic.md' },
      { from: 'CLAUDE.md', to: 'docs/other.md' }, { from: 'CLAUDE.md', to: 'src/CLAUDE.md' },
      { from: 'README.md', to: 'docs/missing.md', broken: true },
    ],
    findings, docs: nodes.length, links: 5, scopes: [],
    census: { docs: DOCS, collections: [], counts: { tracked: 6, network: 5, records: 0, unlinked: 1, byRole: { map: 2, scoped: 1, agent: 1, record: 0, doc: 2 } }, gitWindow: { commits: 0, oldestMs: null }, warnings: [] },
    duplicates,
  }
}

describe('chooseKeeper', () => {
  it('always keeps a map, whichever side it is on, even over a topic doc with more links', () => {
    expect(chooseKeeper({ a: 'CLAUDE.md', b: 'docs/topic.md', sharedRuns: 3, samples: [] }, DOCS)).toEqual({ keeper: 'CLAUDE.md', other: 'docs/topic.md' })
    expect(chooseKeeper({ a: 'docs/other.md', b: 'CLAUDE.md', sharedRuns: 3, samples: [] }, DOCS)).toEqual({ keeper: 'CLAUDE.md', other: 'docs/other.md' })
    expect(chooseKeeper({ a: 'src/CLAUDE.md', b: 'README.md', sharedRuns: 3, samples: [] }, DOCS).keeper).toBe('README.md')
  })

  it('keeps the topic doc over a scoped or agent doc, whichever side it is on', () => {
    expect(chooseKeeper({ a: 'docs/topic.md', b: 'src/CLAUDE.md', sharedRuns: 3, samples: [] }, DOCS)).toEqual({ keeper: 'docs/topic.md', other: 'src/CLAUDE.md' })
    expect(chooseKeeper({ a: '.claude/agents/x.md', b: 'docs/topic.md', sharedRuns: 3, samples: [] }, DOCS).keeper).toBe('docs/topic.md')
  })

  it('breaks a tie by the higher linkedFrom, then the first doc', () => {
    expect(chooseKeeper({ a: 'docs/topic.md', b: 'docs/other.md', sharedRuns: 3, samples: [] }, DOCS)).toEqual({ keeper: 'docs/other.md', other: 'docs/topic.md' })
    expect(chooseKeeper({ a: 'CLAUDE.md', b: 'README.md', sharedRuns: 3, samples: [] }, DOCS).keeper).toBe('README.md')
    expect(chooseKeeper({ a: '.claude/agents/x.md', b: 'src/CLAUDE.md', sharedRuns: 3, samples: [] }, DOCS).keeper).toBe('src/CLAUDE.md')
    expect(chooseKeeper({ a: 'x.md', b: 'y.md', sharedRuns: 3, samples: [] }, DOCS)).toEqual({ keeper: 'x.md', other: 'y.md' })
  })
})

describe('buildFixList', () => {
  const DUP: MdDuplicatePair = { a: 'CLAUDE.md', b: 'docs/topic.md', sharedRuns: 5, samples: ['x'] }
  const COPY: MdDuplicatePair = { a: 'docs/topic.md', b: 'docs/other.md', sharedRuns: 1, samples: ['y'], copy: true }

  it('ranks duplicates first, then broken links, then orphans', () => {
    const rows = buildFixList(net([ORPHAN, BROKEN, LOCAL], [DUP, COPY]))
    expect(rows.map((r) => r.kind)).toEqual(['duplicate', 'duplicate', 'broken-link', 'broken-link', 'orphan'])
    expect(rows.map((r) => r.findingIndex)).toEqual([null, null, 1, 2, 0])
    expect(fixListCount(net([ORPHAN, BROKEN, LOCAL], [DUP, COPY]))).toBe(5)
  })

  it('says where duplicated text should live; a copy pair says keep one', () => {
    const [dup, copy] = buildFixList(net([], [DUP, COPY]))
    expect(dup.where).toBe('Same text in CLAUDE.md and docs/topic.md (5 shared runs)')
    expect(dup.detail).toBe('Keep the rule in CLAUDE.md; replace the copy in docs/topic.md with a link to it')
    expect(dup.open).toBe('docs/topic.md')
    expect(copy.where).toBe('Same text in docs/topic.md and docs/other.md (1 shared run)')
    expect(copy.detail).toBe('Full copy: keep one. Keep it in docs/other.md; link to it from docs/topic.md')
  })

  it('a localOnly broken link says it works only on this machine; others keep the scan detail', () => {
    const [broken, local] = buildFixList(net([BROKEN, LOCAL], []))
    expect(broken.detail).toBe(BROKEN.detail)
    expect(local.detail).toBe('Works only on this machine: notes/private.md is not tracked in git.')
  })

  it('treats a scan without duplicates or census as findings only', () => {
    const bare = { ...net([BROKEN], []), duplicates: undefined, census: undefined as unknown as MdNetwork['census'] }
    expect(buildFixList(bare).map((r) => r.kind)).toEqual(['broken-link'])
    expect(fixListCount(bare)).toBe(1)
  })
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { shell: { open: vi.fn().mockResolvedValue({ ok: true }) } }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(n: MdNetwork) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<MdNetworkCards cwd="/p/alpha" network={n} />))
}

const all = (id: string) => Array.from(container!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const hot = () => all('md-link-map-node').filter((g) => g.getAttribute('data-state') === 'hot').map((g) => g.getAttribute('data-node-id'))
const hover = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })

describe('MdNetworkCards with the fix list', () => {
  it('renders ranked rows with their text and lights each row’s map nodes on hover', () => {
    mount(net([ORPHAN, LOCAL], [{ a: 'CLAUDE.md', b: 'docs/topic.md', sharedRuns: 2, samples: [] }]))
    expect(container!.querySelector('[data-testid="md-findings"]')).toBeNull()
    const rows = all('md-fix-row')
    expect(rows.map((r) => r.getAttribute('data-type'))).toEqual(['duplicate', 'broken-link', 'orphan'])
    expect(all('md-fix-count')[0].textContent).toBe('3')
    expect(all('md-fix-detail').map((d) => d.textContent)).toEqual([
      'Keep the rule in CLAUDE.md; replace the copy in docs/topic.md with a link to it',
      'Works only on this machine: notes/private.md is not tracked in git.',
      ORPHAN.detail,
    ])
    const where = all('md-fix-where')
    expect(where.every((w) => !w.className.includes('break-all'))).toBe(true)
    expect(where.every((w) => w.className.includes('break-words'))).toBe(true)
    expect(all('md-fix-open').map((b) => b.textContent)).toEqual(['Open topic.md', 'Open', 'Open'])
    act(() => all('md-fix-open')[0].click())
    expect((window.api as unknown as { shell: { open: ReturnType<typeof vi.fn> } }).shell.open).toHaveBeenCalledWith({ as: 'revealPath', path: '/p/alpha/docs/topic.md' })
    hover(rows[0])
    expect(hot()).toEqual(['CLAUDE.md', 'docs/topic.md'])
    expect(all('md-link-map-caption')[0].textContent).toBe('duplicate · Same text in CLAUDE.md and docs/topic.md (2 shared runs)')
    hover(rows[2])
    expect(hot()).toEqual(['orphan:notes/'])
  })
})
