// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../../../../lib/useKnownProjects', async (orig) => {
  const actual = await orig<typeof import('../../../../lib/useKnownProjects')>()
  return { ...actual, useKnownProjects: () => ({ projects: [], recentSessions: [], loading: false }) }
})

vi.mock('../../../../lib/useOutsideNeedsYou', () => ({
  useOutsideNeedsYou: () => ({
    items: [{ app: 'portfolio', id: 'i1', title: 'Ship it?', why: 'Green.', link: null, options: ['Yes', 'No'], status: 'open', createdAt: '2026-11-20T10:00:00.000Z' }],
    answer: async () => ({ ok: true }),
    reload: () => {},
  }),
}))

import { Home } from '../../Home'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  const holders = [{ owner: 'scheduler:a', at: '2026-08-02T20:00:00.000Z' }]
  ;(window as unknown as { api: unknown }).api = new Proxy({}, {
    get: (_t, ns) => new Proxy(() => Promise.resolve(null), {
      get: (_t2, m) => (ns === 'schedule' && m === 'sessionSlots'
        ? () => Promise.resolve({ total: 5, inUse: 1, holders, min: 0, max: 10, default: 5, envOverride: false })
        : () => Promise.resolve(null)),
    }),
  })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Home, {}))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

describe('Home — Guild Hall', () => {
  it('renders the world canvas and none of the removed cards', async () => {
    const el = await mount()
    expect(el.querySelector('[data-testid="world-canvas"]')).toBeTruthy()
    expect(el.querySelector('h1')?.textContent).toBe('Guild Hall')
    expect(el.querySelector('[data-testid="home-panel-grid"]')).toBeNull()
    expect(el.textContent).not.toMatch(/New epic/i)
    expect(el.textContent).not.toContain('Reference')
    expect(Array.from(el.querySelectorAll('button')).some((b) => /new epic/i.test(b.textContent ?? ''))).toBe(false)
    for (const t of ['Projects', 'Queued', 'Active sessions', 'Recent sessions', 'All history']) {
      expect(el.textContent).not.toContain(t)
    }
  })

  it('shows "N of M slots busy"', async () => {
    const el = await mount()
    expect(el.querySelector('[data-testid="guild-hall-slots"]')?.textContent).toMatch(/^\d+ of \d+ slots busy$/)
  })

  it('Quest board is closed by default and toggles the needs-you rows', async () => {
    const el = await mount()
    const toggle = el.querySelector('[data-testid="quest-board-toggle"]') as HTMLButtonElement
    expect(toggle.textContent).toBe('Quest board (1)')
    expect(el.querySelector('[data-testid="quest-board"]')).toBeNull()
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const board = el.querySelector('[data-testid="quest-board"]')!
    expect(board).toBeTruthy()
    expect(board.textContent).toContain('Needs you')
    expect(board.textContent).toContain('Ship it?')
  })
})
