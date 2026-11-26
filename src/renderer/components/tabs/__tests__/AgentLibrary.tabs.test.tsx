// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import type { AgentPersona } from '../../../../preload/api'

// The real pane mounts Tiptap/Monaco; the stub keeps the contract this page relies on:
// controlled body text, Document mode by default, and the status bar's Save/Revert.
// These tests drive the expanded 316 px list; the default (collapsed rail) has its own spec, AgentSheet.test.tsx.
vi.mock('../../../lib/uiSettingsPrefs', () => ({
  readUiSettingsPrefs: async () => ({ agentsListExpanded: true }),
  writeUiSettingsPrefs: async () => {},
}))

vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: { path: string; value: string; defaultMode?: string; dirty?: boolean; onChange: (v: string) => void; onSave?: () => void; onRevert?: () => void }) =>
    createElement('div', { 'data-testid': 'document-editor-pane', 'data-mode': p.defaultMode, 'data-path': p.path }, [
      createElement('textarea', { key: 'ta', 'data-testid': 'document-editor-body', value: p.value, onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) }),
      createElement('button', { key: 'r', 'data-testid': 'editor-revert', disabled: !p.dirty, onClick: () => p.onRevert?.() }, 'Revert'),
      createElement('button', { key: 's', 'data-testid': 'editor-save', disabled: !p.dirty, onClick: () => p.onSave?.() }, 'Save'),
    ]),
}))

/** AgentLibrary's Personas | Tags tabs. */

const PERSONAS: AgentPersona[] = [
  {
    name: 'builder',
    description: 'Watch git history and drive the next publish.',
    tools: ['Read', 'Grep'],
    model: null,
    effort: null, color: null,
    tags: ['feature'], projects: [], action: null, actionLabel: null,
    path: '/home/bilko/.claude/agents/builder.md',
    body: 'You are the Builder agent.',
    overridingProjects: [],
  },
  {
    name: 'debugger',
    description: 'Diagnose a failing test.',
    tools: [],
    model: null,
    effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null,
    path: '/home/bilko/.claude/agents/debugger.md',
    body: 'You are the Debugger agent.',
    overridingProjects: [],
  },
]

function installWindowApiMock(personas: AgentPersona[] = PERSONAS) {
  const changedHandlers: Array<() => void> = []
  const api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue(personas),
      savePersona: vi.fn().mockResolvedValue({ ok: true, path: '' }),
      deletePersona: vi.fn().mockResolvedValue({ ok: true }),
      removeOverride: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn((handler: () => void) => {
        changedHandlers.push(handler)
        return () => {
          const i = changedHandlers.indexOf(handler)
          if (i >= 0) changedHandlers.splice(i, 1)
        }
      }),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, mtimeMs: 1 }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, emitChanged: () => changedHandlers.forEach((h) => h()) }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentLibrary))
    await Promise.resolve()
    await Promise.resolve()
  })
  // The roster is the landing; open the first persona's sheet like the old auto-selection did.
  await act(async () => {
    container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  installWindowApiMock()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

function clickText(el: HTMLElement, text: string) {
  const b = Array.from(el.querySelectorAll('button')).find((x) => x.textContent?.trim() === text)!
  return act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('AgentLibrary tabs', () => {
  it('defaults to Personas with the real persona path in the detail eyebrow', async () => {
    const el = await mount()
    expect(el.querySelector('[data-agent-row="builder"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="config-detail-header"]')!.textContent).toContain('~/.claude/agents/builder.md')
  })

  it('Tags tab shows the read-only tag body without the stale Action-button hint', async () => {
    const el = await mount()
    await clickText(el, 'Tags')
    expect(el.textContent).toContain('/develop eagerness')
    expect(el.textContent).toContain('agents carrying this tag')
    expect(el.textContent).not.toContain('Action button')
    expect(el.querySelector('[data-agent-row]')).toBeNull()
  })

  it('clicking a persona on the Tags tab selects it on the Personas tab', async () => {
    const el = await mount()
    await clickText(el, 'Tags')
    await clickText(el, 'builder')
    expect(el.querySelector('[data-agent-row="builder"]')).not.toBeNull()
    expect(el.textContent).toContain('+ New')
    expect(el.querySelector('[data-testid="config-detail-header"]')!.textContent).toContain('builder.md')
  })
})
