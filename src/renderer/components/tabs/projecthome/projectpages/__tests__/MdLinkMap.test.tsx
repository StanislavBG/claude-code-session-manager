// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdNetworkCards, layoutMdNetwork, type MdLinkMapLayout } from '../MdLinkMap'
import { useToast } from '../../../../../state/toast'
import type { MdNetwork, MdNetworkEdge, MdNetworkFinding, MdNetworkNode } from '../../../../../../preload/api'

const CWD = '/p/alpha'

function doc(path: string, depth: number, linksOut = 0, linkedFrom = 1): MdNetworkNode {
  const type = depth === 0 ? 'hub' : depth === 1 && /(^|\/)(CLAUDE|README|AGENTS)\.md$/.test(path) ? 'owner' : 'doc'
  return { id: path, path, depth, type, linksOut, linkedFrom }
}

function network(nodes: MdNetworkNode[], edges: MdNetworkEdge[], findings: MdNetworkFinding[] = []): MdNetwork {
  return { ok: true, root: 'CLAUDE.md', nodes, edges, findings, docs: nodes.length, links: edges.length, scopes: [], census: { docs: [], collections: [], counts: { tracked: 0, network: 0, records: 0, unlinked: 0, byRole: { map: 0, scoped: 0, agent: 0, record: 0, doc: 0 } }, gitWindow: { commits: 0, oldestMs: null }, warnings: [] } }
}

const ARCH = Array.from({ length: 9 }, (_, i) => `docs/arch/a${i + 1}.md`)
const BROKEN: MdNetworkFinding = {
  type: 'broken-link',
  file: 'README.md',
  line: 3,
  target: 'docs/missing.md',
  to: 'docs/missing.md',
  where: 'README.md:3 → docs/missing.md',
  detail: 'The link target doesn’t exist.',
}
const ORPHAN: MdNetworkFinding = {
  type: 'orphan',
  where: 'notes/',
  count: 2,
  paths: ['notes/a.md', 'notes/b.md'],
  detail: 'No link path from CLAUDE.md reaches these 2 docs, so agents starting there never find them.',
}

/**
 * Walk order, as mdNetworkScan emits it: the root links README + nine docs/arch docs (depth 1);
 * README links a1 and a missing doc; a1 links a2 and docs/arch/deep.md (depth 2); deep links
 * x (depth 3); x links y (depth 4) and back to the root.
 */
const NET = network(
  [
    doc('CLAUDE.md', 0, 10, 1),
    doc('README.md', 1, 2, 1),
    ...ARCH.map((p) => doc(p, 1, p.endsWith('a1.md') ? 2 : 0, p.endsWith('a2.md') ? 2 : 1)),
    doc('docs/arch/deep.md', 2, 1, 1),
    doc('docs/arch/deeper/x.md', 3, 2, 1),
    doc('docs/y.md', 4, 0, 1),
  ],
  [
    { from: 'CLAUDE.md', to: 'README.md' },
    ...ARCH.map((p) => ({ from: 'CLAUDE.md', to: p })),
    { from: 'README.md', to: 'docs/arch/a1.md' },
    { from: 'README.md', to: 'docs/missing.md', broken: true },
    { from: 'docs/arch/a1.md', to: 'docs/arch/a2.md' },
    { from: 'docs/arch/a1.md', to: 'docs/arch/deep.md' },
    { from: 'docs/arch/deep.md', to: 'docs/arch/deeper/x.md' },
    { from: 'docs/arch/deeper/x.md', to: 'docs/y.md' },
    { from: 'docs/arch/deeper/x.md', to: 'CLAUDE.md' },
  ],
  [BROKEN, ORPHAN],
)

const GROUP = 'folder:1:docs/arch'
const MISSING = 'missing:docs/missing.md'
const ORPHAN_ID = 'orphan:notes/'

