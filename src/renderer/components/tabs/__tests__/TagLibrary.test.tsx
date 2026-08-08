// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TagLibrary } from '../TagLibrary'
import type { AgentPersona } from '../../../../preload/api'

/**
 * TagLibrary shows/edits which agent personas carry a given Epic intent tag —
 * the other side of AgentLibrary.tsx's "tags" field, both reading/writing the
 * same `tags:` frontmatter via `window.api.agents.*`. Mirrors
 * AgentLibrary.test.tsx's window.api mocking approach.
 */

const PERSONAS: AgentPersona[] = [
  {
    name: 'builder',
    description: 'Watch git history and drive the next publish.',
    tools: ['Read', 'Grep'],
    model: null,
    color: null,
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
    color: null,
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
    root!.render(createElement(TagLibrary))
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

describe('TagLibrary', () => {
  it('shows the agent already carrying the default-selected tag (feature)', async () => {
    const el = await mount()
    expect(el.textContent).toContain('builder')
    expect(el.textContent).not.toContain('no agent carries this tag yet')
  })

  it('shows "no agent carries this tag yet" for a tag nothing is assigned to', async () => {
    const el = await mount()
    const bugRow = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('#bug'))
    await act(async () => {
      bugRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(el.textContent).toContain('no agent carries this tag yet')
  })

  it('unassigning an agent calls savePersona with that tag removed', async () => {
    const { api } = installWindowApiMock()
    const el = await mount()
    const removeBtn = Array.from(el.querySelectorAll('button')).find((b) => b.title === 'Remove this tag from the agent')
    await act(async () => {
      removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(api.agents.savePersona).toHaveBeenCalledWith(expect.objectContaining({ name: 'builder', tags: [] }))
  })

  it('assigning an agent calls savePersona with that tag added', async () => {
    const { api } = installWindowApiMock()
    const el = await mount()
    const bugRow = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('#bug'))
    await act(async () => {
      bugRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const addBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('+ assign agent'))
    await act(async () => {
      addBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const select = el.querySelector('select') as HTMLSelectElement
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(select, 'debugger')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(api.agents.savePersona).toHaveBeenCalledWith(expect.objectContaining({ name: 'debugger', tags: ['bug'] }))
  })

  it('re-fetches personas when agents:changed fires — Agent Library edits the same file from its own side', async () => {
    const { api, emitChanged } = installWindowApiMock()
    await mount()
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(1)
    await act(async () => {
      emitChanged()
      await Promise.resolve()
    })
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(2)
  })
})
