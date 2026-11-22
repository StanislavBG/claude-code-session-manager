// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdMapGraph, MdNetworkCards, layoutMdNetwork, type MdLinkMapLayout, type MdMapNode } from '../MdLinkMap'
import { useToast } from '../../../../../state/toast'
import type { MdDoc, MdDocRole, MdNetwork, MdNetworkEdge, MdNetworkFinding, MdNetworkNode } from '../../../../../../preload/api'

const CWD = '/p/alpha'

function doc(path: string, depth: number, linksOut = 0, linkedFrom = 1): MdNetworkNode {
  const type = depth === 0 ? 'hub' : depth === 1 && /(^|\/)(CLAUDE|README|AGENTS)\.md$/.test(path) ? 'owner' : 'doc'
  return { id: path, path, depth, type, linksOut, linkedFrom }
}

function network(nodes: MdNetworkNode[], edges: MdNetworkEdge[], findings: MdNetworkFinding[] = []): MdNetwork {
  return { ok: true, root: 'CLAUDE.md', nodes, edges, findings, docs: nodes.length, links: edges.length, scopes: [], census: { docs: [], collections: [], counts: { tracked: 0, network: 0, records: 0, unlinked: 0, byRole: { map: 0, scoped: 0, agent: 0, record: 0, doc: 0 } }, gitWindow: { commits: 0, oldestMs: null }, warnings: [] } }
}

function censusDoc(path: string, role: MdDocRole): MdDoc {
  return { path, role, depth: null, lines: null, bytes: null, lastCommitMs: null, commits: 0, linkedFrom: 0, codeRefs: 0, codeRefFiles: [], deadRefs: [], ambiguousRefs: [], changedSince: [], collection: null }
}

