// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdNetworkExplorer, type MdNetworkExplorerProps } from '../MdNetworkExplorer'
import type { MdNetwork, MdNetworkEdge, MdNetworkFinding, MdNetworkNode } from '../../../../../../preload/api'

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
const NET = network(
  [doc('CLAUDE.md', 0, 10, 1), doc('README.md', 1, 2, 1), ...ARCH.map((p) => doc(p, 1)), doc('docs/guide.md', 2, 1, 1)],
  [
    { from: 'CLAUDE.md', to: 'README.md' },
    ...ARCH.map((p) => ({ from: 'CLAUDE.md', to: p })),
    { from: 'README.md', to: 'docs/guide.md' },
    { from: 'README.md', to: 'docs/missing.md', broken: true },
    { from: 'docs/guide.md', to: 'CLAUDE.md' },
  ],
  [BROKEN],
)
const GROUP = 'folder:1:docs/arch'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function render(props: Partial<MdNetworkExplorerProps> = {}) {
  const onClose = props.onClose ?? vi.fn()
  act(() => {
    root.render(<MdNetworkExplorer network={NET} onClose={onClose} {...props} />)
  })
  return onClose
}

const q = (testid: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
const node = (id: string) => document.body.querySelector<SVGGElement>(`[data-testid="md-link-map-node"][data-node-id="${id}"]`)
const click = (el: Element | null) => {
  if (!el) throw new Error('missing element')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('MdNetworkExplorer', () => {
  it('renders in a full Modal titled MD network with the network counts', () => {
    render()
    expect(q('md-explorer')).not.toBeNull()
    expect(q('modal-dialog')?.getAttribute('aria-label')).toBe('MD network')
    expect(q('modal-dialog')?.className).toContain('max-w-[min(96vw,1400px)]')
    const counts = q('md-explorer-counts')?.textContent ?? ''
    expect(counts).toContain('12 docs in the network')
    expect(counts).toContain('13 links')
    expect(counts).toContain('1 finding')
  })

  it('closes on Esc and on the Close button', () => {
    const onClose = render()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    click(q('md-explorer-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('expands a folder node on click, then collapses it again', () => {
    render()
    expect(node(GROUP)).not.toBeNull()
    expect(node('docs/arch/a1.md')).toBeNull()
    click(node(GROUP))
    expect(node(GROUP)).toBeNull()
    expect(node('docs/arch/a1.md')).not.toBeNull()
    expect(q('md-explorer-inspector')?.textContent).not.toContain('docs/arch/')
  })

  it('selects a clicked doc, rings it, and the default inspector navigates through its links', () => {
    render()
    click(node('README.md'))
    expect(node('README.md')?.getAttribute('data-selected')).toBe('true')
    const inspector = q('md-explorer-inspector')
    expect(inspector?.querySelector('[data-testid="md-explorer-selected-path"]')?.textContent).toBe('README.md')
    const from = Array.from(inspector?.querySelectorAll('[data-testid="md-explorer-linked-from"] button') ?? []).map((b) => b.textContent)
    const to = Array.from(inspector?.querySelectorAll('[data-testid="md-explorer-links-to"] button') ?? []).map((b) => b.textContent)
    expect(from).toEqual(['CLAUDE.md'])
    expect(to).toEqual(['docs/guide.md', 'docs/missing.md (missing)'])
    click(inspector?.querySelector('[data-testid="md-explorer-links-to"] button') ?? null)
    expect(q('md-explorer-selected-path')?.textContent).toBe('docs/guide.md')
    expect(node('docs/guide.md')?.getAttribute('data-selected')).toBe('true')
  })

  it('preselects initialPath and hands renderInspector the selection and select', () => {
    const renderInspector = vi.fn((id: string | null, select: (id: string) => void) => (
      <button type="button" data-testid="custom-inspector" onClick={() => select('CLAUDE.md')}>
        {id ?? 'none'}
      </button>
    ))
    render({ initialPath: 'docs/arch/a3.md', renderInspector })
    // a3 is folded into its folder node, yet the inspector still shows it.
    expect(q('custom-inspector')?.textContent).toBe('docs/arch/a3.md')
    click(q('custom-inspector'))
    expect(q('custom-inspector')?.textContent).toBe('CLAUDE.md')
    expect(node('CLAUDE.md')?.getAttribute('data-selected')).toBe('true')
  })

  it('search highlights matching nodes case-insensitively and Enter selects the first match', () => {
    render()
    const input = q('md-explorer-search') as HTMLInputElement
    type(input, 'GUIDE')
    expect(node('docs/guide.md')?.getAttribute('data-state')).toBe('hot')
    expect(node('README.md')?.getAttribute('data-state')).toBe('dim')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(q('md-explorer-selected-path')?.textContent).toBe('docs/guide.md')
    type(input, '')
    expect(node('README.md')?.getAttribute('data-state')).toBe('idle')
  })

  it('shows the Map | Docs toggle only with renderDocs, and Docs swaps the canvas', () => {
    render()
    expect(q('md-explorer-view-docs')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    render({
      renderDocs: (select) => (
        <button type="button" data-testid="docs-table" onClick={() => select('docs/arch/a5.md')}>
          docs
        </button>
      ),
      footer: <div data-testid="explorer-footer">tray</div>,
    })
    expect(q('explorer-footer')).not.toBeNull()
    expect(q('md-explorer-canvas')).not.toBeNull()
    click(q('md-explorer-view-docs'))
    expect(q('md-explorer-canvas')).toBeNull()
    click(q('docs-table'))
    expect(q('md-explorer-selected-path')?.textContent).toBe('docs/arch/a5.md')
    click(q('md-explorer-view-map'))
    expect(q('md-explorer-canvas')).not.toBeNull()
    expect(q('docs-table')).toBeNull()
  })

  it('zoom buttons change the transform and Fit resets it', () => {
    render()
    const viewport = () => q('md-explorer-viewport')?.getAttribute('transform')
    const start = viewport()
    expect(start).toBe('translate(0 0) scale(1)')
    click(q('md-explorer-zoom-in'))
    const zoomedIn = viewport()
    expect(zoomedIn).not.toBe(start)
    expect(zoomedIn).toContain('scale(1.25)')
    click(q('md-explorer-zoom-out'))
    click(q('md-explorer-zoom-out'))
    expect(viewport()).toContain('scale(0.8)')
    for (let i = 0; i < 10; i++) click(q('md-explorer-zoom-out'))
    expect(viewport()).toContain('scale(0.4)')
    click(q('md-explorer-fit'))
    expect(viewport()).toBe(start)
  })
})
