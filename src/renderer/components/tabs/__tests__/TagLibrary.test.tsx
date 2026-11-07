// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TagLibrary } from '../TagLibrary'
import type { AgentPersona } from '../../../../preload/api'

/**
 * TagLibrary shows (read-only) which agent personas carry a given Epic intent tag —
 * the other side of AgentLibrary.tsx's "tags" field, read via
 * `window.api.agents.listPersonas`. Mirrors
 * AgentLibrary.test.tsx's window.api mocking approach.
 */

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

  it('is read-only: no assign/unassign controls and no savePersona call', async () => {
    const { api } = installWindowApiMock()
    const el = await mount()
    expect(el.querySelector('select')).toBeNull()
    expect(el.textContent).not.toContain('+ assign agent')
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.title === 'Remove this tag from the agent')).toBe(false)
    expect(api.agents.savePersona).not.toHaveBeenCalled()
  })

  it('clicking a carrying persona calls onOpenPersona with its name', async () => {
    installWindowApiMock()
    const onOpen = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(TagLibrary, { onOpenPersona: onOpen }))
      await Promise.resolve()
      await Promise.resolve()
    })
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.title === 'Open builder in Personas')
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onOpen).toHaveBeenCalledWith('builder')
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