function withCensus(net: MdNetwork, roles: Record<string, MdDocRole>): MdNetwork {
  return { ...net, census: { ...net.census, docs: Object.entries(roles).map(([p, r]) => censusDoc(p, r)) } }
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
 * Walk order, as mdNetworkScan emits it: the root links README (depth 1); README links nine
 * docs/arch docs (depth 2) and a missing doc; a1 links a2 and docs/arch/deep.md (depth 3); deep
 * links x (depth 4); x links y (depth 5) and back to the root.
 */
const NET = network(
  [
    doc('CLAUDE.md', 0, 1, 1),
    doc('README.md', 1, 10, 1),
    ...ARCH.map((p) => doc(p, 2, p.endsWith('a1.md') ? 2 : 0, p.endsWith('a2.md') ? 2 : 1)),
    doc('docs/arch/deep.md', 3, 1, 1),
    doc('docs/arch/deeper/x.md', 4, 2, 1),
    doc('docs/y.md', 5, 0, 1),
  ],
  [
    { from: 'CLAUDE.md', to: 'README.md' },
    ...ARCH.map((p) => ({ from: 'README.md', to: p })),
    { from: 'README.md', to: 'docs/missing.md', broken: true },
    { from: 'docs/arch/a1.md', to: 'docs/arch/a2.md' },
    { from: 'docs/arch/a1.md', to: 'docs/arch/deep.md' },
    { from: 'docs/arch/deep.md', to: 'docs/arch/deeper/x.md' },
    { from: 'docs/arch/deeper/x.md', to: 'docs/y.md' },
    { from: 'docs/arch/deeper/x.md', to: 'CLAUDE.md' },
  ],
  [BROKEN, ORPHAN],
)

const GROUP = 'folder:2:docs/arch'
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
    expect(col(1)).toEqual([['README.md', 232, 196]])
    expect(col(2)).toEqual([[GROUP, 470, 106], [MISSING, 470, 286]])
    expect(col(3)).toEqual([
      ['docs/arch/deep.md', 650, 61],
      ['docs/arch/deeper/x.md', 650, 151],
      ['docs/y.md', 650, 241],
      [ORPHAN_ID, 650, 331],
    ])
    for (const n of layout.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(16)
      expect(n.y).toBeLessThanOrEqual(376)
    }
  })

  it('collapses more than 8 docs of one folder in a column past depth 1 into one "<folder>/ · <n>" node, re-routing its edges', () => {
    const layout = layoutMdNetwork(NET)
    const group = byId(layout, GROUP)
    expect(group).toMatchObject({ kind: 'folder', label: 'arch/ · 9', path: 'docs/arch/ (9 docs)', count: 9 })
    // Out of the group: a1 → deep. Into it: README's nine links. a1 → a2 stays inside.
    expect([group.linksOut, group.linkedFrom]).toEqual([1, 9])
    expect(layout.nodes.some((n) => ARCH.includes(n.id))).toBe(false)
    // docs/arch/deep.md shares the folder but sits alone in column 3, so it stays a doc.
    expect(byId(layout, 'docs/arch/deep.md')).toMatchObject({ kind: 'doc', label: 'arch/deep.md' })
    const pairs = layout.edges.map((e) => `${e.from} > ${e.to}${e.broken ? ' (broken)' : ''}`)
    expect(pairs).toEqual([
      'CLAUDE.md > README.md',
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
      network([doc('CLAUDE.md', 0, 8, 0), ...eight.map((p) => doc(p, 2))], eight.map((p) => ({ from: 'CLAUDE.md', to: p }))),
    )
    expect(layout.nodes.filter((n) => n.kind === 'folder')).toEqual([])
    expect(layout.nodes.filter((n) => n.column === 2).map((n) => n.id)).toEqual(eight)
    expect(layout.edges).toHaveLength(8)
  })

  it('never collapses depth-1 docs, however many share a folder; deeper columns still collapse', () => {
    const topics = Array.from({ length: 12 }, (_, i) => `architecture/t${i + 1}.md`)
    const deep = Array.from({ length: 9 }, (_, i) => `architecture/sub/d${i + 1}.md`)
    const layout = layoutMdNetwork(
      network(
        [doc('CLAUDE.md', 0, 12, 0), ...topics.map((p) => doc(p, 1)), ...deep.map((p) => doc(p, 2))],
        [...topics.map((p) => ({ from: 'CLAUDE.md', to: p })), ...deep.map((p) => ({ from: topics[0], to: p }))],
      ),
    )
    expect(layout.nodes.filter((n) => n.column === 1).map((n) => [n.id, n.kind])).toEqual(topics.map((p) => [p, 'doc']))
    expect(layout.nodes.filter((n) => n.column === 2).map((n) => [n.id, n.kind])).toEqual([
      ['folder:2:architecture/sub', 'folder'],
    ])
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
    expect(edge('README.md', GROUP)).toBe('M232 196 C351 196 351 106 470 106')
    const arc = edge('docs/arch/deeper/x.md', 'docs/y.md')
    expect(arc.startsWith('M650 151 C')).toBe(true)
    expect(arc.endsWith(' 650 241')).toBe(true)
    expect(arc).not.toBe('M650 151 C650 151 650 241 650 241')
  })

  it('adds a missing node for a broken target, flags the linking doc, and an orphan node per orphan group', () => {
    const layout = layoutMdNetwork(NET)
    expect(byId(layout, MISSING)).toMatchObject({ kind: 'missing', label: 'docs/missing.md', path: 'docs/missing.md (missing)', linkedFrom: 1 })
    expect(byId(layout, ORPHAN_ID)).toMatchObject({ kind: 'orphan', label: 'notes/ · 2', path: 'notes/ (2 docs)', count: 2 })
    expect(layout.nodes.filter((n) => n.flagged).map((n) => n.id)).toEqual(['README.md'])
    expect(layout.findingNodes).toEqual([['README.md', MISSING], [ORPHAN_ID]])
  })

  it('draws each doc by its census role: map, scoped, agent, doc, record', () => {
    const paths = ['CLAUDE.md', 'src/CLAUDE.md', 'AGENTS.md', 'README.md', 'docs/history/2026-01.md']
    const net = withCensus(
      network(
        [doc(paths[0], 0, 4, 0), ...paths.slice(1).map((p) => doc(p, 1))],
        paths.slice(1).map((p) => ({ from: 'CLAUDE.md', to: p })),
      ),
      { 'CLAUDE.md': 'map', 'src/CLAUDE.md': 'scoped', 'AGENTS.md': 'agent', 'README.md': 'doc', 'docs/history/2026-01.md': 'record' },
    )
    const layout = layoutMdNetwork(net)
    expect(layout.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['CLAUDE.md', 'hub'],
      ['src/CLAUDE.md', 'owner'],
      ['AGENTS.md', 'agent'],
      ['README.md', 'doc'],
      ['docs/history/2026-01.md', 'record'],
    ])
  })

  it('a depth-1 README.md with census role doc is a Topic doc, not a Folder note; src/CLAUDE.md (scoped) is a Folder note', () => {
    expect(doc('README.md', 1).type).toBe('owner')
    const net = withCensus(
      network(
        [doc('CLAUDE.md', 0, 2, 0), doc('README.md', 1), doc('src/CLAUDE.md', 2)],
        [{ from: 'CLAUDE.md', to: 'README.md' }, { from: 'README.md', to: 'src/CLAUDE.md' }],
      ),
      { 'CLAUDE.md': 'map', 'README.md': 'doc', 'src/CLAUDE.md': 'scoped' },
    )
    const layout = layoutMdNetwork(net)
    expect(byId(layout, 'README.md').kind).toBe('doc')
    expect(byId(layout, 'src/CLAUDE.md').kind).toBe('owner')
  })

  it('falls back to the scan nodeType for a doc missing from the census', () => {
    const net = withCensus(
      network(
        [doc('CLAUDE.md', 0, 2, 0), doc('README.md', 1), doc('docs/a.md', 2)],
        [{ from: 'CLAUDE.md', to: 'README.md' }, { from: 'README.md', to: 'docs/a.md' }],
      ),
      { 'docs/a.md': 'record' },
    )
    const layout = layoutMdNetwork(net)
    expect(layout.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['CLAUDE.md', 'hub'],
      ['README.md', 'owner'],
      ['docs/a.md', 'record'],
    ])
  })

  it('reports the default 760x392 canvas with no options', () => {
    const layout = layoutMdNetwork(NET)
    expect([layout.width, layout.height]).toEqual([760, 392])
  })

  it('draws the docs of an expanded folder as individual nodes, keeping the other ids', () => {
    const layout = layoutMdNetwork(NET, { expanded: new Set([GROUP]) })
    expect(layout.nodes.some((n) => n.id === GROUP)).toBe(false)
    expect(layout.nodes.filter((n) => n.column === 2).map((n) => n.id)).toEqual([...ARCH, MISSING])
    expect(byId(layout, 'docs/arch/a1.md')).toMatchObject({ kind: 'doc', label: 'arch/a1.md', linksOut: 2 })
    const pairs = layout.edges.map((e) => `${e.from} > ${e.to}`)
    expect(pairs).toContain('docs/arch/a1.md > docs/arch/a2.md')
    expect(pairs).toContain('docs/arch/a1.md > docs/arch/deep.md')
    expect(byId(layout, MISSING).id).toBe(MISSING)
    expect(byId(layout, ORPHAN_ID).id).toBe(ORPHAN_ID)
    expect(layout.height).toBe(392)
  })

  it('grows the height to fit the fullest column at minRowGap and spreads rows within 16..height-16', () => {
    const layout = layoutMdNetwork(NET, { expanded: new Set([GROUP]), minRowGap: 40 })
    // Column 2 holds nine arch docs + the missing target: 32 + 10 * 40.
    expect([layout.width, layout.height]).toEqual([760, 432])
    const col1 = layout.nodes.filter((n) => n.column === 2).map((n) => n.y)
    expect(col1[0]).toBe(36)
    expect(col1[9]).toBe(396)
    for (const n of layout.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(16)
      expect(n.y).toBeLessThanOrEqual(layout.height - 16)
    }
    // A sparse map never shrinks below the card's height.
    expect(layoutMdNetwork(NET, { minRowGap: 40 }).height).toBe(392)
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
    expect(all('md-link-map-legend').map((l) => l.textContent)).toEqual(['Map', 'Folder note', 'Topic doc', 'Finding', 'Missing'])
    expect(all('md-link-map-node').map((g) => g.getAttribute('data-node-id'))).toEqual(layoutMdNetwork(NET).nodes.map((n) => n.id))
    expect(node(GROUP).textContent).toContain('arch/ · 9')
    expect(q('md-link-map-caption')!.textContent).toBe(HINT)
    expect(Object.values(stateOf()).every((s) => s === 'idle')).toBe(true)
  })

  it('the legend names every kind in order but shows only those on the map', () => {
    const paths = ['CLAUDE.md', 'src/CLAUDE.md', 'AGENTS.md', 'README.md', 'docs/history/2026-01.md']
    const full = withCensus(
      network(
        [doc(paths[0], 0, 5, 0), ...paths.slice(1).map((p) => doc(p, 1))],
        [...paths.slice(1).map((p) => ({ from: 'CLAUDE.md', to: p })), { from: 'README.md', to: 'docs/missing.md', broken: true }],
        [BROKEN],
      ),
      { 'CLAUDE.md': 'map', 'src/CLAUDE.md': 'scoped', 'AGENTS.md': 'agent', 'README.md': 'doc', 'docs/history/2026-01.md': 'record' },
    )
    mount(full)
    expect(all('md-link-map-legend').map((l) => l.textContent)).toEqual([
      'Map', 'Folder note', 'Agent file', 'Topic doc', 'History', 'Finding', 'Missing',
    ])
    act(() => root!.render(<MdNetworkCards cwd={CWD} network={withCensus(network([doc('CLAUDE.md', 0, 1, 0), doc('README.md', 1)], [{ from: 'CLAUDE.md', to: 'README.md' }]), { 'CLAUDE.md': 'map', 'README.md': 'doc' })} />))
    expect(all('md-link-map-legend').map((l) => l.textContent)).toEqual(['Map', 'Topic doc'])
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
    expect(q('md-link-map-caption')!.textContent).toBe('README.md · links out 10 · linked from 1')
    unhover(node('README.md'))
    expect(Object.values(stateOf()).every((s) => s === 'idle')).toBe(true)
    expect(q('md-link-map-caption')!.textContent).toBe(HINT)
  })

  it('captions a collapsed folder with its folder path and the links crossing it', () => {
    mount()
    hover(node(GROUP))
    expect(q('md-link-map-caption')!.textContent).toBe('docs/arch/ (9 docs) · links out 1 · linked from 9')
  })
})

