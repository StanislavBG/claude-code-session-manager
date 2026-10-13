// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryExplorer } from '../memory/explorer/MemoryExplorer'

vi.mock('../../VoiceButton', () => ({ VoiceButton: () => null }))
vi.mock('../../../state/toast', () => ({
  toast: { error: vi.fn(), show: vi.fn(), success: vi.fn() },
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

const memory = {
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  create: vi.fn(),
  stale: vi.fn(),
  aggregate: vi.fn(),
  agents: vi.fn(),
  verify: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  listArchived: vi.fn(),
  ask: vi.fn(),
  proposeFix: vi.fn(),
}

const CONTENT = '---\nname: alpha\ndescription: about alpha\n---\n\nalpha body text\n'

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(MemoryExplorer, { cwd: '/p' }))
  })
  await flush()
  await flush()
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click() })

function setAuto(enabled: boolean) {
  memory.list.mockResolvedValue({
    entries: [
      { name: 'alpha.md', path: '/mem/alpha.md', bytes: 40, mtimeMs: Date.now() },
      { name: 'beta.md', path: '/mem/beta.md', bytes: 30, mtimeMs: Date.now() - 86_400_000 },
    ],
    dir: '/mem', autoMemoryEnabled: enabled, error: null, workspace: 'ws',
  })
}

beforeEach(() => {
  localStorage.clear()
  setAuto(true)
  memory.read.mockImplementation(async (name: string) => ({
    content: name === 'beta.md' ? '---\nname: beta\ndescription: about beta\n---\n\nbeta body\n' : CONTENT,
    error: null,
  }))
  memory.write.mockResolvedValue({ ok: true, error: null })
  memory.create.mockResolvedValue({ ok: true, error: null })
  memory.delete.mockResolvedValue({ ok: true, error: null })
  memory.stale.mockResolvedValue({
    entries: [
      { name: 'alpha.md', description: 'about alpha', stale: false, reasons: [], deadRefs: [], danglingLinks: [], outLinks: ['beta'] },
      { name: 'beta.md', description: 'about beta', stale: false, reasons: [], deadRefs: [], danglingLinks: [], outLinks: [] },
    ],
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

describe('MemoryExplorer shell', () => {
  it('renders the header and toggles the LEARN popover', async () => {
    await mount()
    const text = container!.textContent ?? ''
    expect(text).toContain('CONFIGURE')
    expect(text).toContain('Memory')
    expect(text).toContain("Claude Code's own memory files · stored on this machine")
    expect(text).toContain('Search all memories, or ask a question…')
    expect(q('mx-learn-popover')).toBeNull()
    await click(q('mx-learn'))
    expect(q('mx-learn-popover')!.textContent).toContain('How memory works')
    await click(q('mx-learn-close'))
    expect(q('mx-learn-popover')).toBeNull()
  })

  it('shows the auto-memory banner only when auto memory is off', async () => {
    await mount()
    expect(q('mx-auto-off')).toBeNull()
    act(() => root!.unmount())
    container!.remove()
    setAuto(false)
    await mount()
    expect(q('mx-auto-off')!.textContent).toContain('Auto memory is off')
  })

  it('switches to Ask and Clusters from the nav', async () => {
    await mount()
    await click(q('mx-nav-ask'))
    expect(q('mx-ask')).not.toBeNull()
    expect(q('mx-list')).toBeNull()
    await click(q('mx-nav-clusters'))
    expect(q('mx-clusters')).not.toBeNull()
    await click(q('mx-nav-all'))
    expect(q('mx-list')).not.toBeNull()
  })

  it('selecting a row loads the reader', async () => {
    await mount()
    await click(q('mx-list-row-beta.md'))
    await flush()
    expect(memory.read).toHaveBeenCalledWith('beta.md', expect.anything())
    expect(q('mx-reader')!.textContent).toContain('beta body')
  })

  it('delete → dialog → confirm → undo bar → Undo restores', async () => {
    await mount()
    await click(q('mx-list-row-alpha.md'))
    await flush()
    await click(q('mx-reader-more'))
    const del = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Delete…')!
    await click(del)
    expect(q('mx-delete-dialog')).not.toBeNull()
    await click(q('mx-delete-confirm'))
    await flush()
    expect(memory.delete).toHaveBeenCalledWith('alpha.md', expect.anything())
    expect(q('mx-undo-bar')!.textContent).toContain('Deleted alpha')
    await click(q('mx-undo'))
    await flush()
    expect(memory.create).toHaveBeenCalledWith('alpha.md', expect.anything(), expect.anything())
    expect(memory.write).toHaveBeenCalledWith('alpha.md', CONTENT, expect.anything())
  })

  it('/ opens the palette and Enter on a result selects it', async () => {
    await mount()
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })) })
    expect(q('mx-palette')).not.toBeNull()
    const input = q('mx-palette-input') as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(q('mx-palette')).toBeNull()
    expect(q('mx-reader')).not.toBeNull()
  })
})
