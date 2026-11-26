// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import type { AgentCliDetectRow, AgentPersona } from '../../../../preload/api'

// The real pane mounts Tiptap/Monaco; the stub keeps the contract this page relies on:
// controlled body text, Document mode by default, and the status bar's Save/Revert.
vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: { path: string; value: string; defaultMode?: string; dirty?: boolean; onChange: (v: string) => void; onSave?: () => void; onRevert?: () => void }) =>
    createElement('div', { 'data-testid': 'document-editor-pane', 'data-mode': p.defaultMode, 'data-path': p.path }, [
      createElement('textarea', { key: 'ta', 'data-testid': 'document-editor-body', value: p.value, onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) }),
      createElement('button', { key: 'r', 'data-testid': 'editor-revert', disabled: !p.dirty, onClick: () => p.onRevert?.() }, 'Revert'),
      createElement('button', { key: 's', 'data-testid': 'editor-save', disabled: !p.dirty, onClick: () => p.onSave?.() }, 'Save'),
    ]),
}))

const ROW = (id: AgentCliDetectRow['id'], installed: boolean): AgentCliDetectRow => ({
  id, label: id, installed, path: installed ? `/usr/bin/${id}` : null, version: installed ? '1.0.0' : null,
  install: installed ? null : `npm i -g ${id}`, docs: `https://example.com/${id}`, login: null,
})
const ROWS = [ROW('codex', true), ROW('gemini', false), ROW('antigravity', false), ROW('cursor', false), ROW('opencode', false)]

function persona(extra: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: 'p', description: 'd', tools: [], model: 'opus', effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null,
    path: '/x/p.md', body: 'b', overridingProjects: [], ...extra,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let savePersona: ReturnType<typeof vi.fn>

async function mount(p: AgentPersona) {
  savePersona = vi.fn().mockResolvedValue({ ok: true, path: '' })
  ;(window as unknown as { api: unknown }).api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue([p]),
      savePersona,
      deletePersona: vi.fn(), removeOverride: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    agentCli: { detect: vi.fn().mockResolvedValue(ROWS) },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      listDir: vi.fn().mockResolvedValue([]),
      readText: vi.fn().mockResolvedValue(''),
      exists: vi.fn().mockResolvedValue(false),
      watch: vi.fn(), unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentLibrary))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  // The roster is the landing; open the first persona's sheet like the old auto-selection did.
  await act(async () => {
    container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click()
    await Promise.resolve()
  })
  return container
}

const byId = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (b: HTMLElement | null | undefined) => {
  await act(async () => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}
const saveClick = async (el: HTMLElement) => {
  await click(el.querySelector('[data-testid="editor-save"]') as HTMLElement)
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
}
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
  delete (window as unknown as { api?: unknown }).api
})

const cli = (el: HTMLElement) => byId(el, 'agent-persona-cli-select') as HTMLSelectElement
const pick = async (el: HTMLElement, v: string) => {
  await act(async () => { const s = cli(el); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
}

describe('AgentLibrary persona cli field', () => {
  it('a codex persona shows codex selected and the model input; help rides on the title', async () => {
    const el = await mount(persona({ agentCli: 'codex', agentCliModel: 'gpt-5' }))
    expect(cli(el).value).toBe('codex')
    const model = byId(el, 'agent-persona-cli-model') as HTMLInputElement
    expect(model).toBeTruthy()
    expect(model.value).toBe('gpt-5')
    expect(model.maxLength).toBe(128)
    expect(model.placeholder).toBe("Blank = the CLI's own default")
    expect(cli(el).title).toContain('Macros, phone launches and scheduled PRDs always run Claude Code.')
  })

  it('a not-installed CLI is a disabled option that says so', async () => {
    const el = await mount(persona())
    const gemini = Array.from(cli(el).options).find((o) => o.value === 'gemini')!
    expect(gemini.disabled).toBe(true)
    expect(gemini.textContent).toContain('not installed')
    expect(gemini.title).toBe('npm i -g gemini')
    expect(Array.from(cli(el).options).find((o) => o.value === 'codex')!.disabled).toBe(false)
  })

  it('Re-check in the ⋯ menu re-runs CLI detection', async () => {
    const el = await mount(persona())
    const detect = (window as unknown as { api: { agentCli: { detect: ReturnType<typeof vi.fn> } } }).api.agentCli.detect
    await click(byId(el, 'agent-detail-more'))
    await click(byId(el, 'agent-detail-recheck'))
    expect(detect.mock.calls.at(-1)![0]).toMatchObject({ refresh: true })
  })

  it('switching to Claude Code and saving sends agentCli claude and no agentCliModel', async () => {
    const el = await mount(persona({ agentCli: 'codex', agentCliModel: 'gpt-5' }))
    await pick(el, 'claude')
    expect(byId(el, 'agent-persona-cli-model')).toBeNull()
    await saveClick(el)
    const sent = savePersona.mock.calls[0][0]
    expect(sent.agentCli).toBe('claude')
    expect('agentCliModel' in sent).toBe(false)
  })

  it('picking codex and typing a padded model sends the trimmed model', async () => {
    const el = await mount(persona())
    expect(cli(el).value).toBe('claude')
    expect(byId(el, 'agent-persona-cli-model')).toBeNull()
    await pick(el, 'codex')
    await type(byId(el, 'agent-persona-cli-model') as HTMLInputElement, ' o3 ')
    await saveClick(el)
    const sent = savePersona.mock.calls[0][0]
    expect(sent.agentCli).toBe('codex')
    expect(sent.agentCliModel).toBe('o3')
  })

  it('changing the CLI clears the model; a blank model is omitted', async () => {
    const el = await mount(persona({ agentCli: 'codex', agentCliModel: 'gpt-5' }))
    await pick(el, 'claude')
    await pick(el, 'codex')
    expect((byId(el, 'agent-persona-cli-model') as HTMLInputElement).value).toBe('')
    await saveClick(el)
    const sent = savePersona.mock.calls[0][0]
    expect(sent.agentCli).toBe('codex')
    expect('agentCliModel' in sent).toBe(false)
  })
})
