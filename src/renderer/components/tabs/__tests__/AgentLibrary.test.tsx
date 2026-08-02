// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import type { AgentPersona } from '../../../../preload/api'

/**
 * AgentLibrary is a component-local fetch (no store) list+detail page, per
 * Skills.tsx's canonical shape — mirrors Skills.navface.test.tsx's
 * window.api mocking approach but with no NavFace-driven scope switcher
 * (this page is Home-face-only).
 */

const PERSONAS: AgentPersona[] = [
  {
    name: 'builder',
    description: 'Watch git history and drive the next publish.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: null,
    color: null,
    tags: [],
    path: '/home/bilko/.claude/agents/builder.md',
    body: 'You are the Builder agent.',
    overridingProjects: ['session-manager'],
  },
  {
    name: 'debugger',
    description: 'Diagnose a failing test.',
    tools: [],
    model: null,
    color: null,
    tags: [],
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

describe('AgentLibrary', () => {
  it('fetches personas on mount and lists them', async () => {
    const el = await mount()
    expect(el.textContent).toContain('builder')
    expect(el.textContent).toContain('debugger')
    expect(el.textContent).toContain('2 personas')
  })

  it('selects the first persona by default and shows its detail, incl. the overriding project (AC 6: builder overridden by session-manager)', async () => {
    const el = await mount()
    expect(el.textContent).toContain('Watch git history and drive the next publish.')
    expect(el.textContent).toContain('session-manager')
    expect(el.textContent).toContain('Read')
  })

  it('clicking another persona swaps the detail pane', async () => {
    const el = await mount()
    const debuggerRow = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('debugger'))
    await act(async () => {
      debuggerRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(el.textContent).toContain('Diagnose a failing test.')
    expect(el.textContent).toContain('no open project overlays this agent')
  })

  it('filters the list by name', async () => {
    const el = await mount()
    const input = el.querySelector('input[placeholder="filter…"]') as HTMLInputElement
    // React tracks the input's previous value internally; setting .value via
    // plain JS before dispatching 'input' doesn't register as a change
    // unless we go through the native setter React itself overrides.
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'debug')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const rowNames = Array.from(el.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(rowNames.some((t) => t.includes('debugger'))).toBe(true)
    expect(rowNames.some((t) => t.startsWith('builder'))).toBe(false)
  })

  it('re-fetches personas when agents:changed fires — Tag Library edits the same file from its own side', async () => {
    const { api, emitChanged } = installWindowApiMock()
    const el = await mount()
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(1)

    api.agents.listPersonas.mockResolvedValueOnce([
      { ...PERSONAS[0], tags: ['feature'] },
      PERSONAS[1],
    ])
    await act(async () => {
      emitChanged()
      await Promise.resolve()
    })
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(2)
    expect(el.textContent).toContain('builder')
  })
})
