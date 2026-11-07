// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react-dom/test-utils'

vi.mock('../editor/CodeEditorPane', () => ({
  CodeEditorPane: (p: { path: string; value: string; onChange: (t: string) => void; onSave: () => void }) =>
    createElement('div', null,
      createElement('textarea', { 'data-testid': 'ta', value: p.value, onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) }),
      createElement('button', { 'data-testid': 'save', onClick: p.onSave })),
}))
vi.mock('../editor/MarkdownPreview', () => ({ MarkdownPreview: () => null }))
vi.mock('../editor/MarkdownToolbar', () => ({ MarkdownToolbar: () => null }))
vi.mock('../editor/DocOutline', () => ({ DocOutline: () => null }))
vi.mock('../editor/EditorStatusBar', () => ({ EditorStatusBar: () => null }))
vi.mock('../editor/HtmlPreview', () => ({ HtmlPreview: () => null }))
vi.mock('../editor/ImagePane', () => ({ ImagePane: () => null }))
vi.mock('../editor/PdfPane', () => ({ PdfPane: () => null }))
vi.mock('../editor/TablePane', () => ({ TablePane: () => null }))
vi.mock('../editor/JsonlPane', () => ({ JsonlPane: () => null }))
vi.mock('../editor/BinaryPane', () => ({ BinaryPane: () => null }))
vi.mock('../editor/SelectionPopover', () => ({ SelectionPopover: () => null }))
vi.mock('../editor/AssistantRail', () => ({ AssistantRail: () => null }))
vi.mock('../editor/DocumentMenu', () => ({ DocumentMenu: () => null }))
vi.mock('../editor/DisplayPopover', () => ({ DisplayPopover: () => null }))
vi.mock('../editor/useDocEdit', () => ({
  useDocEdit: () => ({ state: { phase: 'idle' }, cancel: () => {}, select: () => {}, run: () => {}, listen: () => {}, sendHeard: () => {}, accept: () => ({ ok: false }), retry: () => {} }),
}))
vi.mock('../../../state/editor', async (orig) => ({ ...(await orig<typeof import('../../../state/editor')>()), hydrateEditorSession: async () => {} }))
vi.mock('../../layout/FileTabBar', () => ({ FileTabBar: () => null }))
vi.mock('../editor/TiptapBody', () => ({ TiptapBody: () => null }))

import { EditorView, isClaudeConfigPath } from '../EditorView'
import { useEditor } from '../../../state/editor'
import { useConfig } from '../../../state/config'

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

function setup(path: string) {
  const api = {
    files: {
      read: vi.fn().mockResolvedValue({ ok: true, text: 'plain', binary: false }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    config: {
      readText: vi.fn().mockResolvedValue({ text: 'cfg', exists: true, mtimeMs: 10, error: null }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
  ;(window as unknown as { api: unknown }).api = api
  useEditor.setState({ openFiles: [{ path }], activeFilePath: path, buffers: {}, baselines: {}, dirty: {}, viewMode: {} } as never)
  useConfig.setState({ files: {}, watchRefs: {} })
  return api
}

async function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => { root.render(createElement(EditorView)) })
  await flush()
  await flush()
  return el
}

function type(el: HTMLElement, text: string) {
  const ta = el.querySelector('[data-testid=ta]') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('isClaudeConfigPath', () => {
  it('matches Claude config files only', () => {
    for (const p of ['/h/.claude/settings.json', '/r/.claude/settings.local.json', '/h/.claude.json', '/r/.mcp.json', '/r/CLAUDE.md', '/r/.claude/settings.json', '/r/CLAUDE.local.md', '/r/.claude/skills/x/SKILL.md', '/h/.claude/agents/a.md']) {
      expect(isClaudeConfigPath(p), p).toBe(true)
    }
    for (const p of ['/r/README.md', '/r/settings.json', '/r/src/a.ts', '/r/agents/a.md']) {
      expect(isClaudeConfigPath(p), p).toBe(false)
    }
  })
})

describe('EditorView config-file routing', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('loads and saves a config file through the config store, not files:write', async () => {
    const api = setup('/r/.claude/settings.json')
    const el = await mount()
    expect(api.config.readText).toHaveBeenCalledWith('/r/.claude/settings.json')
    expect(api.files.read).not.toHaveBeenCalled()
    await act(async () => { type(el, 'edited') })
    expect(useConfig.getState().files['/r/.claude/settings.json'].draftRaw).toBe('edited')
    await act(async () => { (el.querySelector('[data-testid=save]') as HTMLElement).click() })
    await flush()
    expect(api.config.writeText).toHaveBeenCalledWith('/r/.claude/settings.json', 'edited')
    expect(api.files.write).not.toHaveBeenCalled()
  })

  it('does not write when the file changed on disk (conflict)', async () => {
    const api = setup('/r/.claude/settings.json')
    const el = await mount()
    api.config.readText.mockResolvedValue({ text: 'other', exists: true, mtimeMs: 99, error: null })
    await act(async () => { type(el, 'edited') })
    await act(async () => { (el.querySelector('[data-testid=save]') as HTMLElement).click() })
    await flush()
    expect(api.config.writeText).not.toHaveBeenCalled()
    expect(api.files.write).not.toHaveBeenCalled()
  })

  it('keeps files:write for a plain file', async () => {
    const api = setup('/r/notes.txt')
    const el = await mount()
    expect(api.files.read).toHaveBeenCalledWith('/r/notes.txt')
    expect(api.config.readText).not.toHaveBeenCalled()
    await act(async () => { type(el, 'edited') })
    await act(async () => { (el.querySelector('[data-testid=save]') as HTMLElement).click() })
    await flush()
    expect(api.files.write).toHaveBeenCalledWith('/r/notes.txt', 'edited')
    expect(api.config.writeText).not.toHaveBeenCalled()
  })
})
