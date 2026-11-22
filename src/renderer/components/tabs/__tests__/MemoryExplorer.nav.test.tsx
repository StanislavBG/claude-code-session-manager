// @vitest-environment jsdom
// Navigation after the ExplorerNav rail was removed (wave-3 findings 27-29): every view is
// reached from the folder card's chips, and the reader shows the full title with no path footer.
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryExplorer } from '../memory/explorer/MemoryExplorer'

vi.mock('../../VoiceButton', () => ({ VoiceButton: () => null }))
vi.mock('../editor/DocumentEditorPane', () => ({ DocumentEditorPane: () => null }))
vi.mock('../../../state/toast', () => ({ toast: { error: vi.fn(), show: vi.fn(), success: vi.fn() } }))

const LONG = 'feedback_a_really_long_memory_name_that_used_to_be_cut_off_by_an_ellipsis'

let container: HTMLDivElement | null = null
let root: Root | null = null

const memory = {
  list: vi.fn(), read: vi.fn(), write: vi.fn(), delete: vi.fn(), create: vi.fn(), stale: vi.fn(),
  aggregate: vi.fn(), agents: vi.fn(), verify: vi.fn(), archive: vi.fn(), restore: vi.fn(),
  listArchived: vi.fn(), ask: vi.fn(), proposeFix: vi.fn(),
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(MemoryExplorer, { cwd: '/p' })) })
  await flush()
  await flush()
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click() })

beforeEach(() => {
  localStorage.clear()
  memory.list.mockResolvedValue({
    entries: [{ name: `${LONG}.md`, path: `/mem/${LONG}.md`, bytes: 40, mtimeMs: Date.now() }],
    dir: '/mem', autoMemoryEnabled: true, error: null, workspace: 'ws',
  })
  memory.read.mockResolvedValue({ content: '---\nname: x\ndescription: d\n---\n\nbody text\n', error: null })
  memory.stale.mockResolvedValue({
    entries: [{ name: `${LONG}.md`, description: 'd', stale: false, reasons: [], deadRefs: [], danglingLinks: [], outLinks: [] }],
    workspace: 'ws', error: null,
  })
  memory.aggregate.mockResolvedValue({ workspace: 'ws', generatedAt: null, clusters: [], orphans: [], cached: true })
  memory.agents.mockResolvedValue({ agents: [] })
  memory.listArchived.mockResolvedValue({ names: [], error: null })
  ;(window as unknown as { api: unknown }).api = {
    memory,
    config: { watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}) },
    clipboard: { writeText: vi.fn(async () => ({ ok: true })) },
    shell: { open: vi.fn() },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

describe('MemoryExplorer navigation (no rail)', () => {
  it('renders no ExplorerNav rail', async () => {
    await mount()
    expect(container!.querySelector('[data-testid^="mx-nav-"]')).toBeNull()
    expect(q('mx-index-footer')).toBeNull()
  })

  it('the Clusters chip opens the existing ClustersView, and All returns to the reader', async () => {
    await mount()
    expect(q('mx-clusters')).toBeNull()
    await click(q('mx-chip-clusters'))
    expect(q('mx-clusters')).not.toBeNull()
    expect(q('mx-reader')).toBeNull()
    await click(q('mx-chip-all'))
    expect(q('mx-clusters')).toBeNull()
    expect(q('mx-reader')).not.toBeNull()
  })

  it('Review = the Stale / Broken chips; Ask stays the Ask + chip', async () => {
    await mount()
    await click(q('mx-chip-stale'))
    expect(q('mx-list')!.textContent).toContain('Stale')
    await click(q('mx-chip-broken'))
    expect(q('mx-list')!.textContent).toContain('Broken references')
    expect(q('mx-chip-ask')!.textContent).toBe('Ask+')
    await click(q('mx-chip-ask'))
    expect(q('mx-ask')).not.toBeNull()
  })

  it('the reader shows the full title (wraps, never truncates) and has no file-path footer', async () => {
    await mount()
    const title = q('mx-reader-title')!
    expect(title.textContent).toBe(LONG)
    expect(title.className).not.toContain('truncate')
    expect(title.className).not.toContain('text-ellipsis')
    expect(title.className).not.toContain('whitespace-nowrap')
    const reader = q('mx-reader')!
    expect([...reader.querySelectorAll('div')].some((d) => d.textContent === `/mem/${LONG}.md`)).toBe(false)
  })
})
