// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import type { AgentPersona } from '../../../../preload/api'

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
  it('defaults to Personas with a SourceChip of the real persona path', async () => {
    const el = await mount()
    expect(el.querySelector('[data-agent-row="builder"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="source-chip-path"]')!.textContent).toContain('~/.claude/agents/builder.md')
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
    expect(el.textContent).toContain('+ New agent')
    expect(el.querySelector('[data-testid="source-chip-path"]')!.textContent).toContain('builder.md')
  })
})