const byId = (layout: MdLinkMapLayout, id: string) => {
  const n = layout.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

describe('layoutMdNetwork', () => {
  it('puts nodes in four columns by depth (3+ in the last) and spreads each column evenly within 16..376', () => {
    const layout = layoutMdNetwork(NET)
    const col = (c: number) => layout.nodes.filter((n) => n.column === c).map((n) => [n.id, n.x, n.y])
    expect(col(0)).toEqual([['CLAUDE.md', 44, 196]])
    expect(col(1)).toEqual([['README.md', 232, 106], [GROUP, 232, 286]])
    expect(col(2)).toEqual([[MISSING, 470, 106], ['docs/arch/deep.md', 470, 286]])
    expect(col(3)).toEqual([['docs/arch/deeper/x.md', 650, 76], ['docs/y.md', 650, 196], [ORPHAN_ID, 650, 316]])
    for (const n of layout.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(16)
      expect(n.y).toBeLessThanOrEqual(376)
    }
  })

  it('collapses more than 8 docs of one folder in a column into one "<folder>/ · <n>" node, re-routing its edges', () => {
    const layout = layoutMdNetwork(NET)
    const group = byId(layout, GROUP)
    expect(group).toMatchObject({ kind: 'folder', label: 'arch/ · 9', path: 'docs/arch/ (9 docs)', count: 9 })
    // Out of the group: a1 → deep. Into it: the root's nine links + README → a1. a1 → a2 stays inside.
    expect([group.linksOut, group.linkedFrom]).toEqual([1, 10])
    expect(layout.nodes.some((n) => ARCH.includes(n.id))).toBe(false)
    // docs/arch/deep.md shares the folder but sits alone in column 2, so it stays a doc.
    expect(byId(layout, 'docs/arch/deep.md')).toMatchObject({ kind: 'doc', label: 'arch/deep.md' })
    const pairs = layout.edges.map((e) => `${e.from} > ${e.to}${e.broken ? ' (broken)' : ''}`)
    expect(pairs).toEqual([
      'CLAUDE.md > README.md',
      `CLAUDE.md > ${GROUP}`,
      `README.md > ${GROUP}`,
      `README.md > ${MISSING} (broken)`,
      `${GROUP} > docs/arch/deep.md`,
      'docs/arch/deep.md > docs/arch/deeper/x.md',
      'docs/arch/deeper/x.md > docs/y.md',
      'docs/arch/deeper/x.md > CLAUDE.md',
    ])
  })

  it('keeps a folder with exactly 8 docs in a column as separate docs', () => {
    const eight = ARCH.slice(0, 8)
    const layout = layoutMdNetwork(
      network([doc('CLAUDE.md', 0, 8, 0), ...eight.map((p) => doc(p, 1))], eight.map((p) => ({ from: 'CLAUDE.md', to: p }))),
    )
    expect(layout.nodes.filter((n) => n.kind === 'folder')).toEqual([])
    expect(layout.nodes.filter((n) => n.column === 1).map((n) => n.id)).toEqual(eight)
    expect(layout.edges).toHaveLength(8)
  })

  it('labels a doc "<folder>/<file>", clipping the folder from the left, then the file, to its column', () => {
    const owner = 'session-manager-operations/CLAUDE.md'
    const deep = 'a/b/c/2026-08-02-ops-protocol-findings.md'
    const layout = layoutMdNetwork(
      network(
        [doc('CLAUDE.md', 0, 2, 0), doc(owner, 1), doc(deep, 3)],
        [{ from: 'CLAUDE.md', to: owner }, { from: 'CLAUDE.md', to: deep }],
      ),
    )
    expect(byId(layout, 'CLAUDE.md').label).toBe('CLAUDE.md')
    expect(byId(layout, owner).label).toBe('…sion-manager-operations/CLAUDE.md')
    expect(byId(layout, deep).label).toBe('2026-08-02-ops…')
  })

  it('draws bezier edges between columns and an arc for a same-column link', () => {
    const layout = layoutMdNetwork(NET)
    const edge = (from: string, to: string) => layout.edges.find((e) => e.from === from && e.to === to)!.d
    expect(edge('CLAUDE.md', 'README.md')).toBe('M44 196 C138 196 138 106 232 106')
    const arc = edge('docs/arch/deeper/x.md', 'docs/y.md')
    expect(arc.startsWith('M650 76 C')).toBe(true)
    expect(arc.endsWith(' 650 196')).toBe(true)
    expect(arc).not.toBe('M650 76 C650 76 650 196 650 196')
  })

  it('adds a missing node for a broken target, flags the linking doc, and an orphan node per orphan group', () => {
    const layout = layoutMdNetwork(NET)
    expect(byId(layout, MISSING)).toMatchObject({ kind: 'missing', label: 'docs/missing.md', path: 'docs/missing.md (missing)', linkedFrom: 1 })
    expect(byId(layout, ORPHAN_ID)).toMatchObject({ kind: 'orphan', label: 'notes/ · 2', path: 'notes/ (2 docs)', count: 2 })
    expect(layout.nodes.filter((n) => n.flagged).map((n) => n.id)).toEqual(['README.md'])
    expect(layout.findingNodes).toEqual([['README.md', MISSING], [ORPHAN_ID]])
  })
})

const open = vi.fn()

beforeEach(() => {
  open.mockReset()
  open.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = { shell: { open } }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(net: MdNetwork = NET, cwd: string | null = CWD) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<MdNetworkCards cwd={cwd} network={net} />))
  return container
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const all = (id: string) => Array.from(container!.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]
const node = (id: string) => container!.querySelector(`[data-testid="md-link-map-node"][data-node-id="${id}"]`) as Element
const stateOf = () => Object.fromEntries(all('md-link-map-node').map((g) => [g.getAttribute('data-node-id'), g.getAttribute('data-state')]))
const hover = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
const unhover = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
const HINT = 'Hover a doc to see where it lives and what links to it.'

describe('MdNetworkCards LINK MAP', () => {
  it('draws the SVG at viewBox 760x392 with the legend, a node per map node and the hint caption', () => {
    mount()
    const svg = q('md-link-map-svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 760 392')
    expect(all('md-link-map-legend').map((l) => l.textContent)).toEqual(['Entry map', 'Owner doc', 'Doc', 'Finding', 'Missing'])
    expect(all('md-link-map-node').map((g) => g.getAttribute('data-node-id'))).toEqual(layoutMdNetwork(NET).nodes.map((n) => n.id))
    expect(node(GROUP).textContent).toContain('arch/ · 9')
    expect(q('md-link-map-caption')!.textContent).toBe(HINT)
    expect(Object.values(stateOf()).every((s) => s === 'idle')).toBe(true)
  })

  it('draws broken links as dashed accent edges and missing targets as dashed accent nodes', () => {
    mount()
    const broken = all('md-link-map-edge').filter((e) => e.getAttribute('data-broken') === 'true')
    expect(broken.map((e) => e.getAttribute('data-to'))).toEqual([MISSING])
    expect(broken[0].getAttribute('stroke-dasharray')).toBe('5 4')
    expect(broken[0].getAttribute('class')).toContain('stroke-accent')
    const missingDot = node(MISSING).querySelector('[data-testid="md-link-map-dot"]')!
    expect(missingDot.getAttribute('stroke-dasharray')).toBe('2.5 2')
    expect(missingDot.getAttribute('class')).toContain('stroke-accent')
    const flaggedDot = node('README.md').querySelector('[data-testid="md-link-map-dot"]')!
    expect(flaggedDot.getAttribute('class')).toContain('stroke-accent')
    const plain = all('md-link-map-edge').filter((e) => e.getAttribute('data-broken') !== 'true')
    expect(plain.every((e) => e.getAttribute('stroke-dasharray') === null)).toBe(true)
  })

  it('hovering a node dims all but it and its neighbours and captions its path and link counts', () => {
    mount()
    hover(node('README.md'))
    expect(stateOf()).toEqual({
      'CLAUDE.md': 'hot',
      'README.md': 'hot',
      [GROUP]: 'hot',
      [MISSING]: 'hot',
      'docs/arch/deep.md': 'dim',
      'docs/arch/deeper/x.md': 'dim',
      'docs/y.md': 'dim',
      [ORPHAN_ID]: 'dim',
    })
    expect((node('docs/y.md') as SVGGElement).style.opacity).toBe('0.25')
    expect((node('README.md') as SVGGElement).style.opacity).toBe('1')
    const lit = all('md-link-map-edge').filter((e) => e.getAttribute('data-lit') === 'true')
    expect(lit.map((e) => `${e.getAttribute('data-from')} > ${e.getAttribute('data-to')}`)).toEqual([
      'CLAUDE.md > README.md',
      `README.md > ${GROUP}`,
      `README.md > ${MISSING}`,
    ])
    expect(q('md-link-map-caption')!.textContent).toBe('README.md · links out 2 · linked from 1')
    unhover(node('README.md'))
    expect(Object.values(stateOf()).every((s) => s === 'idle')).toBe(true)
    expect(q('md-link-map-caption')!.textContent).toBe(HINT)
  })

  it('captions a collapsed folder with its folder path and the links crossing it', () => {
    mount()
    hover(node(GROUP))
    expect(q('md-link-map-caption')!.textContent).toBe('docs/arch/ (9 docs) · links out 1 · linked from 10')
  })
})

describe('MdNetworkCards FINDINGS', () => {
  const findings = () => all('md-finding')

  it('lists each finding with its type tag (broken-link accent, orphan muted), mono where and detail', () => {
    mount()
    expect(q('md-findings-count')!.textContent).toBe('2')
    expect(findings()).toHaveLength(2)
    const [broken, orphan] = findings()
    const tag = (f: HTMLElement) => f.querySelector('[data-testid="md-finding-type"]') as HTMLElement
    expect(tag(broken).textContent).toBe('broken-link')
    expect(tag(broken).className).toContain('bg-accent')
    expect(tag(orphan).textContent).toBe('orphan')
    expect(tag(orphan).className).toContain('bg-rule-inner')
    const where = broken.querySelector('[data-testid="md-finding-where"]') as HTMLElement
    expect(where.textContent).toBe('README.md:3 → docs/missing.md')
    expect(where.className).toContain('font-mono')
    expect(orphan.querySelector('[data-testid="md-finding-detail"]')!.textContent).toBe(ORPHAN.detail)
  })

  it('hovering a finding highlights its nodes on the map and dims the rest', () => {
    mount()
    hover(findings()[0])
    const s = stateOf()
    expect(Object.keys(s).filter((id) => s[id] === 'hot')).toEqual(['README.md', MISSING])
    expect(s['CLAUDE.md']).toBe('dim')
    expect(q('md-link-map-caption')!.textContent).toBe('broken-link · README.md:3 → docs/missing.md')
    unhover(findings()[0])
    hover(findings()[1])
    const t = stateOf()
    expect(Object.keys(t).filter((id) => t[id] === 'hot')).toEqual([ORPHAN_ID])
    unhover(findings()[1])
    expect(Object.values(stateOf()).every((x) => x === 'idle')).toBe(true)
  })

  it('Open reveals the absolute path: the linking doc of a broken link, the folder of an orphan group', async () => {
    const rootOrphan: MdNetworkFinding = { ...ORPHAN, where: './', count: 1, paths: ['TODO.md'] }
    mount(network(NET.nodes, NET.edges, [BROKEN, ORPHAN, rootOrphan]))
    const openBtns = all('md-finding-open') as HTMLButtonElement[]
    await act(async () => { openBtns[0].click() })
    await act(async () => { openBtns[1].click() })
    await act(async () => { openBtns[2].click() })
    expect(open.mock.calls).toEqual([
      [{ as: 'revealPath', path: '/p/alpha/README.md' }],
      [{ as: 'revealPath', path: '/p/alpha/notes' }],
      [{ as: 'revealPath', path: '/p/alpha' }],
    ])
    expect(useToast.getState().toasts).toEqual([])
  })

  it('a failed Open surfaces as one error toast', async () => {
    open.mockResolvedValue({ ok: false, error: 'outside home' })
    mount()
    await act(async () => { (all('md-finding-open')[0] as HTMLButtonElement).click() })
    expect(useToast.getState().toasts.map((t) => [t.kind, t.message])).toEqual([['error', 'Could not open README.md: outside home']])
  })

  it('with no findings shows an empty note and Open is disabled without a cwd', () => {
    mount(network(NET.nodes, NET.edges, []), null)
    expect(q('md-findings-count')!.textContent).toBe('0')
    expect(q('md-findings-empty')).not.toBeNull()
    act(() => root!.render(<MdNetworkCards cwd={null} network={NET} />))
    expect((all('md-finding-open') as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true)
  })
})