describe('MdNetworkCards FIX LIST', () => {
  const findings = () => all('md-fix-row')

  it('lists each finding with its type tag (broken-link accent, orphan muted), mono where and detail', () => {
    mount()
    expect(q('md-fix-count')!.textContent).toBe('2')
    expect(findings()).toHaveLength(2)
    const [broken, orphan] = findings()
    const tag = (f: HTMLElement) => f.querySelector('[data-testid="md-fix-type"]') as HTMLElement
    expect(tag(broken).textContent).toBe('broken-link')
    expect(tag(broken).className).toContain('bg-accent')
    expect(tag(orphan).textContent).toBe('orphan')
    expect(tag(orphan).className).toContain('bg-rule-inner')
    const where = broken.querySelector('[data-testid="md-fix-where"]') as HTMLElement
    expect(where.textContent).toBe('README.md:3 → docs/missing.md')
    expect(where.className).toContain('font-mono')
    expect(orphan.querySelector('[data-testid="md-fix-detail"]')!.textContent).toBe(ORPHAN.detail)
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
    const openBtns = all('md-fix-open') as HTMLButtonElement[]
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
    await act(async () => { (all('md-fix-open')[0] as HTMLButtonElement).click() })
    expect(useToast.getState().toasts.map((t) => [t.kind, t.message])).toEqual([['error', 'Could not open README.md: outside home']])
  })

  it('with no findings shows an empty note and Open is disabled without a cwd', () => {
    mount(network(NET.nodes, NET.edges, []), null)
    expect(q('md-fix-count')!.textContent).toBe('0')
    expect(q('md-fix-empty')).not.toBeNull()
    act(() => root!.render(<MdNetworkCards cwd={null} network={NET} />))
    expect((all('md-fix-open') as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true)
  })
})

describe('MdMapGraph', () => {
  const layout = layoutMdNetwork(NET)

  function mountGraph(props: { selectedId?: string | null; onNodeClick?: (n: MdMapNode) => void }) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <svg>
          <MdMapGraph layout={layout} focus={null} hoveredId={null} onHover={() => {}} {...props} />
        </svg>,
      ),
    )
  }

  it('marks the selected node with data-selected and an accent ring', () => {
    mountGraph({ selectedId: 'README.md' })
    expect(all('md-link-map-node')).toHaveLength(layout.nodes.length)
    expect(all('md-link-map-edge')).toHaveLength(layout.edges.length)
    const selected = all('md-link-map-node').filter((g) => g.getAttribute('data-selected') === 'true')
    expect(selected.map((g) => g.getAttribute('data-node-id'))).toEqual(['README.md'])
    const ring = node('README.md').querySelector('[data-testid="md-link-map-ring"]')!
    expect(ring.getAttribute('class')).toContain('stroke-accent')
    expect(node('CLAUDE.md').querySelector('[data-testid="md-link-map-ring"]')).toBeNull()
  })

  it('without onNodeClick nodes are not buttons', () => {
    mountGraph({})
    const g = node('README.md')
    expect(g.getAttribute('role')).toBeNull()
    expect(g.getAttribute('tabindex')).toBeNull()
    expect(g.getAttribute('class')).not.toContain('cursor-pointer')
  })

  it('with onNodeClick nodes are focusable buttons that click, Enter and Space activate', () => {
    const onNodeClick = vi.fn()
    mountGraph({ onNodeClick })
    const g = node('README.md')
    expect(g.getAttribute('role')).toBe('button')
    expect(g.getAttribute('tabindex')).toBe('0')
    expect(g.getAttribute('aria-label')).toBe('README.md')
    expect(g.getAttribute('class')).toContain('cursor-pointer')
    expect(node(GROUP).getAttribute('aria-label')).toBe('docs/arch/ (9 docs)')
    act(() => { g.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    act(() => { g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    act(() => { g.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    act(() => { g.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
    expect(onNodeClick.mock.calls.map(([n]) => (n as MdMapNode).id)).toEqual(['README.md', 'README.md', 'README.md'])
  })
})

describe('MdNetworkCards explore', () => {
  function mountExplore(onExplore?: (id: string | null) => void) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<MdNetworkCards cwd={CWD} network={NET} onExplore={onExplore} />))
  }

  it('the LINK MAP header Expand button calls onExplore(null)', () => {
    const onExplore = vi.fn()
    mountExplore(onExplore)
    const expand = q('md-link-map-expand') as HTMLButtonElement
    expect(expand.getAttribute('aria-label')).toBe('Open the full-screen explorer')
    act(() => expand.click())
    expect(onExplore.mock.calls).toEqual([[null]])
  })

  it('clicking a node on the card calls onExplore(node.id)', () => {
    const onExplore = vi.fn()
    mountExplore(onExplore)
    const g = node('README.md')
    expect(g.getAttribute('role')).toBe('button')
    act(() => { g.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onExplore.mock.calls).toEqual([['README.md']])
  })

  it('without onExplore there is no Expand button and nodes are not buttons', () => {
    mountExplore()
    expect(q('md-link-map-expand')).toBeNull()
    expect(node('README.md').getAttribute('role')).toBeNull()
  })
})
