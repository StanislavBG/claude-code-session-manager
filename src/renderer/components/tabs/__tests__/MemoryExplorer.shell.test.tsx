// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryExplorer } from '../memory/explorer/MemoryExplorer'
import { useConfigSearchFocus } from '../../../state/configSearchFocus'

vi.mock('../../VoiceButton', () => ({ VoiceButton: () => null }))
vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: any) => createElement('div', { 'data-testid': 'doc-editor', 'data-path': p.path }, [
    createElement('span', { key: 'v', 'data-testid': 'doc-editor-value' }, p.value),
    createElement('button', { key: 'c', 'data-testid': 'doc-editor-change', onClick: () => p.onChange(p.value + 'more\n') }, 'Type'),
    createElement('button', { key: 's', 'data-testid': 'doc-editor-save', onClick: () => p.onSave?.() }, 'Save'),
    createElement('button', { key: 'r', 'data-testid': 'doc-editor-revert', onClick: () => p.onRevert?.() }, 'Revert'),
  ]),
}))
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
  useConfigSearchFocus.getState().clear()
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
  it('renders no inner header, search field, LEARN or nav rail — only the list column and the reader', async () => {
    await mount()
    const text = container!.textContent ?? ''
    expect(text).not.toContain('CONFIGURE')
    expect(text).not.toContain("Claude Code's own memory files")
    expect(text).not.toContain('Search all memories, or ask a question…')
    expect(q('mx-search-trigger')).toBeNull()
    expect(q('mx-learn')).toBeNull()
    expect(container!.querySelector('[data-testid^="mx-nav-"]')).toBeNull()
    expect(q('mx-list')).not.toBeNull()
    expect(q('mx-reader')).not.toBeNull()
  })

  it('/ no longer opens a Memory-only palette (the band owns search)', async () => {
    await mount()
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })) })
    expect(q('mx-palette')).toBeNull()
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

  it('switches to Ask and Clusters from the chips, keeping the list column', async () => {
    await mount()
    await click(q('mx-chip-ask'))
    expect(q('mx-ask')).not.toBeNull()
    expect(q('mx-list')).not.toBeNull()
    await click(q('mx-chip-clusters'))
    expect(q('mx-clusters')).not.toBeNull()
    expect(q('mx-chip-clusters')!.getAttribute('aria-pressed')).toBe('true')
    await click(q('mx-chip-all'))
    expect(q('mx-clusters')).toBeNull()
    expect(q('mx-reader')).not.toBeNull()
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

  it('list column shows the MEMORY FOLDER card and filter chips that switch views', async () => {
    await mount()
    expect(q('mx-list-folder-count')!.textContent).toBe('2 files')
    expect(q('mx-list')!.textContent).toContain('/mem')
    expect((q('mx-list-scope') as HTMLSelectElement).value).toBe('workspace')
    await click(q('mx-chip-ask'))
    expect(q('mx-ask')).not.toBeNull()
  })

  it('Edit switches to the document editor with the file text; Save writes it through memory.write', async () => {
    await mount()
    await click(q('mx-list-row-alpha.md'))
    await flush()
    await click(q('mx-reader-edit'))
    expect(q('doc-editor')!.getAttribute('data-path')).toBe('/mem/alpha.md')
    expect(q('doc-editor-value')!.textContent).toBe(CONTENT)
    expect(q('mx-links-editing')).not.toBeNull()
    await click(q('doc-editor-change'))
    await click(q('doc-editor-save'))
    await flush()
    expect(memory.write).toHaveBeenCalledWith('alpha.md', CONTENT + 'more\n', expect.anything())
    expect(q('doc-editor')).toBeNull()
    expect(q('mx-undo-bar')!.textContent).toContain('Saved alpha')
  })

  it('Revert reloads the file from disk into the editor', async () => {
    await mount()
    await click(q('mx-list-row-alpha.md'))
    await flush()
    await click(q('mx-reader-edit'))
    await click(q('doc-editor-change'))
    expect(q('doc-editor-value')!.textContent).toBe(CONTENT + 'more\n')
    await click(q('doc-editor-revert'))
    await flush()
    expect(q('doc-editor-value')!.textContent).toBe(CONTENT)
    expect(memory.write).not.toHaveBeenCalled()
  })

  it('Check against the repo runs the existing check (proposeFix)', async () => {
    memory.proposeFix.mockResolvedValue({ ok: true, content: CONTENT, summary: 'fine', action: 'keep', reason: '', fold: null })
    await mount()
    await click(q('mx-list-row-alpha.md'))
    await flush()
    await click(q('mx-links-check'))
    await flush()
    expect(memory.proposeFix).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha.md' }))
  })

  it('a config-search pick opens that memory file, then clears the request', async () => {
    await mount()
    expect(q('mx-reader')!.textContent).toContain('alpha body text')
    await act(async () => { useConfigSearchFocus.getState().set('memory', 'memory:/mem/beta.md') })
    await flush()
    expect(q('mx-reader')!.textContent).toContain('beta body')
    expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
  })

  it('a config-search pick that matches no file keeps the selection, and still clears the request', async () => {
    await mount()
    await click(q('mx-list-row-beta.md'))
    await flush()
    await act(async () => { useConfigSearchFocus.getState().set('memory', 'memory:/mem/missing.md') })
    await flush()
    expect(q('mx-reader')!.textContent).toContain('beta body')
    expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
  })
})
